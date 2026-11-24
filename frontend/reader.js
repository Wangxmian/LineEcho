"use strict";

const $ = (id) => document.getElementById(id);
const audio = $("audio");
const library = $("library");
const documentSelect = $("documents");
const split = $("split");
const voice = $("voice");
const speed = $("speed");
const generationSpeed = $("generation-speed");
const playerNotice = $("player-notice");
const libraryNotice = $("library-notice");
const pasteDialog = $("paste-dialog");
const readingArea = $("reading-scroll");
const readingContent = $("reading-content");
const download = $("download");
const seek = $("seek");
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TEXT = 240000;
const LAST_DOCUMENT = "kokoro-reader-document";
const pendingSaves = new Map();
let training;
let navigation;
let translation;
let revealedBlock;

const state = {
  documents: [], document: null, units: [], index: -1, highlighted: null, sentenceButtons: [],
  libraryBusy: false, ready: false, mode: "single",
  intent: false, pending: false, epoch: 0, controller: null, url: null,
};

function notice(element, message = "", type = "") {
  element.textContent = message;
  element.dataset.state = type;
  element.hidden = !message;
}

function errorMessage(error) {
  if (error.name === "TimeoutError") return "等待超时，请重试。";
  if (error instanceof TypeError) return "无法连接本地服务，请确认 start.command 已运行。";
  return error.message || "操作失败，请重试。";
}

