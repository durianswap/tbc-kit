import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Validate retained Rust dispatch directly; removed historical archives are not
// a dependency of current source conformance.
const expectedIntents = [
  "tbc.transfer","tbc.maintenance.merge","tbc.collection.create","tbc.nft.mint","tbc.nft.transfer",
  "tbc.ft.create","tbc.ft.transfer","tbc.ft.merge","tbc.stablecoin.transfer","tbc.stablecoin.merge","tbc.pool.create",
  "tbc.pool.liquidity.add","tbc.pool.liquidity.remove","tbc.pool.liquidity.close","tbc.pool.ft.merge","tbc.pool.ftlp.merge","tbc.pool.ftlp.burn",
  "tbc.pool.swap.exactTbcForToken","tbc.pool.swap.exactTokenForTbc"
];

function exact(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(label + " mismatch: " + JSON.stringify(actual));
  }
}
const planSource = await readFile(path.join(root, "rust/crates/tbc-engine-core/src/plan.rs"), "utf8");
const implementedIntents = new Set(planSource.match(/"tbc\.[A-Za-z.]+"/g)?.map((value) => value.slice(1, -1)) ?? []);
exact([...implementedIntents].sort(), [...expectedIntents].sort(), "Rust intent dispatch");
const stablecoinTests = await readFile(path.join(root, "rust/crates/tbc-engine-core/tests/nft_stablecoin.rs"), "utf8");
const ancestryTests = await readFile(path.join(root, "rust/crates/tbc-engine-core/src/ancestry.rs"), "utf8");
for (const symbol of ["stablecoin_merge_rejects_stale_and_tampered_continuations", "stablecoin_mint_rejects_noncanonical_coin_nft_state_bytes"]) {
  if (!stablecoinTests.includes(symbol) && !ancestryTests.includes(symbol)) throw new Error(`StableCoin closure evidence is missing: ${symbol}`);
}
// The Kit declaration is the current library-level source of truth. Do not
// create a second manually copied list in the retained historical JSON.
const entry = path.resolve(root, "../kit/src/business-capabilities.ts");
const built = await build({ entryPoints: [entry], bundle: true, write: false,
  format: "esm", platform: "node", metafile: true, logLevel: "silent" });
assert.equal(Object.keys(built.metafile.inputs).length, 1, "Capability inventory must remain data-only");
const current = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`);
const intents = current.TBC_KIT_WALLET_INTENTS;
assert.equal(new Set(intents).size, intents.length);
const blockedCreation = ["tbc.ft.create", "tbc.nft.mint", "tbc.pool.create"];
for (const intent of blockedCreation) assert.ok(!intents.includes(intent), `Forbidden creation advertised: ${intent}`);
assert.ok(intents.includes("tbc.collection.create"), "Shared collection must not be banned by its historical name");
assert.ok(!intents.includes("tbc.pool.liquidity.close"), "Retained internal route is not an advertised wallet entry");
for (const intent of ["tbc20-standard-create", "tbc721-standard-mint", "tbc721-standard-batch-mint",
  "tbc20-stablecoin-create", "tbc-amm-create", "tbc20-lp-transfer", "tbc-htlc-claim", "tbc-timelock-unlock", "tbc-lop-match"]) {
  assert.ok(intents.includes(intent), `Current family omitted: ${intent}`);
}
const normalizeSource = await readFile(path.join(root, "rust/crates/tbc-engine-core/src/normalize.rs"), "utf8");
const businessSource = await readFile(path.join(root, "rust/crates/tbc-engine-core/src/business.rs"), "utf8");
const declaredEngineNames = new Set([...`${planSource}\n${normalizeSource}\n${businessSource}`.matchAll(/"((?:tbc|amm)[A-Za-z0-9.\-]+)"/g)].map(match => match[1]));
for (const intent of intents) assert.ok(declaredEngineNames.has(intent), `No Engine source declaration: ${intent}`);
const support = current.TBC_KIT_UNIFIED_TEMPLATE_SUPPORT;
for (const methods of Object.values(support)) for (const intent of methods) assert.ok(intents.includes(intent));
assert.ok(!support["tbc-amm"].includes("amm.mergeToken"));
assert.ok(!support["tbc-amm"].includes("tbc20Lp.burn"));
assert.ok(support["historical-pool2"].includes("amm.mergeToken"));
assert.ok(support["historical-pool2"].includes("tbc20Lp.burn"));
console.log(JSON.stringify({ scope: "current source declaration, not execution or device acceptance",
  libraryIntents: intents.length, unifiedTemplateProfiles: Object.keys(support).length,
  blockedHistoricalCreation: blockedCreation, sharedCollectionAllowed: true }));
