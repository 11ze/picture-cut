// The window: the list, the crop canvas, the inspector, and the save sheet.
import { Channel, onFileDrop } from "mygo-runtime";
import { Library, type ImportResult, type Progress, type Report, type SaveItem } from "./mygo";
import { clamp, isCustom, maxCrop, nudge, pixelRect, resize } from "./crop";
import {
  RATIOS,
  appliedDocs,
  doc,
  isApplied,
  mb,
  ratio,
  state,
  totalBytes,
  type Crop,
  type Quality,
} from "./state";

type Toast = "ok" | "info";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const photo = $("photo");
const stage = $("stage");
const img = $<HTMLImageElement>("photo-img");
const cropEl = $("crop");
const fileList = $("file-list");
const ratioGrid = $("ratio-grid");
const emptyEl = $("empty");
const canvasHint = document.querySelector<HTMLElement>(".canvas-hint")!;
const pathRow = document.querySelector<HTMLElement>(".path")!;

/** The centered crop of the image's ratio, or the remembered one. */
function ensureCrop(d = doc()): Crop | null {
  if (!d) return null;
  let c = state.crops.get(d.id);
  if (!c) {
    c = maxCrop(d.width, d.height, ratio(d));
    state.crops.set(d.id, c);
  }
  return c;
}

function cropPx(d: NonNullable<ReturnType<typeof doc>>, c: Crop) {
  return pixelRect(d.width, d.height, c);
}

function customCrop(d = doc()): boolean {
  const c = d ? state.crops.get(d.id) : undefined;
  if (!d || !c) return false;
  return isCustom(c, maxCrop(d.width, d.height, ratio(d)));
}

function customCount(docs = state.docs): number {
  return docs.filter((d) => {
    const c = state.crops.get(d.id);
    return Boolean(c) && isCustom(c!, maxCrop(d.width, d.height, ratio(d)));
  }).length;
}

function filename(d = doc()): string {
  if (!d) return "";
  return state.names.get(d.id) ?? d.name;
}

let namesCall = 0;

/** Asks Go for the output names, so the page shows what Save writes. */
async function refreshNames(): Promise<void> {
  if (!state.docs.length) return;
  const call = ++namesCall;
  const docs = state.docs.slice();
  let names: string[];
  try {
    names = await Library.previewNames(
      docs.map((d) => ({ id: d.id, ratio: ratio(d).key, applied: isApplied(d) })),
      state.quality,
      state.inPlace,
      state.outDir,
    );
  } catch {
    // Keep the last names; the sheet still saves with the correct ones.
    return;
  }
  // A newer call, or a list that changed meanwhile, owns the names.
  if (call !== namesCall) return;
  docs.forEach((d, i) => state.names.set(d.id, names[i] ?? d.name));
}

function buildFileList(): void {
  fileList.innerHTML = "";
  state.docs.forEach((d) => {
    const b = document.createElement("div");
    b.className = "file";
    b.setAttribute("role", "button");
    b.tabIndex = 0;
    b.setAttribute("aria-pressed", String(d.id === state.selectedId));
    b.dataset.id = d.id;
    b.title = d.name;
    if (!isApplied(d)) b.classList.add("off");
    b.innerHTML =
      '<img alt="" loading="lazy" />' +
      '<span class="fmeta-wrap"><span class="fname"></span><span class="fmeta"></span></span>' +
      '<button class="remove" type="button" title="从列表移除，不删除源文件"><span class="glyph glyph-x" aria-hidden="true">×</span></button>' +
      '<span class="fdot" hidden></span>';
    const im = b.querySelector("img")!;
    im.src = d.thumb;
    im.alt = d.name;
    b.querySelector(".fname")!.textContent = d.name;
    b.querySelector(".fmeta")!.textContent = `${d.width} × ${d.height} · ${mb(d.bytes)} MB`;
    const rm = b.querySelector<HTMLButtonElement>(".remove")!;
    rm.setAttribute("aria-label", `从列表移除 ${d.name}，不删除源文件`);
    b.addEventListener("click", (e) => {
      if ((e.target as Element).closest(".remove")) return;
      selectDoc(d.id);
    });
    b.addEventListener("keydown", (e) => {
      if ((e.target as Element).closest(".remove")) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectDoc(d.id);
      }
    });
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      askRemove(d.id, rm);
    });
    fileList.appendChild(b);
  });
  if (!state.docs.length) {
    const hint = document.createElement("div");
    hint.className = "list-empty";
    hint.innerHTML = "暂无图片<br><span>点 + 或拖入文件</span>";
    fileList.appendChild(hint);
  }
}

