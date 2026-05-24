import { app } from "/scripts/app.js";

const API_URL = "/api/lite-tag-grimoire/index";
const MIN_QUERY_LENGTH = 1;
const MAX_RESULTS = 12;
const CATEGORY_LABELS = {
  0: "通用",
  3: "作品",
  4: "角色",
  5: "Meta",
};
const KIND_PRIORITY = {
  general: 3,
  copyright: 2,
  character: 1,
};

const state = {
  items: [],
  loaded: false,
  loading: null,
  active: null,
  results: [],
  selected: 0,
};

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\s_・·:：!！?？.,，。"'“”‘’()[\]{}<>【】《》\-]+/g, "");
}

function buildSearchText(item) {
  const fields = [
    item.tag,
    item.preferred,
    item.translation,
    item.source_tag,
    item.source_preferred,
    item.copyright,
    ...(item.aliases || []),
  ];
  return fields.map(normalize).filter(Boolean).join(" ");
}

async function ensureIndex() {
  if (state.loaded) return;
  if (!state.loading) {
    state.loading = fetch(API_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        state.items = (data.items || []).map((item) => ({
          ...item,
          search: buildSearchText(item),
          tagNorm: normalize(item.tag),
          preferredNorm: normalize(item.preferred),
          translationNorm: normalize(item.translation),
          sourceTagNorm: normalize(item.source_tag || item.copyright),
          sourcePreferredNorm: normalize(item.source_preferred),
        }));
        state.loaded = true;
        console.info("[comfyui-tags-graph] loaded", data.counts || state.items.length);
      })
      .catch((err) => {
        console.error("[comfyui-tags-graph] failed to load index", err);
        state.loading = null;
      });
  }
  await state.loading;
}

function getEditableValue(el) {
  if (el.isContentEditable) return el.innerText || "";
  return el.value || "";
}

