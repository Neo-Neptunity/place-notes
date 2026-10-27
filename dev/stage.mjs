// MOD のファイルを一時フォルダにコピーして、ES モジュールとして読めるようにする。
// MOD のフォルダには package.json が無い（配る zip に余計なものを入れない）ので、テストでは、コピーに package.json を足して使う。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MOD_DIR = path.resolve(here, "../mod");

export function stage(name = "run") {
  const dir = path.join(os.tmpdir(), `pn-stage-${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 消せなくても困らない */ } });
  for (const f of fs.readdirSync(MOD_DIR)) if (f.endsWith(".js")) fs.copyFileSync(path.join(MOD_DIR, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  return { dir, url: (f) => pathToFileURL(path.join(dir, f)).href };
}
