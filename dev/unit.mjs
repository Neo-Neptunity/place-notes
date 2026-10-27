// ここ付箋 — 画面を持たない部品の試験。node だけで動く。
//   使い方：node place-notes/dev/unit.mjs
// 付箋の形・貼り先の見つけ方・探し方・保存（偽の本体）・右クリックから貼る・manifest と書き方の決まり。
import fs from "node:fs";
import path from "node:path";
import { stage, MOD_DIR } from "./stage.mjs";
import { createFakeFs, createFakeEp } from "./fake-host.mjs";
import { seedFs, seedIndex, FOLDER, OTHER } from "./seed.mjs";

const st = stage("unit");
const S = await import(st.url("store.js"));
const { createData } = await import(st.url("data.js"));

let fail = 0, total = 0;
const ok = (cond, msg) => { total++; if (!cond) { fail++; console.log("  NG", msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（${JSON.stringify(a)} ≠ ${JSON.stringify(b)}）`);
const section = (s) => console.log(s);
const rejects = async (fn, code, msg) => {
  try { await fn(); ok(false, `${msg}：失敗するはず`); } catch (e) { ok(e.code === code, `${msg}（code ${e.code}）`); }
};
const NOW = new Date(2026, 9, 27, 15, 0, 0).getTime();   // 2026-10-27 15:00（この PC の時刻）
const DAY = 86_400_000;

// ---- 文と付箋の形 ----------------------------------------------------------------------------
section("文と付箋の形");
{
  eq(S.cleanText("  あ\r\nい\rう\u0000\u0007  "), "あ\nい\nう", "改行をそろえ、制御文字と前後の空白を除く");
  eq(S.cleanText(12), "", "文字でないものは空");
  eq([...S.cleanText("𠮷".repeat(900))].length, S.LIMITS.text, "長すぎる文は切る。サロゲートペアは割らない");
  eq(S.cleanText("<b>太字</b>"), "<b>太字</b>", "HTML はただの文字として残す");

  eq(S.normalizeDoc(null), { v: 1, notes: [] }, "null は空");
  eq(S.normalizeDoc(5), { v: 1, notes: [] }, "数は空");
  eq(S.normalizeDoc({ notes: "x" }), { v: 1, notes: [] }, "notes が配列でなければ空");
  const messy = S.normalizeDoc({
    notes: [
      null, 3, "x",
      { id: "a1", text: "ふつう", color: "pink", t: 100, u: 200, gone: 0, on: { name: "a.txt", ids: ["1", "1", "2", "", 3] } },
      { id: "a2", text: "   ", t: 1 },
      { id: "../x", text: "危ないID" },
      { id: "a3", text: "色が変", color: "red", t: -5, u: "x" },
      { id: "a1", text: "同じIDの新しいほう", color: "pink", t: 100, u: 300, on: { name: "a.txt", ids: ["1", "1", "2", "", 3] } },
      { id: "a4", text: "貼り先が空", on: { name: "" } },
      { id: "a5", text: "ids が多い", on: { name: "b.txt", ids: ["1", "2", "3", "4", "5", "6", "7", "8"] } },
      { text: "ID なし" },
    ],
  });
  eq(messy.notes.map((n) => n.id), ["a1", "a3", "a4", "a5"], "壊れた付箋は捨てて、残りはそのまま");
  eq(messy.notes[0].text, "同じIDの新しいほう", "同じ付箋が2つあれば、新しいほう");
  eq(messy.notes[0].on, { name: "a.txt", ids: ["1", "2"] }, "ファイルIDの重なりと空は除く");
  eq([messy.notes[1].color, messy.notes[1].t, messy.notes[1].u], ["yellow", 0, 0], "色は黄色に、時刻は 0 に直す");
  eq(messy.notes[2].on, null, "貼り先の名前が空なら、フォルダ全体");
  eq(messy.notes[3].on.ids, ["3", "4", "5", "6", "7", "8"], "ids は新しい6つだけ");

  const doc = S.emptyDoc();
  const { doc: d1, note } = S.addNote(doc, { text: "  買い物  ", color: "green", on: { name: "a.txt", ids: ["9"] }, now: NOW });
  eq(doc.notes.length, 0, "元の doc は変えない");
  eq([note.text, note.color, note.t, note.u, note.gone], ["買い物", "green", NOW, NOW, 0], "貼った付箋");
  ok(/^n[0-9a-z]{9,}$/.test(note.id), `付箋の ID の形 ${note.id}`);
  ok(S.newId(NOW) !== S.newId(NOW), "ID は重ならない");
  eq(S.addNote(doc, { text: "x", color: "nope", now: NOW }).note.color, "yellow", "知らない色は黄色");

  const d2 = S.editNote(d1, note.id, { text: "買い物 2", color: "blue" }, NOW + 1000);
  eq([d2.notes[0].text, d2.notes[0].color, d2.notes[0].u, d2.notes[0].t], ["買い物 2", "blue", NOW + 1000, NOW], "直す。貼った時刻は変わらず、更新の時刻だけ進む");
  ok(S.editNote(d1, note.id, { text: "買い物" }, NOW + 1) === d1, "同じ文なら、同じ doc を返す（書き込みを省ける）");
  ok(S.editNote(d1, note.id, { text: "   " }, NOW + 1) === d1, "文を空にしても、付箋は消えない");
  ok(S.editNote(d1, "ない", { text: "x" }, NOW) === d1, "無い付箋を直しても、何も起きない");

  const d3 = S.peelNote(d1, note.id, NOW + 5);
  eq([d3.notes[0].gone, d3.notes.length], [NOW + 5, 1], "はがしても付箋は残る");
  ok(S.peelNote(d3, note.id, NOW + 9) === d3, "はがした付箋をもう一度はがしても、同じ");
  const d4 = S.restoreNote(d3, note.id, NOW + 10);
  eq(d4.notes[0].gone, 0, "貼りなおす");
  ok(S.restoreNote(d4, note.id, NOW + 11) === d4, "貼ってある付箋を貼りなおしても、同じ");
  eq(S.removeNote(d1, note.id).notes.length, 0, "完全に消す");

  eq(S.moveNote(d1, note.id, null, NOW + 2).notes[0].on, null, "フォルダ全体に貼りなおす");
  ok(S.moveNote(d1, note.id, { name: "a.txt", ids: ["9"] }, NOW + 2) === d1, "同じ貼り先なら、同じ doc");
  ok(S.importNote(d1, d1.notes[0], null, NOW) === d1, "連れてきた付箋は、同じものをもう一度入れない");
  eq(S.importNote(S.emptyDoc(), { ...note, gone: 5 }, { name: "z.txt", ids: [] }, NOW + 3).notes[0].gone, 0, "連れてきた付箋は貼ってある状態");

  // 大きさとずれ
  const lay = S.layoutNote(d1, note.id, { w: 260, h: 150, x: 40, y: -12 });
  eq([lay.notes[0].w, lay.notes[0].h, lay.notes[0].x, lay.notes[0].y], [260, 150, 40, -12], "大きさとずれを変える");
  eq([lay.notes[0].u, lay.notes[0].t], [d1.notes[0].u, d1.notes[0].t], "大きさやずれを変えても、更新の時刻は変えない（「3日前」が「たった今」にならない）");
  ok(!("w" in d1.notes[0]), "元の doc は変えない。ふつうの付箋には、大きさのキーが無い");
  ok(S.layoutNote(lay, note.id, { w: 260, x: 40 }) === lay, "同じ値なら、同じ doc を返す（書き込みを省ける）");
  const wild = S.layoutNote(lay, note.id, { w: 9999, h: 1, x: 9999, y: -9999 }).notes[0];
  eq([wild.w, wild.h, wild.x, wild.y], [560, 64, 600, -600], "大きさとずれは、決まった範囲に収める");
  const back = S.layoutNote(lay, note.id, { w: 0, h: null, x: 0.4 }).notes[0];
  ok(!("w" in back) && !("h" in back) && !("x" in back) && back.y === -12, "0・null・四捨五入して0 は、ふつうに戻す。書かなかった値は残る");
  const odd = S.normalizeDoc({ notes: [{ id: "l1", text: "t", w: 9999, h: "x", x: -3.7, y: NaN }, { id: "l2", text: "t", w: 0, h: 100 }] }).notes;
  eq([odd[0].w, odd[0].h, odd[0].x, odd[0].y], [560, undefined, -4, undefined], "読んだ大きさとずれは、範囲に収め、数でなければ捨てる");
  ok(!("w" in odd[1]) && odd[1].h === 100, "0 は、ふつう");
  const placedNote = S.moveNote(lay, note.id, null).notes[0];
  eq([placedNote.w, placedNote.h, placedNote.x, placedNote.y, placedNote.u], [260, 150, undefined, undefined, d1.notes[0].u], "貼り先を変えると、ずれは外し、大きさは残す。更新の時刻は変えない");
  const moved = S.importNote(S.emptyDoc(), lay.notes[0], null).notes[0];
  eq([moved.w, moved.x, moved.u, moved.gone], [260, undefined, d1.notes[0].u, 0], "別のフォルダへ貼りなおすと、ずれは外し、大きさと時刻は残す");

  // 重なる順：最後につかんだ付箋が手前
  let zdoc = S.emptyDoc();
  for (const t of ["あ", "い", "う"]) zdoc = S.addNote(zdoc, { text: t, now: NOW }).doc;
  const [za, zb, zc] = zdoc.notes.map((n) => n.id);
  ok(zdoc.notes.every((n) => !("z" in n)), "ふつうの付箋には、重なる順のキーが無い");
  zdoc = S.layoutNote(zdoc, za, { z: "top" });
  eq(zdoc.notes[0].z, 1, "つかんだ付箋は、いちばん手前（まだ誰も手前でなければ 1）");
  zdoc = S.layoutNote(zdoc, zb, { x: 5, z: "top" });
  eq([zdoc.notes[0].z, zdoc.notes[1].z], [1, 2], "あとからつかんだ付箋が、さらに手前");
  ok(S.layoutNote(zdoc, zb, { z: "top" }) === zdoc, "もういちばん手前なら、同じ doc を返す（つかむたびに書き込まない）");
  zdoc = S.layoutNote(zdoc, za, { z: "top" });
  eq([zdoc.notes[0].z, zdoc.notes[1].z], [3, 2], "手前の付箋の下にあった付箋を、またつかむと、また手前に来る");
  eq(S.layoutNote(zdoc, za, { w: 200 }).notes[0].z, 3, "大きさを変えても、重なる順は変わらない");
  eq(S.layoutNote(zdoc, za, { w: 0, h: 0, x: 0, y: 0 }).notes[0].z, 3, "大きさと位置をもとに戻しても、重なる順は残る");
  eq(S.moveNote(zdoc, zc, { name: "a.txt", ids: [] }).notes[2].z, 4, "貼りなおした付箋は、いちばん手前");
  eq(S.importNote(zdoc, { ...zdoc.notes[0], id: "nOther" }, null).notes[3].z, 4, "別のフォルダから貼りなおした付箋は、そこでいちばん手前");
  eq(S.layoutNote(zdoc, za, { z: 99999999 }).notes[0].z, 1_000_000, "重なる順も、範囲に収める");

  let full = S.emptyDoc();
  for (let i = 0; i < S.LIMITS.notes; i++) full = S.addNote(full, { text: "あ".repeat(S.LIMITS.text), now: NOW + i }).doc;
  ok(S.docBytes(full) < 1024 * 1024, `最大の付箋 ${S.LIMITS.notes} 枚 × ${S.LIMITS.text} 字でも、本体の 1MB に収まる（${S.docBytes(full)} バイト）`);
  S.checkSize(full);
  try { S.addNote(full, { text: "もう一枚", now: NOW }); ok(false, "いっぱいなら断る"); } catch (e) { eq(e.code, "full", "いっぱいなら断る"); }
  try { S.addNote(doc, { text: "  ", now: NOW }); ok(false, "空の文は断る"); } catch (e) { eq(e.code, "empty", "空の文は断る"); }
  const keep = S.LIMITS.bytes;
  S.LIMITS.bytes = 100;
  try { S.checkSize(d1); ok(false, "大きすぎれば断る"); } catch (e) { eq(e.code, "too-large", "大きすぎれば断る"); }
  S.LIMITS.bytes = keep;
}

// ---- 貼り先の見つけ方 --------------------------------------------------------------------------
section("貼り先の見つけ方");
{
  const E = (id, name, kind = "file", dir = "C:\\w") => ({ id, name, kind, path: `${dir}\\${name}`, hidden: false });
  const entries = [E("1", "a.docx"), E("2", "b.xlsx"), E("3", "sub", "folder")];
  const mk = (id, on, extra = {}) => ({ id, text: id, color: "yellow", t: 1, u: 1, gone: 0, on, ...extra });
  const m1 = S.matchNotes([mk("n1", { name: "a.docx", ids: ["1"] }), mk("n2", null), mk("n3", { name: "zzz.txt", ids: ["77"] })], entries);
  eq([...m1.byPath.keys()], ["c:\\w\\a.docx"], "貼ったファイルの行に付く");
  eq(m1.general.map((n) => n.id), ["n2"], "フォルダ全体の付箋");
  eq(m1.orphans.map((n) => n.id), ["n3"], "貼り先が無い付箋は、はがれた付箋");
  eq(m1.learned.size, 0, "名前もIDも変わっていなければ、覚え直さない");

  const renamed = [E("1", "a_改.docx"), E("2", "b.xlsx")];
  const m2 = S.matchNotes([mk("n1", { name: "a.docx", ids: ["1"] })], renamed);
  eq([...m2.byPath.keys()], ["c:\\w\\a_改.docx"], "名前を変えても、IDで付いていく");
  eq(m2.learned.get("n1"), { name: "a_改.docx", id: "1" }, "新しい名前を覚え直す");

  const other = [E("500", "a.docx")];
  const noteB = mk("n1", { name: "a.docx", ids: ["1"] });
  const m3 = S.matchNotes([noteB], other);
  eq(m3.byPath.size, 1, "別の PC ではIDが違っても、名前で見つかる");
  eq(m3.learned.get("n1"), { name: "a.docx", id: "500" }, "この PC のIDを覚える");
  const learnedDoc = S.applyLearned({ v: 1, notes: [noteB] }, m3.learned);
  eq(learnedDoc.notes[0].on.ids, ["1", "500"], "IDを足す");
  eq(learnedDoc.notes[0].u, 1, "覚え直しでは、更新の時刻を変えない");
  ok(S.applyLearned(learnedDoc, S.matchNotes(learnedDoc.notes, other).learned) === learnedDoc, "覚え直したあとは、もう何も変わらない（書き込みの繰り返しにならない）");
  const m4 = S.matchNotes(learnedDoc.notes, [E("500", "別名.docx")]);
  eq(m4.byPath.size, 1, "覚え直したあとは、この PC で名前を変えても付いていく");

  eq(S.matchNotes([mk("n1", { name: "A.DOCX", ids: [] })], entries).byPath.size, 1, "名前は大文字・小文字を区別しない");
  eq(S.matchNotes([mk("n1", { name: "sub", ids: ["3"] })], entries).orphans.length, 1, "フォルダには、ファイルの付箋を付けない");
  eq(S.matchNotes([mk("n1", { name: "a.docx", ids: ["1"] }, { gone: 5 })], entries).byPath.size, 0, "はがした付箋は貼り先を探さない");
  const fat = [E("", "memo.txt")];
  const m5 = S.matchNotes([mk("n1", { name: "memo.txt", ids: [] })], fat);
  eq(m5.byPath.size, 1, "ID の無いドライブでは、名前で付く");
  eq(S.applyLearned({ v: 1, notes: [mk("n1", { name: "memo.txt", ids: [] })] }, m5.learned).notes[0].on.ids, [], "空のIDは覚えない");
  eq(S.matchNotes([mk("n1", { name: "a.docx", ids: ["9", "1"] })], entries).byPath.size, 1, "いくつかIDを持っていても、合うものが付く");
}

// ---- 探す・数える ------------------------------------------------------------------------------
section("探す・数える");
{
  const place = (name, path, notes) => ({ id: "", path, name, notes: notes.map(([id, text, on, u, gone]) => ({ id, text, color: "yellow", t: u, u, gone: gone || 0, on })) });
  const places = [
    place("企画", "C:\\w\\企画", [["a", "原価を確認する", "見積もり.xlsx", 300], ["b", "表紙を直す", "企画書.docx", 100], ["c", "古いメモ", null, 50, 60]]),
    place("家", "C:\\h\\家の手続き", [["d", "保険を比べる", null, 200]]),
  ];
  eq(S.searchPlaces(places, "", false).map((g) => g.place.name), ["企画", "家"], "新しい付箋のある場所から");
  eq(S.searchPlaces(places, "", false)[0].notes.map((n) => n.id), ["a", "b"], "場所の中も新しい順");
  eq(S.searchPlaces(places, "原価", false).map((g) => g.notes.map((n) => n.id)), [["a"]], "付箋の文で探す");
  eq(S.searchPlaces(places, "企画書", false).map((g) => g.notes.map((n) => n.id)), [["b"]], "貼り先のファイル名で探す");
  eq(S.searchPlaces(places, "家の", false).map((g) => g.place.name), ["家"], "場所のパスで探す");
  eq(S.searchPlaces(places, "企画 表紙", false)[0].notes.map((n) => n.id), ["b"], "空白で分けたことばは、全部含むものだけ");
  eq(S.searchPlaces(places, "ＡＢＣ", false), [], "見つからなければ空");
  eq(S.searchPlaces(places, "古い", false), [], "はがした付箋は、貼ってある側に出ない");
  eq(S.searchPlaces(places, "古い", true).map((g) => g.notes[0].id), ["c"], "はがした付箋の側で探す");
  eq(S.searchPlaces(places, "ABC", true), [], "大文字・小文字は区別しない（無い語）");
  eq(S.countNotes(places), { active: 3, peeled: 1 }, "数える");
  eq(S.cleanPlace({ path: "C:\\x", notes: [{ id: "q", text: "t" }, { id: "../", text: "bad" }] }).notes.length, 1, "索引の壊れた付箋は捨てる");
  const round = S.cleanPlace(S.summarize({ id: "5", path: "C:\\w\\企画" }, "企画", { v: 1, notes: [{ id: "q1", text: "文", color: "blue", t: 1, u: 2, gone: 0, on: { name: "a.docx", ids: ["9"] } }, { id: "q2", text: "全体", color: "pink", t: 3, u: 3, gone: 0, on: null }] }, NOW));
  eq(round.notes.map((n) => [n.id, n.on, n.color]), [["q1", "a.docx", "blue"], ["q2", null, "pink"]], "索引に写して読み戻しても、貼り先のファイル名が残る");
  eq(S.cleanPlace({ notes: [] }), null, "索引にパスが無ければ捨てる");
  eq(S.cleanPlace("x"), null, "索引が文字なら捨てる");
}

// ---- パスと日付 --------------------------------------------------------------------------------
section("パスと日付");
{
  eq(S.parentOf("C:\\Users\\me"), "C:\\Users", "親のフォルダ");
  eq(S.parentOf("C:\\Users"), "C:\\", "ドライブの直下の親は、ドライブ");
  eq(S.parentOf("C:\\"), "", "ドライブに親は無い");
  eq(S.parentOf("\\\\srv\\share\\x"), "\\\\srv\\share", "ネットワークの親");
  eq(S.nameOf("C:\\Users\\me\\"), "me", "末尾の \\ は無視する");
  eq(S.joinPath("C:\\", "a.txt"), "C:\\a.txt", "ドライブ直下につなぐ");
  ok(S.samePath("C:\\Users\\Me\\", "c:\\users\\me"), "パスは大文字・小文字と末尾の \\ を区別しない");
  eq(S.crumbs("C:\\Users\\me\\Documents"), [{ name: "C:", path: "C:\\" }, { name: "Users", path: "C:\\Users" }, { name: "me", path: "C:\\Users\\me" }, { name: "Documents", path: "C:\\Users\\me\\Documents" }], "パンくず");
  eq(S.crumbs("\\\\srv\\share\\a\\b").map((c) => c.name), ["\\\\srv\\share", "a", "b"], "ネットワークは、サーバーと共有をひとまとまりに");
  eq(S.crumbs("C:\\").map((c) => c.path), ["C:\\"], "ドライブだけ");

  eq(S.whenText(NOW - 5_000, NOW), "たった今", "5秒前");
  eq(S.whenText(NOW - 5 * 60_000, NOW), "5分前", "5分前");
  eq(S.whenText(NOW - 2 * 3_600_000, NOW), "2時間前", "2時間前");
  eq(S.whenText(NOW - 16 * 3_600_000, NOW), "きのう", "日をまたいだ昨日");
  eq(S.whenText(NOW - 4 * DAY, NOW), "4日前", "4日前");
  eq(S.whenText(new Date(2026, 8, 3, 10).getTime(), NOW), "9月3日", "2週間より前は日付");
  eq(S.whenText(new Date(2025, 11, 31, 10).getTime(), NOW), "2025年12月31日", "前の年は年も");
  eq(S.whenText(NOW + 60_000, NOW), "たった今", "時計が進んでいても壊れない");
  eq(S.whenText(0, NOW), "", "時刻が無ければ空");
  eq(S.dateText(new Date(2026, 9, 3, 9, 5).getTime(), NOW), "10/3 09:05", "今年の更新日時");
  eq(S.dateText(new Date(2024, 0, 9, 9, 5).getTime(), NOW), "2024/1/9", "前の年の更新日時");
}

// ---- 保存（偽の本体） --------------------------------------------------------------------------
section("保存");
{
  const fsys = createFakeFs();
  const seeded = seedFs(fsys, S, NOW);
  const log = [];
  const ep = createFakeEp(fsys, FOLDER, { log });
  const data = createData(ep);
  const node = fsys.get(FOLDER);
  const ref = { id: node.id, path: node.path };
  const before = (await data.load(ref)).notes.length;
  eq(before, 8, "種の付箋を読む");

  let r1, r2;
  await Promise.all([
    data.update(ref, (d) => S.addNote(d, { text: "同時1", now: NOW }).doc).then((d) => (r1 = d)),
    data.update(ref, (d) => S.addNote(d, { text: "同時2", now: NOW + 1 }).doc).then((d) => (r2 = d)),
  ]);
  const after = await data.load(ref);
  eq(after.notes.length, before + 2, "同じフォルダへの同時の書き込みは、どちらも残る");
  ok(r2.notes.length === before + 2, "あとの書き込みは、先の書き込みの上に重なる");

  const setsBefore = log.filter((l) => l.startsWith("fd.set")).length;
  const same = await data.update(ref, (d) => d);
  eq(log.filter((l) => l.startsWith("fd.set")).length, setsBefore, "変わらなければ書かない");
  ok(same.notes.length === before + 2, "変わらなくても今の doc を返す");

  // 同期で、別の PC の付箋が届いた
  node.data = { v: 1, notes: [...node.data.notes, { id: "nFromOtherPc", text: "別の PC で貼った", color: "pink", t: NOW, u: NOW, gone: 0, on: null }] };
  const merged = await data.update(ref, (d) => S.addNote(d, { text: "続き", now: NOW + 2 }).doc);
  ok(merged.notes.some((n) => n.id === "nFromOtherPc") && merged.notes.some((n) => n.text === "続き"), "書く前に読み直すので、同期で届いた付箋を巻き戻さない");

  // 壊れたデータ
  const bad = fsys.add(`${FOLDER}\\壊れ`, "folder");
  bad.data = "これは JSON ではない";
  const badRef = { id: bad.id, path: bad.path };
  eq((await data.load(badRef)).notes, [], "壊れたデータは空として読む");
  const fixed = await data.update(badRef, (d) => S.addNote(d, { text: "復活", now: NOW }).doc);
  eq(fixed.notes.length, 1, "壊れたフォルダにも、そのまま貼れる");

  // 0枚になったらデータごと消す
  const only = await data.update(badRef, (d) => S.removeNote(d, d.notes[0].id));
  eq(only.notes.length, 0, "最後の1枚を消す");
  ok(bad.data === undefined && log.includes("fd.delete 壊れ"), "0枚になったら、データのファイルも消す");

  // 大きすぎる
  const keep = S.LIMITS.bytes;
  S.LIMITS.bytes = 300;
  const snapshotBefore = JSON.stringify(node.data);
  await rejects(() => data.update(ref, (d) => S.addNote(d, { text: "あ".repeat(100), now: NOW }).doc), "too-large", "大きすぎれば書かずに断る");
  S.LIMITS.bytes = keep;
  eq(JSON.stringify(node.data), snapshotBefore, "断ったときは、データを変えない");
  await rejects(() => data.update({ id: "9999", path: FOLDER }, (d) => d), "denied", "IDが合わないフォルダには書けない");
  await rejects(() => data.update({ id: "1", path: `${FOLDER}\\ない` }, (d) => d), "not-found", "無いフォルダには書けない");
  const next = await data.update(ref, (d) => S.addNote(d, { text: "失敗のあとも書ける", now: NOW }).doc);
  ok(next.notes.some((n) => n.text === "失敗のあとも書ける"), "書き込みが失敗したあとも、次の書き込みはできる");

  // フォルダを動かしても付箋が付いていく
  const moved = fsys.move(FOLDER, `${FOLDER}改`);
  const movedDoc = await data.load({ id: moved.id, path: moved.path });
  eq(movedDoc.notes.length, next.notes.length, "フォルダの名前を変えても、付箋は付いていく");
  fsys.move(`${FOLDER}改`, FOLDER);

  // 索引
  const sets = [];
  const origSet = ep.storage.set;
  ep.storage.set = async (k, v) => (sets.push(k), origSet(k, v));
  await data.remember(ref, "新商品の企画", next, NOW);
  await data.remember(ref, "新商品の企画", next, NOW + 5000);
  eq(sets.length, 1, "同じ内容は、索引に何度も書かない");
  await data.remember(badRef, "壊れ", only, NOW);
  eq(sets.length, 1, "付箋が0枚の場所は、索引に入れない");
  const places = await data.places();
  eq(places.length, 1, "索引から場所を読む");
  eq([places[0].name, places[0].notes.length], ["新商品の企画", next.notes.length], "索引の写し");
  ep.__store.set("place:壊れた", { path: 5 });
  await data.forget(places[0].key);
  eq((await data.places()).length, 0, "索引から外す。壊れた索引は読み飛ばす");

  const emptyEp = createFakeEp(createFakeFs(), "C:\\", {});
  eq(seedIndex(fsys, S, NOW).length >= 4, true, "種の索引");
}

// ---- 右クリックから貼る --------------------------------------------------------------------------
section("右クリックから貼る");
{
  const run = async (n, { items, folder, answer, settings }) => {
    const fsys = createFakeFs();
    const seeded = seedFs(fsys, S, NOW);
    const log = [];
    const ep = createFakeEp(fsys, FOLDER, { log, background: true, ask: () => answer, settings });
    globalThis.window = { explorerPlus: ep };
    await import(`${st.url("index.js")}?bg${n}`);
    await ep.__emitMenu({ id: "stick", items: items(fsys), folder: folder(fsys) });
    return { fsys, log };
  };
  const refOf = (n) => ({ id: n.id, path: n.path });
  const entryOf = (n) => ({ id: n.id, name: n.name, path: n.path, kind: n.kind, ext: "", hidden: false });
  const notesOf = (fsys, p) => S.normalizeDoc(fsys.get(p).data).notes;

  let r = await run(1, { items: (f) => [entryOf(f.get(`${FOLDER}\\会議メモ.txt`))], folder: (f) => refOf(f.get(FOLDER)), answer: "  明日 10 時に見直す  " });
  let notes = notesOf(r.fsys, FOLDER);
  let mine = notes.at(-1);
  eq([mine.text, mine.on.name, mine.on.ids.length, mine.color], ["明日 10 時に見直す", "会議メモ.txt", 1, "yellow"], "ファイルを右クリック：そのファイルに貼る");
  ok(r.log.some((l) => l.startsWith("toast 付箋を貼りました")) && r.log.includes("menu.done"), "貼ったらお知らせして、終わりを伝える");
  ok(r.log.some((l) => l.startsWith("ask 会議メモ.txt")), "何に貼るのかを、入力の画面に出す");

  r = await run(2, { items: (f) => [entryOf(f.get(`${FOLDER}\\写真`))], folder: (f) => refOf(f.get(FOLDER)), answer: "整理する" });
  eq(notesOf(r.fsys, `${FOLDER}\\写真`).map((n) => [n.text, n.on]), [["整理する", null]], "フォルダを右クリック：そのフォルダの中に貼る");

  r = await run(3, { items: () => [], folder: (f) => refOf(f.get(FOLDER)), answer: "全体のメモ", settings: { color: "blue" } });
  mine = notesOf(r.fsys, FOLDER).at(-1);
  eq([mine.text, mine.on, mine.color], ["全体のメモ", null, "blue"], "空いている所を右クリック：このフォルダ全体に貼る。色は設定どおり");

  r = await run(4, { items: (f) => [entryOf(f.get(`${FOLDER}\\会議メモ.txt`))], folder: (f) => refOf(f.get(FOLDER)), answer: null });
  eq(notesOf(r.fsys, FOLDER).length, 8, "入力をやめたら、何も貼らない");
  ok(r.log.includes("menu.done"), "やめても終わりを伝える");
  r = await run(5, { items: (f) => [entryOf(f.get(`${FOLDER}\\会議メモ.txt`))], folder: (f) => refOf(f.get(FOLDER)), answer: "   " });
  eq(notesOf(r.fsys, FOLDER).length, 8, "空白だけなら、何も貼らない");
  r = await run(6, { items: (f) => [entryOf(f.get(`${FOLDER}\\会議メモ.txt`))], folder: () => null, answer: "x" });
  ok(r.log.some((l) => l.startsWith("toast ここには貼れません")) && r.log.includes("menu.done"), "場所が分からなければ、断って終わる");
  r = await run(7, { items: (f) => [entryOf(f.get(`${FOLDER}\\会議メモ.txt`))], folder: (f) => ({ id: "0", path: f.get(FOLDER).path }), answer: "x" });
  ok(r.log.some((l) => l.startsWith("toast ")) && r.log.includes("menu.done"), "書けなかったときも、お知らせして終わる");
  delete globalThis.window;
}

// ---- manifest と書き方の決まり ---------------------------------------------------------------------
section("manifest と書き方");
{
  const m = JSON.parse(fs.readFileSync(path.join(MOD_DIR, "manifest.json"), "utf8"));
  ok(/^[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]$/.test(m.id) && !m.id.startsWith("builtin."), `id の形 ${m.id}`);
  ok(m.name.length >= 1 && m.name.length <= 40, "名前は40文字まで");
  ok(/^\d+\.\d+\.\d+$/.test(m.version) && m.apiVersion === 1, "版");
  ok(fs.existsSync(path.join(MOD_DIR, m.entry)), "入口がある");
  ok(m.description.length <= 200, `説明は200文字まで（${m.description.length}）`);
  const allowed = new Set(["entries", "size", "folderSize", "modified", "icons", "thumbnails", "tree", "links", "tags", "timetable", "quickAccess", "recent", "folderData", "fileContent", "fileInfo", "search", "system", "createFiles", "collections", "pointerLock", "folderLog", "identity"]);
  ok(m.uses.every((u) => allowed.has(u)), "uses は本体が知っているものだけ");
  eq([...m.uses].sort(), ["entries", "folderData", "icons", "links", "modified"], "uses は必要なものだけ");
  ok(!m.network, "通信はしない");
  ok(m.settings.length <= 30 && m.settings.every((s) => s.label.length <= 40), "設定は30項目まで、名前は40文字まで");
  ok(m.settings.filter((s) => s.type === "choice").every((s) => s.options.some((o) => o.value === s.default)), "選ぶ設定の既定は選択肢の中");
  ok(m.menu.length <= 20 && new Set(m.menu.map((x) => x.id)).size === m.menu.length && m.menu.every((x) => x.label.length <= 60), "右クリックの項目の決まり");
  const COLORS = S.COLORS.map((c) => c.id);
  eq(m.settings.find((s) => s.key === "color").options.map((o) => o.value), COLORS, "設定の色と、付箋の色が同じ");

  const files = fs.readdirSync(MOD_DIR).filter((f) => f.endsWith(".js") || f.endsWith(".css"));
  for (const f of files) {
    const text = fs.readFileSync(path.join(MOD_DIR, f), "utf8");
    const lines = text.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).map((l) => l.replace(/\s\/\/.*$/, ""));
    const code = lines.join("\n");
    ok(!/[（）]/.test(code), `${f}：画面の文章に（）の補足を入れない`);
    const bare = lines.filter((l) => /<[a-z]/.test(l) && [...l.matchAll(/\$\{([^}]*)\}/g)].some((m) => /\.(name|path|text|label|message)\b/.test(m[1]) && !/\besc\(|LIMITS\.|\bc\.label\b/.test(m[1])));
    ok(!bare.length, `${f}：HTML に入れる文字は esc を通す ${bare.join(" / ").slice(0, 120)}`);
    ok(!/\bfetch\(|XMLHttpRequest|WebSocket|ep\.net\b|\beval\(|new Function\(/.test(code), `${f}：通信と eval を使わない`);
    ok(!/\.onclick\s*=\s*"/.test(code), `${f}：文字列のイベント属性を使わない`);
  }
  const html = fs.readFileSync(path.join(MOD_DIR, "view.js"), "utf8");
  ok(!/\$\{n\.on\.name\}/.test(html) && !/\$\{found\.path\}/.test(html), "view.js：貼り先の名前とパスは esc を通す");
}

console.log(fail ? `\n${fail} 件 NG（全 ${total} 件）` : `\n全部 OK（${total} 件）`);
process.exitCode = fail ? 1 : 0;
