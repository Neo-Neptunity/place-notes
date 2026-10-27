// ここ付箋 — 保存。フォルダの中（folderData）に付箋を置き、この PC の索引（storage）に写しを覚える。
import { normalizeDoc, checkSize, placeKey, summarize, cleanPlace } from "./store.js";

const PREFIX = "place:";

export function createData(ep) {
  const tails = new Map();       // フォルダ → 直前の書き込み。同じフォルダへの書き込みは1つずつ順に行う
  const written = new Map();     // 索引のキー → 最後に覚えた JSON。同じものを書き直さない
  let known = null;              // 索引にあるキーの集まり

  const keyOf = (ref) => (ref.id ? `i${ref.id}` : `p${ref.path.toLowerCase()}`);

  async function load(ref) {
    return normalizeDoc(await ep.folderData.get(ref));
  }

  /**
   * 読み直してから変えて書く。ほかのウィンドウや同期で変わっていても、その上に重ねるので、先の変更を巻き戻さない。
   * change は doc を受け取って新しい doc を返す。同じ doc を返せば、何も書かない。付箋が0枚になれば、データのファイルごと消す
   */
  function update(ref, change) {
    const key = keyOf(ref);
    const run = (tails.get(key) || Promise.resolve()).then(async () => {
      const before = await load(ref);
      const after = change(before);
      if (after === before) return before;
      checkSize(after);
      if (after.notes.length === 0) await ep.folderData.delete(ref);
      else await ep.folderData.set(ref, after);
      return after;
    });
    const settle = () => {
      if (tails.get(key) === tail) tails.delete(key);
    };
    const tail = run.then(settle, settle);
    tails.set(key, tail);
    return run;
  }

  async function loadKnown() {
    if (!known) known = new Set((await ep.storage.keys().catch(() => [])).filter((k) => k.startsWith(PREFIX)));
    return known;
  }

  /** 索引に写しを覚える。付箋が0枚なら、索引からも外す。失敗しても付箋そのものには関係ない */
  async function remember(ref, name, doc, now = Date.now()) {
    try {
      const keys = await loadKnown();
      const k = PREFIX + placeKey(ref);
      if (!doc.notes.length) {
        written.delete(k);
        if (keys.delete(k)) await ep.storage.delete(k);
        return;
      }
      const value = summarize(ref, name, doc, now);
      const sig = JSON.stringify({ ...value, saved: 0 });
      if (written.get(k) === sig && keys.has(k)) return;
      await ep.storage.set(k, value);
      written.set(k, sig);
      keys.add(k);
    } catch (e) {
      console.warn("索引に覚えられませんでした", e.message);
    }
  }

  async function places() {
    const keys = [...(await loadKnown())];
    const all = await Promise.all(keys.map(async (k) => {
      const p = cleanPlace(await ep.storage.get(k).catch(() => null));
      return p && { key: k, ...p };
    }));
    return all.filter(Boolean);
  }

  async function forget(key) {
    (await loadKnown()).delete(key);
    written.delete(key);
    await ep.storage.delete(key);
  }

  return { load, update, remember, places, forget };
}
