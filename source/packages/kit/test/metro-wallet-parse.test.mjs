import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";

const packageRoot = resolve(import.meta.dirname, "..");

async function reactNativeWalletClosure() {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const target = manifest.exports["./wallet"]["react-native"];
  const pending = [resolve(packageRoot, target)];
  const visited = new Set();
  const sources = new Map();
  while (pending.length !== 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const source = await readFile(path, "utf8");
    sources.set(path, source);
    const specifiers = new Set();
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/gu)) {
      specifiers.add(match[1]);
    }
    for (const match of source.matchAll(/\bimport\(\s*["'](\.[^"']+)["']\s*\)/gu)) {
      specifiers.add(match[1]);
    }
    for (const specifier of specifiers) pending.push(resolve(dirname(path), specifier));
  }
  return sources;
}

test("react-native wallet closure is Metro-parseable and excludes Node loaders", async () => {
  const sources = await reactNativeWalletClosure();
  const violations = [];
  for (const [path, source] of sources) {
    // A minified conditional can contain `?node:Object.freeze(...)`; only
    // a quoted module specifier can identify a Node builtin.
    if (/["']node:[a-z0-9_/.-]+["']/iu.test(source)) violations.push(`${path}: Node builtin`);
    if (/\bimport\(\s*(?!["'])/u.test(source)) violations.push(`${path}: non-literal dynamic import`);
  }
  assert.deepEqual(violations, []);
});
