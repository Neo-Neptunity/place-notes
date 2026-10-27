// ここ付箋 — 付箋の決まり。データの形・貼る先の見つけ方・探し方。画面も通信も持たない。
// 付箋は「貼った場所のフォルダの中」に保存する。1つのフォルダの付箋が1つの doc（{ v: 1, notes: [...] }）。
// ファイルに貼った付箋は、そのファイルがあるフォルダの doc に入る。フォルダに貼った付箋は、そのフォルダ自身の doc に入る。

export const COLORS = [
  { id: "yellow", label: "きいろ" },
  { id: "pink", label: "もも" },
  { id: "blue", label: "みず" },
  { id: "green", label: "みどり" },
  { id: "purple", label: "むらさき" },
];
const COLOR_IDS = new Set(COLORS.map((c) => c.id));

// 本体の folderData は 1MB まで。日本語は JSON で1文字が最大3バイトなので、余裕を見て決める
export const LIMITS = { text: 800, notes: 300, bytes: 900_000, ids: 6, name: 255 };

export class NoteError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export const emptyDoc = () => ({ v: 1, notes: [] });

// ---- 読んだものの確かめ ----------------------------------------------------------
// フォルダの中のファイルは、同期や手書きで壊れていることがある。形の合わないものは捨てて、直せるものは直す。

const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);

/** 付箋の文：改行をそろえ、制御文字を除き、前後の空白を落とし、長すぎれば切る */
export function cleanText(s) {
  if (typeof s !== "string") return "";
  let t = s.replace(/\r\n?/g, "\n").replace(CTRL, "").trim();
  if (t.length > LIMITS.text) t = [...t].slice(0, LIMITS.text).join("").trimEnd();
  return t;
}

/** 貼り先（ファイル）。name は今の名前、ids は見てきたファイルID（PC ごとに違うので、増えていく） */
export function cleanOn(on) {
  if (!on || typeof on !== "object" || typeof on.name !== "string") return null;
  const name = on.name.slice(0, LIMITS.name);
  if (!name) return null;
  const ids = [];
  for (const id of Array.isArray(on.ids) ? on.ids : []) if (typeof id === "string" && id && id.length <= 64 && !ids.includes(id)) ids.push(id);
  return { name, ids: ids.slice(-LIMITS.ids) };
}

// 付箋の大きさ（w・h）と、貼った場所からのずれ（x・y）。どれも省けて、省けば「ふつう」（幅 320・高さは文に合わせる・ずれなし）。
// ずれは、付箋がふつうに並ぶ位置からの動き。ひとつの行の中で、少しずらすためのもの
// z は重なる順（大きいほど手前）。最後につかんだ付箋が、いつも手前に来る
export const LAYOUT = { w: [140, 560], h: [64, 480], x: [-600, 600], y: [-600, 600], z: [1, 1_000_000] };
const maxZ = (doc) => doc.notes.reduce((m, n) => Math.max(m, n.z || 0), 0);

/** 範囲に収めて整数にする。0・数でないものは 0（＝ふつう） */
function span(v, [lo, hi]) {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.round(v) === 0) return 0;
  return Math.round(Math.min(hi, Math.max(lo, v)));
}

function layoutOf(raw) {
  const out = {};
  for (const k of Object.keys(LAYOUT)) {
    const v = span(raw[k], LAYOUT[k]);
    if (v) out[k] = v;
  }
  return out;
}

function cleanNote(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !/^[\w-]{1,40}$/.test(raw.id)) return null;
  const text = cleanText(raw.text);
  if (!text) return null;
  const t = num(raw.t);
  return {
    id: raw.id,
    text,
    color: COLOR_IDS.has(raw.color) ? raw.color : "yellow",
    t,
    u: num(raw.u, t),
    gone: num(raw.gone),
    on: cleanOn(raw.on),
    ...layoutOf(raw),
  };
}