async function request(path, options = {}, timeout = 15000) {
  const response = await fetch(path, {
    ...options, cache: "no-store",
    signal: options.signal || AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(typeof error.detail === "string" ? error.detail : "本地服务无法完成此操作。");
  }
  return response;
}

async function json(path, method = "GET", data, keepalive = false) {
  const options = { method, keepalive };
  if (data !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(data);
  }
  const response = await request(path, options);
  return response.status === 204 ? null : response.json();
}

function rememberDocument(id) {
  try {
    if (id) localStorage.setItem(LAST_DOCUMENT, id);
    else localStorage.removeItem(LAST_DOCUMENT);
  } catch {
    // Per-document positions are still saved on the server.
  }
}

function rememberedDocument() {
  try { return localStorage.getItem(LAST_DOCUMENT); }
  catch { return null; }
}

function updateLibraryControls() {
  const busy = state.libraryBusy;
  documentSelect.disabled = busy || !state.documents.length;
  $("upload").disabled = busy;
  $("paste-open").disabled = busy;
  $("delete-document").disabled = busy || !state.document;
  split.disabled = busy || !state.document;
  navigation?.setBusy(busy);
}

function renderLibraryList() {
  const items = state.documents.map(({ name, id }) => new Option(name, id));
  documentSelect.replaceChildren(...(items.length ? items : [new Option("没有已导入的文档", "")]));
  documentSelect.value = state.document?.id || "";
  updateLibraryControls();
}

function addMetadata(document) {
  const { blocks, units, ...metadata } = document;
  state.documents = [metadata, ...state.documents.filter((item) => item.id !== document.id)];
  state.documents.sort((left, right) => right.created_at.localeCompare(left.created_at));
}

function formatTime(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function currentMedia() {
  return training?.usesRecording ? training.personal : audio;
}

function updateTimeline() {
  const media = currentMedia();
  const candidate = Number.isFinite(media.duration) ? media.duration :
    (training?.usesRecording ? training.takeLength : 0);
  const duration = media.getAttribute("src") && media.readyState ? candidate : 0;
  const elapsed = duration ? media.currentTime : 0;
  seek.disabled = !duration;
  seek.max = duration || 1;
  seek.value = elapsed;
  seek.style.setProperty("--progress", `${duration ? Math.min(elapsed / duration * 100, 100) : 0}%`);
  seek.setAttribute("aria-valuetext", `${formatTime(elapsed)} / ${formatTime(duration)}`);
  $("elapsed").textContent = formatTime(elapsed);
  $("duration").textContent = formatTime(duration);
}

function standardAvailable() {
  return !!state.document && state.index >= 0 && state.ready && !state.libraryBusy;
}

function updatePlayer() {
  const enabled = standardAvailable();
  const media = currentMedia();
  const playing = !!media.getAttribute("src") && !media.paused && !media.ended;
  const inTraining = !!training?.enabled;
  $("previous").disabled = !enabled || state.index === 0;
  $("next").disabled = !enabled || state.index + 1 >= state.units.length;
  $("training-next").disabled = $("next").disabled || !training?.takeUrl || training.captures;
  $("play").disabled = $("replay").disabled = !enabled || (inTraining && training.captures);
  const canPause = inTraining ? training.pausable : state.intent && (state.pending || playing);
  const loading = state.pending && state.intent;
  const retry = !state.url && playerNotice.dataset.state === "error";
  $("play").toggleAttribute("data-loading", loading);
  const playLabel = inTraining && training.usesRecording ? "播放录音" : "播放标准发音";
  $("play-label").textContent = loading ? "生成中" : canPause ? "暂停" : retry ? "重试" : playLabel;
  $("playing-wave").hidden = !playing;
  $("play-mark").textContent = canPause ? "Ⅱ" : "▶";
  if (loading) $("play").setAttribute("aria-label", "生成中，点击暂停自动播放");
  else $("play").removeAttribute("aria-label");
  if (state.highlighted) state.highlighted.dataset.playing = String(playing);
  training?.render();
}

function updateExpansion() {
  const sentence = $("current-sentence");
  const expanded = sentence.hasAttribute("data-expanded");
  const toggle = $("expand-sentence");
  toggle.hidden = !expanded && sentence.scrollHeight <= sentence.clientHeight + 1;
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.textContent = expanded ? "收起全文" : "展开全文";
}

function revealSentence(button, immediate) {
  const block = button.closest(".reading-block");
  if (block !== revealedBlock) {
    revealedBlock?.removeAttribute("data-reveal");
    block?.setAttribute("data-reveal", "");
    revealedBlock = block;
  }
  const region = readingArea.getBoundingClientRect();
  const chosen = button.getBoundingClientRect();
  if (chosen.top >= region.top + 16 && chosen.bottom <= region.bottom - 18) return;
  const padding = Math.min(70, region.height * 0.27);
  const delta = chosen.top - region.top - padding;
  const motion = !immediate && Math.abs(delta) < 1.7 * region.height &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches;
  readingArea.scrollTo({ top: readingArea.scrollTop + delta, behavior: motion ? "smooth" : "instant" });
}

function roleStyle(label) {
  const role = label.toLowerCase().trim();
  if (/^answer(?:\s+\d+)?$/.test(role)) return "answer";
  if (/^(?:alternate )?question(?:\s+\d+)?$/.test(role)) return "question";
  return /^speaker\s+2$/.test(role) ? "speaker-2" : "speaker";
}

function showSelection(scroll, { focus = false, immediate = false } = {}) {
  const unit = state.units[state.index];
  const selected = state.sentenceButtons[state.index] || null;
  if (state.highlighted && state.highlighted !== selected) {
    state.highlighted.removeAttribute("aria-current");
    delete state.highlighted.dataset.playing;
  }
  if (state.highlighted !== selected || $("current-sentence").textContent === "") {
    const sentence = $("current-sentence");
    sentence.textContent = unit?.speech || "选择要朗读的英文句子。";
    sentence.lang = unit ? "en" : "zh-CN";
    sentence.toggleAttribute("data-placeholder", !unit);
    sentence.removeAttribute("data-expanded");
    $("current-number").hidden = !unit?.number;
    $("current-number").textContent = unit?.number || "";
    $("current-role").hidden = !unit?.role;
    $("current-role").textContent = unit?.role || "";
    $("current-role").dataset.role = roleStyle(unit?.role || "");
    const wordCount = unit?.speech.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length || 0;
    $("word-count").hidden = !wordCount;
    $("word-count").textContent = wordCount ? `${wordCount} 词` : "";
    $("position").textContent = unit ? `第 ${state.index + 1} / ${state.units.length} 句` : "尚未选句";
    updateExpansion();
    translation.select(unit?.speech);
  }
  state.highlighted = selected;
  navigation?.selectOutline(state.index);
  if (selected) {
    selected.setAttribute("aria-current", "true");
    if (focus) selected.focus({ preventScroll: true });
    if (scroll) revealSentence(selected, immediate);
  }
  updatePlayer();
}

function renderReading() {
  const active = state.document;
  readingContent.replaceChildren();
  state.sentenceButtons = [];
  revealedBlock = null;
  readingContent.toggleAttribute("data-long", state.units.length >= 180);
  $("empty").hidden = !!active;
  $("paper").hidden = !active;
  $("document-name").textContent = active?.name || "文档阅读";
  $("document-name").title = active?.name || "";
  $("unit-count").hidden = !active;
  $("mask-answers").hidden = !state.units.some((unit) =>
    roleStyle(unit.role) === "answer" || unit.parts.some(({ label }) => roleStyle(label) === "answer"));
  if (!active) return;
  $("unit-count").textContent = `${state.units.length.toLocaleString("en-US")} 句`;
  split.value = active.mode;
  $("no-english").hidden = !!state.units.length;
  const unitsByBlock = new Map();
  for (const [index, unit] of state.units.entries()) {
    const items = unitsByBlock.get(unit.paragraph_index) || [];
    items.push({ index, unit });
    unitsByBlock.set(unit.paragraph_index, items);
  }

  const fragment = document.createDocumentFragment();
  let lastRow = null;
  let row = null;
  active.blocks.forEach((block, index) => {
    const items = unitsByBlock.get(index);
    if (!items?.length) return;
    const tag = block.kind === "heading" ? `h${Math.min(6, Math.max(2, block.level + 1))}` : "div";
    let element = document.createElement(tag);
    element.className = `reading-block ${block.kind}`;
    element.dataset.level = block.level;
    if (block.kind === "list") {
      element.style.paddingInlineStart = `${Math.min(block.level, 5) * 19 + 8}px`;
      if (block.marker) {
        const marker = document.createElement("span");
        marker.className = "list-marker";
        marker.style.insetInlineStart = `${(Math.min(block.level, 5) - 1) * 19}px`;
        marker.setAttribute("aria-hidden", "true");
        marker.textContent = block.marker;
        element.append(marker);
      }
    }

    const content = Array.from(block.text);
    let offset = null;
    for (const [localIndex, { index: position, unit }] of items.entries()) {
      if (offset !== null && unit.start > offset) {
        const sourceGap = content.slice(offset, unit.start).join("");
        let gap = /^\s+$/.test(sourceGap) ? sourceGap : (sourceGap.includes("\n") ? "\n" : " ");
        if (block.kind === "paragraph" && items.length > 96 && localIndex % 48 === 0 && gap.includes("\n")) {
          element.classList.add("continued");
          fragment.append(element);
          element = document.createElement("div");
          element.className = "reading-block paragraph";
          gap = gap.replace(/^[^\S\n]*\n/, "");
        }
        if (gap) element.append(gap);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sentence";
      button.dataset.index = position;
      button.dataset.unitId = unit.id;
      unit.parts.forEach(({ text, label, number }, line) => {
        if (line) button.append("\n");
        if (number) {
          const badge = document.createElement("span");
          badge.className = "role-label exercise-number";
          badge.textContent = number;
          button.append(badge, " ");
        }
        if (label) {
          const badge = document.createElement("span");
          badge.className = "role-label";
          badge.textContent = label;
          badge.dataset.role = roleStyle(label);
          button.append(badge, " ");
        }
        if (roleStyle(label || (line === 0 ? unit.role : "")) === "answer") {
          const answer = document.createElement("span");
          answer.className = "answer-text";
          answer.textContent = text;
          button.append(answer);
        } else {
          button.append(text);
        }
      });
      element.append(button);
      state.sentenceButtons[position] = button;
      offset = unit.end;
    }

    if (block.row !== null) {
      if (row === null || lastRow !== block.row) {
        row = document.createElement("div");
        row.className = "reading-table-row";
        fragment.append(row);
      }
      row.append(element);
    } else {
      fragment.append(element);
      row = null;
    }
    lastRow = block.row;
  });
  readingContent.append(fragment);
}

function stopStandard() {
  state.epoch++;
  state.intent = false;
  state.pending = false;
  state.controller?.abort();
  state.controller = null;
  audio.pause();
}

function resetAudio({ keepTake = false } = {}) {
  if (training) training.cancel({ discardTake: !keepTake });
  else stopStandard();
  if (state.url) {
    const previous = state.url;
    state.url = null;
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(previous);
  }
  download.removeAttribute("href");
  download.setAttribute("aria-disabled", "true");
  notice(playerNotice);
  updateTimeline();
  updatePlayer();
}

function presentDocument(document) {
  resetAudio();
  const isNewDocument = document?.id !== state.document?.id;
  state.document = document;
  state.units = prepareReadingUnits(document);
  state.index = state.units.findIndex(({ id }) => id === document?.unit_id);
  if (state.index < 0 && state.units.length) {
    const original = document.units.find(({ id }) => id === document.unit_id);
    state.index = original ? state.units.findIndex((unit) => unit.paragraph_index > original.paragraph_index ||
      (unit.paragraph_index === original.paragraph_index && unit.start >= original.start)) : 0;
    if (state.index < 0) state.index = state.units.length - 1;
  }
  if (document) addMetadata(document);
  rememberDocument(document?.id);
  renderLibraryList();
  renderReading();
  navigation.setContent(document?.blocks || [], state.units, state.sentenceButtons, isNewDocument);
  readingArea.scrollTop = 0;
  $("current-sentence").textContent = "";
  showSelection(true, { immediate: true });
}

async function libraryAction(callback) {
  if (state.libraryBusy) return;
  state.libraryBusy = true;
  updateLibraryControls();
  updatePlayer();
  try {
    await callback();
  } finally {
    state.libraryBusy = false;
    updateLibraryControls();
    updatePlayer();
  }
}

function savePosition(document, unit) {
  let entry = pendingSaves.get(document.id);
  if (entry) {
    entry.next = unit.id;
    return;
  }
  entry = { next: unit.id, promise: null };
  pendingSaves.set(document.id, entry);
  entry.promise = (async () => {
    while (entry.next) {
      const unitId = entry.next;
      entry.next = null;
      try {
        await json(`/api/documents/${document.id}`, "PATCH", { unit_id: unitId }, true);
      } catch (error) {
        if (!entry.next && state.document?.id === document.id) {
          notice(libraryNotice, `阅读位置保存失败。 ${errorMessage(error)}`, "error");
        }
      }
    }
    pendingSaves.delete(document.id);
  })();
}

async function openDocument(id) {
  resetAudio();
  notice(libraryNotice);
  try {
    await pendingSaves.get(id)?.promise;
    presentDocument(await json(`/api/documents/${id}`));
  } catch (error) {
    renderLibraryList();
    notice(libraryNotice, errorMessage(error), "error");
  }
}

async function initializeLibrary() {
  await libraryAction(async () => {
    try {
      const { documents } = await json("/api/documents");
      state.documents = documents;
      renderLibraryList();
      const remembered = rememberedDocument();
      const first = documents.find(({ id }) => id === remembered) || documents[0];
      if (first) await openDocument(first.id);
    } catch (error) {
      notice(libraryNotice, errorMessage(error), "error");
    }
  });
}

async function checkModel() {
  try {
    const model = await json("/api/health");
    if (model.status === "error") throw new Error("模型加载失败。请查看本地服务日志。");
    if (model.model_loaded) {
      const voices = await json("/api/voices");
      if (!voices.voices.length) throw new Error("没有可用的本地音色。");
      voice.replaceChildren(...voices.voices.map(({ id, label }) => new Option(label, id)));
      voice.value = voices.default;
      voice.disabled = false;
      updateVoicePreview();
      state.ready = true;
      $("model-status").dataset.state = "ready";
      $("model-label").textContent = "模型已就绪";
      notice(playerNotice);
    } else {
      $("model-status").dataset.state = "loading";
      $("model-label").textContent = "模型加载中";
      notice(playerNotice);
    }
  } catch (error) {
    $("model-status").dataset.state = "error";
    $("model-label").textContent = "模型不可用";
    notice(playerNotice, errorMessage(error), "error");
  } finally {
    updatePlayer();
    if (!state.ready) setTimeout(checkModel, 1800);
  }
}

async function playMedia(epoch) {
  try {
    await audio.play();
    return state.epoch === epoch && state.intent;
  } catch (error) {
    if (state.epoch === epoch && state.intent && error.name !== "AbortError") {
      state.intent = false;
      notice(playerNotice, "音频已就绪，请点击播放。");
    }
    return false;
  } finally {
    if (state.epoch === epoch) updatePlayer();
  }
}

async function startAudio(rewind = false) {
  const unit = state.units[state.index];
  if (!unit || !state.ready || state.libraryBusy) return;
  state.intent = true;
  if (state.url) {
    if (rewind || audio.ended) audio.currentTime = 0;
    notice(playerNotice);
    return playMedia(state.epoch);
  }
  if (state.pending) {
    updatePlayer();
    return;
  }

  const epoch = state.epoch;
  const selectedVoice = voice.value;
  const generation = new AbortController();
  state.controller = generation;
  state.pending = true;
  updatePlayer();
  notice(playerNotice, "正在准备语音…");

  try {
    const response = await request("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: unit.speech, voice: selectedVoice, speed: Number(generationSpeed.value) }),
      signal: AbortSignal.any([generation.signal, AbortSignal.timeout(240000)]),
    });
    if (!response.headers.get("content-type")?.startsWith("audio/wav")) {
      throw new Error("本地服务未返回 WAV 音频。");
    }
    const blob = await response.blob();
    if (state.epoch !== epoch) return;
    state.url = URL.createObjectURL(blob);
    audio.src = state.url;
    applyPlaybackRate();
    download.href = state.url;
    download.download = `kokoro-${selectedVoice}-${state.index + 1}.wav`;
    download.removeAttribute("aria-disabled");
    const cached = response.headers.get("X-Kokoro-Cache") === "hit";
    notice(playerNotice, cached ? "已读取本地音频缓存。" : "语音已生成。", "success");
    if (state.intent) return await playMedia(epoch);
  } catch (error) {
    if (state.epoch !== epoch) return;
    state.intent = false;
    notice(playerNotice, `生成失败。 ${errorMessage(error)}`, "error");
  } finally {
    if (state.epoch === epoch) {
      state.pending = false;
      state.controller = null;
      updatePlayer();
    }
  }
}

function chooseSentence(index, autoplay, focus = false) {
  const document = state.document;
  if (!document || state.libraryBusy || index < 0 || index >= state.units.length) return;
  if (index !== state.index) {
    resetAudio();
    state.index = index;
    document.unit_id = state.units[index].id;
    savePosition(document, state.units[index]);
  }
  showSelection(true, { focus });
  if (autoplay && state.ready) replayCurrent();
}

function replayCurrent() {
  if (training?.enabled) training.listenA();
  else void startAudio(true);
}

function togglePlayback() {
  if (training?.enabled) {
    training.toggle();
    return;
  }
  if (!state.intent || (!state.pending && audio.paused)) {
    void startAudio();
  } else {
    state.intent = false;
    audio.pause();
    if (state.pending) notice(playerNotice, "已暂停自动播放，音频准备好后可手动播放。");
    updatePlayer();
  }
}

async function importFile(file) {
  await libraryAction(async () => {
    if (/\.doc$/i.test(file.name)) {
      notice(libraryNotice, "旧版 .doc 请在 Word 中另存为 .docx 后再导入。", "error");
      return;
    }
    if (!/\.(docx|md|markdown|txt)$/i.test(file.name)) {
      notice(libraryNotice, "请选择 .docx、.md、.markdown 或 .txt 文件。", "error");
      return;
    }
    if (file.size > MAX_FILE) {
      notice(libraryNotice, "文件超过 8 MB，请拆分后再导入。", "error");
      return;
    }
    resetAudio();
    notice(libraryNotice, "正在读取文档…");
    const form = new FormData();
    form.append("file", file);
    try {
      const response = await request("/api/documents/upload", { method: "POST", body: form }, 45000);
      presentDocument(await response.json());
      notice(libraryNotice);
    } catch (error) {
      notice(libraryNotice, errorMessage(error), "error");
    }
  });
}

$("upload").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (file) void importFile(file);
});
window.addEventListener("dragover", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  library.dataset.drop = String(library.contains(event.target) && !state.libraryBusy);
});
window.addEventListener("dragleave", (event) => {
  if (!library.contains(event.relatedTarget)) delete library.dataset.drop;
});
window.addEventListener("drop", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  delete library.dataset.drop;
  if (!library.contains(event.target) || state.libraryBusy) return;
  const files = event.dataTransfer.files;
  if (files.length === 1) void importFile(files[0]);
  else notice(libraryNotice, "请每次拖入一个文件。", "error");
});

