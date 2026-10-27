// ここ付箋 — 本物の index.js を、ヘッドレスの Edge で動かして、操作する・画面を撮る（偽の explorerPlus と、メモリの中のフォルダを渡す）。
//   使い方：node place-notes/dev/browser.mjs [出力フォルダ] [--scenario=look|flow|big] [--w=1100 --h=760] [--dpr=1]
//   出力フォルダに PNG を書く。コンソールのエラーも出す。Edge が無ければ Chrome を使う
import os from "node:os";
import path from "node:path";
import { launch } from "./cdp.mjs";

const args = process.argv.slice(2);
const outDir = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(os.tmpdir(), "pn-shots"));
const opt = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }));
const scenario = opt.scenario || "look";

// ページ：偽のフォルダに種をまいてから、本物の index.js を読む。設定は # の後ろの JSON で渡す
const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<script type="module">
import { createFakeFs, createFakeEp } from "/dev/fake-host.mjs";
import { seedFs, seedIndex, FOLDER } from "/dev/seed.mjs";
import * as S from "/mod/store.js";
const cfg = JSON.parse(decodeURIComponent(location.hash.slice(1) || "{}"));
const fsys = createFakeFs();
const now = Date.now();
seedFs(fsys, S, now, { big: cfg.big || 0 });
window.__fs = fsys; window.__S = S; window.__FOLDER = FOLDER; window.__log = [];
const opts = { log: window.__log, theme: cfg.theme || "light", storage: cfg.index === false ? [] : seedIndex(fsys, S, now), menuChoice: () => window.__menu || null, ask: () => window.__ask ?? null };
window.__opts = opts;
window.__ep = window.explorerPlus = createFakeEp(fsys, cfg.start || FOLDER, opts);
await import("/mod/index.js?debug");
window.__ready = true;
</script></body></html>`;

const b = await launch({ html: HARNESS, w: Number(opt.w || 1100), h: Number(opt.h || 760), dpr: Number(opt.dpr || 1), outDir });
const { ev, sleep, check, shot } = b;
process.on("exit", () => b.logs.length && console.log("\nコンソール：\n" + b.logs.join("\n")));

const READY = "!!window.__ready && document.querySelectorAll('.row').length > 0";
const boot = (cfg = {}) => b.boot(cfg, cfg.ready || READY);
const waitFor = async (expr, ms = 3000) => {
  for (let t = 0; t < ms; t += 50) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(50);
  }
  return false;
};
/** 一覧の行を名前で探す */
const ROW = (name) => `[...document.querySelectorAll('.row')].find((r) => r.querySelector('.nm')?.textContent === ${JSON.stringify(name)})`;
/**
 * 要素が見える所まで動かして、位置が落ち着くまで待つ。
 * ヘッドレスでは、JS で動かした直後の最初のマウス操作で、動かした分が元に戻ることがある。マウスを乗せて待ち、同じ位置が2回続くまで測りなおす
 */
async function settle(measure) {
  let last = null;
  for (let i = 0; i < 6; i++) {
    const p = await ev(measure);
    if (!p) return null;
    if (last && Math.abs(last.x - p.x) < 1 && Math.abs(last.y - p.y) < 1) return p;
    last = p;
    await b.move(p.x, p.y);
    await sleep(200);
  }
  return last;
}
const rowPos = (name) => settle(`(() => { const r = ${ROW(name)}; if (!r) return null; const x = r.querySelector('.nm').getBoundingClientRect(); if (x.top < 60 || x.bottom > innerHeight - 110) r.scrollIntoView({ block: "center" }); const y = r.querySelector('.nm').getBoundingClientRect(); return { x: y.left + 8, y: y.top + y.height / 2 }; })()`);
/** 掲示板の付箋の位置。text は、付箋の文に含まれることば */
const boardChipPos = (text) => settle(`(() => { const t = [...document.querySelectorAll('.board .note')].find((n) => n.textContent.includes(${JSON.stringify(text)})); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 22 }; })()`);
/** 付箋の文の位置 */
const noteTextPos = (name, i = 0) => settle(`(() => { const t = ${ROW(name)}.querySelectorAll('.note .tx')[${i}]; const a = t.getBoundingClientRect(); if (a.top < 60 || a.bottom > innerHeight - 110) t.scrollIntoView({ block: "center" }); const n = t.getBoundingClientRect(); return { x: n.left + 12, y: n.top + 6 }; })()`);
const rowNotes = (name) => ev(`(() => { const r = ${ROW(name)}; return r ? [...r.querySelectorAll('.note .tx')].map((n) => n.textContent) : null; })()`);
const boardNotes = () => ev(`[...document.querySelectorAll('.board .chips:first-of-type .note:not(.orphan) .tx')].map((n) => n.textContent)`);
const orphanCount = () => ev(`document.querySelectorAll('.note.orphan').length`);
const dataOf = (p) => ev(`JSON.stringify(window.__fs.get(${JSON.stringify(p)}).data?.notes?.map((n) => ({ text: n.text, on: n.on?.name ?? null, gone: n.gone })) ?? [])`).then(JSON.parse);
const logHas = (re) => ev(`window.__log.some((l) => ${re}.test(l))`);
const FOLDER = "C:\\Users\\neo\\Documents\\新商品の企画";
const click = async (name) => { const p = await rowPos(name); await b.click(p.x, p.y); await sleep(80); };
const post = async (text) => { await b.type(text); await b.key("Enter"); await sleep(250); };
const press = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);

// ---- 見た目：いくつかの画面を撮る -------------------------------------------------------------
async function look() {
  await boot();
  await sleep(500);
  await shot("here");
  await click("見積もり.xlsx");
  await shot("selected");

  // 書き直し
  const chip = await b.center(".row .note");
  await b.click(chip.x, chip.y);
  await sleep(200);
  await shot("editing");
  await b.key("Escape");

  await press("[data-mode='all']");
  await waitFor("document.querySelectorAll('.place').length > 0");
  await sleep(300);
  await shot("all");
  await press("[data-tab='peeled']");
  await sleep(200);
  await shot("all-peeled");

  await boot({ theme: "dark" });
  await sleep(500);
  await shot("here-dark");
  await press("[data-mode='all']");
  await waitFor("document.querySelectorAll('.place').length > 0");
  await shot("all-dark");

  await b.boot({ w: 420, h: 760 });
  await sleep(500);
  await shot("here-narrow");
  await boot({ index: false, start: "C:\\Users\\neo\\Documents\\家の手続き", w: 1100, h: 560 });
  await sleep(300);
  await shot("other-folder");
  await ev("window.__fs.get('C:\\\\Users\\\\neo\\\\Documents\\\\家の手続き').data = undefined; window.__ep.__emitFolder()");
  await sleep(500);
  await shot("empty-board");
}

// ---- 見た目：付箋をずらす・大きさを変える・つかんでいる最中 ---------------------------------------------
async function layout() {
  await boot({ h: 900 });
  await waitFor("!!document.querySelector('.row .bd')");
  await sleep(300);
  // 掲示板の付箋を書き直す：下の段（色の丸・自動で残ります・ボタン）が崩れない
  const e0 = await boardChipPos("このフォルダは");
  await b.click(e0.x, e0.y);
  await sleep(300);
  await ev(`document.querySelector('.note.editing').style.setProperty('--nw', '210px')`);
  await sleep(100);
  await shot("edit-narrow");
  await ev(`document.querySelector('.note.editing').style.removeProperty('--nw')`);
  await sleep(100);
  await shot("edit-board");
  await b.key("Escape");
  await sleep(300);
  const a = await noteTextPos("企画書_v3.docx", 0);
  await b.drag(a.x, a.y, a.x + 200, a.y + 4, { steps: 8 });
  const gp = await ev(`(() => { const r = ${ROW("企画書_v3.docx")}.querySelectorAll('.note')[1].getBoundingClientRect(); return { x: r.right - 6, y: r.bottom - 6 }; })()`);
  await b.drag(gp.x, gp.y, gp.x + 60, gp.y + 50, { steps: 8 });
  await sleep(400);
  await shot("layout");
  const to = await rowPos("契約書");
  const from = await boardChipPos("山本");
  await b.drag(from.x, from.y, to.x, to.y, { steps: 12, hold: true });
  await sleep(200);
  await shot("dragging");
  await b.mouse("mouseReleased", to.x, to.y);
}

// ---- 操作：貼る・書き直す・はがす・連れていく・動かされる・すべての付箋 ----------------------------------
async function flow() {
  await boot({ h: 1100 });
  await waitFor("!!document.querySelector('.row .bd')");   // 子フォルダの付箋を読み終えるまで待つ
  await sleep(300);

  // はじめの姿
  check((await b.count(".row")) === 10, "隠しファイルは出さない：行が10");
  check((await rowNotes("企画書_v3.docx"))?.length === 2, "ファイルに貼った付箋が、そのファイルの行に出る");
  check((await boardNotes()).length === 2, "フォルダの付箋が上に出る");
  check((await orphanCount()) === 1, "動かされたファイルの付箋は、はがれた付箋として出る");
  check(await ev(`document.querySelector('.lost .where')?.textContent.includes('アーカイブ')`), "動かされた先を案内する");
  check(await ev(`document.querySelector('#nhere').textContent`) === "7", "この場所の付箋の数");
  check(await logHas(/^tab 7$/), "タブに付箋の数を出す");
  check(await ev(`document.querySelector('.row[data-kind=folder] .bd')?.textContent.includes('2')`), "子フォルダの付箋の数が行に出る");
  check(await ev(`document.activeElement?.id === 'compose'`), "開いたら書く欄に入っている");

  // 選んで、書いて、Enter
  await click("見積もり.xlsx");
  check(await ev(`document.querySelector('#to').textContent.includes('見積もり.xlsx')`), "行を選ぶと、貼る先がそのファイルになる");
  check(await ev(`document.activeElement?.id === 'compose'`), "行を選んでも書く欄に入ったまま");
  await post("先方に確認した。送って大丈夫");
  check((await rowNotes("見積もり.xlsx")).length === 2, "Enter で、選んだファイルに貼れる");
  check((await dataOf(FOLDER)).some((n) => n.text === "先方に確認した。送って大丈夫" && n.on === "見積もり.xlsx"), "貼ったとたんに、フォルダの中へ保存される");
  check((await ev(`document.querySelector('#compose').value`)) === "", "貼ったら欄が空になる");
  check(await ev(`document.activeElement?.id === 'compose'`), "貼ったあとも続けて書ける");

  // 何も選ばない＝このフォルダ（行の外の余白を押す）
  await b.click(6, 300);
  await sleep(100);
  check(await ev(`document.querySelector('#to').textContent.includes('このフォルダ')`), "何も選ばなければ、このフォルダに貼る");
  await post("来週までに片付ける");
  check((await boardNotes()).includes("来週までに片付ける"), "フォルダ全体の付箋が上に出る");

  // 改行は Shift + Enter、日本語の入力中の Enter では貼らない
  await b.type("一行目");
  await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", modifiers: 8, windowsVirtualKeyCode: 13, text: "\r" });
  await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", modifiers: 8, windowsVirtualKeyCode: 13 });
  await b.type("二行目");
  check((await ev(`document.querySelector('#compose').value`)) === "一行目\n二行目", "Shift + Enter は改行");
  await ev(`document.querySelector('#compose').value = ''`);

  // フォルダを選んで貼ると、そのフォルダの中に入る
  await click("写真");
  check(await ev(`document.querySelector('#to').textContent.includes('写真 フォルダ')`), "フォルダを選ぶと、そのフォルダが貼る先");
  await post("夏の行事の写真を入れる");
  check((await rowNotes("写真"))?.includes("夏の行事の写真を入れる"), "フォルダの付箋は、その行にも出る");
  check((await dataOf(FOLDER + "\\写真")).length === 1, "フォルダの付箋は、そのフォルダの中に保存される");
  check(await ev(`!!${ROW("写真")}.querySelector('.bd')`), "子フォルダの付箋の数が出る");

  // 書き直す：打つたびに残る
  await click("企画書_v3.docx");
  const c1 = await noteTextPos("企画書_v3.docx");
  await b.click(c1.x, c1.y);
  await sleep(150);
  check((await b.count("textarea.edit")) === 1, "付箋を押すと、その場で書き直せる");
  check(await ev(`document.activeElement.classList.contains('edit')`), "書き直しの欄に入っている");
  await b.type("【急ぎ】");
  await sleep(1000);
  check((await dataOf(FOLDER)).some((n) => n.text.endsWith("【急ぎ】")), "閉じる前でも、自動で残る");
  await b.click(6, 520);
  await sleep(300);
  check((await b.count("textarea.edit")) === 0, "ほかを押すと閉じる");
  check((await rowNotes("企画書_v3.docx")).some((t) => t.endsWith("【急ぎ】")), "書き直した文が出る");

  // 書き直しの途中で同期が届いても、書きかけは消えない
  const c2 = await noteTextPos("参考資料.pdf");
  await b.click(c2.x, c2.y);
  await sleep(150);
  await b.type("（書きかけ）");
  await ev(`(() => { const n = window.__fs.get(window.__FOLDER); n.data = { v: 1, notes: [...n.data.notes, { id: 'nOther1', text: '別の PC で貼った', color: 'pink', t: Date.now(), u: Date.now(), gone: 0, on: null }] }; window.__ep.__emitFolder(); })()`);
  await sleep(500);
  check(await ev(`document.querySelector('textarea.edit')?.value.endsWith('（書きかけ）')`), "同期が届いても、書きかけは消えない");
  check(await ev(`document.activeElement.classList.contains('edit')`), "同期が届いても、書く場所に入ったまま");
  await b.key("Escape");
  await sleep(400);
  check((await boardNotes()).includes("別の PC で貼った"), "閉じたあとで、同期で届いた付箋が出る");
  check((await dataOf(FOLDER)).some((n) => n.text.endsWith("（書きかけ）")), "書きかけも別の PC の付箋も、どちらも残る");

  // 色
  const c3 = await ev(`(() => { document.querySelector('#main').scrollTop = 0; const n = document.querySelector('.board .note:not(.orphan)').getBoundingClientRect(); return { x: n.left + 20, y: n.top + 20 }; })()`);
  await b.click(c3.x, c3.y);
  await sleep(150);
  await press(".note.editing .dot.c-green");
  await sleep(200);
  check(await ev(`document.querySelector('.note.editing').classList.contains('c-green')`), "色をその場で変えられる");
  const footOk = () => ev(`(() => { const bs = [...document.querySelectorAll('.note.editing .foot .sm')]; return bs.length === 2 && bs.every((x) => { const r = x.getBoundingClientRect(); return r.height < 30 && r.width > 36; }); })()`);
  check(await footOk(), "掲示板の付箋を書き直すとき、「とじる」「はがす」の字が縦に崩れない");
  await ev(`document.querySelector('.note.editing').style.setProperty('--nw', '190px')`);
  await sleep(100);
  check(await footOk() && await ev(`document.querySelector('.note.editing .auto').getBoundingClientRect().height < 24`), "せまい付箋でも、ボタンと「自動で残ります」は折り返さず、下の段が2行に分かれる");
  await ev(`document.querySelector('.note.editing').style.removeProperty('--nw')`);
  await b.key("Escape");
  await sleep(300);

  // はがす・元に戻す
  const before = (await boardNotes()).length;
  await press(".board .note:not(.orphan) .peel");
  await sleep(300);
  check((await boardNotes()).length === before - 1, "はがすと、画面から消える");
  check((await dataOf(FOLDER)).some((n) => n.gone > 0), "はがした付箋は、消えずに残っている");
  check(await ev(`!document.querySelector('#snack').hidden`), "元に戻す帯が出る");
  await press("#snack [data-act='undo']");
  await sleep(300);
  check((await boardNotes()).length === before, "元に戻せる");

  // はがれた付箋：連れていく
  check((await b.count(".lost [data-act='carry']")) === 1, "動かされた先が分かれば、連れていくボタンが出る");
  await press(".lost [data-act='carry']");
  await waitFor("document.querySelector('#crumbs .cur')?.textContent === 'アーカイブ'");
  await waitFor("[...document.querySelectorAll('.row')].some((r) => r.querySelector('.nm')?.textContent === '旧見積もり.xlsx' && r.querySelector('.note'))");
  await sleep(300);
  check((await rowNotes("旧見積もり.xlsx"))?.length === 1, "動かされたファイルの行に、付箋が付いてきた");
  check((await dataOf(FOLDER)).every((n) => n.on !== "旧見積もり.xlsx"), "元のフォルダからは外れた");
  check(await logHas(/toast 付箋を連れてきました/), "連れてきたとお知らせする");
  await press("#up");
  await waitFor("document.querySelector('#crumbs .cur')?.textContent === '新商品の企画'");
  await sleep(400);
  check((await orphanCount()) === 0, "連れていったあとは、はがれた付箋が無い");

  // ファイルの名前を変える・動かす
  await ev(`window.__fs.move(window.__FOLDER + '\\\\参考資料.pdf', window.__FOLDER + '\\\\参考資料_最終.pdf')`);
  await sleep(500);
  check((await rowNotes("参考資料_最終.pdf"))?.length === 1, "ファイルの名前を変えても、付箋は付いていく");
  check((await dataOf(FOLDER)).some((n) => n.on === "参考資料_最終.pdf"), "新しい名前を付箋に覚え直す");
  await ev(`window.__fs.move(window.__FOLDER + '\\\\参考資料_最終.pdf', window.__FOLDER + '\\\\アーカイブ\\\\参考資料_最終.pdf')`);
  await sleep(600);
  check((await orphanCount()) === 1, "ファイルを別のフォルダへ動かすと、はがれた付箋になる");
  check(await ev(`document.querySelector('.lost .where')?.textContent.includes('アーカイブ')`), "動かした先を案内する");
  await press(".lost [data-act='to-folder']");
  await sleep(400);
  check((await orphanCount()) === 0 && (await boardNotes()).some((t) => t.startsWith("p.12 の図が使える")), "このフォルダに貼りなおせる");

  // 付箋をつかんで、別のファイルの行に落とす（つかんでいる間は、写しが付いてきて、落とせる行が光る）
  const toLogo = await rowPos("ロゴ案.png");
  const fromBoard = await boardChipPos("p.12");
  await b.drag(fromBoard.x, fromBoard.y, toLogo.x, toLogo.y, { steps: 12, hold: true });
  check((await b.count(".note.ghost")) === 1 && (await b.count(".row.drop")) === 1, "つかんでいる間は、写しが付いてきて、落とせる行が光る");
  await b.mouse("mouseReleased", toLogo.x, toLogo.y);
  await sleep(500);
  check((await rowNotes("ロゴ案.png"))?.some((t) => t.startsWith("p.12 の図が使える")), "付箋をつかんで、別のファイルに貼りなおせる");
  check((await b.count(".note.ghost")) === 0 && (await b.count("textarea.edit")) === 0, "放したあとは、写しが消え、書き直しは開かない");
  check(await ev(`!document.querySelector('#snack').hidden`), "貼りなおしにも、元に戻す帯が出る");

  // 横に並んだフォルダの行に落とす：付箋はそのフォルダの中へ移る
  const toPhoto = await rowPos("写真");
  const fromLogo = await noteTextPos("ロゴ案.png");
  await b.drag(fromLogo.x, fromLogo.y, toPhoto.x, toPhoto.y, { steps: 12 });
  await sleep(600);
  check((await dataOf(FOLDER + "\\写真")).some((n) => n.text.startsWith("p.12") && n.on === null), "フォルダの行に落とすと、付箋はそのフォルダの中に保存される");
  check((await dataOf(FOLDER)).every((n) => !n.text.startsWith("p.12")), "元のフォルダからは外れる");
  check((await rowNotes("写真"))?.some((t) => t.startsWith("p.12")), "そのフォルダの行に出る");
  await press("#snack [data-act='undo']");
  await sleep(600);
  check((await rowNotes("ロゴ案.png"))?.some((t) => t.startsWith("p.12")) && (await dataOf(FOLDER + "\\写真")).every((n) => !n.text.startsWith("p.12")), "元に戻すと、もとのファイルに貼りなおされる");

  // フォルダの付箋を、掲示板（このフォルダ）へ戻す。掲示板の付箋を、フォルダの行へ落とす
  const fromPhoto = await noteTextPos("写真");
  const boardTop = await settle(`(() => { const r = document.querySelector('.board h2').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 8 }; })()`);
  await b.drag(fromPhoto.x, fromPhoto.y, boardTop.x, boardTop.y, { steps: 12 });
  await sleep(600);
  check((await boardNotes()).includes("夏の行事の写真を入れる") && (await dataOf(FOLDER + "\\写真")).length === 0, "フォルダの付箋を掲示板へ落とすと、このフォルダの付箋になる");
  const toContract = await rowPos("契約書");
  const fromBoard2 = await boardChipPos("取引先の担当");
  await b.drag(fromBoard2.x, fromBoard2.y, toContract.x, toContract.y, { steps: 12 });
  await sleep(600);
  check((await dataOf(FOLDER + "\\契約書")).some((n) => n.text.startsWith("取引先の担当")) && !(await boardNotes()).some((t) => t.startsWith("取引先の担当")), "掲示板の付箋を、フォルダの行へ落とすと、そのフォルダの付箋になる");

  // 同じ行の中で放すと、少しずれる。行の外へは出ない
  const chipRect = (name, i = 0) => ev(`(() => { const r = ${ROW(name)}.querySelectorAll('.note')[${i}].getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height }; })()`);
  const layoutOf = (p) => ev(`JSON.stringify(window.__fs.get(${JSON.stringify(p)}).data.notes.filter((n) => n.x || n.y || n.w || n.h).map((n) => ({ text: n.text.slice(0, 5), x: n.x, y: n.y, w: n.w, h: n.h, u: n.u })))`).then(JSON.parse);
  const r0 = await chipRect("企画書_v3.docx");
  const u0 = await ev(`window.__fs.get(window.__FOLDER).data.notes.find((n) => n.text.startsWith('金曜')).u`);
  const g0 = await noteTextPos("企画書_v3.docx", 0);
  await b.drag(g0.x, g0.y, g0.x + 90, g0.y + 4, { steps: 8 });
  await sleep(500);
  const r1 = await chipRect("企画書_v3.docx");
  const lay1 = (await layoutOf(FOLDER)).find((n) => n.text === "金曜までに");
  check(lay1 && lay1.x >= 80 && lay1.x <= 100 && Math.abs(r1.left - r0.left - lay1.x) <= 2, `同じ行の中で放すと、付箋が少しずれて保存される（x=${lay1?.x}、動いた幅 ${Math.round(r1.left - r0.left)}）`);
  check(lay1 && lay1.u === u0, "ずらしても、更新の時刻は変わらない");
  check((await b.count("textarea.edit")) === 0, "ずらしても、書き直しは開かない");
  await ev(`window.__ep.__emitFolder()`);
  await sleep(500);
  check(Math.abs((await chipRect("企画書_v3.docx")).left - r0.left - lay1.x) <= 2, "画面が作り直されても、ずれは残る");
  const g1 = await noteTextPos("企画書_v3.docx", 0);
  await b.drag(g1.x, g1.y, g1.x + 900, g1.y + 300, { steps: 12 });
  await sleep(500);
  const edge = await ev(`(() => { const row = ${ROW("企画書_v3.docx")}; const n = row.querySelectorAll('.note')[0].getBoundingClientRect(); const a = row.querySelector('.notes').getBoundingClientRect(); return { right: n.right <= a.right + 2, left: n.left >= a.left - 2, bottom: n.bottom <= a.bottom + 2, top: n.top >= a.top - 2 }; })()`);
  check(edge.right && edge.left && edge.bottom && edge.top, `行の外へは出ない ${JSON.stringify(edge)}`);

  // 角をつかむと、大きさが変わる。角を2回押すと、もとに戻る
  const sz0 = await chipRect("企画書_v3.docx", 1);
  const grip = () => ev(`(() => { const r = ${ROW("企画書_v3.docx")}.querySelectorAll('.note')[1].getBoundingClientRect(); return { x: r.right - 6, y: r.bottom - 6 }; })()`);
  const gp = await grip();
  await b.drag(gp.x, gp.y, gp.x - 70, gp.y + 60, { steps: 10 });
  await sleep(500);
  const sz1 = await chipRect("企画書_v3.docx", 1);
  const lay2 = (await layoutOf(FOLDER)).find((n) => n.text === "表紙の写真");
  check(lay2 && Math.abs(sz1.w - (sz0.w - 70)) <= 3 && Math.abs(sz1.h - (sz0.h + 60)) <= 3 && lay2.w && lay2.h, `角をつかんで、大きさを変えられる（${Math.round(sz0.w)}×${Math.round(sz0.h)} → ${Math.round(sz1.w)}×${Math.round(sz1.h)}）`);
  check(await ev(`${ROW("企画書_v3.docx")}.querySelectorAll('.note')[1].classList.contains('sized')`), "高さを決めた付箋は、決めた高さになる");
  const gp2 = await grip();
  await b.dblclick(gp2.x, gp2.y);
  await sleep(500);
  const sz2 = await chipRect("企画書_v3.docx", 1);
  check(Math.abs(sz2.w - sz0.w) <= 2 && Math.abs(sz2.h - sz0.h) <= 2 && !(await layoutOf(FOLDER)).some((n) => n.text === "表紙の写真"), "角を2回押すと、大きさがもとに戻る");
  check((await b.count("textarea.edit")) === 0, "角を押しても、書き直しは開かない");

  // 右クリックで、大きさと位置をもとに戻す
  await ev(`window.__menu = 'reset'`);
  const g2 = await noteTextPos("企画書_v3.docx", 0);
  await b.rightClick(g2.x, g2.y);
  await sleep(500);
  await ev(`window.__menu = null`);
  check(!(await layoutOf(FOLDER)).some((n) => n.text === "金曜までに") && Math.abs((await chipRect("企画書_v3.docx")).left - r0.left) <= 2, "右クリックの「大きさと位置をもとに戻す」で、ふつうに戻る");

  // 最後につかんだ付箋は、重なったとき手前に出る（上の付箋を、下の付箋の上へ重ねる。上の付箋は、ふつうは下になる）
  const za = await chipRect("企画書_v3.docx", 0);
  const zb = await chipRect("企画書_v3.docx", 1);
  const zg = await noteTextPos("企画書_v3.docx", 0);
  await b.drag(zg.x, zg.y, zg.x, zg.y + (zb.top - za.top) - 30, { steps: 8 });
  await sleep(500);
  const zTop = await ev(`(() => { const row = ${ROW("企画書_v3.docx")}; const ids = [...row.querySelectorAll('.note')].map((n) => n.dataset.note); const r = row.querySelectorAll('.note')[1].getBoundingClientRect(); const hit = document.elementFromPoint(r.left + 40, r.top + 6)?.closest('.note'); return { first: hit?.dataset.note === ids[0], z: window.__fs.get(window.__FOLDER).data.notes.find((n) => n.id === ids[0]).z || 0 }; })()`);
  check(zTop.first && zTop.z > 0, `最後につかんだ付箋が、重なった付箋より手前に出る（z=${zTop.z}）`);
  await ev(`window.__ep.__emitFolder()`);
  await sleep(500);
  check(await ev(`(() => { const row = ${ROW("企画書_v3.docx")}; const ids = [...row.querySelectorAll('.note')].map((n) => n.dataset.note); const r = row.querySelectorAll('.note')[1].getBoundingClientRect(); return document.elementFromPoint(r.left + 40, r.top + 6)?.closest('.note')?.dataset.note === ids[0]; })()`), "画面が作り直されても、手前のまま");
  await ev(`window.__menu = 'reset'`);
  await b.rightClick(zg.x, zg.y + (zb.top - za.top) - 30);
  await sleep(400);
  await ev(`window.__menu = null`);

  // 別のフォルダへ貼りなおしても、大きさは付いていく（ずれは外れる）
  const g3 = await noteTextPos("企画書_v3.docx", 0);
  await b.drag(g3.x, g3.y, g3.x + 40, g3.y, { steps: 6 });
  await sleep(400);
  const gp3 = await ev(`(() => { const r = ${ROW("企画書_v3.docx")}.querySelectorAll('.note')[0].getBoundingClientRect(); return { x: r.right - 6, y: r.bottom - 6 }; })()`);
  await b.drag(gp3.x, gp3.y, gp3.x - 40, gp3.y, { steps: 6 });
  await sleep(400);
  const toContract2 = await rowPos("契約書");
  const g4 = await noteTextPos("企画書_v3.docx", 0);
  await b.drag(g4.x, g4.y, toContract2.x, toContract2.y, { steps: 12 });
  await sleep(600);
  const moved = (await layoutOf(FOLDER + "\\契約書")).find((n) => n.text === "金曜までに");
  check(moved && moved.w && !moved.x, `別のフォルダへ貼りなおすと、大きさは付いていき、ずれは外れる ${JSON.stringify(moved)}`);
  await press("#snack [data-act='undo']");
  await sleep(600);
  check((await rowNotes("企画書_v3.docx"))?.some((t) => t.startsWith("金曜までに")), "元に戻すと、もとの行へ帰る");

  // 右クリック
  await ev(`window.__menu = 'stick'`);
  const rp = await rowPos("会議メモ.txt");
  await b.rightClick(rp.x, rp.y);
  await sleep(300);
  check(await ev(`document.activeElement?.id === 'compose' && document.querySelector('#to').textContent.includes('会議メモ.txt')`), "右クリックの「付箋を貼る」で、書く欄に入る");
  await ev(`window.__menu = null`);

  // 行の「＋ 付箋」
  await b.click(6, 300);
  await ev(`${ROW("議事録_0915.docx")}.querySelector('.add').click()`);
  check(await ev(`document.querySelector('#to').textContent.includes('議事録_0915.docx') && document.activeElement?.id === 'compose'`), "行の「＋ 付箋」で、その行に貼る態勢になる");

  // キーボード
  await b.click(6, 300);
  await ev(`document.activeElement.blur()`);
  await b.key("ArrowDown");
  await sleep(100);
  check(await ev(`!!document.querySelector('.row.sel')`), "↓ で行を選べる");
  await b.key("Escape");
  await sleep(100);
  check(await ev(`!document.querySelector('.row.sel')`), "Esc で選びなおす");
  await click("提出用.zip");
  await ev(`document.activeElement.blur()`);
  await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "F2", code: "F2", windowsVirtualKeyCode: 113 });
  await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "F2", code: "F2", windowsVirtualKeyCode: 113 });
  await sleep(200);
  check((await b.count(".rn")) === 1, "F2 で名前を変えられる");
  await ev(`document.querySelector('.rn').value = '提出用_最終.zip'`);
  await b.key("Enter");
  await sleep(500);
  check(await rowPos("提出用_最終.zip") !== null, "名前を変える");

  // 付箋のあるものだけ
  await press("#only");
  await sleep(300);
  const onlyRows = await b.count(".row");
  check(onlyRows > 0 && onlyRows < 10, `付箋のあるものだけにしぼれる（${onlyRows} 行）`);
  await press("#only");
  await sleep(200);

  // すべての付箋
  await press("[data-mode='all']");
  await waitFor("document.querySelectorAll('.place').length > 0");
  const places = await b.count(".place");
  check(places >= 3, `すべての付箋に、開いた場所が集まる（${places} か所）`);
  check(await ev(`document.querySelector('#composer').hidden`), "すべての付箋では、書く欄を隠す");
  await b.click((await b.center("#q")).x, (await b.center("#q")).y);
  await b.type("保険");
  await sleep(300);
  check((await b.count(".nrow")) === 1, "ことばで探せる");
  await ev(`document.querySelector('#q').value = ''; document.querySelector('#q').dispatchEvent(new Event('input', { bubbles: true }))`);
  await sleep(200);
  check(await ev(`document.activeElement?.id === 'q'`), "探している間も、入力の欄に入ったまま");

  await press("[data-tab='peeled']");
  await sleep(200);
  const peeled0 = await b.count(".nrow");
  check(peeled0 >= 1, "はがした付箋の側に、はがした付箋が出る");
  await press("[data-act='restore']");
  await sleep(400);
  check((await b.count(".nrow")) === peeled0 - 1, "貼りなおすと、はがした側から消える");

  await press("[data-tab='active']");
  await sleep(200);
  const active0 = await b.count(".nrow");
  await press("[data-act='peel-all']");
  await sleep(400);
  check((await b.count(".nrow")) === active0 - 1, "すべての付箋からも、はがせる");
  await press("[data-tab='peeled']");
  await sleep(200);
  const peeled1 = await b.count(".nrow");
  await ev(`window.__opts.confirm = false`);
  await press("[data-act='erase']");
  await sleep(300);
  check((await b.count(".nrow")) === peeled1, "確かめで断れば、消さない");
  await ev(`window.__opts.confirm = true`);
  await press("[data-act='erase']");
  await sleep(400);
  check((await b.count(".nrow")) === peeled1 - 1, "確かめで許せば、完全に消える");

  await press("[data-tab='active']");
  await sleep(200);
  const target = await ev(`(() => { const p = [...document.querySelectorAll('.place')].find((x) => x.querySelector('.pname').textContent === '家の手続き'); return p ? p.querySelector('[data-act=go]').dataset.place : null; })()`);
  check(!!target, "ほかの場所の付箋も並ぶ");
  await press(`[data-act='go'][data-place=${JSON.stringify(target)}]`);
  await waitFor("document.querySelector('#crumbs .cur')?.textContent === '家の手続き'");
  await sleep(500);
  check(await ev(`document.querySelector('#crumbs .cur')?.textContent === '家の手続き' && !document.querySelector('.seg [data-mode=all]').classList.contains('on')`), "「ここへ行く」で、その場所の付箋の画面へ移る");
  check((await b.count(".note")) >= 2, "移った先に、付箋が出ている");

  // 場所が消えたら、付箋は索引に残る
  await ev(`window.__fs.remove(window.__FOLDER + '\\\\契約書')`);
  await press("[data-mode='all']");
  await waitFor("document.querySelectorAll('.place').length > 0");
  await sleep(300);
  check(await ev(`!!document.querySelector('.place.missing')`), "場所が無くなっても、付箋は残り、見つからないと分かる");
  await press(".place.missing [data-act='forget']");
  await sleep(300);
  check((await b.count(".place.missing")) === 0, "記録から消せる");
}

// ---- 大きなフォルダ ----------------------------------------------------------------------------
async function big() {
  await boot({ big: 1500, start: "C:\\Users\\neo\\Documents\\大量", ready: "!!window.__ready && document.querySelectorAll('.row').length > 1000" });
  const t0 = Date.now();
  await ev(`(() => { const f = window.__fs.get('C:\\\\Users\\\\neo\\\\Documents\\\\大量'); window.__fs.add(f.path + '\\\\新しい.txt'); })()`);
  await waitFor("document.querySelectorAll('.row').length === 1501");
  console.log("  一覧の作り直し", Date.now() - t0, "ms");
  check((await b.count(".row")) === 1501, "1500 件のフォルダを開ける");
  const t1 = Date.now();
  await b.click(6, 300);
  await b.type("たくさんあるフォルダのメモ");
  await b.key("Enter");
  await waitFor("document.querySelectorAll('.board .note').length === 1");
  console.log("  貼るまで", Date.now() - t1, "ms");
  check((await b.count(".board .note")) === 1, "大きなフォルダでも貼れる");

  // 奥までスクロールしているときに、同期などで画面が作り直されても、見ている所が動かない
  for (let i = 0; i < 6; i++) await b.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 300, y: 300, deltaX: 0, deltaY: 1500 });
  await sleep(500);
  const top0 = await ev(`document.querySelector('#main').scrollTop`);
  const at0 = await ev(`(() => { const r = [...document.querySelectorAll('.row')].find((x) => x.getBoundingClientRect().top > 100); return r.querySelector('.nm').textContent; })()`);
  await ev(`window.__fs.add(window.__fs.get('C:\\\\Users\\\\neo\\\\Documents\\\\大量').path + '\\\\後から増えた.txt')`);
  await sleep(700);
  const top1 = await ev(`document.querySelector('#main').scrollTop`);
  const at1 = await ev(`(() => { const r = [...document.querySelectorAll('.row')].find((x) => x.getBoundingClientRect().top > 100); return r.querySelector('.nm').textContent; })()`);
  check(top0 > 3000 && at0 === at1, `奥までスクロールしても、画面が作り直されて見ている所が動かない（${top0} → ${top1}、${at0} → ${at1}）`);
  await shot("big");
}

const scenarios = { look, layout, flow, big };
try {
  await scenarios[scenario]();
} catch (e) {
  console.log("  NG", e.message);
  process.exitCode = 1;
} finally {
  b.cleanup();
}