function buildRatioGrid(): void {
  ratioGrid.innerHTML = "";
  RATIOS.forEach((r) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ratio";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(r.key === ratio().key));
    b.setAttribute("aria-label", `${r.key}，${r.use}`);
    b.dataset.key = r.key;
    b.innerHTML =
      `<span class="glyph"><i style="width:${r.gw}px;height:${r.gh}px"></i></span>` +
      `<span class="lbl">${r.key}</span>`;
    b.addEventListener("click", () => setRatio(r.key));
    ratioGrid.appendChild(b);
  });
}

function selectDoc(id: string): void {
  const d = state.docs.find((x) => x.id === id);
  if (!d || id === state.selectedId) return;
  state.selectedId = id;
  ensureCrop(d);
  updateAll();
}

function setRatio(key: string): void {
  if (!doc() || key === ratio().key) return;
  void applyRatio(key);
}

async function applyRatio(key: string): Promise<void> {
  const d = doc();
  if (!d) return;
  state.ratios.set(d.id, key);
  state.crops.delete(d.id);
  ensureCrop(d);
  await refreshNames();
  updateAll();
}

function toggleApplied(): void {
  const d = doc();
  if (!d) return;
  if (state.excluded.has(d.id)) state.excluded.delete(d.id);
  else state.excluded.add(d.id);
  updateFileList();
  updateInspector();
  $<HTMLButtonElement>("save-all").disabled = state.importing || !appliedDocs().length;
  // Another image may have held the name this one now gets.
  refreshNamesLater();
  showToast(isApplied(d) ? "这张图已参与保存" : "这张图不参与保存，裁切设置已保留");
}

/** Names depend on which images take part: refresh them, then the inspector. */
function refreshNamesLater(): void {
  void refreshNames().then(() => updateInspector());
}

function updateAll(): void {
  updateFileList();
  updateRatioGrid();
  if (!state.docs.length) {
    updateEmptyState();
    return;
  }
  photo.hidden = false;
  emptyEl.hidden = true;
  canvasHint.hidden = false;
  $<HTMLButtonElement>("copy-name").disabled = false;
  $<HTMLButtonElement>("save-all").disabled = false;
  updateImage();
  updateCropVars();
  updateInspector();
}

function updateEmptyState(): void {
  photo.hidden = true;
  emptyEl.hidden = false;
  canvasHint.hidden = true;
  $("doc-title").textContent = "未选择图片";
  $("doc-title").title = "";
  $("crop-size").textContent = "未选择";
  $("crop-unit").hidden = true;
  $("out-sub").textContent = "添加图片后显示";
  $("output-format").textContent = "格式跟随原图";
  $("quality-high").textContent = "高质量";
  $("quality-note").textContent = "";
  const qh = $<HTMLButtonElement>("quality-high");
  const qc = $<HTMLButtonElement>("quality-compressed");
  qh.disabled = true;
  qc.disabled = true;
  qh.setAttribute("aria-checked", "false");
  qc.setAttribute("aria-checked", "false");
  $("quality-seg").classList.add("disabled");
  $("filename").textContent = "未选择";
  $("filename").removeAttribute("title");
  $<HTMLButtonElement>("apply-toggle").disabled = true;
  $("apply-toggle").setAttribute("aria-checked", "false");
  syncOutputSettings();
  $<HTMLButtonElement>("copy-name").disabled = true;
  $<HTMLButtonElement>("save-all").disabled = true;
  $("save-count").textContent = "0";
  $("count").textContent = "0";
  $("side-foot").textContent = "0 张";
  $("status-crop").textContent = "未选择图片";
}

function updateFileList(): void {
  fileList.querySelectorAll<HTMLElement>(".file").forEach((b) => {
    const d = state.docs.find((x) => x.id === b.dataset.id);
    if (!d) return;
    b.setAttribute("aria-pressed", String(d.id === state.selectedId));
    b.classList.toggle("off", !isApplied(d));
    const dot = b.querySelector<HTMLElement>(".fdot")!;
    dot.hidden = !customCrop(d);
  });
}

function updateRatioGrid(): void {
  ratioGrid.querySelectorAll<HTMLButtonElement>(".ratio").forEach((b) => {
    b.disabled = !doc();
    b.setAttribute("aria-checked", String(Boolean(doc()) && b.dataset.key === ratio().key));
  });
  $("ratio-hint").textContent = doc() ? `${ratio().key} · ${ratio().use}` : "添加图片后选择比例";
}

function updateImage(): void {
  const d = doc();
  if (!d) return;
  if (img.dataset.src !== d.preview) {
    img.dataset.src = d.preview;
    img.src = d.preview;
    img.alt = `${d.name} 预览`;
  }
  photo.style.aspectRatio = `${d.width} / ${d.height}`;
  layoutPhoto();
}