function setEditableValue(el, value) {
  if (el.isContentEditable) {
    el.innerText = value;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function getCaret(el) {
  if (el.isContentEditable) {
    return getEditableValue(el).length;
  }
  return typeof el.selectionStart === "number" ? el.selectionStart : getEditableValue(el).length;
}

function setCaret(el, pos) {
  if (!el.isContentEditable && typeof el.setSelectionRange === "function") {
    el.setSelectionRange(pos, pos);
  }
}

function getCurrentQuery(el) {
  const value = getEditableValue(el);
  const caret = getCaret(el);
  const before = value.slice(0, caret);
  const start = Math.max(
    before.lastIndexOf(","),
    before.lastIndexOf("\n"),
    before.lastIndexOf("("),
    before.lastIndexOf("["),
    before.lastIndexOf("{")
  ) + 1;
  const raw = before.slice(start);
  const leading = raw.match(/^\s*/)?.[0] || "";
  const query = raw.slice(leading.length);
  return { value, caret, start, leading, query };
}

function scoreItem(item, rawQuery) {
  const query = normalize(rawQuery);
  if (!query) return 0;

  let score = 0;
  if (item.tagNorm.startsWith(query)) score += 1200;
  if (item.preferredNorm.startsWith(query)) score += 1100;
  if (item.translationNorm.startsWith(query)) score += 1100;
  if (item.tagNorm.includes(query)) score += 650;
  if (item.preferredNorm.includes(query)) score += 620;
  if (item.translationNorm.includes(query)) score += 620;
  if (item.kind === "character" && item.sourceTagNorm.startsWith(query)) score += 980;
  if (item.kind === "character" && item.sourcePreferredNorm.startsWith(query)) score += 980;
  if (item.kind === "character" && item.sourceTagNorm.includes(query)) score += 520;
  if (item.kind === "character" && item.sourcePreferredNorm.includes(query)) score += 520;
  if (item.search.includes(query)) score += 450;

  for (const alias of item.aliases || []) {
    const norm = normalize(alias);
    if (norm.startsWith(query)) score += 900;
    else if (norm.includes(query)) score += 420;
  }

  if (!score) return 0;
  const kindBonus = item.kind === "general" ? 120 : item.kind === "copyright" ? 80 : 0;
  return score + kindBonus + Math.min(160, Math.log10((item.post_count || 0) + 1) * 32);
}

function search(query) {
  const scored = [];
  for (const item of state.items) {
    const score = scoreItem(item, query);
    if (score > 0) scored.push({ item, score });
  }
  scored.sort(
    (a, b) =>
      (KIND_PRIORITY[b.item.kind] || 0) - (KIND_PRIORITY[a.item.kind] || 0) ||
      b.score - a.score ||
      (b.item.post_count || 0) - (a.item.post_count || 0)
  );
  return scored.slice(0, MAX_RESULTS).map((entry) => entry.item);
}

function makePanel() {
  const panel = document.createElement("div");
  panel.className = "ctg-panel";
  panel.innerHTML = `
    <div class="ctg-list"></div>
    <div class="ctg-footer">↑↓ 选择 · Tab 补全 · Esc 关闭 · Enter 保持原输入行为</div>
  `;
  document.body.appendChild(panel);
  return panel;
}

function makeGhost() {
  const ghost = document.createElement("div");
  ghost.className = "ctg-ghost";
  document.body.appendChild(ghost);
  return ghost;
}

function positionPanel(el, panel) {
  const rect = el.getBoundingClientRect();
  panel.style.left = `${Math.max(8, rect.left)}px`;
  panel.style.top = `${Math.min(window.innerHeight - 260, rect.bottom + 6)}px`;
  panel.style.width = `${Math.max(320, Math.min(560, rect.width))}px`;
}

function positionGhost(el, ghost, text) {
  const rect = el.getBoundingClientRect();
  ghost.textContent = text;
  ghost.style.left = `${Math.max(8, rect.left + 12)}px`;
  ghost.style.top = `${Math.max(8, rect.bottom - 28)}px`;
  ghost.style.maxWidth = `${Math.max(240, rect.width - 24)}px`;
}

function render(active) {
  const { panel, ghost, el } = active;
  const list = panel.querySelector(".ctg-list");
  list.textContent = "";

  state.results.forEach((item, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `ctg-row${index === state.selected ? " selected" : ""}`;
    const sourceLine = getSourceLine(item);
    row.innerHTML = `
      <span class="ctg-tag-col">
        <code>${escapeHtml(item.tag)}</code>
        <span>${escapeHtml(getKindLabel(item))} · ${formatCount(item.post_count)}</span>
      </span>
      <span class="ctg-cn-col">
        <strong>${escapeHtml(getTranslation(item))}</strong>
        ${sourceLine ? `<span>${escapeHtml(sourceLine)}</span>` : ""}
      </span>
    `;
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      accept(item);
    });
    list.appendChild(row);
  });
  scrollSelectedIntoView(list);

  const first = state.results[0];
  if (first) {
    const query = getCurrentQuery(el).query;
    const suffix = first.tag.startsWith(query) ? first.tag.slice(query.length) : first.tag;
    positionGhost(el, ghost, suffix ? `${query}${suffix}` : first.tag);
  }

  panel.hidden = state.results.length === 0;
  ghost.hidden = state.results.length === 0;
  positionPanel(el, panel);
}

