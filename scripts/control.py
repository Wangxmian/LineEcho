import argparse
import fcntl
import http.client
import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime"
TOKEN_FILE = RUNTIME / "control-token"
LOG_FILE = RUNTIME / "server.log"
HOST = "127.0.0.1"
PORT = 7860
URL = f"http://{HOST}:{PORT}"
APP_ID = "kokoro-tts-local"


def request(method, path, token=""):
    connection = http.client.HTTPConnection(HOST, PORT, timeout=1)
    try:
        connection.request(method, path, headers={"X-Kokoro-Control": token})
        response = connection.getresponse()
        return response.status, response.read() if response.status == 200 else b""
    except (OSError, http.client.HTTPException):
        return None, b""
    finally:
        connection.close()


def own_service(token):
    status, data = request("GET", "/_control/status", token)
    if status != 200 or not token:
        return None
    try:
        result = json.loads(data)
        return result if result.get("app") == APP_ID else None
    except (ValueError, AttributeError):
        return None


def check_dependencies():
    from importlib.metadata import PackageNotFoundError, version

    missing = []
    for name in ("fastapi", "uvicorn", "mlx", "mlx-audio", "misaki",
                 "spacy", "en-core-web-sm", "espeakng-loader", "python-docx",
                 "markdown-it-py", "pysbd", "python-multipart"):
        try:
            version(name)
        except PackageNotFoundError:
            missing.append(name)
    if missing:
        raise RuntimeError("缺少依赖 " + ", ".join(missing) + "。请运行 scripts/install.command。")


def wait_until_ready(token, child=None):
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if child and child.poll() is not None:
            raise RuntimeError(f"服务进程提前退出，请查看 {LOG_FILE}。")
        status = own_service(token)
        if status and status["status"] != "loading":
            return status
        time.sleep(0.35)
    raise RuntimeError(f"等待模型就绪超时，请查看 {LOG_FILE}。")


def start(token, open_browser):
    check_dependencies()
    status = own_service(token)
    child = None
    if not status:
        # This also detects a listener that accepts TCP but does not answer HTTP.
        import socket
        with socket.socket() as probe:
            probe.settimeout(0.5)
            if probe.connect_ex((HOST, PORT)) == 0:
                raise RuntimeError(f"{URL} 已由其他进程占用，请释放端口后重试。")
        token = secrets.token_hex(32)
        fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as file:
            file.write(token)
        print("正在启动 Kokoro 并加载本地模型…", flush=True)
        with LOG_FILE.open("w") as log:
            child = subprocess.Popen(
                [sys.executable, str(ROOT / "scripts" / "serve.py")],
                cwd=ROOT,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                env={**os.environ, "KOKORO_CONTROL_TOKEN": token},
            )
    status = wait_until_ready(token, child)
    if open_browser:
        subprocess.run(["/usr/bin/open", URL], check=True)
    if status["status"] != "ready":
        raise RuntimeError(f"模型加载失败。{status['error']}\n日志位于 {LOG_FILE}")
    print(f"Kokoro 已就绪  {URL}")


def stop(token):
    if not own_service(token):
        print("本项目的服务未运行。")
        return
    code, _ = request("POST", "/_control/stop", token)
    if code != 202:
        raise RuntimeError(f"服务未接受关闭请求，请查看 {LOG_FILE}。")
    print("正在关闭 Kokoro…", flush=True)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if not own_service(token):
            # A graceful shutdown can stop accepting connections before exiting.
            # Wait for the server to release its lifetime lock.
            with (RUNTIME / "server.lock").open("a") as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    pass
                else:
                    TOKEN_FILE.unlink(missing_ok=True)
                    print("Kokoro 已停止。")
                    return
        time.sleep(0.25)
    raise RuntimeError("服务正在等待当前任务结束，请稍后再试。")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["start", "stop"])
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    RUNTIME.mkdir(mode=0o700, exist_ok=True)
    with (RUNTIME / "command.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        token = TOKEN_FILE.read_text().strip() if TOKEN_FILE.is_file() else ""
        if args.action == "start":
            start(token, open_browser=not args.no_browser)
        else:
            stop(token)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"Kokoro  ·  {exc}", file=sys.stderr)
        sys.exit(1)
