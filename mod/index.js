// ここ付箋 — 付箋を、ファイルやフォルダに貼る。付箋は貼った場所のフォルダの中に保存するので、はがれても、失くしても、場所から離れない。
// 選んで、書いて、Enter。貼ったファイルの横に付箋が出て、フォルダを開くたびに目に入る。通信はしない。
// 付箋のデータは、そのフォルダの .explorer_plus の中（本体の folderData）に置く。ほかのファイルは書き換えない。
import * as S from "./store.js";
import * as V from "./view.js";
import { createData } from "./data.js";

const ep = window.explorerPlus;
const data = createData(ep);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const SAVE_MS = 700;          // 書いている途中の自動保存
const POLL_MS = 15_000;       // 同期で届いた付箋を見に行く間隔
const CARRY_MS = 10 * 60_000; // 「連れていく」の待ち時間
const SUB_LIMIT = 300;        // 子フォルダの付箋を先読みする数
const SUBS_MS = 20_000;       // 子フォルダの付箋を読み直す間隔のいちばん短いもの

const st = {
  settings: { fontSize: 14, color: "yellow", badge: true },
  folder: null,               // 本体から届いた今のフォルダ
  ref: null,                  // その { id, path }
  doc: S.emptyDoc(),          // 今のフォルダの付箋
  subs: new Map(),            // 子フォルダ（小文字のパス）→ { ref, notes（フォルダに貼った付箋）, total（中の付箋の数） }
  lost: new Map(),            // はがれた付箋の id → 今の場所（ep.resolve の結果）か null
  sel: null,                  // 選んでいる行（小文字のパス）
  mode: "here",               // "here" か "all"
  only: false,                // 付箋のあるものだけ
  color: "yellow",            // 次に貼る付箋の色
  editing: null,              // { id, home }：書き直している付箋
  renaming: null,
  flash: null,                // 見せたい付箋の id（貼ったばかり・探して来た）
  places: [], query: "", tab: "active", loading: false,
  seq: 0, subsSeq: 0, subsAt: 0, tried: new Set(),
  stale: false, pointerDown: false, noClick: false, saveTimer: 0, raf: 0, badge: -1, undo: null,
};

const ctx = await ep.ready();
if (ctx.background) startBackground();
else startView();

// ---- 右クリックから貼る（見えない所で動く） ----------------------------------------------------

function startBackground() {
  ep.onMenu(async ({ id, items, folder }) => {
    try {
      if (id === "stick") await stickFromMenu(items, folder);
    } catch (e) {
      toast(failText(e));
    } finally {
      await ep.menu.done().catch(() => {});
    }
  });
}

async function stickFromMenu(items, folder) {
  const one = items[0];
  let home, on = null, label;
  if (one && one.kind === "file") {
    home = folder;
    on = { name: one.name, ids: one.id ? [one.id] : [] };
    label = one.name;
  } else if (one) {
    home = { id: one.id, path: one.path };
    label = `${one.name} フォルダ`;
  } else {
    home = folder;
    label = "このフォルダ";
  }
  if (!home) return toast("ここには貼れません。");
  const text = S.cleanText(await ep.ui.ask({ label: `${label}に貼る付箋`, placeholder: "書いて Enter", okLabel: "貼る" }));
  if (!text) return;
  const settings = await ep.settings.get().catch(() => st.settings);
  const now = Date.now();
  const after = await data.update(home, (d) => S.addNote(d, { text, color: settings.color, on, now }).doc);
  data.remember(home, S.nameOf(home.path), after);
  toast("付箋を貼りました。ここ付箋のビューで見られます。");
}

// ---- 画面の土台 ------------------------------------------------------------------------------

function startView() {
  document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: new URL("./style.css", import.meta.url).href }));
  document.documentElement.dataset.theme = ctx.theme;
  document.body.innerHTML = `<div id="app">
    <header class="bar">
      <button class="ic" id="up" title="ひとつ上へ" aria-label="ひとつ上へ"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <nav class="crumbs" id="crumbs"></nav>
      <div class="seg"><button data-mode="here">この場所 <b id="nhere"></b></button><button data-mode="all">すべての付箋</button></div>
    </header>
    <main id="main"></main>
    <footer class="compose" id="composer">
      <div class="to"><span class="lbl">貼る先</span><span class="chip" id="to"></span><button class="x" id="clear-to" title="選びなおす" aria-label="選びなおす" hidden>×</button><span class="sp"></span><span class="colors" id="colors"></span></div>
      <div class="inp"><textarea id="compose" rows="1" maxlength="${S.LIMITS.text}" placeholder="ここに書いて Enter で貼る" aria-label="付箋の文" title="Shift + Enter で改行"></textarea><button class="primary" id="post">貼る</button></div>
    </footer>
    <div id="snack" class="snack" hidden></div>
  </div>`;
  wire();
  ep.onTheme((t) => (document.documentElement.dataset.theme = t));
  ep.settings.get().then(applySettings).catch(() => applySettings({}));
  ep.onSettings(applySettings);
  ep.onFolder(onFolder);
  ep.onFolderData(() => reload());
  ep.onMenu(({ id, items }) => {
    if (id === "look" && items[0] && items[0].kind === "folder") ep.navigate(items[0].path).catch(() => {});
  });
  ep.onAction(({ action, entry }) => {
    if (action === "rename") startRename(entry);
  });
  ep.onDragTargets(() => ep.drag.targets(folderTargets()).catch(() => {}));
  ep.commands.set([
    { id: "all", label: "すべての付箋を見る" },
    { id: "here", label: "この場所の付箋を見る" },
    { id: "only", label: "付箋のあるものだけ見る・戻す" },
  ]).catch(() => {});
  ep.onCommand((id) => {
    if (id === "all") openAll();
    if (id === "here") openHere();
    if (id === "only") {
      st.only = !st.only;
      openHere();
    }
  });
  window.addEventListener("focus", () => reload({ subs: true }));
  document.addEventListener("visibilitychange", () => !document.hidden && reload({ subs: true }));
  setInterval(() => !document.hidden && !st.editing && reload(), POLL_MS);
}