function scrollSelectedIntoView(list) {
  const selected = list.querySelector(".ctg-row.selected");
  selected?.scrollIntoView({ block: "nearest" });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getTranslation(item) {
  if (item.translation) return item.translation;
  if (item.preferred && item.preferred !== item.tag) return item.preferred;
  if (item.kind === "character") return "角色";
  return item.tag;
}

function getKindLabel(item) {
  if (item.kind === "copyright") return "作品/IP";
  return CATEGORY_LABELS[item.category] || item.kind;
}

function getSourceLine(item) {
  if (item.kind !== "character") return "";
  const sourceCn = item.source_preferred || item.copyright || "";
  const sourceTag = item.source_tag || item.copyright || "";
  if (sourceCn && sourceTag && sourceCn !== sourceTag) return `来自：${sourceCn} / ${sourceTag}`;
  if (sourceCn || sourceTag) return `来自：${sourceCn || sourceTag}`;
  return "";
}

function formatCount(count) {
  if (!count) return "0";
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(count);
}

async function update(el) {
  await ensureIndex();
  const query = getCurrentQuery(el).query.trim();
  if (query.length < MIN_QUERY_LENGTH) {
    close();
    return;
  }
  if (!state.active || state.active.el !== el) {
    state.active = { el, panel: makePanel(), ghost: makeGhost() };
  }
  state.results = search(query);
  state.selected = 0;
  render(state.active);
}

function accept(item = state.results[state.selected]) {
  if (!state.active || !item) return;
  const el = state.active.el;
  const current = getCurrentQuery(el);
  const before = current.value.slice(0, current.start);
  const after = current.value.slice(current.caret);
  const inserted = `${current.leading}${item.tag}, `;
  const next = `${before}${inserted}${after}`;
  const nextCaret = before.length + inserted.length;
  setEditableValue(el, next);
  setCaret(el, nextCaret);
  close();
  el.focus();
}

function close() {
  if (!state.active) return;
  state.active.panel.remove();
  state.active.ghost.remove();
  state.active = null;
  state.results = [];
  state.selected = 0;
}

function shouldAttach(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.dataset.ctgAttached === "1") return false;
  if (el.closest(".ctg-panel")) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.isContentEditable) return true;
  if (el.tagName === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type !== "text") return false;
    const hint = [
      el.placeholder,
      el.name,
      el.id,
      el.className,
      el.getAttribute("aria-label"),
    ]
      .join(" ")
      .toLowerCase();
    if (/\b(search|filter|filename|path|url)\b/.test(hint)) return false;
    return el.clientWidth > 180 || /\b(prompt|tag|positive|negative)\b/.test(hint);
  }
  return false;
}

function attach(el) {
  if (!shouldAttach(el)) return;
  el.dataset.ctgAttached = "1";
  el.setAttribute("autocomplete", "off");

  el.addEventListener("input", () => update(el));
  el.addEventListener("focus", () => update(el));
  el.addEventListener("blur", () => setTimeout(close, 150));
  el.addEventListener("keydown", (event) => {
    if (!state.active || state.active.el !== el || state.results.length === 0) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.selected = (state.selected + 1) % state.results.length;
      render(state.active);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      state.selected = (state.selected - 1 + state.results.length) % state.results.length;
      render(state.active);
    } else if (event.key === "Tab") {
      event.preventDefault();
      accept();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
}

function scan(root = document) {
  root.querySelectorAll?.("textarea,input,[contenteditable='true']").forEach(attach);
}

function injectStyles() {
  if (document.getElementById("ctg-style")) return;
  const style = document.createElement("style");
  style.id = "ctg-style";
  style.textContent = `
    .ctg-panel {
      position: fixed;
      z-index: 100000;
      color: #f5f1f4;
      background: rgba(24, 20, 25, 0.97);
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.42);
      border-radius: 8px;
      overflow: hidden;
      font: 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .ctg-list { max-height: 320px; overflow-y: auto; padding: 4px; }
    .ctg-row {
      all: unset;
      box-sizing: border-box;
      display: grid;
      grid-template-columns: minmax(150px, 1fr) minmax(150px, 1.1fr);
      gap: 14px;
      align-items: start;
      width: 100%;
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
    }
    .ctg-row.selected,
    .ctg-row:hover { background: rgba(168, 96, 132, 0.36); }
    .ctg-tag-col,
    .ctg-cn-col { min-width: 0; display: grid; gap: 2px; }
    .ctg-tag-col code { color: #f2edf0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ctg-tag-col span,
    .ctg-cn-col span { color: #b5aab1; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ctg-cn-col strong { color: #f5f1f4; font-size: 14px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ctg-footer { border-top: 1px solid rgba(255, 255, 255, 0.1); color: #b9aeb5; padding: 7px 10px; font-size: 12px; }
    .ctg-ghost {
      position: fixed;
      z-index: 99999;
      pointer-events: none;
      color: rgba(245, 241, 244, 0.36);
      font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;
  document.head.appendChild(style);
}

app.registerExtension({
  name: "comfyui-tags-graph.autocomplete",
  async setup() {
    injectStyles();
    scan();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            attach(node);
            scan(node);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  },
});
