// ここ付箋 — 画面の HTML を作る。状態は持たず、渡されたものを文字列にするだけ。文字は必ず esc を通す。
import { COLORS, LIMITS, whenText, dateText, parentOf, lower } from "./store.js";

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** 付箋ごとに決まる、ほんの少しの傾き（-0.8〜0.8 度）。貼ったばかりの付箋らしさ */
function tilt(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 17) - 8) / 10;
}

export const dotsHtml = (cur) =>
  COLORS.map((c) => `<button class="dot c-${c.id}${c.id === cur ? " on" : ""}" data-act="color" data-color="${c.id}" title="${c.label}" aria-label="${c.label}"></button>`).join("");

/** 付箋の大きさとずれを、CSS の変数にする（無ければ、ふつう） */
function layoutVars(n) {
  let s = "";
  if (n.w) s += `;--nw:${n.w}px`;
  if (n.h) s += `;--nh:${n.h}px`;
  if (n.x) s += `;--nx:${n.x}px`;
  if (n.y) s += `;--ny:${n.y}px`;
  if (n.z) s += `;--nz:${n.z}`;
  return s;
}

/**
 * 付箋1枚。
 * o：home（どのフォルダのデータか。現在のフォルダは "."、子フォルダはその小文字のパス）・now・editing・flash・lost（はがれた付箋の案内の HTML）
 */
export function noteHtml(n, o) {
  const cls = ["note", `c-${n.color}`];
  if (o.editing) cls.push("editing");
  if (o.flash) cls.push("flash");
  if (n.h) cls.push("sized");
  if (o.lost !== undefined) cls.push("orphan");
  const attrs = `data-note="${esc(n.id)}" data-home="${esc(o.home)}" style="--tilt:${tilt(n.id)}deg${layoutVars(n)}"`;
  if (o.editing) {
    return `<article class="${cls.join(" ")}" ${attrs}><i class="tape"></i>
      <textarea class="edit" maxlength="${LIMITS.text}" rows="2" aria-label="付箋の文">${esc(n.text)}</textarea>
      <div class="foot"><span class="dots">${dotsHtml(n.color)}</span><span class="auto">自動で残ります</span><span class="sp"></span><span class="acts"><button class="sm" data-act="done">とじる</button><button class="sm" data-act="peel">はがす</button></span></div>
    </article>`;
  }
  return `<article class="${cls.join(" ")}" ${attrs}><i class="tape"></i>
    <p class="tx">${esc(n.text)}</p>${o.lost || ""}
    <div class="foot"><time>${esc(whenText(n.u, o.now))}</time><span class="sp"></span><button class="sm peel" data-act="peel" title="はがしても消えません。すべての付箋に残ります">はがす</button></div>
    <i class="grip" title="つかんで大きさを変える。2回押すと、もとに戻ります"></i>
  </article>`;
}

/** 貼っていたファイルが、このフォルダに見つからない付箋の案内。found は ep.resolve で見つけた今の場所（無ければ null） */
export function lostHtml(n, found) {
  const where = found
    ? `<span class="where">いまは ${esc(parentOf(found.path))} にあります</span><button class="sm go" data-act="carry">連れていく</button>`
    : `<span class="where">いまの場所は分かりません</span>`;
  return `<div class="lost"><span class="was">貼っていたファイル　${esc(n.on.name)}</span>${where}<button class="sm" data-act="to-folder">このフォルダに貼る</button></div>`;
}

/**
 * ファイル・フォルダの1行。
 * o：sel・notes（この行の付箋の HTML の配列）・more（表に出さなかった付箋の数）・badge（フォルダの中の付箋の数）・renaming・now
 */
export function rowHtml(e, o) {
  const key = lower(e.path);
  const ico = e.iconUrl
    ? `<img class="ico" src="${esc(e.iconUrl)}" alt="" draggable="false">`
    : `<span class="ico emo">${e.kind === "folder" ? "📁" : "📄"}</span>`;
  const name = o.renaming ? `<input class="rn" value="${esc(e.name)}" aria-label="新しい名前">` : `<span class="nm">${esc(e.name)}</span>`;
  const more = o.more > 0 ? `<button class="more" data-act="open-row">ほか ${o.more} 枚を見る</button>` : "";
  const badge = o.badge > 0 ? `<span class="bd" title="このフォルダの中の付箋">📝 ${o.badge}</span>` : "";
  return `<div class="row${o.sel ? " sel" : ""}${o.notes.length ? " has" : ""}${e.hidden ? " hid" : ""}" data-key="${esc(key)}" data-kind="${e.kind}">
    ${ico}<span class="nmw">${name}${badge}</span><span class="tail"><button class="add" data-act="add-note" title="この行に付箋を貼る" aria-label="この行に付箋を貼る">＋ 付箋</button><span class="mt">${esc(dateText(e.modified, o.now))}</span></span>
    ${o.notes.length ? `<div class="notes">${o.notes.join("")}${more}</div>` : ""}
  </div>`;
}

