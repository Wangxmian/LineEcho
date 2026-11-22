import json
import os
import re
import shutil
import tempfile
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from .document_parser import (
    MAX_DOCUMENT_CHARACTERS, MAX_FILE_BYTES, Block, DocumentError, file_type, make_units,
    parse_document,
)

FILTER_VERSION = 2
SplitMode = Literal["smart", "lines"]
router = APIRouter(prefix="/api/documents", tags=["documents"])


class TextImport(BaseModel):
    name: str = Field(default="粘贴文本", max_length=160)
    text: str = Field(max_length=MAX_DOCUMENT_CHARACTERS)


class DocumentSettings(BaseModel):
    mode: SplitMode | None = None
    unit_id: str | None = Field(default=None, max_length=32)


def write_json(path, value):
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, prefix=".tmp-", delete=False
    ) as file:
        temporary = Path(file.name)
        try:
            json.dump(value, file, ensure_ascii=False, separators=(",", ":"))
            file.close()
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def display_name(name):
    clean = name.replace("\\", "/").rsplit("/", 1)[-1]
    return "".join(char for char in clean if char.isprintable()).strip()[:160] or "粘贴文本"


def locate_unit(units, unit_id):
    exact = next((unit for unit in units if unit["id"] == unit_id), None)
    if exact or not units:
        return exact
    anchor = re.fullmatch(r"p(\d+)-(\d+)", unit_id or "")
    if not anchor:
        return units[0]
    block, offset = map(int, anchor.groups())
    return next((unit for unit in units if unit["paragraph_index"] > block or (
        unit["paragraph_index"] == block and unit["end"] > offset
    )), units[-1])


class DocumentStore:
    def __init__(self, directory):
        self.directory = directory
        self.lock = RLock()
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)

    def list(self):
        with self.lock:
            documents = [read_json(path) for path in self.directory.glob("*/meta.json")
                         if not path.parent.name.startswith(".")]
        return sorted(documents, key=lambda document: document["created_at"], reverse=True)

    def create(self, name, source, value):
        blocks = parse_document(source, value)
        if not blocks:
            raise DocumentError("文档为空，未检测到可朗读的英文内容。")
        modes = {mode: make_units(blocks, mode, source=source) for mode in ("smart", "lines")}
        multiline = sum(len(block.text.splitlines()) for block in blocks) > 1
        selected_mode = "lines" if source == "paste" and multiline else "smart"
        if not modes[selected_mode]:
            raise DocumentError("未检测到可朗读的英文内容")
        document_id = str(uuid4())
        metadata = {
            "id": document_id, "name": display_name(name), "source": source,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "mode": selected_mode, "unit_id": modes[selected_mode][0]["id"],
            "unit_count": len(modes[selected_mode]),
        }
        content = {"filter_version": FILTER_VERSION, "blocks": [asdict(block) for block in blocks], "modes": modes}
        with self.lock, tempfile.TemporaryDirectory(dir=self.directory, prefix=".new-") as scratch:
            staging = Path(scratch) / "document"
            staging.mkdir()
            write_json(staging / "content.json", content)
            write_json(staging / "meta.json", metadata)
            staging.rename(self.directory / document_id)
        return self.view(metadata, content)

    @staticmethod
    def view(metadata, content):
        return {**metadata, "blocks": content["blocks"], "units": content["modes"][metadata["mode"]]}

    def folder(self, document_id):
        path = self.directory / str(document_id)
        if not (path / "meta.json").is_file():
            raise HTTPException(404, "这份文档已不存在。")
        return path

    def get(self, document_id):
        with self.lock:
            folder = self.folder(document_id)
            return self.view(*self.load(folder))

    @staticmethod
    def load(folder):
        metadata = read_json(folder / "meta.json")
        content = read_json(folder / "content.json")
        if content.get("filter_version") != FILTER_VERSION:
            blocks = [Block(**block) for block in content["blocks"]]
            content["modes"] = {
                mode: make_units(blocks, mode, source=metadata["source"], limit=None)
                for mode in ("smart", "lines")
            }
            content["filter_version"] = FILTER_VERSION
            write_json(folder / "content.json", content)
        units = content["modes"][metadata["mode"]]
        selected = locate_unit(units, metadata["unit_id"])
        unit_id = selected["id"] if selected else None
        if metadata["unit_id"] != unit_id or metadata["unit_count"] != len(units):
            metadata.update(unit_id=unit_id, unit_count=len(units))
            write_json(folder / "meta.json", metadata)
        return metadata, content

    def update(self, document_id, settings):
        with self.lock:
            folder = self.folder(document_id)
            metadata, content = self.load(folder)
            mode = settings.mode or metadata["mode"]
            if settings.mode is None and settings.unit_id is None:
                raise HTTPException(422, "请提供要保存的分割方式或阅读位置。")
            units = content["modes"][mode]
            if settings.unit_id is not None:
                selected = next((unit for unit in units if unit["id"] == settings.unit_id), None)
                if selected is None:
                    raise HTTPException(422, "阅读位置已更改，请重新选择句子。")
            else:
                selected = locate_unit(units, metadata["unit_id"])
            metadata.update(mode=mode, unit_id=selected["id"] if selected else None, unit_count=len(units))
            write_json(folder / "meta.json", metadata)
            return self.view(metadata, content) if settings.mode is not None else metadata

    def delete(self, document_id):
        with self.lock:
            shutil.rmtree(self.folder(document_id))


async def create_document(request, name, source, value):
    try:
        return await run_in_threadpool(request.app.state.documents.create, name, source, value)
    except DocumentError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("")
def get_documents(request: Request):
    return {"documents": request.app.state.documents.list()}


@router.post("/upload", status_code=201)
async def upload(request: Request):
    length = request.headers.get("content-length")
    if length and length.isdecimal() and int(length) > MAX_FILE_BYTES + 64 * 1024:
        raise HTTPException(413, "文件超过 8 MB，请拆分后再导入。")
    async with request.form(max_files=1, max_fields=0) as form:
        file = form.get("file")
        if not isinstance(file, UploadFile) or not file.filename:
            raise HTTPException(422, "请选择要导入的文件。")
        try:
            source = file_type(file.filename)
        except DocumentError as exc:
            raise HTTPException(415, str(exc)) from exc
        data = await file.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(413, "文件超过 8 MB，请拆分后再导入。")
    return await create_document(request, file.filename, source, data)


@router.post("/text", status_code=201)
async def paste(request: Request, payload: TextImport):
    return await create_document(request, payload.name, "paste", payload.text)


@router.get("/{document_id}")
def get_document(document_id: UUID, request: Request):
    return request.app.state.documents.get(document_id)


@router.patch("/{document_id}")
def save_settings(document_id: UUID, settings: DocumentSettings, request: Request):
    return request.app.state.documents.update(document_id, settings)


@router.delete("/{document_id}", status_code=204)
def delete_document(document_id: UUID, request: Request):
    request.app.state.documents.delete(document_id)
    return Response(status_code=204)
