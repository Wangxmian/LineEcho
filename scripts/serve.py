import fcntl
import sys

import uvicorn

from control import HOST, PORT, ROOT, RUNTIME

sys.path.insert(0, str(ROOT))

from app.main import app


if __name__ == "__main__":
    with (RUNTIME / "server.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        server = uvicorn.Server(uvicorn.Config(
            app, host=HOST, port=PORT, proxy_headers=False, timeout_graceful_shutdown=45,
        ))
        app.state.server = server
        server.run()
