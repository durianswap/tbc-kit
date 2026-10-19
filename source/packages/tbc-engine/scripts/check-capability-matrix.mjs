import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Preserve the original 19-intent inventory as historical evidence. An old
// builder/test remaining in source does not authorize its current execution.
const matrix = JSON.parse(await readFile(path.join(root, "evidence/capability-matrix.json"), "utf8"));
const expectedMethods = ["normalizeRequest", "plan", "validate", "finalize"];
const expectedIntents = [
  "tbc.transfer","tbc.maintenance.merge","tbc.collection.create","tbc.nft.mint","tbc.nft.transfer",
  "tbc.ft.create","tbc.ft.transfer","tbc.ft.merge","tbc.stablecoin.transfer","tbc.stablecoin.merge","tbc.pool.create",
  "tbc.pool.liquidity.add","tbc.pool.liquidity.remove","tbc.pool.liquidity.close","tbc.pool.ft.merge","tbc.pool.ftlp.merge","tbc.pool.ftlp.burn",
  "tbc.pool.swap.exactTbcForToken","tbc.pool.swap.exactTokenForTbc"
];
const expectedLegacy = [
  "P2PKH","COLLECTION_CREATE","NFT_CREATE","NFT_TRANSFER","FT_MINT","FT_TRANSFER",
  "STABLECOIN_TRANSFER","POOLNFT_MINT","POOLNFT_INIT","POOLNFT_LP_INCREASE",
  "POOLNFT_LP_CONSUME","POOLNFT_LP_BURN","POOLNFT_SWAP_TO_TOKEN",
  "POOLNFT_SWAP_TO_TBC","FT_MERGE","STABLECOIN_MERGE","POOLNFT_MERGE","FTLP_MERGE"
];

function exact(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(label + " mismatch: " + JSON.stringify(actual));
  }
}
exact(matrix.engineMethods, expectedMethods, "engine methods");
exact(matrix.publicIntents.map((item) => item.intent), expectedIntents, "public intents");
const planSource = await readFile(path.join(root, "rust/crates/tbc-engine-core/src/plan.rs"), "utf8");
const implementedIntents = new Set(planSource.match(/"tbc\.[A-Za-z.]+"/g)?.map((value) => value.slice(1, -1)) ?? []);
exact([...implementedIntents].sort(), [...expectedIntents].sort(), "Rust intent dispatch");
const legacy = matrix.publicIntents.flatMap((item) => item.legacyBehaviors)
  .concat(matrix.internalMaintenance.map((item) => item.legacyBehavior));
exact(legacy, expectedLegacy, "Legacy behaviors");
if (matrix.publicIntents.some((item) => item.status !== "implemented-tested" || !item.evidence.length)) {
  throw new Error("every public intent must be implemented-tested with evidence");
}
if (matrix.internalMaintenance.some((item) => item.status !== "implemented-tested" || !item.evidence.length)) {
  throw new Error("every maintenance behavior must be implemented-tested with evidence");
}
for (const item of [...matrix.publicIntents, ...matrix.internalMaintenance]) {
  for (const reference of item.evidence) {
    const [relative, fragment] = reference.split("#");
    const target = path.join(root, relative);
    await access(target);
    if (fragment && !(await readFile(target, "utf8")).includes(fragment)) {
      throw new Error(`missing evidence symbol ${fragment} in ${relative}`);
    }
  }
}
const stablecoinTests = await readFile(path.join(root, "rust/crates/tbc-engine-core/tests/nft_stablecoin.rs"), "utf8");
const ancestryTests = await readFile(path.join(root, "rust/crates/tbc-engine-core/src/ancestry.rs"), "utf8");
for (const symbol of ["stablecoin_merge_rejects_stale_and_tampered_continuations", "stablecoin_mint_rejects_noncanonical_coin_nft_state_bytes"]) {
  if (!stablecoinTests.includes(symbol) && !ancestryTests.includes(symbol)) throw new Error(`StableCoin closure evidence is missing: ${symbol}`);
}
exact(matrix.counts, { publicIntents: 19, legacyBehaviors: 18, engineMethods: 4 }, "counts");
console.log("historical source inventory: 19 intents, 18 Legacy behaviors, 4 engine methods; NOT current advertised support");

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
