"use strict";

const DIALOGUE_PREFIX = /^(Speaker[ \t]+[0-9]{1,3}|Question(?:[ \t]+[0-9]{1,3})?|Answer(?:[ \t]+[0-9]{1,3})?)[ \t]*:[ \t]*/i;

function dialogueLines(text) {
  let offset = 0;
  return text.split("\n").map((line) => {
    const firstLatin = line.search(/\p{Script=Latin}/u);
    const match = firstLatin < 0 ? null : DIALOGUE_PREFIX.exec(line.slice(firstLatin));
    const result = {
      start: offset,
      end: offset + Array.from(line).length,
      bodyStart: match ? offset + Array.from(line.slice(0, firstLatin + match[0].length)).length : null,
      label: match?.[1] || "",
    };
    offset = result.end + 1;
    return result;
  });
}

function prepareReadingUnits(document) {
  if (!document) return [];
  const result = [];
  let currentBlock = -1;
  let lines = [];
  let lineIndex = 0;
  let pendingLabel = "";

  for (const unit of document.units) {
    if (unit.paragraph_index !== currentBlock) {
      currentBlock = unit.paragraph_index;
      const block = document.blocks[currentBlock];
      lines = block.kind === "heading" ? [] : dialogueLines(block.text);
      if (block.kind === "heading") pendingLabel = "";
      lineIndex = 0;
    }
    while (lineIndex + 1 < lines.length && lines[lineIndex + 1].start <= unit.start) lineIndex++;

    const parts = unit.text.split("\n").map((text, index) => {
      const line = lines[lineIndex + index];
      const prefix = line?.label && (index > 0 || unit.start < line.bodyStart)
        ? DIALOGUE_PREFIX.exec(text) : null;
      if (!prefix || prefix[1].toLowerCase() !== line.label.toLowerCase()) return { text, label: "" };
      return { text: text.slice(prefix[0].length), label: prefix[1] };
    });
    const speech = parts.map(({ text }) => text).join("\n").trim();
    if (!speech) {
      pendingLabel = parts.find(({ label }) => label)?.label || "";
      continue;
    }
    if (pendingLabel && !parts.some(({ label }) => label) && !lines[lineIndex]?.label) {
      parts[0].label = pendingLabel;
    }
    pendingLabel = "";
    result.push({ ...unit, parts, speech, role: parts.find(({ label }) => label)?.label || lines[lineIndex]?.label || "" });
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
    this.units = [];
    this.buttons = [];
    this.matches = [];
    this.active = -1;
    this.query = "";
    this.busy = false;
    this.timer = null;

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
    });
  }

  setContent(blocks, units, buttons, resetQuery) {
    clearTimeout(this.timer);
    this.units = units;
    this.buttons = buttons;
    this.text = units.map((unit) => normalizedSearch(unit.text));
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
    const choices = [...headings.values()].map(({ index, text, level }) =>
      new Option("\u00a0\u00a0".repeat(Math.max(0, Math.min(3, level - 1))) + text, index));
    this.chapter.replaceChildren(new Option("章节导航", ""), ...choices);
    this.chapter.hidden = !choices.length;
    this.setBusy(this.busy);
    this.search(false);
  }

  setBusy(busy) {
    this.busy = busy;
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
      snippet.textContent = this.units[unitIndex].text;
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
