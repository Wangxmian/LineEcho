import io
import logging
import textwrap
import wave
from dataclasses import asdict, dataclass
from pathlib import Path

from .english_text import SPEAKABLE

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "models" / "Kokoro-82M-bf16"
MODEL_ID = "mlx-community/Kokoro-82M-bf16"
MAX_CHARACTERS = 12_000
DEFAULT_VOICE = "af_heart"
LOGGER = logging.getLogger("uvicorn.error")


@dataclass(frozen=True)
class Voice:
    id: str
    label: str
    lang_code: str
    accent: str
    gender: str


VOICES = (
    Voice("af_heart", "美式女声 Heart", "a", "美式", "女声"),
    Voice("af_bella", "美式女声 Bella", "a", "美式", "女声"),
    Voice("af_nova", "美式女声 Nova", "a", "美式", "女声"),
    Voice("am_adam", "美式男声 Adam", "a", "美式", "男声"),
    Voice("am_echo", "美式男声 Echo", "a", "美式", "男声"),
    Voice("bf_emma", "英式女声 Emma", "b", "英式", "女声"),
    Voice("bm_george", "英式男声 George", "b", "英式", "男声"),
)


class TTSEngine:
    """Created and used on the server's single inference thread."""

    def __init__(self):
        import espeakng_loader
        import mlx.core as mx
        import numpy as np
        import spacy
        from mlx_audio.tts.models.kokoro.pipeline import KokoroPipeline
        from mlx_audio.tts.utils import load_model
        from phonemizer.backend.espeak.wrapper import EspeakWrapper

        if not spacy.util.is_package("en_core_web_sm"):
            raise RuntimeError("缺少本地 spaCy 英文资源，请运行 scripts/install.command。")
        if not all((MODEL_DIR / name).is_file() for name in (
            "config.json", "kokoro-v1_0.safetensors"
        )):
            raise RuntimeError("缺少本地 Kokoro 权重或配置，请运行 scripts/install.command。")

        EspeakWrapper.set_library(espeakng_loader.get_library_path())
        EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
        device = mx.gpu if mx.metal.is_available() else mx.cpu
        mx.set_default_device(device)
        self.device = "Apple Silicon GPU (Metal)" if device == mx.gpu else "Apple Silicon CPU"
        self.model = load_model(MODEL_DIR)
        self.sample_rate = int(self.model.sample_rate)
        self.pipelines = {}
        self.voices = {}
        self.packs = {}
        self.mx = mx
        self.np = np

        for lang in sorted({voice.lang_code for voice in VOICES}):
            pipeline = KokoroPipeline(
                lang_code=lang, model=self.model, repo_id=MODEL_ID, model_path=MODEL_DIR
            )
            if pipeline.g2p.fallback is None:
                raise RuntimeError("本地 eSpeak 英文发音补全无法加载，请查看服务日志。")
            self.pipelines[lang] = pipeline

        for voice in VOICES:
            path = MODEL_DIR / "voices" / f"{voice.id}.safetensors"
            try:
                if not path.is_file():
                    raise FileNotFoundError(path)
                pack = self.pipelines[voice.lang_code].load_voice(str(path))
                mx.eval(pack)
                if (
                    pack.ndim != 3 or pack.shape[0] < self.model.context_length - 2
                    or pack.shape[1:] != (1, 2 * self.model.config.style_dim)
                    or not mx.all(mx.isfinite(pack)).item()
                ):
                    raise ValueError(f"音色张量无效，维度为 {pack.shape}")
            except Exception:
                LOGGER.warning("音色 %s 无法加载", voice.id, exc_info=True)
                continue
            self.voices[voice.id] = voice
            self.packs[voice.id] = pack

        if not self.voices:
            raise RuntimeError("没有可用的本地英文音色，请运行 scripts/install.command。")
        LOGGER.info("已加载 %s，设备 %s，采样率 %s，可用音色 %s",
                    MODEL_DIR, self.device, self.sample_rate, ", ".join(self.voices))

    def voice_list(self):
        return [asdict(voice) for voice in self.voices.values()]

    def synthesize(self, text: str, voice_id: str, speed: float):
        voice = self.voices[voice_id]
        pipeline = self.pipelines[voice.lang_code]
        pack = self.packs[voice_id]
        max_phonemes = min(self.model.context_length - 2, pack.shape[0])
        output = io.BytesIO()
        segments = 0

        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(self.sample_rate)
            for paragraph in text.splitlines():
                if not SPEAKABLE.search(paragraph):
                    continue
                _, tokens = pipeline.g2p(paragraph.strip())
                first_in_paragraph = True
                for _, phonemes, _ in pipeline.en_tokenize(tokens):
                    # A single token can exceed the model context. Keep the tail
                    # and prefer splitting at whitespace when that happens.
                    parts = [phonemes]
                    if len(phonemes) > max_phonemes:
                        parts = textwrap.wrap(phonemes, width=max_phonemes, break_on_hyphens=False)
                    for part in parts:
                        if not part:
                            continue
                        result = pipeline.infer(self.model, part, pack, speed)
                        samples = self.np.asarray(result.audio.astype(self.mx.float32)).reshape(-1)
                        if not samples.size or not self.np.isfinite(samples).all():
                            raise RuntimeError("模型返回了无效音频。")
                        if segments and first_in_paragraph:
                            wav.writeframesraw(bytes(2 * round(self.sample_rate * 0.16)))
                        pcm = (self.np.clip(samples, -1, 1) * 32767).astype("<i2")
                        wav.writeframesraw(pcm.tobytes())
                        first_in_paragraph = False
                        segments += 1
        if not segments:
            raise ValueError("没有可朗读内容，请输入英文句子或数字。")
        return output.getvalue(), segments