function layoutPhoto(): void {
  const d = doc();
  if (!d || photo.hidden) return;
  const maxW = Math.max(80, stage.clientWidth - 64);
  const maxH = Math.max(80, stage.clientHeight - 64);
  const s = Math.min(maxW / d.width, maxH / d.height);
  photo.style.width = `${Math.max(40, Math.round(d.width * s))}px`;
  photo.style.height = `${Math.max(40, Math.round(d.height * s))}px`;
}

function updateCropVars(): void {
  const d = doc();
  if (!d) return;
  const c = ensureCrop(d)!;
  const px = cropPx(d, c);
  photo.style.setProperty("--x", `${(c.x * 100).toFixed(4)}%`);
  photo.style.setProperty("--y", `${(c.y * 100).toFixed(4)}%`);
  photo.style.setProperty("--w", `${(c.w * 100).toFixed(4)}%`);
  photo.style.setProperty("--h", `${(c.h * 100).toFixed(4)}%`);
  cropEl.setAttribute("aria-label", `裁切框，${ratio().key}，${px.w} × ${px.h} 像素`);
}

/** Mirrors the shared output settings, which show even when no image is open. */
function syncOutputSettings(): void {
  $<HTMLInputElement>("in-place").checked = state.inPlace;
  $("path-text").hidden = !state.inPlace;
  const outPath = $<HTMLInputElement>("out-path");
  outPath.hidden = state.inPlace;
  if (outPath.value !== state.outDir) outPath.value = state.outDir;
}

function updateInspector(): void {
  const d = doc();
  if (!d) return;
  const c = ensureCrop(d)!;
  const px = cropPx(d, c);
  const isPng = d.format === "PNG";

  $("output-format").textContent = `${d.format} · 跟随原图`;
  $("crop-size").textContent = `${px.w} × ${px.h}`;
  $("crop-unit").hidden = false;
  $("out-sub").textContent = `原图 ${d.width} × ${d.height} · 按原始像素裁切`;

  const qh = $<HTMLButtonElement>("quality-high");
  const qc = $<HTMLButtonElement>("quality-compressed");
  qh.disabled = false;
  qc.disabled = false;
  qh.textContent = isPng ? "无损保存" : "高质量";
  qh.title = isPng ? "保留全部颜色和透明背景，不做有损压缩" : "保留更多细节，文件较大，仍会有损压缩";
  qc.title = isPng ? "文件较小，保留透明背景，可能影响渐变和细节" : "文件较小，可能出现压缩痕迹";
  qh.setAttribute("aria-checked", String(state.quality === "high"));
  qc.setAttribute("aria-checked", String(state.quality === "compressed"));
  $("quality-seg").classList.remove("disabled");

  if (isPng && state.quality === "high") {
    $("quality-note").textContent = "保留全部颜色 · 保留透明背景";
  } else if (state.quality === "high") {
    $("quality-note").textContent = "保留更多细节";
  } else {
    $("quality-note").textContent = "文件较小";
  }

  const fullName = filename(d);
  const cut = fullName.lastIndexOf("_") + 1;
  const nameEl = $("filename");
  nameEl.textContent = "";
  nameEl.append(fullName.slice(0, cut), document.createElement("br"), fullName.slice(cut));
  nameEl.title = fullName;

  syncOutputSettings();

  $("doc-title").textContent = d.name;
  $("doc-title").title = d.name;
  $("status-crop").textContent = `${ratio().key} · ${px.w} × ${px.h} px`;

  const applied = isApplied(d);
  $<HTMLButtonElement>("apply-toggle").disabled = false;
  $("apply-toggle").setAttribute("aria-checked", String(applied));
  $("save-count").textContent = String(appliedDocs().length);
  $<HTMLButtonElement>("save-all").disabled = state.importing || !appliedDocs().length;
  $("count").textContent = String(state.docs.length);
  $("side-foot").textContent = state.importing
    ? "正在读取图片…"
    : `${state.docs.length} 张 · ${mb(totalBytes())} MB`;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(text: string, type: Toast = "ok"): void {
  $("toast-text").textContent = text;
  const isInfo = type === "info";
  $("toast-check").hidden = isInfo;
  $("toast-info").hidden = !isInfo;
  const el = $("toast");
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

type DragState =
  | { mode: "move"; startX: number; startY: number; crop: Crop; rect: DOMRect }
  | { mode: "resize"; corner: string; crop: Crop; rect: DOMRect };

let drag: DragState | null = null;

function startMove(e: PointerEvent): void {
  if (e.button !== 0) return;
  if ((e.target as Element).closest(".handle")) return;
  const d = doc();
  if (!d) return;
  const rect = photo.getBoundingClientRect();
  if (!rect.width) return;
  drag = { mode: "move", startX: e.clientX, startY: e.clientY, crop: { ...ensureCrop(d)! }, rect };
  cropEl.focus({ preventScroll: true });
  document.body.classList.add("is-dragging");
  e.preventDefault();
  window.addEventListener("pointermove", onDrag);
  window.addEventListener("pointerup", endDrag, { once: true });
}

function startResize(e: PointerEvent, handle: HTMLElement): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const d = doc();
  if (!d) return;
  const rect = photo.getBoundingClientRect();
  if (!rect.width) return;
  drag = { mode: "resize", corner: handle.dataset.corner!, crop: { ...ensureCrop(d)! }, rect };
  handle.focus({ preventScroll: true });
  document.body.classList.add("is-dragging");
  window.addEventListener("pointermove", onDrag);
  window.addEventListener("pointerup", endDrag, { once: true });
}

function onDrag(e: PointerEvent): void {
  if (!drag) return;
  const d = doc();
  if (!d) return;
  const rect = drag.rect;
  let c: Crop;

  if (drag.mode === "move") {
    const dx = (e.clientX - drag.startX) / rect.width;
    const dy = (e.clientY - drag.startY) / rect.height;
    if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) return;
    c = {
      x: clamp(drag.crop.x + dx, 0, 1 - drag.crop.w),
      y: clamp(drag.crop.y + dy, 0, 1 - drag.crop.h),
      w: drag.crop.w,
      h: drag.crop.h,
    };
  } else {
    c = resize(
      drag.crop,
      drag.corner,
      e.clientX - rect.left,
      e.clientY - rect.top,
      rect.width,
      rect.height,
      ratio(),
    );
  }

  state.crops.set(d.id, c);
  updateCropVars();
  updateInspector();
  updateFileList();
}

