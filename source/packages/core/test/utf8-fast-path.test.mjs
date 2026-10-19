import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: [new URL("../src/encoding.ts", import.meta.url).pathname],
  bundle: true, platform: "neutral", format: "cjs", write: false,
});

function load(withEncoder) {
  const calls = { codeUnits: 0, encodes: 0 };
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, calls,
    ...(withEncoder ? { TextEncoder: class {
      encode(value) { calls.encodes++; return new TextEncoder().encode(value); }
    } } : {}),
  });
  vm.runInContext(`const original = String.prototype.charCodeAt;
    String.prototype.charCodeAt = function(index) {
      calls.codeUnits++; return original.call(this, index);
    };`, context);
  vm.runInContext(compiled.outputFiles[0].text, context);
  return { utf8: module.exports.utf8, calls };
}

test("ASCII transaction data uses the platform encoder without a JS byte array", () => {
  const { utf8, calls } = load(true);
  const value = "abcdef0123456789".repeat(8000);
  assert.deepEqual(Array.from(utf8(value)), Array.from(new TextEncoder().encode(value)));
  assert.equal(calls.encodes, 1);
  assert.equal(calls.codeUnits, 0);
});

test("platform and no-encoder runtimes preserve exact UTF-8 and lone-surrogate rejection", () => {
  for (const withEncoder of [true, false]) {
    const { utf8 } = load(withEncoder);
    for (const value of ["", "abc\u0000\n\u007f", "é中", "a😀z", "\ud800\udc00", "\udbff\udfff"]) {
      assert.deepEqual(Array.from(utf8(value)), Array.from(new TextEncoder().encode(value)));
    }
    for (const value of ["\ud800", "\udfff", "a\ud800z", "😀\udfff", "x".repeat(128000) + "\ud800"]) {
      assert.throws(() => utf8(value), /lone surrogate/);
    }
    for (const value of [null, 1, {}, new String("abc")]) {
      assert.throws(() => utf8(value), /must be a string/);
    }
  }
});