export function normalizeDoc(raw) {
  const list = raw && typeof raw === "object" && Array.isArray(raw.notes) ? raw.notes : [];
  const seen = new Map();
  for (const r of list) {
    const n = cleanNote(r);
    if (!n) continue;
    const prev = seen.get(n.id);
    if (prev && prev.u >= n.u) continue;   // 同期で同じ付箋が2つ届いたら、新しいほう
    seen.set(n.id, n);
  }
  return { v: 1, notes: [...seen.values()] };
}

export const docBytes = (doc) => new TextEncoder().encode(JSON.stringify(doc)).length;

export function checkSize(doc) {
  if (docBytes(doc) > LIMITS.bytes) throw new NoteError("too-large", "付箋がいっぱいです");
}

// ---- 付箋を変える（元の doc は変えず、新しい doc を返す） --------------------------------------

export function newId(now = Date.now(), rand = Math.random) {
  return `n${now.toString(36)}${Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0")}`;
}

export function addNote(doc, { text, color = "yellow", on = null, now, id }) {
  const clean = cleanText(text);
  if (!clean) throw new NoteError("empty", "文が空です");
  if (doc.notes.length >= LIMITS.notes) throw new NoteError("full", "付箋がいっぱいです");
  const note = { id: id || newId(now), text: clean, color: COLOR_IDS.has(color) ? color : "yellow", t: now, u: now, gone: 0, on: cleanOn(on) };
  return { doc: { ...doc, notes: [...doc.notes, note] }, note };
}

/** 変わらなければ、同じ doc を返す（呼ぶ側は、書き込みを省ける） */
function mapNote(doc, id, fn) {
  let changed = false;
  const notes = [];
  for (const n of doc.notes) {
    if (n.id !== id) {
      notes.push(n);
      continue;
    }
    const r = fn(n);
    if (r !== n) changed = true;
    if (r) notes.push(r);
  }
  return changed ? { ...doc, notes } : doc;
}

/** patch：{ text?, color? }。文を空にしても付箋は消えない（消すのは removeNote、はがすのは peelNote） */
export function editNote(doc, id, patch, now) {
  return mapNote(doc, id, (n) => {
    const next = { ...n };
    if ("text" in patch) {
      const t = cleanText(patch.text);
      if (t) next.text = t;
    }
    if ("color" in patch && COLOR_IDS.has(patch.color)) next.color = patch.color;
    if (next.text === n.text && next.color === n.color) return n;
    next.u = now;
    return next;
  });
}

export const peelNote = (doc, id, now) => mapNote(doc, id, (n) => (n.gone ? n : { ...n, gone: now, u: now }));
export const restoreNote = (doc, id, now) => mapNote(doc, id, (n) => (n.gone ? { ...n, gone: 0, u: now } : n));
export const removeNote = (doc, id) => mapNote(doc, id, () => null);

/** 貼る先が変わると、並ぶ位置も変わるので、ずれは外す（大きさは残す）。付箋の文は変わらないので、u は変えない */
const placed = ({ x, y, ...rest }) => rest;

/** 貼る先を変える。on が null なら、フォルダ全体に貼る */
export function moveNote(doc, id, on) {
  const to = cleanOn(on);
  return mapNote(doc, id, (n) => (JSON.stringify(n.on) === JSON.stringify(to) ? n : { ...placed(n), on: to, z: maxZ(doc) + 1 }));
}

/** 別のフォルダから連れてきた・貼りなおした付箋を入れる。同じ付箋はもう一度入れない */
export function importNote(doc, note, on) {
  if (doc.notes.some((n) => n.id === note.id)) return doc;
  if (doc.notes.length >= LIMITS.notes) throw new NoteError("full", "付箋がいっぱいです");
  return { ...doc, notes: [...doc.notes, { ...placed(note), on: cleanOn(on), gone: 0, z: maxZ(doc) + 1 }] };
}

/**
 * 大きさ・ずれ・重なる順を変える。patch：{ w?, h?, x?, y?, z? }。0 か null で「ふつう」に戻す。
 * 付箋の文は変わらないので、u は変えない（「3日前」が「たった今」にならない）
 */