function endDrag(): void {
  drag = null;
  document.body.classList.remove("is-dragging");
  window.removeEventListener("pointermove", onDrag);
}

let saveOpen = false;
// Bumped by every open and close, so an open that awaited names stops when
// the user closed the sheet meanwhile.
let sheetCall = 0;
let channel: Channel<Progress> | null = null;
let report: Report | null = null;

function qualitySummary(docs = state.docs): string {
  const png = docs.filter((d) => d.format === "PNG").length;
  const jpg = docs.length - png;
  const parts: string[] = [];
  if (jpg) parts.push(`JPEG ${state.quality === "high" ? "高质量" : "标准压缩"}`);
  if (png) parts.push(`PNG ${state.quality === "high" ? "无损保存" : "标准压缩"}`);
  return parts.join(" · ") || "按原格式";
}

function destination(): string {
  return state.inPlace ? "原图所在目录" : state.outDir || "未指定目录";
}

function sheetViews(which: "summary" | "progress" | "done"): void {
  $("sheet-summary-view").hidden = which !== "summary";
  $("sheet-summary-foot").hidden = which !== "summary";
  $("sheet-progress-view").hidden = which !== "progress";
  $("sheet-progress-foot").hidden = which !== "progress";
  $("sheet-done-view").hidden = which !== "done";
  $("sheet-done-foot").hidden = which !== "done";
}

async function openSheet(): Promise<void> {
  if (state.importing || saveOpen) return;
  if (!state.docs.length) return;
  const docs = appliedDocs();
  if (!docs.length) return;
  saveOpen = true;
  const call = ++sheetCall;
  await refreshNames();
  if (call !== sheetCall) return;
  updateInspector();
  const skipped = state.docs.length - docs.length;
  report = null;
  $("sheet-title").textContent = `保存 ${docs.length} 张图片`;
  $("sheet-sub").textContent = skipped
    ? `${docs.length} 张参与 · ${skipped} 张不参与`
    : "按各图裁切设置保存 · 源文件不改";
  $("summary-count").textContent = `${docs.length} 张图片${skipped ? ` · ${skipped} 张不参与` : ""}`;
  const ratioKeys = [...new Set(docs.map((d) => ratio(d).key))];
  $("summary-ratio").textContent = `${ratioKeys.length === 1 ? ratioKeys[0] : "各图比例"} · 原始像素`;
  $("summary-quality").textContent = qualitySummary(docs);
  $("summary-format").textContent = `${[...new Set(docs.map((d) => d.format))].join(" · ")}（跟随原图）`;
  const custom = customCount(docs);
  $("summary-crops").textContent = `${custom} 张手动 · ${docs.length - custom} 张默认${skipped ? ` · ${skipped} 张不参与` : ""}`;
  $("summary-dest").textContent = destination();
  $("sheet-start").textContent = `保存 ${docs.length} 张`;
  $("sheet-count").textContent = `0 / ${docs.length}`;
  $("sheet-pct").textContent = "0%";
  $<HTMLElement>("sheet-bar").style.transform = "scaleX(0)";
  $("done-path").textContent = destination();
  buildSummaryList();
  buildSaveList(docs);
  sheetViews("summary");
  $("scrim").hidden = false;
  $("sheet").hidden = false;
  requestAnimationFrame(() => {
    $("scrim").classList.add("open");
    $("sheet").classList.add("open");
  });
  $("sheet-start").focus({ preventScroll: true });
}

