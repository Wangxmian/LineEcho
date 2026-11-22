import asyncio
import hashlib
import json
import logging
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from .english_text import LATIN
from .mtran_engine import (
    MANIFEST as MTRAN_MANIFEST, MODEL_ID as MTRAN_MODEL_ID,
    MODEL_REVISION as MTRAN_REVISION, MTranEngine,
)
from .translation_engine import (
    GENERATION, MAX_TEXT, MODEL_ID, MODEL_REVISION, SOURCE_TOKENS, TARGET_TAG,
    MarianEngine, TranslationError,
)

SOURCE_LANGUAGE = "en"
TARGET_LANGUAGE = "zh-Hans"
CACHE_VERSION = 1
MAX_CACHE_ENTRIES = 8_000
MAX_PENDING = 2
LOGGER = logging.getLogger("uvicorn.error")
router = APIRouter(prefix="/api", tags=["translation"])


class TranslateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT, strict=True)
    source: Literal["en"] = SOURCE_LANGUAGE
    target: Literal["zh-Hans"] = TARGET_LANGUAGE

    @field_validator("text")
    @classmethod
    def normalize_text(cls, text):
        normalized = " ".join(text.split())
        if not LATIN.search(normalized):
            raise ValueError("请输入包含英文字母的内容。")
        return normalized


def translation_key(text, use_mtran=False):
    if use_mtran:
        identity = (CACHE_VERSION, MTRAN_MODEL_ID, MTRAN_REVISION, SOURCE_LANGUAGE, TARGET_LANGUAGE, text)
    else:
        identity = (
            CACHE_VERSION, MODEL_ID, MODEL_REVISION, SOURCE_LANGUAGE, TARGET_LANGUAGE,
            TARGET_TAG, SOURCE_TOKENS, GENERATION, text,
        )
    serialized = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