export function layoutNote(doc, id, patch) {
  return mapNote(doc, id, (n) => {
    const next = { ...n };
    for (const k of Object.keys(LAYOUT)) {
      if (!(k in patch)) continue;
      // z は "top" で、いちばん手前（もう手前なら、そのまま）
      const want = k === "z" && patch.z === "top" ? ((n.z || 0) === maxZ(doc) && n.z ? n.z : maxZ(doc) + 1) : patch[k];
      const v = span(want, LAYOUT[k]);
      if (v) next[k] = v;
      else delete next[k];
    }
    return Object.keys(LAYOUT).every((k) => (next[k] || 0) === (n[k] || 0)) ? n : next;
  });
}

export const findNote = (doc, id) => doc.notes.find((n) => n.id === id) || null;
export const byTime = (a, b) => a.t - b.t || (a.id < b.id ? -1 : 1);

// ---- 貼り先を見つける ----------------------------------------------------------------

export const lower = (s) => s.toLowerCase();

/**
 * フォルダの中身と付箋を突き合わせる。
 * まずファイルID（名前を変えても同じ）、なければ名前（別の PC ではIDが違う）で探す。
 * learned は「覚え直すとよいこと」：新しい名前・この PC のID。書き戻すと、別の PC でも名前の変更に付いていける。
 */
export function matchNotes(notes, entries) {
  const byId = new Map();
  const byName = new Map();
  for (const e of entries) {
    if (e.kind !== "file") continue;
    if (e.id) byId.set(e.id, e);
    byName.set(lower(e.name), e);
  }
  const out = { general: [], byPath: new Map(), orphans: [], learned: new Map() };
  for (const n of notes) {
    if (n.gone) continue;
    if (!n.on) {
      out.general.push(n);
      continue;
    }
    let hit = null;
    for (let i = n.on.ids.length - 1; i >= 0 && !hit; i--) hit = byId.get(n.on.ids[i]) || null;
    if (!hit) hit = byName.get(lower(n.on.name)) || null;
    if (!hit) {
      out.orphans.push(n);
      continue;
    }
    const key = lower(hit.path);
    if (!out.byPath.has(key)) out.byPath.set(key, []);
    out.byPath.get(key).push(n);
    if (hit.name !== n.on.name || (hit.id && !n.on.ids.includes(hit.id))) out.learned.set(n.id, { name: hit.name, id: hit.id });
  }
  return out;
}

/** matchNotes の learned を doc に書き込む。何も変わらなければ同じ doc を返す。u は変えない（文が変わったわけではない） */
export function applyLearned(doc, learned) {
  if (!learned.size) return doc;
  let changed = false;
  const notes = doc.notes.map((n) => {
    const l = learned.get(n.id);
    if (!l || !n.on) return n;
    const ids = l.id && !n.on.ids.includes(l.id) ? [...n.on.ids, l.id].slice(-LIMITS.ids) : n.on.ids;
    if (n.on.name === l.name && ids === n.on.ids) return n;
    changed = true;
    return { ...n, on: { name: l.name, ids } };
  });
  return changed ? { ...doc, notes } : doc;
}

// ---- 場所の索引（この PC の「すべての付箋」） ------------------------------------------------
// 開いた場所ごとに、付箋の写しを ep.storage に覚える。フォルダが消えても、付箋は索引に残る。

export const placeKey = (ref) => (ref.id ? `i${ref.id}` : `p${lower(ref.path)}`);

export function summarize(ref, name, doc, now) {
  return {
    id: ref.id,
    path: ref.path,
    name,
    saved: now,
    notes: doc.notes.map((n) => ({ id: n.id, text: n.text, color: n.color, t: n.t, u: n.u, gone: n.gone, on: n.on ? n.on.name : null })),
  };
}

/** 索引から読んだものを確かめる。壊れていたら null */
export function cleanPlace(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.path !== "string" || !raw.path || !Array.isArray(raw.notes)) return null;
  const notes = [];
  for (const r of raw.notes) {
    // 索引の付箋の on は、貼り先のファイル名（文字）だけ
    const n = r && typeof r === "object" ? cleanNote({ ...r, on: typeof r.on === "string" && r.on ? { name: r.on } : null }) : null;
    if (n) notes.push({ id: n.id, text: n.text, color: n.color, t: n.t, u: n.u, gone: n.gone, on: n.on ? n.on.name : null });
  }
  return { id: typeof raw.id === "string" ? raw.id : "", path: raw.path, name: typeof raw.name === "string" && raw.name ? raw.name : nameOf(raw.path) || raw.path, saved: num(raw.saved), notes };
}