function buildSummaryList(): void {
  const list = $("summary-list");
  list.innerHTML = "";
  state.docs.forEach((d) => {
    const applied = isApplied(d);
    const custom = applied && customCrop(d);
    const row = document.createElement("div");
    row.className = "sum-item";
    if (!applied) row.classList.add("skip");
    row.innerHTML = '<span class="sname"></span><span class="stag"></span>';
    row.querySelector(".sname")!.textContent = filename(d);
    const tag = row.querySelector(".stag")!;
    tag.textContent = !applied ? "不参与" : custom ? "手动" : "默认";
    if (custom) tag.classList.add("custom");
    if (!applied) tag.classList.add("skip");
    list.appendChild(row);
  });
}

function buildSaveList(docs: ReturnType<typeof appliedDocs>): void {
  const list = $("save-list");
  list.innerHTML = "";
  docs.slice(0, 3).forEach((d) => {
    const row = document.createElement("div");
    row.className = "save-item";
    row.dataset.state = "pending";
    row.innerHTML =
      '<span class="mark"><ryugi-icon name="check" size="9"></ryugi-icon></span>' +
      '<span class="sname"></span>';
    row.querySelector(".sname")!.textContent = filename(d);
    list.appendChild(row);
  });
  if (docs.length > 3) {
    const more = document.createElement("div");
    more.className = "save-more";
    more.textContent = `+${docs.length - 3} 个文件`;
    list.appendChild(more);
  }
}

function onProgress(p: Progress): void {
  const total = p.total || 1;
  const done = Math.min(p.done, total);
  $("sheet-count").textContent = `${done} / ${total}`;
  $("sheet-pct").textContent = `${Math.round((done / total) * 100)}%`;
  $<HTMLElement>("sheet-bar").style.transform = `scaleX(${done / total})`;
  // Each row keeps the state its own event gave it: a failed row must not
  // turn into a check when the files after it finish.
  const rows = document.querySelectorAll<HTMLElement>(".save-item");
  rows.forEach((row, i) => {
    if (i === done - 1) row.dataset.state = p.ok ? "done" : "failed";
    else if (i === done) row.dataset.state = "active";
    else if (i > done) row.dataset.state = "pending";
  });
}

let runSeq = 0;
let saving = false;

async function startSave(): Promise<void> {
  if (!saveOpen || saving) return;
  saving = true;
  const run = ++runSeq;
  const docs = appliedDocs();
  const items: SaveItem[] = docs.map((d) => ({
    id: d.id,
    ratio: ratio(d).key,
    crop: ensureCrop(d)!,
  }));
  $("sheet-title").textContent = `正在保存 ${docs.length} 个文件`;
  $("sheet-sub").textContent = `保存到 ${destination()}`;
  $("sheet-count").textContent = `0 / ${docs.length}`;
  $("sheet-pct").textContent = "0%";
  $<HTMLElement>("sheet-bar").style.transform = "scaleX(0)";
  sheetViews("progress");
  buildSaveList(docs);
  $("sheet-cancel").focus({ preventScroll: true });

  const runChannel = new Channel<Progress>((p) => onProgress(p));
  channel = runChannel;
  try {
    const result = await Library.save(
      {
        items,
        quality: state.quality,
        inPlace: state.inPlace,
        outDir: state.outDir,
      },
      runChannel,
    );
    // The page may have cancelled this run and started another one meanwhile.
    if (run !== runSeq) return;
    if (result.canceled) {
      closeSheet();
      return;
    }
    report = result;
    showDone(result);
  } catch (err) {
    if (run !== runSeq) return;
    showToast(errorText(err), "info");
    closeSheet();
  } finally {
    if (run === runSeq) {
      saving = false;
      channel = null;
    }
  }
}

