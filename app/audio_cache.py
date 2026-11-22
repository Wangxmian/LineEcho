import hashlib
import json
import logging
import os
import re
import struct
import tempfile
from pathlib import Path
from threading import RLock

from .tts_engine import MODEL_ID

CACHE_FORMAT = 1
MODEL_REVISION = "a71e4d38b236d968966a2002c4c895dbd12b1c3c"
MAX_CACHE_BYTES = 256 * 1024 * 1024
MAX_CACHE_ENTRIES = 2_000
ENTRY_NAME = re.compile(r"[0-9a-f]{64}\.bin")
HEADER = struct.Struct(">I")
LOGGER = logging.getLogger("uvicorn.error")


def audio_key(text, voice, speed):
    identity = json.dumps((CACHE_FORMAT, MODEL_ID, MODEL_REVISION, text, voice, speed),
                          ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(identity).hexdigest()


class AudioCache:
    def __init__(self, directory):
        self.directory = directory
        self.lock = RLock()
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)

    def lookup(self, key):
        path = self.directory / f"{key}.bin"
        with self.lock:
            try:
                with path.open("rb") as file:
                    segments, = HEADER.unpack(file.read(HEADER.size))
                    wav = file.read()
                if not (segments and wav.startswith(b"RIFF") and wav[8:12] == b"WAVE"):
                    path.unlink(missing_ok=True)
                    return None
                os.utime(path)
                return wav, segments
            except FileNotFoundError:
                return None
            except (OSError, struct.error):
                LOGGER.warning("无法读取本地语音缓存", exc_info=True)
                return None

    def save(self, key, wav, segments):
        path = self.directory / f"{key}.bin"
        with self.lock:
            try:
                with tempfile.NamedTemporaryFile(dir=self.directory, prefix=".tmp-", delete=False) as file:
                    temporary = Path(file.name)
                    try:
                        file.write(HEADER.pack(segments))
                        file.write(wav)
                        file.close()
                        os.replace(temporary, path)
                    finally:
                        temporary.unlink(missing_ok=True)
                self.evict()
            except OSError:
                LOGGER.warning("无法写入本地语音缓存", exc_info=True)

    def entries(self):
        return (path for path in self.directory.iterdir()
                if ENTRY_NAME.fullmatch(path.name) and path.is_file())

    def evict(self):
        entries = sorted((stat.st_mtime_ns, stat.st_size, path)
                         for path in self.entries() if (stat := path.stat()))
        kept_bytes = sum(size for _, size, _ in entries)
        for index, (_, size, path) in enumerate(entries):
            if len(entries) - index <= MAX_CACHE_ENTRIES and kept_bytes <= MAX_CACHE_BYTES:
                break
            path.unlink()
            kept_bytes -= size

    def clear(self):
        with self.lock:
            paths = list(self.entries())
            for path in paths:
                path.unlink(missing_ok=True)
            return len(paths)
