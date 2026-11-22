import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from hmac import compare_digest
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.middleware.trustedhost import TrustedHostMiddleware

os.environ.update(HF_HUB_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", TRANSFORMERS_OFFLINE="1")

from .audio_cache import AudioCache, audio_key
from .documents import DocumentStore, router as documents_router
from .english_text import SPEAKABLE, clean_tts_text
from .tts_engine import DEFAULT_VOICE, MAX_CHARACTERS, MODEL_ID, TTSEngine

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"
DATA = FRONTEND.parent / "data"
LOGGER = logging.getLogger("uvicorn.error")
APP_ID = "kokoro-tts-local"


async def initialize_model(app):
    try:
        app.state.engine = await asyncio.get_running_loop().run_in_executor(
            app.state.inference, TTSEngine
        )
    except Exception as exc:
        LOGGER.exception("Kokoro 初始化失败")
        app.state.load_error = str(exc)


@asynccontextmanager
async def lifespan(app):
    DATA.mkdir(mode=0o700, exist_ok=True)
    app.state.documents = DocumentStore(DATA / "documents")
    app.state.audio_cache = AudioCache(DATA / "audio-cache")
    app.state.engine = None
    app.state.load_error = None
    app.state.inference = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kokoro")
    app.state.generation = asyncio.Lock()
    loader = asyncio.create_task(initialize_model(app))
    try:
        yield
    finally:
        await loader
        app.state.inference.shutdown(wait=True, cancel_futures=True)


app = FastAPI(title="Kokoro English TTS", lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])
app.mount("/assets", StaticFiles(directory=FRONTEND), name="assets")
app.include_router(documents_router)


@app.middleware("http")
async def local_document_writes(request: Request, call_next):
    path = request.url.path.rstrip("/")
    if request.method in {"POST", "PATCH", "DELETE"} and (
        path.startswith("/api/documents") or path == "/api/tts/cache"
    ):
        origin = request.headers.get("origin")
        if origin and origin != f"{request.url.scheme}://{request.url.netloc}":
            return JSONResponse({"detail": "请从本地 Kokoro 阅读器发起操作。"}, status_code=403)
    return await call_next(request)


class TTSRequest(BaseModel):
    text: str
    voice: str = Field(default=DEFAULT_VOICE, max_length=40)
    speed: float = Field(default=1.0, ge=0.7, le=1.3, allow_inf_nan=False, strict=True)

    @field_validator("text")
    @classmethod
    def validate_text(cls, text):
        if len(text) > MAX_CHARACTERS:
            raise ValueError(f"英文文本最多 {MAX_CHARACTERS:,} 个字符。")
        text = clean_tts_text(text)
        if not SPEAKABLE.search(text):
            raise ValueError("请输入包含英文字母或数字的文本。")
        return text


@app.exception_handler(RequestValidationError)
async def input_error(_request, error):
    issue = error.errors()[0]
    field = issue["loc"][-1]
    if _request.url.path.startswith("/api/documents"):
        message = (
            "粘贴文本最多支持 240,000 个字符。"
            if field == "text" and issue["type"] == "string_too_long"
            else "请检查文档名称、内容或阅读位置。"
        )
    elif field == "speed":
        message = "语速必须是 0.7 到 1.3 之间的数字。"
    elif field == "voice":
        message = "请选择可用音色。"
    elif field == "text":
        message = issue["msg"].removeprefix("Value error, ") if issue["type"] == "value_error" else "请输入英文文本。"
    else:
        message = "请求格式有误，请重新生成。"
    return JSONResponse({"detail": message}, status_code=422)


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(FRONTEND / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/tts", include_in_schema=False)
async def full_text():
    return FileResponse(FRONTEND / "tts.html", headers={"Cache-Control": "no-cache"})


@app.get("/api/health")
async def health():
    engine = app.state.engine
    error = app.state.load_error
    return {
        "app": APP_ID,
        "status": "ready" if engine else "error" if error else "loading",
        "model": MODEL_ID,
        "model_loaded": engine is not None,
        "framework": "MLX / MLX-Audio",
        "device": engine.device if engine else None,
        "sample_rate": engine.sample_rate if engine else None,
        "max_characters": MAX_CHARACTERS,
        "offline": True,
        "error": error,
    }


@app.get("/api/voices")
async def voices():
    engine = app.state.engine
    entries = engine.voice_list() if engine else []
    default = DEFAULT_VOICE if engine and DEFAULT_VOICE in engine.voices else (
        entries[0]["id"] if entries else None
    )
    return {"voices": entries, "default": default}


@app.post("/api/tts", response_class=Response, responses={200: {"content": {"audio/wav": {}}}})
async def synthesize(payload: TTSRequest, request: Request):
    engine = app.state.engine
    if not engine:
        raise HTTPException(503, app.state.load_error or "模型正在加载，请稍后再试。")
    if payload.voice not in engine.voices:
        raise HTTPException(422, "该音色不可用，请从音色列表重新选择。")

    cache = app.state.audio_cache
    key = audio_key(payload.text, payload.voice, payload.speed)
    cached = await asyncio.to_thread(cache.lookup, key)
    cache_status = "hit"
    if cached is None:
        async with app.state.generation:
            cached = await asyncio.to_thread(cache.lookup, key)
            if cached is None:
                if await request.is_disconnected():
                    return Response(status_code=499)
                try:
                    cached = await asyncio.get_running_loop().run_in_executor(
                        app.state.inference, engine.synthesize, payload.text, payload.voice, payload.speed
                    )
                    await asyncio.to_thread(cache.save, key, *cached)
                    cache_status = "miss"
                except ValueError as exc:
                    raise HTTPException(422, str(exc)) from exc
                except Exception as exc:
                    LOGGER.exception("Kokoro 合成失败")
                    raise HTTPException(500, "语音生成失败。请重试，或查看 .runtime/server.log。") from exc

    wav, segments = cached
    filename = f"kokoro-{payload.voice}.wav"
    return Response(wav, media_type="audio/wav", headers={
        "Content-Disposition": f'inline; filename="{filename}"',
        "Cache-Control": "no-store",
        "X-Kokoro-Segments": str(segments),
        "X-Kokoro-Cache": cache_status,
    })


@app.delete("/api/tts/cache")
async def clear_cache():
    async with app.state.generation:
        try:
            return {"removed": await asyncio.to_thread(app.state.audio_cache.clear)}
        except OSError as exc:
            LOGGER.exception("清理音频缓存失败")
            raise HTTPException(500, "无法清理音频缓存，请查看服务日志。") from exc


def check_control(request: Request):
    token = os.environ.get("KOKORO_CONTROL_TOKEN")
    presented = request.headers.get("x-kokoro-control", "")
    if not token or not compare_digest(token.encode(), presented.encode()):
        raise HTTPException(404)


@app.get("/_control/status", include_in_schema=False)
async def control_status(request: Request):
    check_control(request)
    return await health()


@app.post("/_control/stop", include_in_schema=False)
async def control_stop(request: Request):
    check_control(request)
    app.state.server.should_exit = True
    return Response(status_code=202)
