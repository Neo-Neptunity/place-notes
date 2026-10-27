// 偽の explorer_plus：メモリの中のフォルダと、それを見る explorerPlus。
// node の試験（unit.mjs）と、ブラウザの試験（browser.mjs がページに読み込む）の両方で使う。
// 本物と同じく、ID が合わないと断る（denied）・無ければ not-found・フォルダのデータはフォルダにくっつく（フォルダを動かせば付いていく）。

const err = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const parentOf = (p) => p.slice(0, p.lastIndexOf("\\"));
const nameOf = (p) => p.slice(p.lastIndexOf("\\") + 1);
const join = (dir, name) => `${dir}\\${name}`;
const lower = (s) => s.toLowerCase();

export function createFakeFs(start = 7000) {
  let nextId = start;
  const nodes = new Map();       // 小文字のパス → { id, name, path, kind, modified, data }
  const listeners = new Set();
  const emit = (dir) => listeners.forEach((f) => f(dir));

  function add(path, kind = "file", opts = {}) {
    if (nodes.has(lower(path))) throw err("exists", path);
    const n = { id: opts.id ?? String(nextId++), name: nameOf(path), path, kind, modified: opts.modified ?? Date.now() - 3 * 86_400_000, hidden: !!opts.hidden, data: undefined };
    nodes.set(lower(path), n);
    emit(parentOf(path));
    return n;
  }
  function mkdirp(path) {
    const parts = path.split("\\");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("\\");
      if (!nodes.has(lower(p))) add(p, "folder");
    }
    return nodes.get(lower(path));
  }
  const get = (p) => nodes.get(lower(p));
  const byId = (id) => [...nodes.values()].find((n) => id && n.id === id);
  const list = (dir) => [...nodes.values()].filter((n) => lower(parentOf(n.path)) === lower(dir));

  /** 名前を変える（フォルダなら、中のものも付いていく） */
  function move(path, newPath) {
    const n = get(path);
    if (!n) throw err("not-found", path);
    if (get(newPath) && lower(newPath) !== lower(path)) throw err("exists", newPath);
    const prefix = lower(path) + "\\";
    for (const m of [...nodes.values()]) {
      if (m === n || lower(m.path).startsWith(prefix)) {
        nodes.delete(lower(m.path));
        m.path = m === n ? newPath : newPath + m.path.slice(path.length);
        m.name = nameOf(m.path);
        nodes.set(lower(m.path), m);
      }
    }
    emit(parentOf(path));
    emit(parentOf(newPath));
    return n;
  }
  function remove(path) {
    const n = get(path);
    if (!n) throw err("not-found", path);
    const prefix = lower(path) + "\\";
    for (const m of [...nodes.values()]) if (m === n || lower(m.path).startsWith(prefix)) nodes.delete(lower(m.path));
    emit(parentOf(path));
  }
  return { nodes, add, mkdirp, get, byId, list, move, remove, onChange: (f) => listeners.add(f), join, parentOf };
}

const entryOf = (n) => ({
  id: n.id, name: n.name, path: n.path, kind: n.kind, hidden: n.hidden,
  ext: n.kind === "file" && n.name.includes(".") ? n.name.split(".").pop().toLowerCase() : "", modified: n.modified,
});

/**
 * 1つのタブ分の explorerPlus。startPath のフォルダを開いた状態で始まる。
 * opts：log（呼び出しの記録）・storage（[[キー, 値]]）・settings・background・theme・
 *       ask（ui.ask の答えを返す関数）・confirm（false で断る）・menuChoice（showMenu で選ぶ項目を返す関数）
 */
