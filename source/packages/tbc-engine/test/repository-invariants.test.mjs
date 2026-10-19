import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("historical source inventory remains intact, not a current capability claim", async () => {
  const matrix = JSON.parse(await readFile(path.join(packageRoot, "evidence/capability-matrix.json"), "utf8"));
  assert.equal(matrix.publicIntents.length, 19);
  assert.equal(matrix.publicIntents.flatMap((item) => item.legacyBehaviors).length + matrix.internalMaintenance.length, 18);
  assert.deepEqual(matrix.engineMethods, ["normalizeRequest","plan","validate","finalize"]);
});

test("current capability check distinguishes retained builders from advertised operations", () => {
  const output = execFileSync(process.execPath, [path.join(packageRoot, "scripts/check-capability-matrix.mjs")], { encoding: "utf8" });
  const result = JSON.parse(output.trim().split("\n").at(-1));
  assert.equal(result.scope, "current source declaration, not execution or device acceptance");
  assert.deepEqual(result.blockedHistoricalCreation, ["tbc.ft.create", "tbc.nft.mint", "tbc.pool.create"]);
  assert.equal(result.sharedCollectionAllowed, true);
  assert.equal(result.unifiedTemplateProfiles, 8);
  assert.ok(result.libraryIntents > 19);
});

test("WASM artifact is self-contained and imports no host capability", async () => {
  const bytes = await readFile(path.join(packageRoot, "artifacts/wasm/tbc_engine_wasm.wasm"));
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)), []);
});

test("adapters contain transport glue but no wallet responsibility", async () => {
  for (const relative of ["rust/crates/tbc-engine-native/src/lib.rs","rust/crates/tbc-engine-wasm/src/lib.rs"]) {
    const source = await readFile(path.join(packageRoot, relative), "utf8");
    assert.match(source, /tbc_engine_core/);
    assert.doesNotMatch(source, /reqwest|fetch\s*\(|broadcast|mnemonic|PrivateKey/);
  }
});
