import re

import regex

LATIN = regex.compile(r"[\p{Script=Latin}&&\p{Letter}]", regex.V1)
SPEAKABLE = regex.compile(r"[\p{Script=Latin}\p{Decimal_Number}]")
# Treat non-Latin writing and East Asian annotation punctuation as boundaries.
# Han includes supplementary-plane ideographs and compatibility characters.
BOUNDARY = regex.compile(
    r"(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}"
    r"\u3000-\u303f\uff61-\uff65，。！？；：、（）［］｛｝－／]|(?!\p{Script=Latin})\p{Letter})+"
)
FENCE = re.compile(r"(?m)^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$")
PARENTHETICAL = re.compile(r"\([^()\n]*\)|（[^（）\n]*）")
HAN = regex.compile(r"\p{Script=Han}")
EDGE_MARKS = " \t\r\n:;,|—–·-"


def outside_code(text, fence=None):
    """Return source spans outside fenced blocks, carrying state between paragraphs."""
    spans = []
    cursor = 0
    for match in FENCE.finditer(text):
        marker = match[1]
        if fence is None:
            spans.append((cursor, match.start()))
            fence = marker
        elif marker[0] == fence[0] and len(marker) >= len(fence) and not text[match.end(1):match.end()].strip():
            fence = None
            cursor = match.end()
    if fence is None:
        spans.append((cursor, len(text)))
    return spans, fence


def mask_notes(text):
    def replacement(match):
        note = match[0]
        if HAN.search(note) and not LATIN.search(note):
            return " " * len(note)
        return note

    return PARENTHETICAL.sub(replacement, text)


def spoken_text(value, source):
    if value == source:
        return value
    value = re.sub(r"[ \t]+", " ", value)
    return re.sub(r" +([,.!?;:])", r"\1", value)


def english_spans(text):
    """Find Latin-letter runs in source order without joining across annotations."""
    cursor = 0
    annotation = False
    for match in BOUNDARY.finditer(text):
        yield from trim_run(text, cursor, match.start(), left=annotation, right=True)
        cursor = match.end()
        annotation = True
    yield from trim_run(text, cursor, len(text), left=annotation, right=False)


def trim_run(text, start, end, *, left, right):
    value = text[start:end]
    first = len(value) - len(value.lstrip(EDGE_MARKS if left else None))
    last = len(value.rstrip(EDGE_MARKS if right else None))
    if first < last and LATIN.search(value, first, last):
        yield start + first, start + last


def clean_tts_text(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not BOUNDARY.search(text) and not FENCE.search(text):
        return text.strip()
    spans, _ = outside_code(text)
    values = []
    for origin, end in spans:
        source = text[origin:end]
        reading = mask_notes(source)
        for first, last in english_spans(reading):
            values.append(spoken_text(reading[first:last], source[first:last]))
    return "\n".join(values)
