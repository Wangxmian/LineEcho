"use strict";

const byId = (id) => document.getElementById(id);
const editor = byId("text");
const voice = byId("voice");
const speed = byId("speed");
const generate = byId("generate");
const player = byId("player");
const result = byId("result");
const feedback = byId("feedback");
const download = byId("download");
const example = editor.defaultValue;
const state = { maxCharacters: 12000, ready: false, busy: false, audioUrl: null };

function updateInput() {
  const length = Array.from(editor.value).length;
  const tooLong = length > state.maxCharacters;
  byId("character-count").textContent =
    `${length.toLocaleString("en-US")} / ${state.maxCharacters.toLocaleString("en-US")} 字符`;
  byId("character-count").dataset.invalid = String(tooLong);
  editor.setAttribute("aria-invalid", String(tooLong));
  generate.disabled = !state.ready || state.busy || tooLong || !editor.value.trim();
}

function showFeedback(message, type = "") {
  feedback.textContent = message;
  feedback.dataset.state = type;
  feedback.hidden = !message;
}

function modelStatus(type, label) {
  byId("model-status").dataset.state = type;
  byId("model-status-text").textContent = label;
}

async function jsonRequest(url) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("本地服务暂时不可用。");
  return response.json();
}

async function checkModel() {
  try {
    const health = await jsonRequest("/api/health");
    state.maxCharacters = health.max_characters;
    if (health.status === "error") {
      modelStatus("error", "模型加载失败");
      showFeedback(health.error || "无法加载模型。请查看服务日志。", "error");
    } else if (health.model_loaded) {
      const data = await jsonRequest("/api/voices");
      if (!data.voices.length) throw new Error("没有可用的本地音色。");
      voice.replaceChildren(...data.voices.map(({ label, id }) => new Option(label, id)));
      voice.value = data.default;
      voice.disabled = false;
      modelStatus("ready", "模型已就绪");
      showFeedback("");
      state.ready = true;
    } else {
      modelStatus("loading", "模型加载中");
      showFeedback("");
    }
  } catch (error) {
    modelStatus("error", "服务未连接");
    showFeedback(`${error.message || "无法连接本地服务。"} 请检查 start.command 是否已运行。`, "error");
  } finally {
    updateInput();
    if (!state.ready) window.setTimeout(checkModel, 1800);
  }
}

function discardAudio() {
  player.pause();
  if (state.audioUrl) {
    player.removeAttribute("src");
    player.load();
    download.removeAttribute("href");
    URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = null;
  }
}

function setBusy(busy) {
  state.busy = busy;
  generate.dataset.busy = String(busy);
  byId("generate-label").textContent = busy ? "Generating…" : "Generate Speech";
  updateInput();
}

function fillEditor(value) {
  editor.value = value;
  editor.focus();
  updateInput();
}

editor.addEventListener("input", updateInput);
byId("example").addEventListener("click", () => fillEditor(example));
byId("clear").addEventListener("click", () => fillEditor(""));
speed.addEventListener("input", () => {
  byId("speed-value").textContent = `${Number(speed.value).toFixed(1)}×`;
});

byId("tts-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.ready || state.busy) return;
  if (Array.from(editor.value).length > state.maxCharacters || !/[A-Za-z0-9]/.test(editor.value)) {
    showFeedback("请输入包含英文字母或数字、且在字数上限内的文本。", "error");
    editor.focus();
    return;
  }

  const payload = { text: editor.value, voice: voice.value, speed: Number(speed.value) };
  const label = voice.selectedOptions[0].textContent;
  player.pause();
  setBusy(true);
  showFeedback("正在生成语音，长文本可能需要更多时间。", "loading");

  try {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(240000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(typeof error.detail === "string" ? error.detail : "本地服务无法生成语音。");
    }
    if (!response.headers.get("content-type")?.startsWith("audio/wav")) {
      throw new Error("服务未返回 WAV 音频。");
    }

    const wav = await response.blob();
    discardAudio();
    state.audioUrl = URL.createObjectURL(wav);
    player.src = state.audioUrl;
    download.href = state.audioUrl;
    download.download = `kokoro-${payload.voice}.wav`;
    byId("result-details").textContent = `${label} · ${payload.speed.toFixed(1)}× · WAV`;
    result.hidden = false;
    showFeedback("语音生成成功。", "success");
    player.play().catch(() => {
      if (player.paused && player.currentSrc === state.audioUrl && !state.busy) {
        showFeedback("语音生成成功。请点击播放器中的播放按钮。", "success");
      }
    });
  } catch (error) {
    const message = error.name === "TimeoutError"
      ? "生成超时。请缩短文本后重试。"
      : (error.name === "TypeError" ? "连接本地服务失败，请检查 start.command。" : error.message);
    showFeedback(`生成失败。 ${message}`, "error");
  } finally {
    setBusy(false);
  }
});

byId("replay").addEventListener("click", () => {
  player.currentTime = 0;
  player.play().catch(() => showFeedback("请点击播放器中的播放按钮。"));
});
player.addEventListener("error", () => {
  if (state.audioUrl) showFeedback("浏览器无法播放这段音频。可以下载 WAV 后打开。", "error");
});
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) discardAudio();
});

updateInput();
checkModel();
