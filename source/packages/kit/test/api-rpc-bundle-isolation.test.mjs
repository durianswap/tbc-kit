import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forbidden = /tbc_engine|WebAssembly|createTbcWallet\s*\(|approval-material|\bsigner\b/iu;

function esmGraph(entry) {
  const pending = [entry];
  const visited = new Set();
  let source = "";
  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const contents = readFileSync(path, "utf8");
    source += contents;
    for (const match of contents.matchAll(/(?:from\s+|import\s*)["'](\.\/[^"]+?\.js)["']/gu)) {
      pending.push(resolve(dirname(path), match[1]));
    }
  }
  return source;
}

test("/api and /rpc bundles stay independent from Engine, Signer, UI, native and WASM", () => {
  for (const entry of ["api", "rpc"]) {
    const esm = esmGraph(resolve(packageRoot, `dist/esm/${entry}.js`));
    assert.doesNotMatch(esm, forbidden, `ESM /${entry} retained a wallet or Engine module`);

    const cjs = readFileSync(resolve(packageRoot, `dist/cjs/${entry}.cjs`), "utf8");
    assert.doesNotMatch(cjs, forbidden, `CJS /${entry} retained a wallet or Engine module`);
    assert.doesNotMatch(cjs, /runtime\.cjs/u, `CJS /${entry} loaded the combined runtime`);
  }
});
