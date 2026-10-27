// ヘッドレスの Edge（なければ Chrome）を動かして、ページを開く・式を評価する・マウスとキーを送る・画面を撮る。
// node の標準の WebSocket だけで足りる。終わったら、描画の子プロセスまで必ず止める。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BOX = path.resolve(here, "..");

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml" };

/**
 * html：ページ（ハーネス）。/mod/… /dev/… /docs/… は、この箱のファイルを返す
 */
export async function launch({ html, w = 1280, h = 760, dpr = 1, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
    if (url === "/" || url === "/index.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    const m = /^\/(mod|dev|docs)\/(.+)$/.exec(url);
    const f = m && path.join(BOX, m[1], m[2]);
    if (f && f.startsWith(BOX) && fs.existsSync(f)) {
      res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" });
      return res.end(fs.readFileSync(f));
    }
    res.writeHead(404); res.end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const exes = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const exe = exes.find((p) => fs.existsSync(p));
  if (!exe) throw new Error("Edge も Chrome も見つかりません");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pn-edge-"));
  const profileName = path.basename(profile);
  const dbg = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(exe, [
    "--headless=new", `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`, `--window-size=${w},${h}`,
    "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "about:blank",
  ], { stdio: "ignore" });

  let ws, seq = 0, closed = false;
  const pending = new Map();
  const logs = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function cleanup() {
    if (closed) return;
    closed = true;
    try { ws && ws.close(); } catch { /* もう閉じている */ }
    try { server.close(); } catch { /* もう閉じている */ }
    try { spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 終わっていた */ }
    try {
      // 描画・GPU の子プロセスが残ることがあるので、一時プロファイルの名前で探して止める
      spawnSync("powershell", ["-NoProfile", "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${profileName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: "ignore" });
    } catch { /* 探せなくても困らない */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 消せなくても困らない */ }
  }
  process.on("exit", cleanup);

  async function connect() {
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json();
        const pg = list.find((t) => t.type === "page");
        if (pg) {
          ws = new WebSocket(pg.webSocketDebuggerUrl);
          await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
          ws.onmessage = (m) => {
            const d = JSON.parse(m.data);
            if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
            else if (d.method === "Runtime.consoleAPICalled") {
              const line = `[${d.params.type}] ${d.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`;
              if (!line.includes("chrome-extension://")) logs.push(line);   // ブラウザに入っている拡張機能の出力は、MOD と関係ない
            } else if (d.method === "Runtime.exceptionThrown") logs.push(`[exception] ${d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text}`);
          };
          return;
        }
      } catch { /* まだ起動中 */ }
      await sleep(250);
    }
    throw new Error("ブラウザにつながりません");
  }

  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (d) => (d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const api = {
    send, ev, sleep, logs, cleanup, port,
    async boot(cfg = {}, ready = "!!window.__ready") {
      if (!ws) { await connect(); await send("Runtime.enable"); await send("Page.enable"); }
      await send("Emulation.setDeviceMetricsOverride", { width: cfg.w || w, height: cfg.h || h, deviceScaleFactor: cfg.dpr || dpr, mobile: false });
      await send("Page.navigate", { url: `http://127.0.0.1:${port}/?r=${Math.random()}#${encodeURIComponent(JSON.stringify(cfg))}` });
      for (let i = 0; i < 100; i++) {
        await sleep(150);
        if (await ev(ready).catch(() => false)) break;
      }
      await sleep(500);
    },
    async shot(name) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      const file = path.join(outDir, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      console.log("  shot", file);
      return file;
    },
    mouse: (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: extra.button || "left", buttons: type === "mouseReleased" ? 0 : (extra.buttons ?? 1), clickCount: extra.clickCount ?? 1, ...extra }),
    async move(x, y) { return api.mouse("mouseMoved", x, y, { buttons: 0 }); },
    async click(x, y, extra = {}) {
      await api.mouse("mouseMoved", x, y, { buttons: 0 });
      await api.mouse("mousePressed", x, y, extra);
      await api.mouse("mouseReleased", x, y, extra);
    },
    async dblclick(x, y) {
      await api.mouse("mouseMoved", x, y, { buttons: 0 });
      for (const c of [1, 2]) { await api.mouse("mousePressed", x, y, { clickCount: c }); await api.mouse("mouseReleased", x, y, { clickCount: c }); }
    },
    async rightClick(x, y) {
      await api.mouse("mouseMoved", x, y, { buttons: 0 });
      await api.mouse("mousePressed", x, y, { button: "right", buttons: 2 });
      await api.mouse("mouseReleased", x, y, { button: "right", buttons: 0 });
    },
    async drag(x0, y0, x1, y1, { steps = 10, mods = 0, hold = false } = {}) {
      await api.mouse("mouseMoved", x0, y0, { buttons: 0, modifiers: mods });
      await api.mouse("mousePressed", x0, y0, { modifiers: mods });
      for (let i = 1; i <= steps; i++) await api.mouse("mouseMoved", x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, { modifiers: mods });
      if (!hold) await api.mouse("mouseReleased", x1, y1, { modifiers: mods });
    },
    async key(key, { mods = 0, code } = {}) {
      const text = key.length === 1 ? key : undefined;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: code || (key.length === 1 ? `Key${key.toUpperCase()}` : key), modifiers: mods, text, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : { Escape: 27, Enter: 13, Delete: 46, Backspace: 8, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40 }[key] });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: code || (key.length === 1 ? `Key${key.toUpperCase()}` : key), modifiers: mods });
    },
    /** 押しっぱなし。code は "KeyW"・"Space"・"ShiftLeft"・"ControlLeft" など */
    async down(code, mods = 0) {
      const key = code.startsWith("Key") ? code.slice(3).toLowerCase() : { Space: " ", ShiftLeft: "Shift", ControlLeft: "Control" }[code] || code;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers: mods, windowsVirtualKeyCode: { Space: 32, ShiftLeft: 16, ControlLeft: 17 }[code] || key.toUpperCase().charCodeAt(0), text: key.length === 1 ? key : undefined });
    },
    async up(code, mods = 0) {
      const key = code.startsWith("Key") ? code.slice(3).toLowerCase() : { Space: " ", ShiftLeft: "Shift", ControlLeft: "Control" }[code] || code;
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers: mods, windowsVirtualKeyCode: { Space: 32, ShiftLeft: 16, ControlLeft: 17 }[code] || key.toUpperCase().charCodeAt(0) });
    },
    async type(text) { await send("Input.insertText", { text }); },
    check(cond, msg) { console.log(cond ? "  ok" : "  NG", msg); if (!cond) process.exitCode = 1; return !!cond; },
    count: (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`),
    /** 要素の中心の位置 */
    center: (sel, i = 0) => ev(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`),
  };
  return api;
}
