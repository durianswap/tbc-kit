import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

test("large scalar-only strings avoid JS code-unit scans without changing JCS acceptance", async () => {
  const compiled = await build({
    entryPoints: [new URL("../src/canonical-json.ts", import.meta.url).pathname],
    bundle: true, platform: "neutral", format: "cjs", write: false,
  });
  const calls = { count: 0 };
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, calls, Object });
  vm.runInContext(`const original = String.prototype.charCodeAt;
    String.prototype.charCodeAt = function(index) { calls.count++; return original.call(this, index); };`, context);
  vm.runInContext(compiled.outputFiles[0].text, context);
  const { canonicalize } = module.exports;
  const large = "abcdef0123456789".repeat(8000);
  assert.equal(canonicalize(large), JSON.stringify(large));
  assert.equal(calls.count, 0, "ASCII transaction data must not walk every code unit in JavaScript");
  for (const value of ["", "中文", "quote\"\n\u0000", "a😀z", "\ud800\udc00", "\udbff\udfff"]) {
    assert.equal(canonicalize(value), JSON.stringify(value));
  }
  for (const value of ["\ud800", "\udfff", "a\ud800z", "a\udc00z", "\ud800\ud800", "😀\udfff", `${large}\ud800`]) {
    assert.throws(() => canonicalize(value), /lone surrogate/);
    assert.throws(() => canonicalize({ [value]: true }), /lone surrogate/);
  }
});