function applySettings(v) {
  st.settings = { ...st.settings, ...v };
  st.color = S.COLORS.some((c) => c.id === st.settings.color) ? st.settings.color : "yellow";
  document.documentElement.style.setProperty("--fs", `${Math.min(20, Math.max(12, Number(st.settings.fontSize) || 14))}px`);
  if (!st.settings.badge) ep.ui.tab({ badge: null }).catch(() => {});
  st.badge = -1;
  if (st.folder) render();
  renderComposer();
}

// ---- フォルダを読む -----------------------------------------------------------------------------

async function onFolder(folder) {
  const moved = !st.folder || !S.samePath(st.folder.path, folder.path);
  st.folder = folder;
  st.ref = { id: folder.id, path: folder.path };
  if (moved) {
    Object.assign(st, { sel: null, doc: S.emptyDoc(), subs: new Map(), lost: new Map(), mode: "here", editing: null, renaming: null, query: "" });
    $("#main").scrollTop = 0;
  }
  render(moved);
  await reload({ subs: moved, force: moved });
  if (moved) {
    await settleCarry();
    focusComposer();
  }
}

/**
 * 今のフォルダの付箋を読み直す。同期やほかのウィンドウで変わっていれば、画面に出す。
 * subs：子フォルダの付箋も読み直す。force でなければ、20秒以内にやったばかりのときは省く（ウィンドウを行き来するたびに、全部は読まない）
 */
async function reload({ subs = false, force = false } = {}) {
  const folder = st.folder;
  if (!folder) return;
  if (subs && (force || Date.now() - st.subsAt > SUBS_MS)) st.subsAt = Date.now();
  else subs = false;
  const seq = ++st.seq;
  let doc;
  try {
    doc = await data.load(st.ref);
  } catch (e) {
    return console.warn("付箋を読めませんでした", e.message);
  }
  if (seq !== st.seq || !S.samePath(folder.path, st.folder.path)) return;
  const changed = JSON.stringify(doc) !== JSON.stringify(st.doc);
  st.doc = doc;
  if (changed) render();
  data.remember(st.ref, folder.name, doc);
  learn();
  checkLost();
  if (subs) loadSubs();
}

/** 名前の変更や別の PC のIDを、付箋に覚え直す。書けないフォルダでは何もしない */
async function learn() {
  const m = S.matchNotes(st.doc.notes, st.folder.entries);
  if (!m.learned.size) return;
  const sig = S.lower(st.folder.path) + JSON.stringify([...m.learned]);
  if (st.tried.has(sig)) return;
  st.tried.add(sig);
  try {
    const after = await data.update(st.ref, (d) => S.applyLearned(d, m.learned));
    if (S.samePath(st.ref.path, st.folder.path)) st.doc = after;
  } catch (e) {
    console.warn("貼り先を覚え直せませんでした", e.message);
  }
}

