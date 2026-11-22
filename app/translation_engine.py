import logging
import os
import re
from pathlib import Path

from .english_text import HAN

MODEL_ID = "Helsinki-NLP/opus-mt-en-zh"
MODEL_REVISION = "408d9bc410a388e1d9aef112a2daba955b945255"
MODEL_DIR = Path(__file__).resolve().parents[1] / "models" / "MarianMT-en-zh"
TARGET_TAG = ">>cmn_Hans<<"
MAX_TEXT = 12_000
# Reserve space for the target tag and decoder expansion within Marian's context.
SOURCE_TOKENS = 192
GENERATION = {"num_beams": 3, "do_sample": False, "max_new_tokens": 384}
SENTENCE_END = re.compile(r"""[.!?]['"”’)]*\s+""")
LOGGER = logging.getLogger("uvicorn.error")


class TranslationError(ValueError):
    pass


class MarianEngine:
    def __init__(self):
        if not (MODEL_DIR / "pytorch_model.bin").is_file():
            raise FileNotFoundError("本地 MarianMT 权重未安装。")
        import torch
        from opencc import OpenCC
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

        self.torch = torch
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR, local_files_only=True)
        if TARGET_TAG not in self.tokenizer.supported_language_codes:
            raise TranslationError("本地 Marian 分词器缺少简体中文标记。")
        if self.encode("Hello")[0] != self.tokenizer.convert_tokens_to_ids(TARGET_TAG):
            raise TranslationError("Marian 分词器未正确应用简体中文标记。")
        self.simplify = OpenCC("t2s")
        self.model = AutoModelForSeq2SeqLM.from_pretrained(
            MODEL_DIR, local_files_only=True, use_safetensors=False
        ).eval()
        self.model.generation_config.max_length = None  # Use the explicit decoder token budget.
        self.device = "cpu"
        if torch.backends.mps.is_available():
            try:
                self.model.to("mps")
                self.device = "mps"
            except (RuntimeError, NotImplementedError):
                self.use_cpu()
        # Verify actual decoding before declaring the model ready.
        self.translate("Hello, how are you today?")

    def use_cpu(self):
        LOGGER.warning("MarianMT 无法使用 MPS，正在切换到 CPU。", exc_info=True)
        self.model.to("cpu")
        self.device = "cpu"

    def encode(self, text):
        return self.tokenizer.encode(f"{TARGET_TAG} {text}", verbose=False)

    def chunks(self, text):
        while text:
            ids = self.encode(text)
            if len(ids) <= SOURCE_TOKENS:
                yield ids
                return
            lo, hi = 1, len(text) - 1
            while lo < hi:
                middle = (lo + hi + 1) // 2
                if len(self.encode(text[:middle])) <= SOURCE_TOKENS:
                    lo = middle
                else:
                    hi = middle - 1
            cut = text.rfind(" ", lo // 2, lo + 1)
            sentence_end = max((m.end() for m in SENTENCE_END.finditer(text, lo // 2, lo)), default=0)
            cut = sentence_end or (cut if cut > 0 else lo)
            ids = self.encode(text[:cut].rstrip())
            # SentencePiece can change its final tokenization at a new boundary.
            if len(ids) > SOURCE_TOKENS:
                cut = max(1, cut // 2)
                ids = self.encode(text[:cut].rstrip())
            yield ids
            text = text[cut:].lstrip()

    def generate(self, ids):
        tensor = self.torch.tensor([ids], dtype=self.torch.long, device=self.device)
        with self.torch.inference_mode():
            output = self.model.generate(
                input_ids=tensor, attention_mask=self.torch.ones_like(tensor), **GENERATION
            )
        tokens = output[0].tolist()
        if len(tokens) > GENERATION["max_new_tokens"]:
            raise TranslationError("译文达到模型长度限制，请拆短后重试。")
        return self.tokenizer.decode(tokens, skip_special_tokens=True).strip()

    def translate(self, text):
        pieces = []
        for ids in self.chunks(text):
            try:
                translated = self.generate(ids)
            except (RuntimeError, NotImplementedError):
                if self.device != "mps":
                    raise
                self.use_cpu()
                translated = self.generate(ids)
            if not translated:
                raise TranslationError("模型未生成译文，请重试。")
            pieces.append(translated)
        translation = self.simplify.convert(" ".join(pieces))
        if not HAN.search(translation):
            raise TranslationError("模型没有生成中文译文。")
        return translation