class TranslationCache:
    def __init__(self, path):
        self.path = path

    def connect(self):
        return sqlite3.connect(self.path, timeout=2)

    def initialize(self):
        with closing(self.connect()) as db, db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS translations (
                    key TEXT PRIMARY KEY, translation TEXT NOT NULL, saved INTEGER NOT NULL
                )
            """)
            db.execute("CREATE INDEX IF NOT EXISTS translations_saved ON translations(saved)")

    def lookup(self, key):
        with closing(self.connect()) as db:
            row = db.execute("SELECT translation FROM translations WHERE key = ?", (key,)).fetchone()
            return row[0] if row else None

    def save(self, key, translation):
        with closing(self.connect()) as db, db:
            db.execute(
                "INSERT OR REPLACE INTO translations VALUES (?, ?, ?)", (key, translation, time.time_ns())
            )
            db.execute("""
                DELETE FROM translations WHERE key IN (
                    SELECT key FROM translations ORDER BY saved DESC LIMIT -1 OFFSET ?
                )
            """, (MAX_CACHE_ENTRIES,))

    def clear(self):
        with closing(self.connect()) as db, db:
            return db.execute("DELETE FROM translations").rowcount


class TranslationService:
    def __init__(self, cache_path):
        self.use_mtran = MTRAN_MANIFEST.is_file()
        self.cache = TranslationCache(cache_path)
        self.cache_ready = False
        self.cache_epoch = 0
        self.cache_write = asyncio.Lock()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="translation")
        self.engine = None
        self.loader = None
        self.error = None
        self.pending = {}

    def start(self):
        if self.engine is None and (self.loader is None or self.loader.done()):
            self.error = None
            self.loader = asyncio.create_task(self.load())

    async def load(self):
        try:
            await asyncio.to_thread(self.cache.initialize)
            self.cache_ready = True
        except sqlite3.Error:
            LOGGER.exception("无法初始化翻译缓存")
        factory = MTranEngine if self.use_mtran else MarianEngine
        try:
            self.engine = await asyncio.get_running_loop().run_in_executor(self.worker, factory)
            LOGGER.info("%s 已就绪 (%s)", factory.__name__, self.engine.device)
        except Exception:
            installer = "install-mtran.command" if self.use_mtran else "install-translation.command"
            self.error = f"翻译暂不可用。请重试，或运行 scripts/{installer}。"
            LOGGER.exception("%s 初始化失败", factory.__name__)

    def status(self):
        return {
            "model": MTRAN_MODEL_ID if self.use_mtran else MODEL_ID,
            "revision": MTRAN_REVISION if self.use_mtran else MODEL_REVISION,
            "source_language": SOURCE_LANGUAGE, "target_language": TARGET_LANGUAGE,
            "target_tag": None if self.use_mtran else TARGET_TAG, "ready": self.engine is not None,
            "state": "ready" if self.engine else "error" if self.error else "loading",
            "device": self.engine.device if self.engine else None,
            "offline": True, "error": self.error,
        }

    async def translate(self, text, request):
        key = translation_key(text, self.use_mtran)
        if self.cache_ready:
            try:
                cached = await asyncio.to_thread(self.cache.lookup, key)
            except sqlite3.Error:
                cached = None
                LOGGER.exception("无法读取翻译缓存")
            if cached is not None:
                return {"translation": cached, "cached": True}

        if self.engine is None:
            if self.error:
                raise HTTPException(503, self.error)
            raise HTTPException(503, "正在加载本地翻译模型……", headers={"Retry-After": "1"})

        if await request.is_disconnected():
            return None
        job = self.pending.get(key)
        if job is None:
            if len(self.pending) >= MAX_PENDING:
                raise HTTPException(429, "本地翻译繁忙，请稍后重试。", headers={"Retry-After": "1"})
            job = asyncio.create_task(self.generate(key, text, self.cache_epoch))
            self.pending[key] = job
            job.add_done_callback(lambda task: self.finish(key, task))

        try:
            return {"translation": await asyncio.shield(job), "cached": False}
        except TranslationError as exc:
            raise HTTPException(422, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(500, "翻译失败，请重试。") from exc

    def finish(self, key, task):
        self.pending.pop(key, None)
        if not task.cancelled():
            error = task.exception()
            if error and not isinstance(error, TranslationError):
                LOGGER.error("本地翻译失败", exc_info=(type(error), error, error.__traceback__))

    async def generate(self, key, text, epoch):
        translation = await asyncio.get_running_loop().run_in_executor(self.worker, self.engine.translate, text)
        if self.cache_ready:
            async with self.cache_write:
                if epoch == self.cache_epoch:
                    try:
                        await asyncio.to_thread(self.cache.save, key, translation)
                    except sqlite3.Error:
                        LOGGER.exception("无法写入翻译缓存")
        return translation

    async def clear(self):
        async with self.cache_write:
            try:
                await asyncio.to_thread(self.cache.initialize)
                removed = await asyncio.to_thread(self.cache.clear)
            except sqlite3.Error as exc:
                LOGGER.exception("无法清理翻译缓存")
                raise HTTPException(500, "无法清理翻译缓存，请查看本地服务日志。") from exc
            self.cache_ready = True
            self.cache_epoch += 1
            return removed

    async def close(self):
        if self.loader:
            await self.loader
        await asyncio.gather(*self.pending.values(), return_exceptions=True)
        try:
            if isinstance(self.engine, MTranEngine):
                await asyncio.get_running_loop().run_in_executor(self.worker, self.engine.close)
        finally:
            self.worker.shutdown(wait=True, cancel_futures=True)


@router.get("/translation/status")
async def status(request: Request):
    return request.app.state.translation.status()


@router.post("/translation/reload", status_code=202)
async def reload_model(request: Request):
    translation = request.app.state.translation
    translation.start()
    return translation.status()


@router.post("/translate")
async def translate(payload: TranslateRequest, request: Request):
    return await request.app.state.translation.translate(payload.text, request)


@router.delete("/translation/cache")
async def clear_cache(request: Request):
    return {"removed": await request.app.state.translation.clear()}
