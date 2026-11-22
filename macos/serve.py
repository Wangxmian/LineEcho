import os
import socket
import sys
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.main import app


@app.middleware("http")
async def restrict_window_resources(request, call_next):
    response = await call_next(request)
    if response.headers.get("content-type", "").startswith("text/html"):
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; connect-src 'self'; img-src 'self' data:; "
            "media-src 'self' blob:; style-src 'self' 'unsafe-inline'; "
            "object-src 'none'; frame-src 'none'; form-action 'self'; base-uri 'none'"
        )
    return response


if __name__ == "__main__":
    port = int(os.environ["KOKORO_DESKTOP_PORT"])
    config = uvicorn.Config(app, host="127.0.0.1", port=port,
                            proxy_headers=False, timeout_graceful_shutdown=8)
    app.state.server = uvicorn.Server(config)
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", port))
        app.state.server.run(sockets=[listener])
