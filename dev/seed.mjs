// 試験用の種：仕事のフォルダに、付箋がほどよく貼ってある状態を作る。
// 「新商品の企画」：ファイルの付箋・フォルダの付箋・動かされたファイルの付箋・はがした付箋・子フォルダの付箋。
export const BASE = "C:\\Users\\neo\\Documents";
export const FOLDER = `${BASE}\\新商品の企画`;
export const OTHER = `${BASE}\\家の手続き`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function seedFs(fs, S, now, { big = 0 } = {}) {
  const mk = (dir, name, kind = "file", opts = {}) => fs.add(`${dir}\\${name}`, kind, { modified: now - (opts.ago ?? 2 * DAY), ...opts });
  fs.mkdirp(BASE);

  // ---- 新商品の企画 ----
  fs.mkdirp(FOLDER);
  const doc = mk(FOLDER, "企画書_v3.docx");
  const xls = mk(FOLDER, "見積もり.xlsx", "file", { ago: 5 * DAY });
  const pdf = mk(FOLDER, "参考資料.pdf", "file", { ago: 9 * DAY });
  mk(FOLDER, "会議メモ.txt", "file", { ago: 1 * DAY });
  mk(FOLDER, "ロゴ案.png", "file", { ago: 12 * DAY });
  mk(FOLDER, "議事録_0915.docx", "file", { ago: 40 * DAY });
  mk(FOLDER, "提出用.zip", "file", { ago: 6 * HOUR });
  mk(FOLDER, "desktop.ini", "file", { hidden: true });
  const archive = mk(FOLDER, "アーカイブ", "folder", { ago: 20 * DAY });
  mk(FOLDER, "写真", "folder", { ago: 8 * DAY });
  const contract = mk(FOLDER, "契約書", "folder", { ago: 30 * DAY });

  // 動かされたファイル：付箋は旧見積もり.xlsx に貼ってあるが、ファイルはアーカイブの中にある（IDは同じ）
  const old = mk(archive.path, "旧見積もり.xlsx", "file", { ago: 60 * DAY });
  mk(archive.path, "企画案_初稿.docx", "file", { ago: 70 * DAY });

  const addTo =(folder, text, color, ago, file) => {
    folder.data = S.addNote(S.normalizeDoc(folder.data), { text, color, on: file ? { name: file.name, ids: [file.id] } : null, now: now - ago }).doc;
  };
  addTo(fs.get(FOLDER), "このフォルダは10月末で片付ける。古いものはアーカイブへ。", "yellow", 3 * DAY);
  addTo(fs.get(FOLDER), "取引先の担当は山本さん。内線 3318。", "purple", 20 * DAY);
  addTo(fs.get(FOLDER), "金曜までに数字を直す。原価は田中さんに確認してから。", "yellow", 20 * HOUR, doc);
  addTo(fs.get(FOLDER), "表紙の写真を差し替える。", "pink", 4 * HOUR, doc);
  addTo(fs.get(FOLDER), "税込と税抜がまざっている。最終版を作ってから送る。", "blue", 2 * DAY, xls);
  addTo(fs.get(FOLDER), "p.12 の図が使える。出典は巻末。", "green", 6 * DAY, pdf);
  addTo(fs.get(FOLDER), "古い見積もり。数字の根拠はここ。", "yellow", 30 * DAY, old);
  addTo(fs.get(FOLDER), "もう使わないメモ。", "pink", 50 * DAY);
  fs.get(FOLDER).data = S.peelNote(S.normalizeDoc(fs.get(FOLDER).data), S.normalizeDoc(fs.get(FOLDER).data).notes.at(-1).id, now - 2 * DAY);

  addTo(archive, "ここは見るだけ。直さない。", "blue", 15 * DAY);
  addTo(archive, "初稿のあとで方針が変わった。経緯は議事録を見る。", "yellow", 14 * DAY, fs.get(`${archive.path}\\企画案_初稿.docx`));
  addTo(contract, "更新は来年3月まで。2か月前に連絡。", "green", 9 * DAY);

  // ---- 家の手続き ----
  fs.mkdirp(OTHER);
  const tax = mk(OTHER, "確定申告_控え.pdf", "file", { ago: 200 * DAY });
  mk(OTHER, "保険証券.pdf", "file", { ago: 400 * DAY });
  addTo(fs.get(OTHER), "更新月は6月。通知が届いたら見積もりを3社から取る。", "pink", 120 * DAY, fs.get(`${OTHER}\\保険証券.pdf`));
  addTo(fs.get(OTHER), "医療費の領収書は封筒にまとめてある。", "yellow", 200 * DAY, tax);

  if (big) fs.mkdirp(`${BASE}\\大量`);
  for (let i = 0; i < big; i++) mk(`${BASE}\\大量`, `file_${String(i).padStart(4, "0")}.txt`, "file");
  return { doc, xls, pdf, old, archive };
}

/** 開いたことのある場所として、索引（ep.storage の place:…）に写しを覚えておく */
export function seedIndex(fs, S, now) {
  const store = [];
  for (const n of fs.nodes.values()) {
    if (n.kind !== "folder" || !n.data) continue;
    const doc = S.normalizeDoc(n.data);
    if (!doc.notes.length) continue;
    const ref = { id: n.id, path: n.path };
    store.push([`place:${S.placeKey(ref)}`, S.summarize(ref, n.name, doc, now)]);
  }
  return store;
}
