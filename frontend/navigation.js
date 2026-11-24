"use strict";

const DIALOGUE_LABEL = /^(Speaker[^\S\r\n]+\d{1,3}|(?:(?:Alternate[^\S\r\n]+)?Question|Answer)(?:[^\S\r\n]+\d{1,3})?)(?=\s|[:：]|$)/i;
const LABEL_COLON = /^[^\S\r\n]*[:：][^\S\r\n]*/;
const QUESTION_LABEL = /^(?:Alternate )?Question\b/i;
const ANSWER_LABEL = /^Answer\b/i;
const NUMBERED_ITEM = /^(?:[A-Z]{1,2}\d{1,4}(?=$|[ \t]*[.·:：—–-])|\d{1,4}[.)](?=\s|$))/;
const QA_BODY_START = /^[\s“‘"'(\[]*[\p{Lu}\p{Nd}]/u;
const EXERCISE_NUMBER = /^([A-Z])(\d{2,4})(?=$|[^\S\r\n]|[.:：)](?=$|[^\S\r\n]))(?:[^\S\r\n]*[.)·:：–—-](?=$|[^\S\r\n]))?[^\S\r\n]*/;

function dialogueLines(blocks) {
  let previousText = "";
  let question = null;
  const exerciseNumbers = new Set();
  return blocks.map((block) => {
    if (block.kind === "heading") {
      previousText = block.text.trim();
      question = null;
    }
    const canPair = ["paragraph", "list", "quote"].includes(block.kind);
    let offset = 0;
    return block.text.split("\n").map((line) => {
      const record = { start: offset, label: "", bodyStart: null, recognized: false };
      offset += Array.from(line).length + 1;
      const trimmed = line.trim();
      if (!trimmed) return record;

      let bodyLine = line;
      const number = block.kind === "code" ? null : EXERCISE_NUMBER.exec(trimmed);
      if (number) {
        const [, letter, digits] = number;
        const serial = Number(digits);
        const previous = letter + String(serial - 1).padStart(digits.length, "0");
        // A zero-padded label starts a series. A bare code such as B12
        // stays in the prose unless it continues a recognized series.
        if (serial > 0 && (digits.startsWith("0") || exerciseNumbers.has(previous))) {
          record.number = letter + digits;
          record.numberStart = record.start + line.length - line.trimStart().length;
          exerciseNumbers.add(record.number);
          bodyLine = line.trimStart().slice(number[0].length);
        }
      }
      if (block.kind === "heading") return record;

      const afterNumber = NUMBERED_ITEM.test(previousText);
      previousText = canPair ? trimmed : "";
      const firstLatin = bodyLine.search(/\p{Script=Latin}/u);
      const match = firstLatin < 0 ? null : DIALOGUE_LABEL.exec(bodyLine.slice(firstLatin));
      const pendingQuestion = question;
      question = null;
      if (!match) return record;

      const rest = bodyLine.slice(firstLatin + match[0].length);
      const colon = LABEL_COLON.exec(rest);
      const label = match[1].replace(/\s+/g, " ");
      const isQuestion = QUESTION_LABEL.test(label);
      const isAnswer = ANSWER_LABEL.test(label);
      const body = colon ? rest.slice(colon[0].length) : rest.trimStart();
      if (!colon && (!canPair || body === rest || firstLatin !== bodyLine.length - bodyLine.trimStart().length ||
          !QA_BODY_START.test(body))) return record;

      record.label = label;
      record.bodyStart = record.start + Array.from(line.slice(0, line.length - body.length)).length;
      record.recognized = !!colon;
      // With a space as the separator, require a neighboring question and answer.
      if (canPair && isAnswer && pendingQuestion) {
        pendingQuestion.recognized = record.recognized = true;
      } else if (canPair && isQuestion && (colon || afterNumber || record.number || body.includes("?"))) {
        question = record;
      }
      return record;
    });
  });
}

