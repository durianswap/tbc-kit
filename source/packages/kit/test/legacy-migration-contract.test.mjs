import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

import { TBC_KIT_LEGACY_MIGRATION_CONTRACT } from "../dist/esm/wallet.js";

// The source gate catches stale public metadata before producing a successor
// candidate. The original dist checks below keep their installed-export scope.
const sourceBundle = await build({
  entryPoints: [fileURLToPath(new URL("../src/legacy-migration-contract.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "neutral",
});
const source = await import(`data:text/javascript;base64,${Buffer.from(sourceBundle.outputFiles[0].text).toString("base64")}`);

test("migration inventory labels old issuance blocked without deleting historical seams", () => {
  const entries = source.TBC_KIT_LEGACY_MIGRATION_CONTRACT;
  assert.deepEqual(entries.map(({ id }) => id), ["ft-mint", "ft-transfer", "pool-signing"]);
  const mint = entries.find(({ id }) => id === "ft-mint");
  assert.equal(mint.status, "blocked");
  assert.match(mint.canonicalEntrypoint, /rejected.*historical issuance/i);
  assert.match(mint.canonicalEntrypoint, /tbc\.ft\.create/);
  assert.equal(entries.find(({ id }) => id === "ft-transfer").status, "canonical");
  const pool = entries.find(({ id }) => id === "pool-signing");
  assert.equal(pool.status, "canonical");
  assert.match(pool.legacySurface, /existing.pool/i);
  assert.match(pool.legacySurface, /creation blocked/i);
  assert.ok(Object.isFrozen(entries));
});

test("Kit migration contract lists only remaining supported Legacy seams", () => {
  const ids = TBC_KIT_LEGACY_MIGRATION_CONTRACT.map(({ id }) => id);
  assert.deepEqual(ids, [
    "ft-mint",
    "ft-transfer",
    "pool-signing",
  ]);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of TBC_KIT_LEGACY_MIGRATION_CONTRACT) {
    assert.equal(typeof entry.canonicalEntrypoint, "string");
    assert.ok(entry.canonicalEntrypoint.length > 0);
    assert.doesNotMatch(entry.canonicalEntrypoint, /Legacy(?:Ft|Pool)(?:Mint|Transfer|Signing)Service/);
  }
});

test("migration contract keeps private execution and recovery out of Legacy", () => {
  assert.equal(TBC_KIT_LEGACY_MIGRATION_CONTRACT.some(({ id }) => id === "secure-fallback"), false);
  assert.equal(TBC_KIT_LEGACY_MIGRATION_CONTRACT.some(({ id }) => id === "workflow-preparation-alias"), false);
});