function showDone(result: Report): void {
  const failed = result.failed.length;
  const skipped = state.docs.length - appliedDocs().length;
  $("sheet-title").textContent = "保存完成";
  $("sheet-sub").textContent = "源文件未修改";
  let title = `已保存 ${result.saved.length} 个文件`;
  if (skipped) title += `，${skipped} 张不参与`;
  if (failed) title += `，${failed} 个失败`;
  $("done-title").textContent = title;
  if (failed) {
    const first = result.failed[0];
    if (first) showToast(`${first.name}：${first.error}`, "info");
  }
  if (result.dir) $("done-path").textContent = result.dir;
  sheetViews("done");
  $("sheet-finish").focus({ preventScroll: true });
}

function closeSheet(focusEl?: HTMLElement): void {
  if (!saveOpen) return;
  sheetCall++;
  saveOpen = false;
  // A save still in flight belongs to this sheet: forget it, and stop it.
  runSeq++;
  saving = false;
  channel?.close();
  channel = null;
  $("scrim").classList.remove("open");
  $("sheet").classList.remove("open");
  setTimeout(() => {
    if (saveOpen) return;
    $("scrim").hidden = true;
    $("sheet").hidden = true;
  }, 200);
  (focusEl ?? $("save-all")).focus({ preventScroll: true });
}

let confirmOpen = false;
let confirmAction: (() => void) | null = null;
let confirmReturnFocus: HTMLElement | null = null;

function openConfirm(opts: {
  title: string;
  message: string;
  confirmLabel: string;
  returnFocus?: HTMLElement;
  onConfirm: () => void;
}): void {
  if (confirmOpen) return;
  confirmOpen = true;
  confirmAction = opts.onConfirm;
  confirmReturnFocus = opts.returnFocus ?? (document.activeElement as HTMLElement | null);
  $("confirm-title").textContent = opts.title;
  $("confirm-msg").textContent = opts.message;
  $("confirm-ok").textContent = opts.confirmLabel;
  $("confirm-scrim").hidden = false;
  $("confirm").hidden = false;
  requestAnimationFrame(() => {
    $("confirm-scrim").classList.add("open");
    $("confirm").classList.add("open");
  });
  $("confirm-cancel").focus({ preventScroll: true });
}

function closeConfirm(): void {
  if (!confirmOpen) return;
  confirmOpen = false;
  $("confirm-scrim").classList.remove("open");
  $("confirm").classList.remove("open");
  setTimeout(() => {
    if (confirmOpen) return;
    $("confirm-scrim").hidden = true;
    $("confirm").hidden = true;
  }, 180);
  const f = confirmReturnFocus;
  confirmReturnFocus = null;
  if (f?.isConnected) f.focus({ preventScroll: true });
}

function askRemove(id: string, trigger: HTMLElement): void {
  const d = state.docs.find((x) => x.id === id);
  if (!d) return;
  openConfirm({
    title: "移除这张图片？",
    message: `「${d.name}」会从本次列表移除。源文件不会被删除。`,
    confirmLabel: "移除",
    returnFocus: trigger,
    onConfirm: () => removeDoc(id),
  });
}

function removeDoc(id: string): void {
  const i = state.docs.findIndex((d) => d.id === id);
  if (i < 0) return;
  const wasSelected = state.selectedId === id;
  state.docs.splice(i, 1);
  state.ratios.delete(id);
  state.crops.delete(id);
  state.excluded.delete(id);
  state.names.delete(id);
  if (!state.docs.length) {
    state.selectedId = null;
  } else if (wasSelected) {
    state.selectedId = state.docs[Math.min(i, state.docs.length - 1)]!.id;
    ensureCrop(doc());
  }
  buildFileList();
  updateAll();
  refreshNamesLater();
  const sel = fileList.querySelector<HTMLElement>('.file[aria-pressed="true"]');
  (sel ?? $("add-btn")).focus({ preventScroll: true });
  showToast("已从列表移除，源文件未删除");
}

function clearDocs(): void {
  if (!state.docs.length) return;
  state.docs = [];
  state.ratios.clear();
  state.crops.clear();
  state.excluded.clear();
  state.names.clear();
  state.selectedId = null;
  buildFileList();
  updateAll();
  showToast("列表已清空，源文件未删除");
}

function askClear(): void {
  if (!state.docs.length) return;
  openConfirm({
    title: "清空本次图片？",
    message: `列表中的 ${state.docs.length} 张图片和裁切设置会从本次列表移除。源文件不会被删除。`,
    confirmLabel: "清空",
    returnFocus: $("add-btn"),
    onConfirm: clearDocs,
  });
}

function toggleAddMenu(open: boolean): void {
  $("add-menu").hidden = !open;
  $("add-btn").setAttribute("aria-expanded", String(open));
  $<HTMLButtonElement>("add-clear").disabled = !state.docs.length;
  if (open) $("add-image").focus({ preventScroll: true });
}

