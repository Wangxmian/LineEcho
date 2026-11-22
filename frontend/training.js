"use strict";

const RECORD_LIMIT_MS = 60000;
const COMPARISON_GAP_MS = 450;
const MIC_TIMEOUT_MS = 30000;
const RECORD_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];

function microphoneMessage(error) {
  switch (error.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "麦克风权限被拒绝。请在浏览器的网站权限及 macOS 麦克风设置中允许访问后重试。";
    case "NotFoundError": return "找不到麦克风。请连接或选择一个录音设备后重试。";
    case "NotReadableError": return "无法访问麦克风。请检查设备连接或关闭占用麦克风的应用。";
    default: return "无法开始录音。请检查设备或换用支持录音的浏览器。";
  }
}

function stopTracks(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function makeRecorder(stream) {
  for (const mimeType of RECORD_TYPES) {
    if (!MediaRecorder.isTypeSupported?.(mimeType)) continue;
    try { return new MediaRecorder(stream, { mimeType }); }
    catch { /* Another supported container or the browser default may work. */ }
  }
  return new MediaRecorder(stream);
}

function recordingExtension(type) {
  if (type.includes("mp4")) return "m4a";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("wav")) return "wav";
  if (type.includes("webm")) return "webm";
  return "audio";
}

class ShadowTraining {
  constructor(hooks) {
    this.hooks = hooks;
    this.enabled = false;
    this.op = null;
    this.takeUrl = null;
    this.takeLength = 0;
    this.media = "a";
    this.personal = $("training-audio");
    $("reader-normal").addEventListener("click", () => this.setEnabled(false));
    $("reader-training").addEventListener("click", () => this.setEnabled(true));
    $("reader-training").parentElement.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const enabled = event.key === "End" || (event.key !== "Home" && !this.enabled);
      this.setEnabled(enabled);
      $(enabled ? "reader-training" : "reader-normal").focus();
    });
    $("training-toggle").addEventListener("click", () => this.toggle());
    $("training-style").addEventListener("change", () => this.cancel());
    $("training-a").addEventListener("click", () => this.listenA());
    $("training-start").addEventListener("click", () => this.start());
    $("training-retake").addEventListener("click", () => this.start());
    $("training-finish").addEventListener("click", () => this.finishRecording());
    $("training-b").addEventListener("click", () => this.listenB());
    $("training-compare").addEventListener("click", () => this.compare());
    $("training-stop").addEventListener("click", () => this.cancel());

    for (const event of ["timeupdate", "loadedmetadata", "durationchange", "play", "pause", "seeked"]) {
      this.personal.addEventListener(event, () => this.hooks.changed());
    }
    this.personal.addEventListener("ended", () => this.personalEnded());
    this.personal.addEventListener("error", () => {
      if (this.op?.phase === "personal" && this.personal.error) {
        this.fail("浏览器无法播放这份录音。可以下载录音后用本地播放器打开。");
      }
    });
  }

  get phase() { return this.op?.phase || "idle"; }
  get automatic() { return $("training-style").value === "auto"; }
  get captures() { return ["permission", "recording", "finishing"].includes(this.phase); }
  get pausable() { return ["standard", "personal", "gap", "preparing"].includes(this.phase); }
  get usesRecording() { return this.enabled && this.media === "b" && !!this.takeUrl; }

  setEnabled(enabled) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.cancel();
    $("reader-normal").setAttribute("aria-selected", String(!enabled));
    $("reader-training").setAttribute("aria-selected", String(enabled));
    $("reader-normal").tabIndex = enabled ? -1 : 0;
    $("reader-training").tabIndex = enabled ? 0 : -1;
    $("training-panel").hidden = !enabled;
    $("normal-panel").hidden = enabled;
    $(enabled ? "training-timeline-slot" : "normal-timeline-slot").append($("timeline"));
    this.hooks.changed();
  }

  render() {
    const haveUnit = this.hooks.available();
    const haveTake = !!this.takeUrl;
    const phase = this.phase;
    $("training-panel").dataset.phase = phase;
    $("training-delay-field").hidden = !this.automatic;
    $("training-start").textContent = this.automatic ? "开始跟读" : "开始录音";
    $("training-style").disabled = this.captures;
    $("training-delay").disabled = phase !== "idle";
    $("training-a").disabled = !haveUnit || this.captures;
    $("training-start").disabled = !haveUnit || this.captures;
    $("training-start").hidden = phase === "recording";
    $("training-finish").hidden = phase !== "recording";
    $("recording-indicator").hidden = phase !== "recording";
    $("training-b").disabled = !haveTake || this.captures;
    $("training-compare").disabled = !haveUnit || !haveTake || this.captures;
    $("training-retake").disabled = !haveUnit || !haveTake || this.captures;
    $("training-session").hidden = phase === "idle";
    $("training-toggle").hidden = !this.pausable && phase !== "paused";
    $("training-toggle").textContent = phase === "paused" ? "继续播放" : "暂停";
    $("training-stop").hidden = phase === "idle";
    const mic = $("mic-state");
    mic.dataset.state = phase;
    mic.textContent = phase === "recording" ? "麦克风已启用" :
      phase === "permission" ? "等待麦克风许可" : "麦克风未启用";
    $("training-download").hidden = !haveTake || this.captures;
  }

  message(message = "", type = "") {
    notice($("training-notice"), message, type);
  }

  setPhase(op, phase, message) {
    if (this.op !== op) return;
    op.phase = phase;
    if (message !== undefined) this.message(message);
    this.hooks.changed();
  }

  clearTiming(op) {
    if (!op) return;
    clearTimeout(op.timer);
    clearInterval(op.ticker);
  }

  cancel({ discardTake = false, keepNotice = false } = {}) {
    const op = this.op;
    this.op = null;
    this.clearTiming(op);
    this.personal.pause();
    this.hooks.stopStandard();
    try {
      if (op?.recorder && op.recorder.state !== "inactive") op.recorder.stop();
    } catch {
      // Track shutdown still releases the device if the recorder already closed.
    } finally {
      stopTracks(op?.stream);
    }
    if (discardTake) this.discardTake();
    this.media = "a";
    if (!keepNotice) this.message();
    this.hooks.changed();
  }

  discardTake() {
    if (!this.takeUrl) return;
    const url = this.takeUrl;
    this.takeUrl = null;
    this.takeLength = 0;
    this.personal.pause();
    this.personal.removeAttribute("src");
    this.personal.load();
    $("training-download").removeAttribute("href");
    URL.revokeObjectURL(url);
  }

  begin(kind) {
    this.cancel();
    if (!this.enabled || !this.hooks.available()) return null;
    this.op = { kind, phase: "idle" };
    return this.op;
  }

  async playA(op, rewind) {
    const attempt = Symbol();
    op.attempt = attempt;
    this.media = "a";
    this.personal.pause();
    this.setPhase(op, "standard", op.kind === "compare" ? "A · 标准发音" : "正在播放标准发音。");
    const played = await this.hooks.playStandard(rewind);
    if (!played && this.op === op && op.attempt === attempt && op.phase === "standard") {
      this.fail("标准发音未能播放。请查看播放器提示后重试。");
    }
  }

  listenA() {
    if (this.captures) return;
    const op = this.begin("a");
    if (op) void this.playA(op, true);
  }

  async playB(op, rewind) {
    if (this.op !== op || !this.takeUrl) return;
    const attempt = Symbol();
    op.attempt = attempt;
    this.hooks.stopStandard();
    this.media = "b";
    if (rewind || this.personal.ended) this.personal.currentTime = 0;
    this.setPhase(op, "personal", op.kind === "compare" ? "B · 我的录音" : "正在播放我的录音。");
    try {
      await this.personal.play();
    } catch (error) {
      if (this.op === op && op.attempt === attempt && op.phase === "personal" && error.name !== "AbortError") {
        this.finish("录音已就绪。请点击「播放我的录音」。");
      }
    }
  }

  listenB() {
    if (!this.takeUrl || this.captures) return;
    const op = this.begin("b");
    if (op) void this.playB(op, true);
  }

  compare() {
    if (!this.takeUrl || this.captures) return;
    const op = this.begin("compare");
    if (op) void this.playA(op, true);
  }

  standardEnded() {
    const op = this.op;
    if (op?.phase !== "standard") return;
    if (op.kind === "compare") {
      this.wait(op, "gap", COMPARISON_GAP_MS, () => void this.playB(op, true));
    } else if (op.kind === "auto") {
      this.wait(op, "preparing", Number($("training-delay").value) * 1000,
        () => void this.authorize(op, (stream) => this.record(op, stream)));
    } else {
      this.finish("标准发音已播放。");
    }
  }

  standardError() {
    if (this.op?.phase === "standard") this.fail("标准音频无法播放，请重试。");
  }

  personalEnded() {
    if (this.op?.phase === "personal" && this.personal.ended) {
      this.finish(this.op.kind === "compare" ? "A/B 对比已结束。" : "可以重新录音或切换到下一句。");
    }
  }

  wait(op, phase, duration, next) {
    if (this.op !== op) return;
    this.clearTiming(op);
    op.deadline = performance.now() + duration;
    op.next = next;
    this.setPhase(op, phase);
    const tick = () => {
      if (this.op !== op || op.phase !== phase) return;
      const seconds = Math.max(0, Math.ceil((op.deadline - performance.now()) / 1000));
      this.message(phase === "gap" ? "即将播放 B · 我的录音" : `准备跟读 · ${seconds} 秒`);
    };
    tick();
    op.ticker = setInterval(tick, 100);
    op.timer = setTimeout(() => {
      if (this.op !== op || op.phase !== phase) return;
      this.clearTiming(op);
      next();
    }, duration);
  }

  toggle() {
    if (this.captures) return;
    const op = this.op;
    if (!op) {
      if (this.usesRecording) this.listenB();
      else this.listenA();
      return;
    }
    if (op.phase === "paused") {
      const { phase, remaining, next } = op.pause;
      if (phase === "standard") void this.playA(op, false);
      else if (phase === "personal") void this.playB(op, false);
      else this.wait(op, phase, remaining, next);
    } else if (this.pausable) {
      op.attempt = null;
      op.pause = {
        phase: op.phase, remaining: Math.max(0, (op.deadline || 0) - performance.now()), next: op.next,
      };
      this.clearTiming(op);
      this.setPhase(op, "paused", "已暂停，点击播放继续。");
      this.hooks.stopStandard();
      this.personal.pause();
    }
  }

  start() {
    if (this.captures) return;
    const op = this.begin(this.automatic ? "auto" : "manual");
    if (!op) return;
    if (op.kind === "auto") {
      // Ask from the explicit click. Release this stream before playing A.
      void this.authorize(op, (stream) => {
        stopTracks(stream);
        void this.playA(op, true);
      });
    } else {
      void this.authorize(op, (stream) => this.record(op, stream));
    }
  }

  async authorize(op, onReady) {
    if (this.op !== op) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      this.fail("此浏览器无法录音。请通过本地地址打开页面，并使用支持麦克风录音的 Safari 或 Chrome。");
      return;
    }
    this.setPhase(op, "permission", "正在等待麦克风权限或设备…");
    op.timer = setTimeout(() => {
      if (this.op === op) this.fail("等待麦克风超时。请确认浏览器权限后重试。");
    }, MIC_TIMEOUT_MS);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 }, echoCancellation: true },
        video: false,
      });
      if (this.op !== op) {
        stopTracks(stream);
        return;
      }
      this.clearTiming(op);
      onReady(stream);
    } catch (error) {
      if (this.op === op) this.fail(microphoneMessage(error));
    }
  }

  record(op, stream) {
    op.stream = stream;
    op.chunks = [];
    try {
      const tracks = stream.getAudioTracks();
      if (!tracks.some((track) => track.readyState === "live")) throw new Error("Missing live audio track");
      const recorder = makeRecorder(stream);
      op.recorder = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (this.op === op && event.data.size) op.chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => this.saveTake(op));
      recorder.addEventListener("error", () => {
        if (this.op === op) this.fail("录音失败。请检查麦克风或更换浏览器后重试。");
      });
      for (const track of tracks) {
        track.addEventListener("ended", () => {
          if (this.op === op && op.phase === "recording") this.fail("麦克风已断开，请重新连接后重试。");
        }, { once: true });
      }
      recorder.start(250);
      op.started = performance.now();
      $("recording-time").textContent = "0:00";
      this.setPhase(op, "recording", "请跟读当前句子，录音最长 60 秒。");
      op.ticker = setInterval(() => {
        if (this.op === op) $("recording-time").textContent = formatTime((performance.now() - op.started) / 1000);
      }, 200);
      op.timer = setTimeout(() => {
        if (this.op === op) this.finishRecording();
      }, RECORD_LIMIT_MS);
    } catch {
      this.fail("无法使用当前麦克风或录音格式。请更换设备或浏览器后重试。");
    }
  }

  finishRecording() {
    const op = this.op;
    if (op?.phase !== "recording") return;
    this.clearTiming(op);
    op.duration = (performance.now() - op.started) / 1000;
    this.setPhase(op, "finishing", "正在整理录音…");
    op.timer = setTimeout(() => {
      if (this.op === op) this.fail("录音结束超时。请重试。");
    }, 5000);
    try {
      if (op.recorder.state !== "inactive") op.recorder.stop();
    } catch {
      this.fail("无法结束录音，请重试。");
    } finally {
      stopTracks(op.stream);
      op.stream = null;
    }
  }

  saveTake(op) {
    if (this.op !== op) return;
    if (op.phase !== "finishing") {
      this.fail("录音已意外停止，请检查麦克风后重试。");
      return;
    }
    this.clearTiming(op);
    const mime = op.recorder.mimeType || op.chunks[0]?.type;
    const blob = new Blob(op.chunks, { type: mime || "" });
    if (!blob.size) {
      this.fail("没有收到录音数据。请读完当前句子后再停止录音。");
      return;
    }
    this.discardTake();
    this.takeUrl = URL.createObjectURL(blob);
    this.takeLength = op.duration;
    this.personal.src = this.takeUrl;
    $("training-download").href = this.takeUrl;
    $("training-download").download = `kokoro-follow-along.${recordingExtension(blob.type)}`;
    if (op.kind === "auto") void this.playB(op, true);
    else this.finish("录音已就绪，可以回听或进行 A/B 对比。");
  }

  finish(message) {
    this.clearTiming(this.op);
    this.op = null;
    this.message(message, "success");
    this.hooks.changed();
  }

  fail(message) {
    this.cancel({ keepNotice: true });
    this.message(message, "error");
  }
}