$("paste-open").addEventListener("click", () => {
  notice($("paste-notice"));
  pasteDialog.showModal();
  $("paste-text").focus();
});
$("paste-cancel").addEventListener("click", () => pasteDialog.close());
$("paste-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("paste-name").value.trim() || "粘贴文本";
  const text = $("paste-text").value;
  if (!text.trim() || Array.from(text).length > MAX_TEXT) {
    notice($("paste-notice"), "请输入英文正文，最多 240,000 个字符。", "error");
    return;
  }
  void libraryAction(async () => {
    resetAudio();
    $("paste-submit").disabled = true;
    notice($("paste-notice"), "正在整理朗读单元…");
    try {
      presentDocument(await json("/api/documents/text", "POST", { name, text }));
      notice(libraryNotice);
      pasteDialog.close();
      $("paste-form").reset();
    } catch (error) {
      notice($("paste-notice"), errorMessage(error), "error");
    } finally {
      $("paste-submit").disabled = false;
    }
  });
});

documentSelect.addEventListener("change", () => {
  const id = documentSelect.value;
  if (id && id !== state.document?.id) void libraryAction(() => openDocument(id));
});
split.addEventListener("change", () => {
  const document = state.document;
  const mode = split.value;
  $("document-options").open = false;
  if (!document || document.mode === mode) return;
  void libraryAction(async () => {
    resetAudio();
    notice(libraryNotice);
    try {
      await pendingSaves.get(document.id)?.promise;
      presentDocument(await json(`/api/documents/${document.id}`, "PATCH", { mode }));
    } catch (error) {
      split.value = document.mode;
      notice(libraryNotice, errorMessage(error), "error");
    }
  });
});
$("delete-document").addEventListener("click", () => {
  const document = state.document;
  $("document-options").open = false;
  if (!document || !window.confirm(`移除文档库中的「${document.name}」？`)) return;
  void libraryAction(async () => {
    resetAudio();
    notice(libraryNotice);
    try {
      await pendingSaves.get(document.id)?.promise;
      await json(`/api/documents/${document.id}`, "DELETE");
      state.documents = state.documents.filter(({ id }) => id !== document.id);
      presentDocument(null);
      if (state.documents.length) await openDocument(state.documents[0].id);
    } catch (error) {
      notice(libraryNotice, errorMessage(error), "error");
    }
  });
});