function setImporting(importing: boolean): void {
  state.importing = importing;
  for (const id of ["add-btn", "empty-open", "empty-folder"]) {
    $<HTMLButtonElement>(id).disabled = importing;
  }
  $<HTMLButtonElement>("save-all").disabled = importing || !appliedDocs().length;
  $("side-foot").textContent = importing
    ? "正在读取图片…"
    : `${state.docs.length} 张 · ${mb(totalBytes())} MB`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function importWith(pick: () => Promise<ImportResult>, emptyNote = ""): Promise<void> {
  if (state.importing) return;
  if (saveOpen || confirmOpen) {
    showToast("先完成当前操作再添加图片", "info");
    return;
  }
  setImporting(true);
  try {
    const result = await pick();
    const added = result.images;
    if (added.length) {
      state.docs.push(...added);
      state.selectedId = added[0]!.id;
      ensureCrop(doc());
      await refreshNames();
      buildFileList();
    }
    updateAll();
    const messages: string[] = [];
    if (added.length) messages.push(`已添加 ${added.length} 张`);
    if (result.skipped) messages.push(`跳过 ${result.skipped} 个文件，仅支持可读取的 JPG/JPEG、PNG`);
    if (!messages.length && emptyNote) messages.push(emptyNote);
    const tone = result.skipped || !added.length ? "info" : "ok";
    if (messages.length) showToast(messages.join(" · "), tone);
  } catch (err) {
    showToast(errorText(err), "info");
  } finally {
    setImporting(false);
    updateAll();
  }
}

/** Imports files and folders dropped on the window. */
function importDropped(paths: string[]): void {
  dropAnswered = true;
  if (dropBlocked()) {
    showToast(state.importing ? "正在读取图片，请稍后" : "先完成当前操作再添加图片", "info");
    return;
  }
  void importWith(() => Library.importPaths(paths), "没有找到可添加的图片");
}

let dropTimer = 0;
let dropNonce = 0;
let dropAnswered = false;

/** Answers a drop MyGo did not report, so it cannot pass silently. */
function watchDrop(): void {
  dropAnswered = false;
  const nonce = ++dropNonce;
  setTimeout(() => {
    if (nonce !== dropNonce || dropAnswered) return;
    showToast("没有可添加的图片，仅支持 JPG/JPEG、PNG", "info");
  }, 700);
}

/** True while a drop would race the save sheet or an import. */
function dropBlocked(): boolean {
  return state.importing || saveOpen || confirmOpen;
}

function isFileDrag(e: DragEvent): boolean {
  const data = e.dataTransfer;
  if (!data) return false;
  return Array.from(data.types).includes("Files");
}

function hideDropTarget(): void {
  clearTimeout(dropTimer);
  $("drop").hidden = true;
}

/** Shows the drop target while files are dragged over the window. */
function initDropTarget(): void {
  document.addEventListener("dragenter", (e) => {
    if (!isFileDrag(e)) return;
    // Accept the drag so the target can show. MyGo's bridge cancels the drop
    // itself, which keeps the file from replacing the page.
    e.preventDefault();
    if (dropBlocked()) return;
    clearTimeout(dropTimer);
    $("drop").hidden = false;
  });
  document.addEventListener("dragover", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const data = e.dataTransfer;
    if (!data) return;
    // Kept as a copy when blocked: a drop that is refused still arrives, so
    // importDropped can say why.
    data.dropEffect = "copy";
    if (dropBlocked()) return;
    clearTimeout(dropTimer);
    $("drop").hidden = false;
  });
  document.addEventListener("dragleave", () => {
    // Moving over the window's children fires dragleave too, so hide only if
    // no dragover follows.
    clearTimeout(dropTimer);
    dropTimer = setTimeout(hideDropTarget, 180);
  });
  document.addEventListener("drop", (e) => {
    hideDropTarget();
    if (isFileDrag(e)) watchDrop();
  });
  document.addEventListener("dragend", hideDropTarget);
  window.addEventListener("blur", hideDropTarget);
}

function persistSettings(): void {
  void Library.updateSettings({
    inPlace: state.inPlace,
    outDir: state.outDir,
    quality: state.quality,
  }).catch(() => {
    // The settings are a convenience; saving still uses the page's values.
  });
}

function setQuality(quality: Quality): void {
  if (!doc()) return;
  state.quality = quality;
  persistSettings();
  updateInspector();
  void refreshNames().then(() => updateInspector());
}