function prepareReadingUnits(document) {
  if (!document) return [];
  const result = [];
  const linesByBlock = dialogueLines(document.blocks);
  let currentBlock = -1;
  let lines = [];
  let lineIndex = 0;
  let pendingLabel = "";
  let pendingNumber = "";

  for (const unit of document.units) {
    if (unit.paragraph_index !== currentBlock) {
      currentBlock = unit.paragraph_index;
      const block = document.blocks[currentBlock];
      lines = linesByBlock[currentBlock];
      if (block.kind === "heading") pendingLabel = "";
      lineIndex = 0;
    }
    while (lineIndex + 1 < lines.length && lines[lineIndex + 1].start <= unit.start) lineIndex++;

    const parts = unit.text.split("\n").map((text, index) => {
      const line = lines[lineIndex + index];
      const number = line?.number && (index > 0 || unit.start === line.numberStart)
        ? EXERCISE_NUMBER.exec(text.trimStart()) : null;
      const hasNumber = number && number[1] + number[2] === line.number;
      if (hasNumber) text = text.trimStart().slice(number[0].length);
      const part = { text, label: "", number: hasNumber ? line.number : "" };
      const prefix = line?.recognized && (index > 0 || unit.start < line.bodyStart)
        ? DIALOGUE_LABEL.exec(text) : null;
      if (prefix && prefix[1].replace(/\s+/g, " ").toLowerCase() === line.label.toLowerCase()) {
        part.text = text.slice(prefix[0].length).replace(LABEL_COLON, "").trimStart();
        part.label = line.label;
      }
      return part;
    });
    const partNumber = parts.find(({ number }) => number)?.number;
    const speech = parts.map(({ text }) => text).join("\n").trim();
    if (!speech) {
      pendingLabel = parts.find(({ label }) => label)?.label || "";
      if (partNumber) pendingNumber = partNumber;
      continue;
    }
    const line = lines[lineIndex];
    if (pendingLabel && !parts.some(({ label }) => label) && (!line?.recognized || line.label === pendingLabel)) {
      parts[0].label = pendingLabel;
    }
    pendingLabel = "";
    const carriedNumber = !partNumber ? pendingNumber : "";
    if (carriedNumber) parts[0].number = carriedNumber;
    pendingNumber = "";
    result.push({
      ...unit, parts, speech,
      number: partNumber || carriedNumber || line?.number || "",
      searchText: carriedNumber ? `${carriedNumber} ${unit.text}` : unit.text,
      role: parts.find(({ label }) => label)?.label || (line?.recognized ? line.label : ""),
    });
  }
  return result;
}

