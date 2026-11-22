"use strict";

const TRANSLATION_PREFERENCE = "kokoro-reader-translation-visible";
const TRANSLATION_MEMORY_LIMIT = 160;

function waitForTranslation(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

class SentenceTranslation {
  constructor() {
    this.body = $("translation-body");
    this.output = $("translation-output");
    this.toggle = $("translation-toggle");
    this.retry = $("translation-retry");
    this.cache = new Map();
    this.cacheEpoch = 0;
    this.text = null;
    this.controller = null;
    this.visible = true;
    try {
      this.visible = localStorage.getItem(TRANSLATION_PREFERENCE) !== "false";
    } catch {
      // The control remains usable when browser storage is unavailable.
    }
    this.syncVisibility();
    this.toggle.addEventListener("click", () => {
      this.visible = !this.visible;
      this.syncVisibility();
      try {
        localStorage.setItem(TRANSLATION_PREFERENCE, String(this.visible));
      } catch {
        // The choice still applies to this page.
      }
      this.refresh();
    });
    this.retry.addEventListener("click", () => this.refresh(true));
    $("clear-translation-cache").addEventListener("click", () => void this.clearCache());
  }

  syncVisibility() {
    this.body.hidden = !this.visible;
    this.toggle.setAttribute("aria-expanded", String(this.visible));
    this.toggle.textContent = this.visible ? "隐藏" : "显示";
  }

  select(text) {
    const normalized = (text || "").trim().replace(/\s+/g, " ");
    if (normalized === this.text) return;
    this.text = normalized;
    this.refresh();
  }

  show(state, message) {
    if (this.output.dataset.state !== state) this.output.dataset.state = state;
    if (this.output.textContent !== message) this.output.textContent = message;
    this.retry.hidden = state !== "error";
  }

  refresh(reload = false) {
    this.controller?.abort();
    this.controller = null;
    if (!this.visible) return;
    const text = this.text;
    if (!text) {
      this.show("idle", "请选择左侧英文句子。");
      return;
    }
    const cached = this.cache.get(text);
    if (cached) {
      this.remember(text, cached);
      this.show("ready", cached);
      return;
    }
    this.show("translating", "正在翻译……");
    const controller = new AbortController();
    this.controller = controller;
    void this.load(text, controller, reload, this.cacheEpoch);
  }

  async load(text, controller, reload, epoch) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    try {
      if (reload) {
        const response = await fetch("/api/translation/reload", { method: "POST", signal });
        if (!response.ok) throw new Error("无法重新加载本地翻译服务。");
      } else {
        await waitForTranslation(90, signal);
      }
      const request = JSON.stringify({ text, source: "en", target: "zh-Hans" });
      while (!signal.aborted) {
        const response = await fetch("/api/translate", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: request, signal,
        });
        if (controller !== this.controller) return;
        if (response.headers.has("Retry-After") && [429, 503].includes(response.status)) {
          if (response.status === 503) this.show("loading", "正在加载本地翻译模型……");
          else this.show("translating", "正在翻译……");
          await waitForTranslation(response.status === 503 ? 900 : 400, signal);
          continue;
        }
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || "翻译失败，请重试。");
        if (!result.translation) throw new Error("模型没有返回译文，请重试。");
        if (epoch === this.cacheEpoch) this.remember(text, result.translation);
        if (controller === this.controller) this.show("ready", result.translation);
        return;
      }
      signal.throwIfAborted();
    } catch (error) {
      if (this.controller !== controller) return;
      const message = error.name === "TimeoutError" ? "翻译等待超时，请重试。" :
        error instanceof TypeError ? "无法连接本地翻译服务，请重试。" :
        error.message || "翻译失败，请重试。";
      this.show("error", message);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  remember(text, translation) {
    this.cache.delete(text);
    this.cache.set(text, translation);
    if (this.cache.size > TRANSLATION_MEMORY_LIMIT) this.cache.delete(this.cache.keys().next().value);
  }

  async clearCache() {
    if (!window.confirm("清理本地中文翻译缓存？")) return;
    const button = $("clear-translation-cache");
    const status = $("translation-cache-note");
    button.disabled = true;
    try {
      const { removed } = await json("/api/translation/cache", "DELETE");
      this.cacheEpoch++;
      this.cache.clear();
      notice(status, `已清理 ${removed} 条翻译缓存。`, "success");
    } catch (error) {
      notice(status, errorMessage(error), "error");
    } finally {
      button.disabled = false;
    }
  }
}