export function createFakeEp(fs, startPath, opts = {}) {
  let cur = startPath;
  const store = new Map(opts.storage || []);
  const log = opts.log || [];
  const settings = { fontSize: 14, color: "yellow", badge: true, ...(opts.settings || {}) };
  const folderCbs = new Set();
  const dataCbs = new Set();
  const menuCbs = new Set();
  const actionCbs = new Set();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  const verify = (ref) => {
    const n = ref && fs.get(ref.path);
    if (!n) throw err("not-found", ref && ref.path);
    if (n.id !== ref.id) throw err("denied", `id does not match ${ref.path}`);
    return n;
  };
  const snapshot = () => {
    const n = fs.get(cur);
    return { id: n.id, path: n.path, name: n.name, parentPath: fs.parentOf(n.path) || null, entries: fs.list(cur).map(entryOf) };
  };
  const emitFolder = () => {
    if (!fs.get(cur)) return;
    const s = snapshot();
    for (const cb of folderCbs) cb(s);
  };
  fs.onChange((dir) => {
    if (lower(dir) === lower(cur)) setTimeout(emitFolder, 0);
  });
  const goto = (path) => {
    if (!fs.get(path)) throw err("not-found", path);
    cur = fs.get(path).path;
    setTimeout(emitFolder, 0);
  };

  const ep = {
    theme: opts.theme || "light",
    ready: async () => ({ apiVersion: 1, viewId: "neo.place-notes", tabId: "t1", theme: opts.theme || "light", background: !!opts.background }),
    settings: { get: async () => ({ ...settings }) },
    onSettings: (cb) => (opts.onSettings = cb, () => {}),
    onTheme: () => () => {},
    storage: {
      get: async (k) => clone(store.get(k)),
      set: async (k, v) => {
        const s = JSON.stringify(v);
        if (s.length > 1024 * 1024) throw err("too-large", k);
        store.set(k, JSON.parse(s));
      },
      delete: async (k) => void store.delete(k),
      keys: async () => [...store.keys()],
    },
    folderData: {
      get: async (ref) => {
        const n = verify(ref);
        log.push(`fd.get ${n.name}`);
        if (opts.failRead && opts.failRead(n)) throw err("io", n.name);
        return clone(n.data);
      },
      set: async (ref, value) => {
        const n = verify(ref);
        if (n.kind !== "folder") throw err("invalid", "not a folder");
        const s = JSON.stringify(value);
        if (s.length > 1024 * 1024) throw err("too-large", n.name);
        if (opts.failWrite && opts.failWrite(n)) throw err("io", n.name);
        log.push(`fd.set ${n.name}`);
        n.data = JSON.parse(s);
        for (const cb of dataCbs) if (lower(n.path) === lower(cur)) cb({ path: n.path });
      },
      delete: async (ref) => {
        const n = verify(ref);
        log.push(`fd.delete ${n.name}`);
        n.data = undefined;
      },
    },
    onFolderData: (cb) => (dataCbs.add(cb), () => dataCbs.delete(cb)),
    onFolder: (cb) => {
      folderCbs.add(cb);
      setTimeout(() => fs.get(cur) && cb(snapshot()), 0);
      return () => folderCbs.delete(cb);
    },
    onChanges: () => () => {},
    resolve: async (refs) => {
      log.push(`resolve ${refs.length}`);
      return refs.map((r) => {
        const at = fs.get(r.path);
        if (!r.id) return at ? entryOf(at) : null;
        if (at && at.id === r.id) return entryOf(at);
        const n = fs.byId(r.id);
        return n ? entryOf(n) : null;
      });
    },
    open: async (ref) => {
      const n = verify(ref);
      log.push(`open ${n.name}`);
      if (n.kind === "folder") goto(n.path);
    },
    navigate: async (path) => {
      log.push(`navigate ${path}`);
      goto(path);
    },
    navigateUp: async () => goto(fs.parentOf(cur)),
    rename: async (ref, newName) => {
      const n = verify(ref);
      if (/[\\/:*?"<>|]/.test(newName)) throw err("invalid", newName);
      log.push(`rename ${n.name} ${newName}`);
      return entryOf(fs.move(n.path, join(parentOf(n.path), newName)));
    },
    trash: async (refs) => {
      for (const r of refs) {
        const n = verify(r);
        log.push(`trash ${n.name}`);
        fs.remove(n.path);
      }
      return { trashed: refs.length };
    },
    createFolder: async (name) => {
      const n = fs.add(join(cur, name || "新しいフォルダー"), "folder");
      setTimeout(() => actionCbs.forEach((cb) => cb({ action: "rename", entry: entryOf(n) })), 20);
      return entryOf(n);
    },
    showMenu: async ({ extra }) => ({ chosen: opts.menuChoice ? opts.menuChoice(extra) : null }),
    onAction: (cb) => (actionCbs.add(cb), () => actionCbs.delete(cb)),
    onMenu: (cb) => (menuCbs.add(cb), () => menuCbs.delete(cb)),
    menu: { done: async () => void log.push("menu.done") },
    commands: { set: async (list) => void (opts.commands = list) },
    onCommand: (cb) => (opts.onCommand = cb, () => {}),
    ui: {
      toast: async (t) => void log.push(`toast ${t}`),
      status: async () => {},
      tab: async (o) => void log.push(`tab ${o.badge ?? ""}`),
      confirm: async (m) => (log.push(`confirm ${m.split("\n")[0]}`), opts.confirm !== false),
      ask: async (o) => (log.push(`ask ${o.label}`), opts.ask ? opts.ask(o) : null),
      choose: async () => null,
    },
    drag: { start: async (o) => void log.push(`drag ${o.items.length}`), targets: async () => {} },
    onDragTargets: () => () => {},
    // 試験から
    __emitFolder: emitFolder,
    __emitMenu: (event) => Promise.all([...menuCbs].map((cb) => cb(event))),
    __emitAction: (a) => actionCbs.forEach((cb) => cb(a)),
    __goto: goto,
    __store: store,
    __log: log,
    __cur: () => cur,
  };
  return ep;
}