function init(): void {
  buildFileList();
  buildRatioGrid();
  ensureCrop(doc());
  updateAll();

  requestAnimationFrame(() => layoutPhoto());
  new ResizeObserver(() => layoutPhoto()).observe(stage);
  img.addEventListener("load", () => layoutPhoto());

  cropEl.addEventListener("pointerdown", startMove);
  initDropTarget();
  onFileDrop(({ paths }) => {
    if (paths.length) importDropped(paths);
  });
  document.querySelectorAll<HTMLElement>(".handle").forEach((h) => {
    h.addEventListener("pointerdown", (e) => startResize(e, h));
  });
  cropEl.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.01 : 0.002;
    let dx = 0;
    let dy = 0;
    if (e.key === "ArrowLeft") dx = -1;
    else if (e.key === "ArrowRight") dx = 1;
    else if (e.key === "ArrowUp") dy = -1;
    else if (e.key === "ArrowDown") dy = 1;
    else return;
    e.preventDefault();
    const d = doc();
    if (!d) return;
    state.crops.set(d.id, nudge(ensureCrop(d)!, dx, dy, step));
    updateCropVars();
    updateInspector();
    updateFileList();
  });

  $("save-all").addEventListener("click", () => void openSheet());
  $("copy-name").addEventListener("click", async () => {
    const d = doc();
    if (!d) return;
    try {
      await navigator.clipboard.writeText(filename(d));
      showToast("文件名已复制");
    } catch {
      showToast("复制失败，请手动选择文件名", "info");
    }
  });

  $("empty-open").addEventListener("click", () => void importWith(() => Library.pickImages()));
  $("empty-folder").addEventListener("click", () => void importWith(() => Library.pickFolder()));

  $("add-btn").addEventListener("click", () => toggleAddMenu(Boolean($("add-menu").hidden)));
  $("add-image").addEventListener("click", () => {
    toggleAddMenu(false);
    void importWith(() => Library.pickImages());
  });
  $("add-folder").addEventListener("click", () => {
    toggleAddMenu(false);
    void importWith(() => Library.pickFolder());
  });
  $("add-clear").addEventListener("click", () => {
    toggleAddMenu(false);
    askClear();
  });
  document.addEventListener("click", (e) => {
    if ($("add-menu").hidden) return;
    const target = e.target as Element;
    if (target.closest("#add-menu") || target.closest("#add-btn")) return;
    toggleAddMenu(false);
  });

  $("quality-high").addEventListener("click", () => setQuality("high"));
  $("quality-compressed").addEventListener("click", () => setQuality("compressed"));
  $<HTMLInputElement>("in-place").addEventListener("change", (e) => {
    state.inPlace = (e.target as HTMLInputElement).checked;
    persistSettings();
    void refreshNames().then(() => updateInspector());
  });
  pathRow.addEventListener("click", async () => {
    if (state.inPlace) return;
    try {
      const dir = await Library.chooseOutputDir();
      if (!dir) return;
      state.outDir = dir;
      persistSettings();
      void refreshNames().then(() => updateInspector());
    } catch (err) {
      showToast(errorText(err), "info");
    }
  });

  $("summary-cancel").addEventListener("click", () => closeSheet());
  $("sheet-start").addEventListener("click", () => void startSave());
  $("apply-toggle").addEventListener("click", toggleApplied);
  $("sheet-cancel").addEventListener("click", () => closeSheet());
  $("sheet-close").addEventListener("click", () => closeSheet());
  $("sheet-finish").addEventListener("click", () => closeSheet());
  $("sheet-finish-clear").addEventListener("click", () => {
    clearDocs();
    closeSheet($("add-btn"));
  });
  $("sheet-reveal").addEventListener("click", () => {
    const fromReport = report?.dir || report?.saved[0] || "";
    Library.showInFolder(fromReport);
  });

  $("confirm-cancel").addEventListener("click", closeConfirm);
  $("confirm-scrim").addEventListener("click", closeConfirm);
  $("confirm-ok").addEventListener("click", () => {
    const action = confirmAction;
    closeConfirm();
    action?.();
  });

  window.addEventListener("keydown", (e) => {
    if (confirmOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeConfirm();
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (!saveOpen) void openSheet();
    } else if (e.key === "Escape" && saveOpen) {
      e.preventDefault();
      closeSheet();
    } else if (e.key === "Escape" && !$("add-menu").hidden) {
      e.preventDefault();
      toggleAddMenu(false);
      $("add-btn").focus({ preventScroll: true });
    }
  });

  void Library.settings()
    .then((s) => {
      state.inPlace = s.inPlace;
      state.outDir = s.outDir;
      state.quality = s.quality === "high" ? "high" : "compressed";
      updateInspector();
    })
    .catch(() => {
      // Defaults stay.
    });
}

init();