/** 子フォルダに貼られた付箋を先読みする（行の横に見せる・すべての付箋の索引に覚える） */
async function loadSubs() {
  const folder = st.folder;
  const stamp = ++st.subsSeq;
  const dirs = folder.entries.filter((e) => e.kind === "folder").slice(0, SUB_LIMIT);
  let next = 0;
  const worker = async () => {
    while (next < dirs.length) {
      const e = dirs[next++];
      if (stamp !== st.subsSeq || !S.samePath(folder.path, st.folder.path)) return;
      const ref = { id: e.id, path: e.path };
      try {
        const doc = await data.load(ref);
        data.remember(ref, e.name, doc);
        keepSub(S.lower(e.path), ref, doc);
        scheduleRender();
      } catch {
        // 読めない子フォルダは飛ばす
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

function keepSub(key, ref, doc) {
  const active = doc.notes.filter((n) => !n.gone);
  if (active.length) st.subs.set(key, { ref, notes: active.filter((n) => !n.on).sort(S.byTime), total: active.length });
  else st.subs.delete(key);
}

// ---- はがれた付箋：貼っていたファイルが、このフォルダに無い ----------------------------------------------

function checkLost() {
  const orphans = S.matchNotes(st.doc.notes, st.folder.entries).orphans;
  const ids = new Set(orphans.map((n) => n.id));
  for (const id of [...st.lost.keys()]) if (!ids.has(id)) st.lost.delete(id);
  const todo = orphans.filter((n) => !st.lost.has(n.id));
  for (const n of todo) st.lost.set(n.id, null);
  if (todo.length) resolveLost(todo);
}

/** 動かされたファイルを、ファイルIDから探す。名前が同じものだけ信じる（別の PC のIDと偶然重なっても、間違えない） */
async function resolveLost(list) {
  const folder = st.folder;
  const refs = [];
  const owners = [];
  for (const n of list) for (const id of n.on.ids) {
    refs.push({ id, path: S.joinPath(folder.path, n.on.name) });
    owners.push(n);
  }
  if (!refs.length) return;
  let found;
  try {
    found = await ep.resolve(refs);
  } catch {
    return;
  }
  if (!S.samePath(folder.path, st.folder.path)) return;
  let any = false;
  found.forEach((r, i) => {
    const n = owners[i];
    if (!r || r.kind !== "file" || S.lower(r.name) !== S.lower(n.on.name) || S.samePath(S.parentOf(r.path), folder.path)) return;
    st.lost.set(n.id, r);
    any = true;
  });
  if (any) render();
}

/** 付箋を、動かされたファイルの新しい場所へ連れていく：そのフォルダへ移って、着いたら付箋を移す */
async function carry(id) {
  const note = S.findNote(st.doc, id);
  const found = st.lost.get(id);
  if (!note || !found) return;
  const toPath = S.parentOf(found.path);
  await ep.storage.set("carry", { note, src: st.ref, toPath, t: Date.now() });
  await ep.navigate(toPath).catch((e) => toast(failText(e)));
}

async function settleCarry() {
  const c = await ep.storage.get("carry").catch(() => null);
  if (!c) return;
  if (Date.now() - c.t > CARRY_MS) return ep.storage.delete("carry").catch(() => {});
  if (!S.samePath(c.toPath, st.folder.path)) return;
  await ep.storage.delete("carry").catch(() => {});
  const note = S.normalizeDoc({ notes: [c.note] }).notes[0];
  if (!note || !note.on) return;
  const file = st.folder.entries.find((e) => e.kind === "file" && S.lower(e.name) === S.lower(note.on.name));
  const on = { name: file ? file.name : note.on.name, ids: file && file.id ? [file.id] : [] };
  try {
    const after = await data.update(st.ref, (d) => S.importNote(d, note, on));
    await data.update(c.src, (d) => S.removeNote(d, note.id));
    st.doc = after;
    st.flash = note.id;
    render();
    data.remember(st.ref, st.folder.name, after);
    data.load(c.src).then((d) => data.remember(c.src, S.nameOf(c.src.path), d)).catch(() => {});
    toast("付箋を連れてきました。");
  } catch (e) {
    toast(failText(e));
  }
}

// ---- 画面を描く ----------------------------------------------------------------------------------

function scheduleRender() {
  if (st.raf) return;
  st.raf = requestAnimationFrame(() => {
    st.raf = 0;
    render();
  });
}

/** 書き直している間・マウスを押している間は作り直さない（書きかけと、押したボタンが消えないように）。あとでまとめて描く */
function render(force = false) {
  if (!st.folder) return;
  if (!force && (st.editing || st.pointerDown)) {
    st.stale = true;
    return;
  }
  st.stale = false;
  renderBar();
  renderComposer();
  const main = $("#main");
  const top = main.scrollTop;
  const anchor = st.mode === "here" ? anchorRow(main) : null;
  if (st.mode === "all") {
    main.innerHTML = V.allBarHtml(allModel()) + `<div id="allbody">${V.allBodyHtml(allModel())}</div>`;
  } else {
    main.innerHTML = V.hereHtml(hereModel());
  }
  main.scrollTop = top;
  restoreAnchor(main, anchor);
  showFlash();
}

/** 作り直しても、見ている行が動かないように、いちばん上に見えている行を覚える（見えていない行の高さは、作り直すと見積もりになるため） */
function anchorRow(main) {
  const edge = main.getBoundingClientRect().top;
  for (const r of $$(".row", main)) {
    const box = r.getBoundingClientRect();
    if (box.bottom > edge + 1) return { key: r.dataset.key, off: box.top - edge };
  }
  return null;
}

function restoreAnchor(main, anchor) {
  const r = anchor && rowEl(anchor.key);
  if (r) main.scrollTop += r.getBoundingClientRect().top - main.getBoundingClientRect().top - anchor.off;
}

function flushStale() {
  if (st.stale && !st.editing && !st.pointerDown) render();
}

const entryOf = (key) => (st.folder ? st.folder.entries.find((e) => S.lower(e.path) === key) || null : null);

function chipHtml(n, home, extra = {}) {
  return V.noteHtml(n, { home, now: Date.now(), editing: !!st.editing && st.editing.id === n.id, flash: st.flash === n.id, ...extra });
}

function hereModel() {
  const f = st.folder;
  const now = Date.now();
  const m = S.matchNotes(st.doc.notes, f.entries);
  const rows = [];
  for (const e of f.entries) {
    const key = S.lower(e.path);
    const isDir = e.kind === "folder";
    const sub = isDir ? st.subs.get(key) : null;
    const notes = isDir ? (sub ? sub.notes : []) : (m.byPath.get(key) || []).slice().sort(S.byTime);
    const has = notes.length > 0 || (!!sub && sub.total > 0);
    if (e.hidden && !has && st.sel !== key) continue;
    if (st.only && !has) continue;
    const shown = isDir ? notes.slice(0, 3) : notes;
    rows.push(V.rowHtml(e, {
      sel: st.sel === key,
      notes: shown.map((n) => chipHtml(n, isDir ? key : ".")),
      more: notes.length - shown.length,
      badge: sub ? sub.total : 0,
      renaming: st.renaming === key,
      now,
    }));
  }
  return {
    board: m.general.slice().sort(S.byTime).map((n) => chipHtml(n, ".")),
    orphans: m.orphans.slice().sort(S.byTime).map((n) => chipHtml(n, ".", { lost: V.lostHtml(n, st.lost.get(n.id) || null) })),
    rows,
    total: f.entries.filter((e) => !e.hidden).length,
    only: st.only,
  };
}

function allModel() {
  const counts = S.countNotes(st.places);
  return { query: st.query, tab: st.tab, counts, now: Date.now(), loading: st.loading, groups: S.searchPlaces(st.places, st.query, st.tab === "peeled") };
}

function renderAllBody() {
  const body = $("#allbody");
  if (body) body.innerHTML = V.allBodyHtml(allModel());
}

function renderBar() {
  const f = st.folder;
  const list = S.crumbs(f.path);
  $("#crumbs").innerHTML = list
    .map((c, i) => `<button class="crumb${i === list.length - 1 ? " cur" : ""}" data-path="${V.esc(c.path)}">${V.esc(c.name)}</button>`)
    .join('<span class="sep">›</span>');
  $("#up").disabled = !f.parentPath;
  for (const b of $$(".seg button")) b.classList.toggle("on", b.dataset.mode === st.mode);
  const m = S.matchNotes(st.doc.notes, f.entries);
  const n = m.general.length + m.orphans.length + [...m.byPath.values()].reduce((a, l) => a + l.length, 0);
  $("#nhere").textContent = n ? String(n) : "";
  if (n !== st.badge) {
    st.badge = n;
    if (st.settings.badge) ep.ui.tab({ badge: n ? String(n) : null }).catch(() => {});
  }
}

function composeTarget() {
  const e = st.sel && entryOf(st.sel);
  if (e && e.kind === "file") return { home: st.ref, homeKey: ".", on: { name: e.name, ids: e.id ? [e.id] : [] }, label: `📄 ${e.name}` };
  if (e) return { home: { id: e.id, path: e.path }, homeKey: S.lower(e.path), on: null, label: `📁 ${e.name} フォルダ` };
  return { home: st.ref, homeKey: ".", on: null, label: "📁 このフォルダ" };
}

function renderComposer() {
  const box = $("#composer");
  if (!box) return;
  box.hidden = st.mode === "all" || !st.folder;
  if (!st.folder) return;
  if (st.sel && !entryOf(st.sel)) st.sel = null;   // 選んでいた行が、消えた・名前が変わった
  const t = composeTarget();
  $("#to").textContent = t.label;
  $("#to").title = t.label;
  $("#clear-to").hidden = !st.sel;
  $("#colors").innerHTML = V.dotsHtml(st.color).replaceAll('data-act="color"', 'data-act="next-color"');
}

function showFlash() {
  if (!st.flash) return;
  const el = noteEl(st.flash);
  if (!el) return;
  el.scrollIntoView({ block: "nearest" });
  st.flash = null;
}

const noteEl = (id) => $$(".note[data-note]").find((el) => el.dataset.note === id) || null;

// ---- 貼る ---------------------------------------------------------------------------------------

async function post() {
  const box = $("#compose");
  const text = S.cleanText(box.value);
  if (!text) return;
  const t = composeTarget();
  const now = Date.now();
  let made;
  try {
    const after = await data.update(t.home, (d) => {
      const r = S.addNote(d, { text, color: st.color, on: t.on, now });
      made = r.note;
      return r.doc;
    });
    box.value = "";
    autosize(box);
    applyDoc(t.homeKey, after, t.home);
    st.flash = made.id;
    render(true);
  } catch (e) {
    toast(failText(e));
  }
}

/** 書き込んだあとの doc を、画面と索引に反映する。homeKey：現在のフォルダは "."、子フォルダは小文字のパス */
function applyDoc(homeKey, doc, ref) {
  if (homeKey === ".") {
    st.doc = doc;
    data.remember(st.ref, st.folder.name, doc);
    return;
  }
  keepSub(homeKey, ref, doc);
  const e = entryOf(homeKey);
  data.remember(ref, e ? e.name : S.nameOf(ref.path), doc);
}

const homeRef = (key) => (key === "." ? st.ref : st.subs.get(key)?.ref || (entryOf(key) ? { id: entryOf(key).id, path: entryOf(key).path } : null));

function noteIn(homeKey, id) {
  if (homeKey === ".") return S.findNote(st.doc, id);
  const sub = st.subs.get(homeKey);
  return sub ? sub.notes.find((n) => n.id === id) || null : null;
}

function autosize(ta) {
  if (ta.closest(".note.sized")) return void (ta.style.height = "");   // 大きさを決めた付箋は、付箋いっぱいに広げる
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`;
}

// ---- 書き直す ------------------------------------------------------------------------------------

function startEdit(id, home) {
  if (st.editing || !noteIn(home, id)) return;
  st.editing = { id, home };
  render(true);
  const ta = $(".note.editing textarea");
  if (!ta) {
    st.editing = null;
    return;
  }
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  autosize(ta);
}

/** 書いた文を保存する。空にしたときは何もしない（付箋を消すのは「はがす」） */
async function saveText(ed, text) {
  const clean = S.cleanText(text);
  const ref = homeRef(ed.home);
  if (!clean || !ref) return;
  const now = Date.now();
  try {
    applyDoc(ed.home, await data.update(ref, (d) => S.editNote(d, ed.id, { text: clean }, now)), ref);
  } catch (e) {
    toast(failText(e));
  }
}

async function commitEdit() {
  const ed = st.editing;
  if (!ed) return;
  const el = noteEl(ed.id);
  const ta = el && $("textarea", el);
  clearTimeout(st.saveTimer);
  st.editing = null;
  if (ta) await saveText(ed, ta.value);
  const n = noteIn(ed.home, ed.id);
  if (el && el.isConnected) {
    if (n) el.outerHTML = chipHtml(n, ed.home);
    else el.remove();
  }
  st.stale = true;
  setTimeout(flushStale, 0);
}

function changeColor(id, home, color) {
  const ref = homeRef(home);
  if (!ref) return;
  const el = noteEl(id);
  if (el) el.className = el.className.replace(/\bc-\w+/, `c-${color}`);
  const now = Date.now();
  data.update(ref, (d) => S.editNote(d, id, { color }, now)).then((after) => applyDoc(home, after, ref)).catch((e) => toast(failText(e)));
}

// ---- はがす・戻す ---------------------------------------------------------------------------------

async function peel(id, home) {
  const ref = homeRef(home);
  if (!ref) return;
  try {
    const now = Date.now();
    applyDoc(home, await data.update(ref, (d) => S.peelNote(d, id, now)), ref);
    render(true);
    undoable("付箋をはがしました。", async () => {
      applyDoc(home, await data.update(ref, (d) => S.restoreNote(d, id, Date.now())), ref);
      render(true);
    });
  } catch (e) {
    toast(failText(e));
  }
}

/**
 * 付箋を貼りなおす。to：{ home, on }（home は "." か子フォルダの小文字のパス、on は貼るファイルか null）。
 * 同じフォルダの中なら貼り先を変えるだけ。別のフォルダなら、先に新しいほうへ書いてから、元から外す
 * （途中で止まっても、付箋は失われない。付箋のID が同じなので、やりなおしても増えない）
 */
async function moveNoteTo(id, fromHome, to, { undo = true } = {}) {
  const note = noteIn(fromHome, id);
  const from = homeRef(fromHome);
  const dest = homeRef(to.home);
  if (!note || !from || !dest) return;
  const fromOn = note.on;
  try {
    if (fromHome === to.home) {
      applyDoc(fromHome, await data.update(from, (d) => S.moveNote(d, id, to.on)), from);
    } else {
      applyDoc(to.home, await data.update(dest, (d) => S.importNote(d, note, to.on)), dest);
      applyDoc(fromHome, await data.update(from, (d) => S.removeNote(d, id)), from);
    }
    st.flash = id;
    render(true);
    if (undo) undoable("付箋を貼りなおしました。", () => moveNoteTo(id, to.home, { home: fromHome, on: fromOn }, { undo: false }));
  } catch (e) {
    toast(failText(e));
  }
}

/** 付箋の大きさとずれを画面に反映する（作り直さずに、この付箋だけ） */
function styleNote(el, n) {
  for (const [k, v, unit] of [["--nw", n.w, "px"], ["--nh", n.h, "px"], ["--nx", n.x, "px"], ["--ny", n.y, "px"], ["--nz", n.z, ""]]) {
    if (v) el.style.setProperty(k, `${v}${unit}`);
    else el.style.removeProperty(k);
  }
  el.classList.toggle("sized", !!n.h);
}

/** 付箋の大きさ・ずれを保存する。patch：{ w?, h?, x?, y? }（0 でふつうに戻す） */
async function saveLayout(id, home, patch) {
  const ref = homeRef(home);
  if (!ref) return;
  try {
    applyDoc(home, await data.update(ref, (d) => S.layoutNote(d, id, patch)), ref);
    const n = noteIn(home, id);
    const el = noteEl(id);
    if (n && el) styleNote(el, n);
  } catch (e) {
    toast(failText(e));
  }
}

function undoable(text, undo) {
  const box = $("#snack");
  clearTimeout(st.undo?.timer);
  st.undo = { undo, timer: setTimeout(hideUndo, 8000) };
  box.innerHTML = `<span>${V.esc(text)}</span><button data-act="undo">元に戻す</button>`;
  box.hidden = false;
}

function hideUndo() {
  clearTimeout(st.undo?.timer);
  st.undo = null;
  $("#snack").hidden = true;
}

const toast = (text) => ep.ui.toast(text).catch(() => {});

function failText(e) {
  switch (e && e.code) {
    case "full":
    case "too-large": return "この場所は付箋がいっぱいです。はがした付箋を消してください。";
    case "denied": return "この場所には書き込めません。";
    case "not-found": return "場所が見つかりません。";
    default: return `付箋を残せませんでした：${(e && e.message) || e}`;
  }
}

// ---- すべての付箋 ---------------------------------------------------------------------------------

function openHere() {
  st.mode = "here";
  render(true);
  focusComposer();
}

async function openAll() {
  if (st.editing) await commitEdit();
  st.mode = "all";
  st.loading = true;
  render(true);
  const list = await data.places();
  try {
    const found = await ep.resolve(list.map((p) => ({ id: p.id, path: p.path })));
    list.forEach((p, i) => {
      p.found = !!found[i];
      if (found[i]) {
        p.path = found[i].path;
        p.name = found[i].name;
      }
    });
  } catch {
    // 場所を確かめられなくても、付箋は見せる
  }
  st.places = list;
  st.loading = false;
  if (st.mode === "all") render(true);
}

const placeOf = (key) => st.places.find((p) => p.key === key) || null;

/** すべての付箋から、ある場所の付箋を書き換える。今開いているフォルダなら、画面にも反映する */
async function changePlace(place, change) {
  const ref = { id: place.id, path: place.path };
  const after = await data.update(ref, change);
  const sum = S.summarize(ref, place.name, after, Date.now());
  place.notes = sum.notes;
  data.remember(ref, place.name, after);
  if (st.folder && S.samePath(place.path, st.folder.path)) st.doc = after;
  else keepSub(S.lower(place.path), ref, after);
}

async function goPlace(place, noteId) {
  st.flash = noteId || null;
  if (S.samePath(place.path, st.folder.path)) return openHere();
  await ep.navigate(place.path).catch((e) => toast(failText(e)));
}

async function allAction(act, btn) {
  const place = placeOf(btn.dataset.place);
  const id = btn.dataset.note;
  if (!place) return;
  try {
    if (act === "go") return goPlace(place, id);
    if (act === "forget") {
      await data.forget(place.key);
      st.places = st.places.filter((p) => p !== place);
    } else if (act === "peel-all") {
      await changePlace(place, (d) => S.peelNote(d, id, Date.now()));
    } else if (act === "restore") {
      await changePlace(place, (d) => S.restoreNote(d, id, Date.now()));
    } else if (act === "erase") {
      if (!(await ep.ui.confirm("この付箋を完全に消します。元に戻せません。", { okLabel: "消す" }))) return;
      await changePlace(place, (d) => S.removeNote(d, id));
    }
    st.places = st.places.filter((p) => p.notes.length);
    render(true);
  } catch (e) {
    toast(failText(e));
  }
}

// ---- 行の操作 -------------------------------------------------------------------------------------

function select(key) {
  st.sel = key;
  for (const r of $$(".row")) r.classList.toggle("sel", r.dataset.key === key);
  renderComposer();
}

/** 書く欄に入る。ほかの入力欄にいるときは動かさない。soon が false なら、すぐに入る（押した直後に打ち始めても、取りこぼさない） */
function focusComposer(soon = true) {
  const run = () => {
    const a = document.activeElement;
    if (st.mode === "here" && !st.editing && !st.renaming && !(a && a !== document.body && a.matches("input, textarea"))) $("#compose")?.focus();
  };
  if (soon) setTimeout(run, 0);
  else run();
}

function moveSel(d) {
  const rows = $$(".row");
  if (!rows.length) return;
  const i = rows.findIndex((r) => r.dataset.key === st.sel);
  const next = rows[Math.min(rows.length - 1, Math.max(0, i < 0 ? (d > 0 ? 0 : rows.length - 1) : i + d))];
  select(next.dataset.key);
  next.scrollIntoView({ block: "nearest" });
}

const rowEl = (key) => $$(".row").find((r) => r.dataset.key === key) || null;
const refOf = (e) => ({ id: e.id, path: e.path });

function openSel() {
  const e = st.sel && entryOf(st.sel);
  const el = e && rowEl(st.sel);
  if (e) ep.open(refOf(e), { from: el ? el.getBoundingClientRect() : undefined }).catch((err) => toast(err.message));
}

async function trashSel() {
  const e = st.sel && entryOf(st.sel);
  if (!e) return;
  const el = rowEl(st.sel);
  await ep.trash([refOf(e)], { from: el ? el.getBoundingClientRect() : undefined }).catch((err) => err.code !== "denied" && toast(err.message));
}

/** 一覧のキー操作。使ったら true */
function listKey(e) {
  if (st.mode !== "here" || st.editing || st.renaming) return false;
  if (e.key === "ArrowDown") moveSel(1);
  else if (e.key === "ArrowUp") moveSel(-1);
  else if (e.key === "Enter") openSel();
  else if (e.key === "Delete") trashSel();
  else if (e.key === "F2") {
    const en = st.sel && entryOf(st.sel);
    if (!en) return false;
    startRename(en);
  } else if (e.key === "Escape") select(null);
  else return false;
  return true;
}

function startRename(entry) {
  const key = S.lower(entry.path);
  st.renaming = key;
  st.sel = key;
  st.mode = "here";
  render(true);
  const input = $(".rn");
  if (!input) return;
  input.focus();
  const dot = entry.kind === "file" ? input.value.lastIndexOf(".") : -1;
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
}

async function finishRename(input, apply) {
  const key = st.renaming;
  if (!key) return;
  st.renaming = null;
  const e = entryOf(key);
  const name = input.value.trim();
  if (apply && e && name && name !== e.name) {
    try {
      const renamed = await ep.rename(refOf(e), name);
      st.sel = S.lower(renamed.path);
    } catch (err) {
      toast(err.code === "exists" ? "同じ名前がもうあります。" : err.code === "invalid" ? "その名前は使えません。" : err.message);
    }
  }
  render(true);
}

// ---- 本体のドラッグ（ファイルを動かす） --------------------------------------------------------------

const folderTargets = () => $$('.row[data-kind="folder"]').map((el) => ({ entry: refOf(entryOf(el.dataset.key) || { id: "", path: "" }), rect: el.getBoundingClientRect() }));

// ---- 入力の配線 ------------------------------------------------------------------------------------

function wire() {
  const main = $("#main");
  const box = $("#compose");
  let press = null;

  document.addEventListener("pointerdown", () => (st.pointerDown = true), true);
  const release = () => {
    st.pointerDown = false;
    press = null;
    setTimeout(flushStale, 0);
  };
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
  // 枠の外で手を離したときは pointerup が届かない。ボタンを押していない動きが来たら、押し終わったことにする
  document.addEventListener("pointermove", (e) => st.pointerDown && e.buttons === 0 && release(), true);
  document.addEventListener("dragend", release, true);
  window.addEventListener("blur", release);

  // 元に戻すの帯
  $("#snack").addEventListener("click", (e) => {
    if (!e.target.closest("[data-act='undo']") || !st.undo) return;
    const { undo } = st.undo;
    hideUndo();
    undo().catch((err) => toast(failText(err)));
  });

  $("#up").onclick = () => ep.navigateUp().catch(() => {});
  $("#crumbs").addEventListener("click", (e) => {
    const b = e.target.closest(".crumb");
    if (b && !b.classList.contains("cur")) ep.navigate(b.dataset.path).catch(() => {});
  });
  $(".seg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.mode === "all") openAll();
    else openHere();
  });

  // 書く欄
  $("#post").onclick = post;
  $("#clear-to").onclick = () => {
    select(null);
    box.focus();
  };
  $("#colors").addEventListener("click", (e) => {
    const b = e.target.closest("[data-color]");
    if (!b) return;
    st.color = b.dataset.color;
    renderComposer();
    box.focus();
  });
  box.addEventListener("input", () => autosize(box));
  box.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey && box.value.trim()) {
      e.preventDefault();
      post();
    } else if (!box.value && listKey(e)) {
      e.preventDefault();
    } else if (e.key === "Escape") {
      box.blur();
    }
  });

  // 一覧
  main.addEventListener("click", onClick);
  main.addEventListener("dblclick", (e) => {
    const grip = e.target.closest(".grip");
    if (grip) {
      const chip = grip.closest(".note");
      saveLayout(chip.dataset.note, chip.dataset.home, { w: 0, h: 0 });   // 角を2回押すと、大きさがふつうに戻る
      return;
    }
    if (e.target.closest(".note, button, input, textarea")) return;
    const row = e.target.closest(".row");
    const en = row && entryOf(row.dataset.key);
    if (en) ep.open(refOf(en), { from: row.getBoundingClientRect() }).catch((err) => toast(err.message));
  });
  main.addEventListener("contextmenu", onContextMenu);
  main.addEventListener("input", (e) => {
    if (e.target.matches("#q")) {
      st.query = e.target.value;
      renderAllBody();
    } else if (e.target.matches("textarea.edit")) {
      autosize(e.target);
      clearTimeout(st.saveTimer);
      const ta = e.target;
      st.saveTimer = setTimeout(() => st.editing && saveText(st.editing, ta.value), SAVE_MS);
    }
  });
  main.addEventListener("change", (e) => {
    if (e.target.id === "only") {
      st.only = e.target.checked;
      render(true);
    }
  });
  main.addEventListener("focusout", (e) => {
    if (e.target.matches("textarea.edit")) {
      const chip = e.target.closest(".note");
      if (!(e.relatedTarget && chip.contains(e.relatedTarget))) commitEdit();
    } else if (e.target.matches(".rn") && st.renaming) {
      finishRename(e.target, true);
    }
  });
  main.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.target.matches("textarea.edit")) {
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        commitEdit().then(focusComposer);
      }
    } else if (e.target.matches(".rn")) {
      if (e.key === "Enter") {
        e.preventDefault();
        finishRename(e.target, true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finishRename(e.target, false);
      }
    }
  });

  wireNotes(main);

  // ファイルをつかんで、フォルダへ動かす（本体のドラッグ）
  main.addEventListener("pointerdown", (e) => {
    const row = e.button === 0 && e.target.closest(".row");
    if (row && !e.target.closest(".note, button, input")) press = { key: row.dataset.key, x: e.clientX, y: e.clientY };
  });
  document.addEventListener("pointermove", (e) => {
    if (!press || Math.hypot(e.clientX - press.x, e.clientY - press.y) < 7) return;
    const en = entryOf(press.key);
    press = null;
    if (en) ep.drag.start({ items: [refOf(en)], x: e.clientX, y: e.clientY, targets: folderTargets() }).catch(() => {});
  });

  // 何も選ばずに打ち始めたら、書く欄へ
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const t = e.target;
    if (t instanceof HTMLElement && t.matches("input, textarea, select")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (st.mode === "all") {
      if (e.key.length === 1) $("#q")?.focus();
      return;
    }
    if (listKey(e)) e.preventDefault();
    else if (e.key.length === 1 && !st.editing && !st.renaming) box.focus();
  });
}

// ---- 付箋をつかむ -----------------------------------------------------------------------------------
// つかんで動かす：同じ行の中で放せば、少しずれる（行の外へは出ない）。別のファイルの行・フォルダの行・掲示板に放せば、貼りなおす。
// 角をつかめば、大きさが変わる。つかんでいる間は、付箋の写しが指に付いてくる（行の外へ出ても、欠けない）

const HOLD_PX = 5;   // これだけ動いたら、押しただけでなく、つかんだことにする
const EDGE_PX = 44;  // 一覧の上下の端にこれだけ近づくと、一覧が動く

function wireNotes(main) {
  let g = null;   // つかんでいるもの：{ kind: "move" | "resize", chip, id, home, x, y, rect, on, last, ghost, timer, size }
  const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
  const clearMarks = () => $$(".drop").forEach((el) => el.classList.remove("drop"));

  /** 付箋の写しの下にある、貼れる所：ファイルの行・フォルダの行・掲示板。own は、今の貼り先と同じ（＝貼りなおさない） */
  function targetAt(x, y, chip) {
    const el = document.elementFromPoint(x, y);
    const row = el && el.closest(".row");
    if (row) {
      const en = entryOf(row.dataset.key);
      if (!en) return null;
      const own = chip.closest(".row") === row;
      if (en.kind === "file") return { el: row, own, home: ".", on: { name: en.name, ids: en.id ? [en.id] : [] } };
      return { el: row, own, home: row.dataset.key, on: null };
    }
    const board = el && el.closest(".board");
    return board ? { el: board, own: chip.closest(".board") === board && !chip.classList.contains("orphan"), home: ".", on: null } : null;
  }

  function mark() {
    clearMarks();
    const t = targetAt(g.last.x, g.last.y, g.chip);
    if (t && !t.own) t.el.classList.add("drop");
  }

  function begin() {
    g.on = true;
    if (g.kind === "resize") {
      document.body.classList.add("resizing");
      return;
    }
    const r = g.rect;
    const ghost = g.chip.cloneNode(true);
    ghost.classList.add("ghost");
    ghost.style.cssText += `;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
    document.body.append(ghost);
    g.ghost = ghost;
    g.chip.classList.add("dragging");
    document.body.classList.add("moving");
    g.timer = setInterval(() => {
      const box = main.getBoundingClientRect();
      const step = g.last.y < box.top + EDGE_PX ? -16 : g.last.y > box.bottom - EDGE_PX ? 16 : 0;
      if (step) {
        main.scrollTop += step;
        mark();
      }
    }, 30);
  }

  function drag(e) {
    g.last = { x: e.clientX, y: e.clientY };
    const dx = g.last.x - g.x;
    const dy = g.last.y - g.y;
    if (!g.on) {
      if (Math.hypot(dx, dy) < HOLD_PX) return;
      begin();
    }
    if (g.kind === "resize") {
      const w = Math.round(clamp(g.rect.width + dx, S.LAYOUT.w));
      g.size = { w };
      g.chip.style.setProperty("--nw", `${w}px`);
      if (Math.abs(dy) >= 4 || g.chip.classList.contains("sized")) {
        const h = Math.round(clamp(g.rect.height + dy, S.LAYOUT.h));
        g.size.h = h;
        g.chip.style.setProperty("--nh", `${h}px`);
        g.chip.classList.add("sized");
      }
      return;
    }
    g.ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(-1.2deg)`;
    mark();
  }

  /** 同じ行の中で放した：落ちた位置までのずれを足す。行（掲示板なら付箋の並び）の中に収める */
  function nudge(cur, el) {
    const note = noteIn(cur.home, cur.id);
    if (!note) return;
    const box = el.getBoundingClientRect();
    const cx = note.x || 0;
    const cy = note.y || 0;
    let x = cx + (cur.rect.left + (cur.last.x - cur.x) - box.left);   // 写しが落ちた位置と、今の位置の差（つかんでいる間に一覧が動いても合う）
    let y = cy + (cur.rect.top + (cur.last.y - cur.y) - box.top);
    const area = el.closest(".notes") || el.closest(".chips");
    if (area) {
      const a = area.getBoundingClientRect();
      const room = (lo, hi) => (hi < lo ? [0, 0] : [lo, hi]);
      const [x0, x1] = room(a.left - (box.left - cx), a.right - (box.left - cx) - box.width);
      const [y0, y1] = room(a.top - (box.top - cy), a.bottom - (box.top - cy) - box.height);
      x = clamp(x, [x0, x1]);
      y = clamp(y, [y0, y1]);
    }
    const patch = { x: Math.abs(x) < 3 ? 0 : Math.round(x), y: Math.abs(y) < 3 ? 0 : Math.round(y) };
    styleNote(el, { ...note, ...patch });
    saveLayout(cur.id, cur.home, { ...patch, z: "top" });   // 最後につかんだ付箋は、いちばん手前
  }

  function finish(e, cancel) {
    const cur = g;
    g = null;
    clearInterval(cur.timer);
    if (cur.ghost) cur.ghost.remove();
    clearMarks();
    document.body.classList.remove("moving", "resizing");
    cur.chip.classList.remove("dragging");
    if (!cur.on) return;
    st.noClick = true;   // 放したときの click で、書き直しが開かないように
    setTimeout(() => (st.noClick = false), 60);
    const el = cur.chip.isConnected ? cur.chip : noteEl(cur.id);
    if (!el) return;
    if (cur.kind === "resize") {
      if (cancel) styleNote(el, noteIn(cur.home, cur.id) || {});
      else if (cur.size) saveLayout(cur.id, cur.home, { ...cur.size, z: "top" });
      return;
    }
    if (cancel) return;
    const t = targetAt(e.clientX, e.clientY, cur.chip);
    if (t && !t.own) moveNoteTo(cur.id, cur.home, { home: t.home, on: t.on });
    else nudge(cur, el);
  }

  main.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || st.editing) return;
    const chip = e.target.closest(".note");
    if (!chip || chip.classList.contains("mini") || chip.classList.contains("editing") || e.target.closest("button")) return;
    if (!noteIn(chip.dataset.home, chip.dataset.note)) return;
    g = {
      kind: e.target.closest(".grip") ? "resize" : "move", chip, id: chip.dataset.note, home: chip.dataset.home,
      x: e.clientX, y: e.clientY, rect: chip.getBoundingClientRect(), on: false, last: { x: e.clientX, y: e.clientY }, ghost: null, timer: 0, size: null,
    };
  });
  document.addEventListener("pointermove", (e) => {
    if (!g) return;
    if (e.buttons === 0) finish(e, true);   // 枠の外で手を離した
    else drag(e);
  });
  document.addEventListener("pointerup", (e) => g && finish(e, false));
  document.addEventListener("pointercancel", (e) => g && finish(e, true));
}

function onClick(e) {
  const t = e.target;
  if (st.noClick || t.closest(".grip")) return;   // つかんで放しただけ・角を押しただけ
  if (t.closest("[data-tab]")) {
    st.tab = t.closest("[data-tab]").dataset.tab;
    return render(true);
  }
  const btn = t.closest("[data-act]");
  const chip = t.closest(".note");
  if (btn) {
    const act = btn.dataset.act;
    if (["go", "forget", "peel-all", "restore", "erase"].includes(act)) return allAction(act, btn);
    if (act === "open-row") {
      const en = entryOf(btn.closest(".row").dataset.key);
      return en && ep.navigate(en.path).catch(() => {});
    }
    if (act === "add-note") {
      select(btn.closest(".row").dataset.key);
      return focusComposer(false);
    }
    const id = chip && chip.dataset.note;
    const home = chip && chip.dataset.home;
    if (act === "done") return commitEdit().then(focusComposer);
    if (act === "color") return changeColor(id, home, btn.dataset.color);
    if (act === "peel") return (st.editing ? commitEdit() : Promise.resolve()).then(() => peel(id, home));
    if (act === "to-folder") return moveNoteTo(id, home, { home, on: null });
    if (act === "carry") return carry(id);
    return;
  }
  if (chip) {
    if (!chip.classList.contains("editing") && !chip.classList.contains("mini")) startEdit(chip.dataset.note, chip.dataset.home);
    return;
  }
  if (t.closest("input, textarea, label")) return;
  const row = t.closest(".row");
  select(row ? row.dataset.key : null);
  focusComposer(false);
}

async function onContextMenu(e) {
  e.preventDefault();
  if (st.mode !== "here") return;
  const chip = e.target.closest(".note");
  const row = e.target.closest(".row");
  try {
    if (chip && !chip.classList.contains("editing")) {
      const id = chip.dataset.note;
      const home = chip.dataset.home;
      const extra = [
        { id: "edit", label: "書き直す" },
        { id: "peel", label: "はがす" },
        { id: "reset", label: "大きさと位置をもとに戻す" },
        ...S.COLORS.map((c) => ({ id: `color:${c.id}`, label: `色を${c.label}にする` })),
      ];
      const { chosen } = await ep.showMenu({ x: e.clientX, y: e.clientY, items: [], extra });
      if (chosen === "edit") startEdit(id, home);
      else if (chosen === "peel") peel(id, home);
      else if (chosen === "reset") saveLayout(id, home, { w: 0, h: 0, x: 0, y: 0 });
      else if (chosen && chosen.startsWith("color:")) changeColor(id, home, chosen.slice(6));
      return;
    }
    if (row) {
      select(row.dataset.key);
      const en = entryOf(row.dataset.key);
      const { chosen } = await ep.showMenu({ x: e.clientX, y: e.clientY, items: [refOf(en)], extra: [{ id: "stick", label: "付箋を貼る" }] });
      if (chosen === "stick") $("#compose").focus();
      return;
    }
    select(null);
    const { chosen } = await ep.showMenu({ x: e.clientX, y: e.clientY, items: [], extra: [{ id: "stick", label: "このフォルダに付箋を貼る" }, { id: "mkdir", label: "新しいフォルダー" }] });
    if (chosen === "stick") $("#compose").focus();
    if (chosen === "mkdir") ep.createFolder().catch((err) => toast(err.message));
  } catch {
    // 裏のタブなどで、メニューを出せなかった
  }
}