/**
 * 「この場所」の画面。
 * m：board（フォルダの付箋の HTML）・orphans（はがれた付箋の HTML）・rows（行の HTML）・total・only・hiddenByFilter
 */
export function hereHtml(m) {
  const boardCount = m.board.length + m.orphans.length;
  return `<div class="cols">
  <section class="files">
    <div class="fhead"><h2>ファイルとフォルダ <span class="n">${m.total}</span></h2>
      <label class="chk"><input type="checkbox" id="only"${m.only ? " checked" : ""}> 付箋のあるものだけ</label></div>
    <div class="rows">${m.rows.join("")}</div>
    ${m.rows.length ? "" : `<p class="hint">${m.only ? "付箋のあるものはありません。" : "このフォルダは空です。"}</p>`}
  </section>
  <aside class="board" data-drop="board">
    <h2>このフォルダの付箋 ${boardCount ? `<span class="n">${boardCount}</span>` : ""}</h2>
    ${boardCount ? `<div class="chips">${m.board.join("")}</div>` : `<p class="hint">まだありません。ファイルを選んで、下に書いて Enter を押すと貼れます。付箋はこのフォルダの中に保存されるので、フォルダを動かしても、同期しても、いっしょに付いていきます。</p>`}
    ${m.orphans.length ? `<h3 class="sub">貼っていた先が見つかりません</h3><div class="chips">${m.orphans.join("")}</div>` : ""}
  </aside>
  </div>`;
}

// ---- すべての付箋 ------------------------------------------------------------------

/** 検索とタブ。入力中に作り直さないよう、本文とは別にしてある */
export function allBarHtml(m) {
  return `<div class="allbar">
    <input id="q" class="q" type="search" value="${esc(m.query)}" placeholder="付箋や場所をさがす" aria-label="付箋や場所をさがす">
    <div class="tabs"><button data-tab="active" class="${m.tab === "active" ? "on" : ""}">貼ってある <b>${m.counts.active}</b></button><button data-tab="peeled" class="${m.tab === "peeled" ? "on" : ""}">はがした <b>${m.counts.peeled}</b></button></div>
  </div>`;
}

function miniHtml(n, now) {
  return `<div class="note mini c-${n.color}" style="--tilt:${tilt(n.id)}deg"><i class="tape"></i><p class="tx">${esc(n.text)}</p></div>`;
}

/** m：groups（searchPlaces の結果。place.found が false なら場所が見つからない）・tab・now・query・loading */
export function allBodyHtml(m) {
  if (m.loading) return `<p class="hint">集めています。</p>`;
  if (!m.groups.length) {
    return `<p class="hint">${m.query ? "見つかりません。" : m.tab === "peeled" ? "はがした付箋はありません。" : "まだ付箋がありません。ファイルやフォルダに貼ると、ここに集まります。"}</p><p class="foot-note">この PC で開いた場所の付箋が集まります。</p>`;
  }
  const groups = m.groups.map(({ place: p, notes }) => {
    const missing = p.found === false;
    const head = `<h3 class="phead"><span class="pname">${esc(p.name)}</span><span class="ppath" title="${esc(p.path)}">${esc(parentOf(p.path) || p.path)}</span>
      ${missing ? `<em class="miss">場所が見つかりません</em><button class="sm" data-act="forget" data-place="${esc(p.key)}">記録から消す</button>` : `<button class="sm" data-act="go" data-place="${esc(p.key)}">ここへ行く</button>`}</h3>`;
    const rows = notes.map((n) => {
      const where = n.on ? `<span class="on">📄 ${esc(n.on)}</span>` : `<span class="on">📁 フォルダ全体</span>`;
      const btns = m.tab === "peeled"
        ? `<button class="sm" data-act="restore" data-place="${esc(p.key)}" data-note="${esc(n.id)}"${missing ? " disabled" : ""}>貼りなおす</button><button class="sm warn" data-act="erase" data-place="${esc(p.key)}" data-note="${esc(n.id)}"${missing ? " disabled" : ""}>完全に消す</button>`
        : `<button class="sm" data-act="go" data-place="${esc(p.key)}" data-note="${esc(n.id)}"${missing ? " disabled" : ""}>ここへ行く</button><button class="sm" data-act="peel-all" data-place="${esc(p.key)}" data-note="${esc(n.id)}"${missing ? " disabled" : ""}>はがす</button>`;
      return `<li class="nrow">${miniHtml(n, m.now)}<div class="info">${where}<time>${esc(whenText(n.u, m.now))}</time></div><div class="btns">${btns}</div></li>`;
    });
    return `<section class="place${missing ? " missing" : ""}">${head}<ul>${rows.join("")}</ul></section>`;
  });
  return `${groups.join("")}<p class="foot-note">この PC で開いた場所の付箋が集まります。</p>`;
}