/** 文字・貼り先のファイル名・場所の名前とパスの全部に、空白で分けたことばが含まれるものを、新しい順に */
export function searchPlaces(places, query, gone) {
  const terms = lower(query).split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of places) {
    const head = lower(`${p.name} ${p.path}`);
    const notes = p.notes
      .filter((n) => !!n.gone === !!gone && terms.every((t) => head.includes(t) || lower(n.text).includes(t) || (n.on && lower(n.on).includes(t))))
      .sort((a, b) => b.u - a.u);
    if (notes.length) out.push({ place: p, notes, latest: notes[0].u });
  }
  return out.sort((a, b) => b.latest - a.latest);
}

export function countNotes(places) {
  let active = 0;
  let peeled = 0;
  for (const p of places) for (const n of p.notes) n.gone ? peeled++ : active++;
  return { active, peeled };
}

// ---- パスと日付 ----------------------------------------------------------------------

const trimEnd = (p) => p.replace(/\\+$/, "");
export const samePath = (a, b) => lower(trimEnd(a)) === lower(trimEnd(b));
export const nameOf = (p) => trimEnd(p).split("\\").pop() || p;
export const joinPath = (dir, name) => `${trimEnd(dir)}\\${name}`;

export function parentOf(p) {
  const t = trimEnd(p);
  const i = t.lastIndexOf("\\");
  if (i < 0) return "";
  return /^[A-Za-z]:$/.test(t.slice(0, i)) ? t.slice(0, i + 1) : t.slice(0, i);
}

/** パンくず。ドライブは "C:\"、ネットワークは \\サーバー\共有 をひとまとまりにする */
export function crumbs(path) {
  const unc = path.startsWith("\\\\");
  const parts = trimEnd(path).replace(/^\\\\/, "").split("\\").filter(Boolean);
  const out = [];
  let acc = "";
  parts.forEach((p, i) => {
    if (unc) {
      if (i === 0) return;
      acc = i === 1 ? `\\\\${parts[0]}\\${p}` : `${acc}\\${p}`;
      out.push({ name: i === 1 ? `\\\\${parts[0]}\\${p}` : p, path: acc });
    } else {
      acc = i === 0 ? `${p}\\` : `${trimEnd(acc)}\\${p}`;
      out.push({ name: p, path: acc });
    }
  });
  return out;
}

const dayStart = (ms) => new Date(ms).setHours(0, 0, 0, 0);

/** 付箋の「いつ」：たった今・5分前・3時間前・きのう・4日前・10月3日 */
export function whenText(t, now) {
  if (!(t > 0)) return "";
  const d = now - t;
  if (d < 60_000) return "たった今";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}分前`;
  const days = Math.round((dayStart(now) - dayStart(t)) / 86_400_000);
  if (days <= 0) return `${Math.floor(d / 3_600_000)}時間前`;
  if (days === 1) return "きのう";
  if (days < 14) return `${days}日前`;
  const a = new Date(t);
  const b = new Date(now);
  return a.getFullYear() === b.getFullYear() ? `${a.getMonth() + 1}月${a.getDate()}日` : `${a.getFullYear()}年${a.getMonth() + 1}月${a.getDate()}日`;
}

/** 一覧の更新日時：今年なら 月/日 時:分、前の年なら 年/月/日 */
export function dateText(ms, now) {
  if (!ms) return "";
  const a = new Date(ms);
  const b = new Date(now);
  const two = (n) => String(n).padStart(2, "0");
  if (a.getFullYear() !== b.getFullYear()) return `${a.getFullYear()}/${a.getMonth() + 1}/${a.getDate()}`;
  return `${a.getMonth() + 1}/${a.getDate()} ${two(a.getHours())}:${two(a.getMinutes())}`;
}