function normalizedSearch(text) {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

class DocumentNavigation {
  constructor(selectUnit) {
    this.selectUnit = selectUnit;
    this.input = $("document-search");
    this.chapter = $("chapters");
    this.results = $("search-results");
    this.count = $("search-count");
    this.previous = $("search-previous");
    this.next = $("search-next");
    this.outline = $("outline-list");
    this.outlinePanel = $("outline-sidebar");
    this.outlineToggle = $("outline-toggle");
    this.outlineFilters = $("outline-filters");
    this.desktop = matchMedia("(min-width: 1025px)");
    this.outlineEntries = [];
    this.outlineCurrent = null;
    this.units = [];
    this.buttons = [];
    this.matches = [];
    this.active = -1;
    this.query = "";
    this.busy = false;
    this.timer = null;

    this.desktop.addEventListener("change", ({ matches }) => {
      if (!matches) this.toggleOutline(false);
    });
    this.outlineToggle.addEventListener("click", () => this.toggleOutline());
    this.outline.addEventListener("click", (event) => {
      const entry = event.target.closest("button[data-unit]");
      if (!entry || this.busy) return;
      if (!this.desktop.matches) {
        this.toggleOutline(false);
        this.outlineToggle.focus({ preventScroll: true });
      }
      this.selectUnit(Number(entry.dataset.unit));
    });
    this.outlineFilters.addEventListener("click", (event) => {
      const filter = event.target.closest("button[data-part]");
      if (filter) this.filterOutline(filter.dataset.part);
    });
    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.key !== "Escape" || this.desktop.matches || this.outlinePanel.hidden) return;
      this.toggleOutline(false);
      if (this.outlinePanel.contains(event.target)) this.outlineToggle.focus();
    });

    this.input.addEventListener("input", () => {
      clearTimeout(this.timer);
      this.results.hidden = true;
      if (!this.input.value.trim()) {
        this.search(false);
        return;
      }
      this.count.hidden = true;
      this.timer = setTimeout(() => this.search($("search-box").contains(document.activeElement)), 100);
    });
    this.input.addEventListener("focus", () => this.search(true));
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.results.hidden) {
        this.results.hidden = true;
        event.preventDefault();
      } else if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        this.move(event.shiftKey ? -1 : 1);
      }
    });
    this.previous.addEventListener("click", () => this.move(-1));
    this.next.addEventListener("click", () => this.move(1));
    this.results.addEventListener("click", (event) => {
      const result = event.target.closest("button[data-result]");
      if (result) this.jump(Number(result.dataset.result), true);
    });
    this.chapter.addEventListener("change", () => {
      if (!this.chapter.value) return;
      this.selectUnit(Number(this.chapter.value));
      this.chapter.selectedIndex = 0;
    });
    document.addEventListener("pointerdown", (event) => {
      if (!$("search-box").contains(event.target)) this.results.hidden = true;
      if (!this.desktop.matches && !this.outlinePanel.hidden &&
          !this.outlinePanel.contains(event.target) && !this.outlineToggle.contains(event.target)) {
        this.toggleOutline(false);
      }
    });
  }

  setContent(blocks, units, buttons, resetQuery) {
    clearTimeout(this.timer);
    this.units = units;
    this.buttons = buttons;
    this.text = units.map((unit) => normalizedSearch(unit.searchText));
    this.matches = [];
    this.query = "";
    this.active = -1;
    if (resetQuery) this.input.value = "";
    const headings = new Map();
    units.forEach((unit, index) => {
      const block = blocks[unit.paragraph_index];
      if (block.kind !== "heading") return;
      if (headings.has(unit.paragraph_index)) headings.get(unit.paragraph_index).text += " " + unit.text;
      else headings.set(unit.paragraph_index, { index, text: unit.text, level: block.level });
    });
    const entries = [...headings.values()];
    const choices = entries.map(({ index, text, level }) =>
      new Option("\u00a0\u00a0".repeat(Math.max(0, Math.min(3, level - 1))) + text, index));
    this.chapter.replaceChildren(new Option("章节导航", ""), ...choices);
    this.chapter.hidden = !choices.length;
    this.renderOutline(entries, blocks.length > 0);
    this.setBusy(this.busy);
    this.search(false);
  }

  toggleOutline(open = this.outlinePanel.hidden) {
    this.outlinePanel.hidden = !open;
    this.outlineToggle.setAttribute("aria-expanded", String(open));
    this.outlinePanel.parentElement.dataset.outline = open ? "open" : "closed";
    if (open) this.revealOutline();
  }

  renderOutline(entries, haveDocument) {
    this.outline.replaceChildren();
    this.outlineFilters.replaceChildren();
    this.outlineEntries = [];
    this.outlineCurrent = null;
    $("outline-count").hidden = !entries.length;
    $("outline-count").textContent = `${entries.length} 个标题`;
    this.outlineFilters.hidden = true;
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = haveDocument ? "这份文档没有可导航的章节标题。" : "导入文档后可查看章节。";
      this.outline.append(empty);
      return;
    }

    const firstLevel = Math.min(...entries.map(({ level }) => level));
    const parts = new Set();
    let part = "";
    const fragment = document.createDocumentFragment();
    for (const { index, text, level } of entries) {
      const match = text.match(/^Part\s+([A-Z]|\d+)\b/i);
      if (match) {
        part = `Part ${match[1].toUpperCase()}`;
        parts.add(part);
      } else if (level === firstLevel) {
        part = "";
      }
      const entry = document.createElement("button");
      entry.type = "button";
      entry.className = "outline-entry";
      entry.dataset.unit = index;
      entry.dataset.part = part;
      entry.style.setProperty("--depth", Math.min(4, level - firstLevel));
      entry.toggleAttribute("data-root", level === firstLevel || !!match);
      entry.lang = "en";
      entry.textContent = text;
      entry.title = text;
      fragment.append(entry);
      this.outlineEntries.push({ index, entry });
    }
    this.outline.append(fragment);
    const filters = [["", "全部"]];
    if (this.outlineEntries.some(({ entry }) => !entry.hasAttribute("data-root"))) {
      filters.push(["major", "仅主章节"]);
    }
    if (parts.size > 1) for (const part of parts) filters.push([part, part]);
    if (filters.length === 1) return;
    for (const [part, label] of filters) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.part = part;
      button.textContent = label;
      button.setAttribute("aria-pressed", String(!part));
      this.outlineFilters.append(button);
    }
    this.outlineFilters.hidden = false;
  }

  filterOutline(part) {
    for (const { entry } of this.outlineEntries) {
      entry.hidden = part === "major" ? !entry.hasAttribute("data-root") : !!part && entry.dataset.part !== part;
    }
    for (const button of this.outlineFilters.children) {
      button.setAttribute("aria-pressed", String(button.dataset.part === part));
    }
    this.outline.scrollTop = 0;
    this.revealOutline();
  }

  selectOutline(index) {
    let first = 0;
    let last = this.outlineEntries.length;
    while (first < last) {
      const middle = (first + last) >>> 1;
      if (this.outlineEntries[middle].index <= index) first = middle + 1;
      else last = middle;
    }
    const selected = this.outlineEntries[first - 1]?.entry || null;
    if (this.outlineCurrent === selected) return;
    this.outlineCurrent?.removeAttribute("aria-current");
    this.outlineCurrent = selected;
    selected?.setAttribute("aria-current", "location");
    this.revealOutline();
  }

  revealOutline() {
    if (!this.outlineCurrent || this.outlinePanel.hidden || this.outlineCurrent.hidden) return;
    const list = this.outline.getBoundingClientRect();
    const current = this.outlineCurrent.getBoundingClientRect();
    if (current.top < list.top || current.bottom > list.bottom) {
      this.outline.scrollTop += current.top - list.top - 15;
    }
  }

  setBusy(busy) {
    this.busy = busy;
    for (const { entry } of this.outlineEntries) entry.disabled = busy;
    this.input.disabled = this.chapter.disabled = busy || !this.units.length;
    this.updateControls();
  }

  updateControls() {
    this.previous.disabled = this.next.disabled = this.busy || !this.matches.length;
    this.count.hidden = !this.query;
    this.count.textContent = this.query ? (this.active < 0
      ? `${this.matches.length} 条` : `${this.active + 1} / ${this.matches.length}`) : "";
  }

  search(open) {
    clearTimeout(this.timer);
    const query = normalizedSearch(this.input.value);
    if (query !== this.query) {
      for (const index of this.matches) this.buttons[index]?.classList.remove("search-hit");
      this.matches = [];
      if (query) this.text.forEach((value, index) => {
        if (value.includes(query)) {
          this.matches.push(index);
          this.buttons[index]?.classList.add("search-hit");
        }
      });
      this.query = query;
      this.active = -1;
    }
    this.updateControls();
    if (open && query) this.showResults();
    else this.results.hidden = true;
  }

  showResults() {
    this.results.replaceChildren();
    this.results.hidden = false;
    if (!this.matches.length) {
      const empty = document.createElement("p");
      empty.className = "search-result-empty";
      empty.textContent = "没有匹配的句子。";
      this.results.append(empty);
      return;
    }
    const start = Math.max(0, Math.min(this.active - 3, this.matches.length - 7));
    this.matches.slice(start, start + 7).forEach((unitIndex, offset) => {
      const position = start + offset;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-result";
      button.dataset.result = position;
      if (position === this.active) button.setAttribute("aria-current", "true");
      const number = document.createElement("span");
      number.textContent = `${unitIndex + 1}.`;
      const snippet = document.createElement("span");
      snippet.lang = "en";
      snippet.textContent = this.units[unitIndex].searchText;
      snippet.title = snippet.textContent;
      button.append(number, snippet);
      this.results.append(button);
    });
  }

  move(direction) {
    this.search(false);
    if (!this.matches.length || this.busy) return;
    const total = this.matches.length;
    this.jump(this.active < 0 && direction < 0 ? total - 1 :
      (this.active + direction + total) % total, false);
  }

  jump(position, focusSentence) {
    const index = this.matches[position];
    if (this.busy || index === undefined) return;
    this.active = position;
    this.updateControls();
    this.results.hidden = true;
    this.selectUnit(index, focusSentence);
  }
}
