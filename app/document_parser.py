import codecs
import io
import re
from dataclasses import dataclass
from pathlib import Path
from zipfile import BadZipFile, ZipFile

import pysbd
from docx import Document
from docx.opc.exceptions import PackageNotFoundError
from docx.table import Table
from lxml.etree import XMLSyntaxError
from markdown_it import MarkdownIt
from pysbd.utils import TextSpan

from .english_text import LATIN, english_spans, mask_notes, outside_code, spoken_text
from .tts_engine import MAX_CHARACTERS

MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_DOCUMENT_CHARACTERS = 240_000
MAX_UNITS = 12_000
FILE_TYPES = {".docx": "docx", ".md": "markdown", ".markdown": "markdown", ".txt": "text"}
URL_TEXT = re.compile(r'(?:https?://|www\.)[^\s<>()]+', re.IGNORECASE)
MARKDOWN = MarkdownIt("commonmark", {"maxNesting": 64}).enable("table")


@dataclass
class Block:
    text: str
    kind: str = "paragraph"
    level: int = 0
    marker: str = ""
    row: int | None = None


class DocumentError(ValueError):
    pass


class OrderedEnglishSegmenter(pysbd.Segmenter):
    def sentences_with_char_spans(self, sentences):
        # pySBD knows the boundaries. Locate each sentence from the end of
        # its predecessor so a long paragraph of repeated text stays linear.
        spans = []
        cursor = 0
        for sentence in sentences:
            if not sentence:
                continue
            start = self.original_text.find(sentence, cursor)
            if start >= 0:
                cursor = start + len(sentence)
                spans.append(TextSpan(sentence, start, cursor))
        return spans


def file_type(filename):
    extension = Path(filename).suffix.lower()
    if extension == ".doc":
        raise DocumentError("旧版 .doc 请在 Word 中另存为 .docx 后再导入。")
    if extension not in FILE_TYPES:
        raise DocumentError("请选择 .docx、.md、.markdown 或 .txt 文件。")
    return FILE_TYPES[extension]


def decode_text(data):
    try:
        if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
            return data.decode("utf-16")
        value = data.decode("utf-8-sig")
        if "\0" in value:
            raise UnicodeError
        return value
    except UnicodeError as exc:
        raise DocumentError("无法读取文本编码。请将文件另存为 UTF-8 后再导入。") from exc


def plain_blocks(text):
    return [Block(piece) for piece in re.split(r"\n[^\S\n]*\n+", text) if piece.strip()]


def markdown_inline(tokens):
    pieces = []
    in_autolink = False
    hidden_tag = None
    for token in tokens:
        if token.type == "html_inline":
            tag = re.match(r"<(/?)(script|style)(?=[\s>])", token.content, re.I)
            if tag:
                hidden_tag = None if tag[1] else tag[2].lower()
            continue
        if hidden_tag:
            continue
        if token.markup == "autolink":
            in_autolink = token.type == "link_open"
        elif in_autolink:
            continue
        elif token.type in {"text", "code_inline"}:
            pieces.append(URL_TEXT.sub("", token.content))
        elif token.type == "softbreak":
            pieces.append(" ")
        elif token.type == "hardbreak":
            pieces.append("\n")
    return "".join(pieces)


def markdown_blocks(text):
    blocks = []
    containers = []
    next_row = 0
    for token in MARKDOWN.parse(text):
        if token.nesting == 1:
            context = {"tag": token.tag}
            if token.tag == "ol":
                context["next"] = int(token.attrGet("start") or 1)
            elif token.tag == "li":
                parent = containers[-1]
                context["marker"] = "•"
                if parent["tag"] == "ol":
                    context["marker"] = f"{parent['next']}."
                    parent["next"] += 1
            elif token.tag == "tr":
                context["row"] = next_row
                next_row += 1
            containers.append(context)
        elif token.nesting == -1:
            containers.pop()
        elif token.type == "inline":
            content = markdown_inline(token.children or []).strip()
            if not content:
                continue
            tags = {item["tag"] for item in containers}
            heading = next((tag for tag in tags if re.fullmatch(r"h[1-6]", tag)), None)
            item = next((item for item in reversed(containers) if item["tag"] == "li"), None)
            if heading:
                blocks.append(Block(content, "heading", int(heading[1])))
            elif "th" in tags or "td" in tags:
                row = next(item["row"] for item in reversed(containers) if item["tag"] == "tr")
                blocks.append(Block(content, "table-heading" if "th" in tags else "table-cell", row=row))
            elif item:
                marker = item.pop("marker", "")
                depth = sum(item["tag"] == "li" for item in containers)
                blocks.append(Block(content, "list", depth, marker))
            elif "blockquote" in tags:
                blocks.append(Block(content, "quote"))
            else:
                blocks.append(Block(content))
    return blocks


