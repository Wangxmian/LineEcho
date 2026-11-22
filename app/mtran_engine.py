import json
import os
import selectors
import shutil
import subprocess
import time
from pathlib import Path

from .english_text import HAN
from .translation_engine import TranslationError

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "models" / "MTranServer"
RUNTIME_DIR = ROOT / ".runtime" / "mtranserver"
MODEL_ID = "MTranServer/en-zh-Hans"
MODEL_REVISION = "5.1.1/mozilla-3.0/k9"
MANIFEST = MODEL_DIR / "models" / "en_zh-Hans" / "manifest.json"


class MTranEngine:
    device = "cpu"

    def __init__(self):
        self.process = None
        self.buffer = bytearray()
        self.start()

    def start(self):
        node_paths = os.pathsep.join((os.environ.get("PATH", ""), "/opt/homebrew/bin", "/usr/local/bin"))
        node = os.environ.get("KOKORO_NODE_BINARY") or shutil.which("node", path=node_paths)
        if not node or not MANIFEST.is_file():
            raise RuntimeError("请运行 scripts/install-mtran.command 准备离线翻译模型。")
        self.buffer.clear()
        self.process = subprocess.Popen(
            [node, str(ROOT / "scripts" / "mtran-worker.mjs"), str(RUNTIME_DIR), str(MODEL_DIR)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        )
        try:
            if self.read_result(45).get("ready") is not True:
                raise RuntimeError("MTranServer 启动失败，请查看本地服务日志。")
        except Exception:
            self.close()
            raise

    def read_result(self, timeout):
        deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            while b"\n" not in self.buffer:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise TimeoutError("等待 MTranServer 响应超时。")
                chunk = os.read(self.process.stdout.fileno(), 16_384)
                if not chunk:
                    raise RuntimeError("MTranServer 已退出。")
                self.buffer.extend(chunk)
                if len(self.buffer) > 262_144:
                    raise RuntimeError("MTranServer 响应超过大小限制。")
        end = self.buffer.index(b"\n")
        result = json.loads(self.buffer[:end])
        del self.buffer[:end + 1]
        if not isinstance(result, dict):
            raise RuntimeError("MTranServer 返回了不支持的响应。")
        return result

    def translate(self, text):
        if self.process and self.process.poll() is not None:
            self.close()
        if self.process is None:
            self.start()
        try:
            self.process.stdin.write(json.dumps({"text": text}).encode("utf-8") + b"\n")
            self.process.stdin.flush()
            result = self.read_result(65)
        except Exception:
            self.close()
            raise
        if result.get("error"):
            raise RuntimeError("MTranServer 推理出错，请查看本地服务日志。")
        translation = result.get("translation")
        if not isinstance(translation, str) or not HAN.search(translation):
            raise TranslationError("模型没有生成中文译文。")
        return translation.strip()

    def close(self):
        process, self.process = self.process, None
        if process is None:
            return
        try:
            try:
                process.stdin.close()
            except BrokenPipeError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        finally:
            process.stdout.close()