readingContent.addEventListener("click", (event) => {
  const sentence = event.target.closest("button.sentence");
  if (sentence) chooseSentence(Number(sentence.dataset.index), true);
});
$("previous").addEventListener("click", () => chooseSentence(state.index - 1, true));
for (const id of ["next", "training-next"]) {
  $(id).addEventListener("click", () => chooseSentence(state.index + 1, true));
}
$("play").addEventListener("click", togglePlayback);
$("replay").addEventListener("click", replayCurrent);
function updateVoicePreview() {
  $("voice-preview").textContent = voice.disabled ? "" : voice.selectedOptions[0]?.textContent || "";
}

function rateLabel(rate) {
  return `${rate.toFixed(2).replace(/0$/, "")}×`;
}

function applyPlaybackRate() {
  const rate = Number(speed.value);
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;
  $("speed-value").textContent = rateLabel(rate);
  for (const button of $("speed-presets").querySelectorAll("button[data-rate]")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.rate) === rate));
  }
}

voice.addEventListener("change", () => {
  updateVoicePreview();
  resetAudio({ keepTake: true });
});
speed.addEventListener("input", applyPlaybackRate);
audio.addEventListener("loadedmetadata", applyPlaybackRate);
$("speed-presets").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-rate]");
  if (!button) return;
  speed.value = button.dataset.rate;
  applyPlaybackRate();
});
generationSpeed.addEventListener("input", () => {
  $("generation-speed-value").textContent = rateLabel(Number(generationSpeed.value));
  if (state.pending || state.url || training?.op) resetAudio({ keepTake: true });
});
$("training-slow").addEventListener("click", () => {
  if (!training.enabled || training.captures || !standardAvailable()) return;
  speed.value = "0.75";
  applyPlaybackRate();
  training.listenA();
});