def word_blocks(data):
    try:
        with ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 2_000 or sum(entry.file_size for entry in entries) > MAX_EXPANDED_BYTES:
                raise DocumentError("DOCX 解压后的体积过大。请拆分文档后重新导入。")
        document = Document(io.BytesIO(data))
    except (BadZipFile, PackageNotFoundError, KeyError, XMLSyntaxError, ValueError, RuntimeError) as exc:
        if isinstance(exc, DocumentError):
            raise
        raise DocumentError("无法读取此 DOCX，文件可能损坏或不是有效的 Word 文档。") from exc

    row_number = 0
    blocks = []

    def append_items(container, table_row=None):
        nonlocal row_number
        for item in container.iter_inner_content():
            if isinstance(item, Table):
                seen = set()
                for row in item.rows:
                    row_number += 1
                    current_row = row_number
                    for cell in row.cells:
                        if cell._tc not in seen:
                            seen.add(cell._tc)
                            append_items(cell, current_row)
                continue

            text = item.text
            if not text.strip():
                continue
            style = item.style
            style_id = style.style_id if style else ""
            heading = re.fullmatch(r"Heading([1-9])", style_id)
            numbering = item._p.pPr is not None and item._p.pPr.numPr is not None
            if style_id.lower() in {"code", "codeblock", "sourcecode", "htmlcode"}:
                blocks.append(Block(text, "code", row=table_row))
            elif table_row is not None:
                blocks.append(Block(text, "table-cell", row=table_row))
            elif heading or style_id == "Title":
                blocks.append(Block(text, "heading", int(heading[1]) if heading else 1))
            elif numbering or style_id.startswith(("ListBullet", "ListNumber")):
                blocks.append(Block(text, "list", 1, "•"))
            elif style_id in {"Quote", "IntenseQuote"}:
                blocks.append(Block(text, "quote"))
            else:
                blocks.append(Block(text))

    try:
        append_items(document)
    except (ValueError, KeyError, AttributeError, IndexError, RecursionError) as exc:
        raise DocumentError("DOCX 的文档结构无法读取。请在 Word 中另存为新文件后再试。") from exc
    return blocks


def parse_document(source, value):
    if source == "docx":
        blocks = word_blocks(value)
    else:
        text = (decode_text(value) if isinstance(value, bytes) else value).replace("\r\n", "\n").replace("\r", "\n")
        if len(text) > MAX_DOCUMENT_CHARACTERS:
            raise DocumentError(f"文档最多支持 {MAX_DOCUMENT_CHARACTERS:,} 个字符。请拆分后再导入。")
        blocks = markdown_blocks(text) if source == "markdown" else plain_blocks(text)
    if sum(len(block.text) for block in blocks) > MAX_DOCUMENT_CHARACTERS:
        raise DocumentError(f"文档最多支持 {MAX_DOCUMENT_CHARACTERS:,} 个字符。请拆分后再导入。")
    return blocks


def bounded_spans(text, start, end, limit):
    while end - start > limit:
        boundary = text.rfind(" ", start + limit // 2, start + limit + 1)
        if boundary == -1:
            boundary = start + limit
        yield start, boundary
        start = boundary
    yield start, end


def boundaries(text, mode, segmenter):
    if mode == "lines":
        yield from (match.span() for match in re.finditer(r"[^\n]+", text))
        return
    origin = 0
    while origin < len(text):
        # Include lookahead for abbreviation/quote rules, then advance only to
        # an established boundary. A single oversized sentence uses the TTS limit.
        window_end = min(len(text), origin + MAX_CHARACTERS + 2_000)
        spans = segmenter.segment(text[origin:window_end])
        if window_end == len(text):
            cutoff = window_end
        else:
            spans = [span for span in spans if span.end <= MAX_CHARACTERS]
            cutoff = origin + spans[-1].end if spans else next(
                bounded_spans(text, origin, len(text), MAX_CHARACTERS)
            )[1]
        cursor = origin
        for span in spans:
            start, end = origin + span.start, origin + span.end
            if start > cursor and LATIN.search(text, cursor, start):
                yield cursor, start
            yield start, end
            cursor = end
        if cursor < cutoff and LATIN.search(text, cursor, cutoff):
            yield cursor, cutoff
        origin = cutoff


def make_units(blocks, mode, *, source=None, limit=MAX_UNITS):
    units = []
    segmenter = OrderedEnglishSegmenter(language="en", clean=False, char_span=True) if mode == "smart" else None
    fence = None
    for index, block in enumerate(blocks):
        if block.kind == "code":
            continue
        ranges = [(0, len(block.text))]
        if source in {"docx", "text", "paste"}:
            ranges, fence = outside_code(block.text, fence)
        for origin, end in ranges:
            masked = mask_notes(block.text[origin:end])
            for run_start, run_end in english_spans(masked):
                offset = origin + run_start
                text = masked[run_start:run_end]
                for start, end in boundaries(text, mode, segmenter):
                    for first, last in bounded_spans(text, start, end, MAX_CHARACTERS):
                        value = text[first:last]
                        if not LATIN.search(value):
                            continue
                        first += len(value) - len(value.lstrip())
                        last -= len(value) - len(value.rstrip())
                        units.append({
                            "id": f"p{index}-{offset + first}", "paragraph_index": index,
                            "start": offset + first, "end": offset + last,
                            "text": spoken_text(text[first:last], block.text[offset + first:offset + last]),
                        })
                        if limit is not None and len(units) > limit:
                            raise DocumentError(f"文档最多支持 {limit:,} 个朗读单元。请拆分后再导入。")
    return units