$("mask-answers").addEventListener("click", () => {
  const masking = readingContent.toggleAttribute("data-mask");
  $("mask-answers").setAttribute("aria-pressed", String(masking));
  $("mask-answers").textContent = masking ? "显示答案" : "遮罩答案";
});

$("reading-font").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-size]");
  if (!button) return;
  readingArea.dataset.size = button.dataset.size;
  for (const preset of $("reading-font").children) {
    preset.setAttribute("aria-pressed", String(preset === button));
  }
  requestAnimationFrame(() => {
    if (state.highlighted?.isConnected) revealSentence(state.highlighted, true);
  });
});

$("expand-sentence").addEventListener("click", () => {
  $("current-sentence").toggleAttribute("data-expanded");
  updateExpansion();
});
new ResizeObserver(updateExpansion).observe($("current-sentence"));
let readingWidth = readingArea.clientWidth;
let readingResizeFrame;
new ResizeObserver(() => {
  const width = readingArea.clientWidth;
  if (width === readingWidth) return;
  readingWidth = width;
  cancelAnimationFrame(readingResizeFrame);
  const selected = state.highlighted;
  if (!selected) return;
  const align = () => {
    if (selected === state.highlighted && selected.isConnected) revealSentence(selected, true);
  };
  readingResizeFrame = requestAnimationFrame(() => {
    align();
    // Offscreen paragraphs take one frame to adopt their new wrapped heights.
    readingResizeFrame = requestAnimationFrame(align);
  });
}).observe(readingArea);
document.addEventListener("pointerdown", (event) => {
  const menu = $("document-options");
  if (menu.open && !menu.contains(event.target)) menu.open = false;
});
$("document-options").addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  $("document-options").open = false;
  $("document-options").querySelector("summary").focus();
});

for (const mode of document.querySelectorAll('input[name="play-mode"]')) {
  mode.addEventListener("change", () => { state.mode = mode.value; });
}

seek.addEventListener("input", () => {
  if (!seek.disabled) currentMedia().currentTime = Number(seek.value);
});
for (const event of ["timeupdate", "loadedmetadata", "durationchange", "seeked"]) {
  audio.addEventListener(event, updateTimeline);
}
for (const event of ["play", "playing", "pause"]) audio.addEventListener(event, updatePlayer);
audio.addEventListener("ended", () => {
  if (training?.enabled) {
    state.intent = false;
    if (audio.ended) training.standardEnded();
    updatePlayer();
    return;
  }
  if (state.url && state.intent && audio.ended) {
    if (state.mode === "loop") {
      void startAudio(true);
      return;
    }
    if (state.mode === "continuous" && state.index + 1 < state.units.length) {
      chooseSentence(state.index + 1, true);
      return;
    }
    state.intent = false;
  }
  updatePlayer();
});
audio.addEventListener("error", () => {
  if (!state.url || !audio.error) return;
  state.intent = false;
  notice(playerNotice, "浏览器无法播放此音频。可下载 WAV 后打开。", "error");
  training?.standardError();
  updatePlayer();
});
$("clear-cache").addEventListener("click", async () => {
  if (!window.confirm("清理 Kokoro 的本地音频缓存？文档和阅读位置会保留。")) return;
  $("clear-cache").disabled = true;
  try {
    const { removed } = await json("/api/tts/cache", "DELETE");
    notice(playerNotice, `已清理 ${removed} 个缓存音频。`, "success");
  } catch (error) {
    notice(playerNotice, errorMessage(error), "error");
  } finally {
    $("clear-cache").disabled = false;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey ||
      pasteDialog.open || event.target.closest?.("input, textarea, select, summary, [role=tab], [contenteditable]")) return;
  if (event.key.toLowerCase() === "b") {
    event.preventDefault();
    navigation.toggleOutline();
    return;
  }
  if (!state.document || !state.ready || state.libraryBusy) return;
  if (event.key === " " && event.target.closest?.("button:not(.sentence):not(#play), a")) return;
  const shortcuts = {
    " ": togglePlayback,
    ArrowLeft: () => chooseSentence(state.index - 1, true),
    ArrowRight: () => chooseSentence(state.index + 1, true),
    r: replayCurrent,
  };
  const action = shortcuts[event.key === "R" ? "r" : event.key];
  if (action) {
    event.preventDefault();
    action();
  }
});
window.addEventListener("pagehide", () => resetAudio());

navigation = new DocumentNavigation((index, focus) => chooseSentence(index, false, focus));
translation = new SentenceTranslation();
training = new ShadowTraining({
  available: standardAvailable,
  playStandard: startAudio,
  stopStandard,
  changed: () => {
    updateTimeline();
    updatePlayer();
  },
});
updatePlayer();
showSelection(false);
void initializeLibrary();
void checkModel();
