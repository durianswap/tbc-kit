import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const directory = new URL("../schemas/", import.meta.url);
const schemas = readdirSync(directory).filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(new URL(name, directory), "utf8")));
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addFormat("uri", /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]*$/u);
ajv.addFormat("date-time", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u);
schemas.forEach((schema) => ajv.addSchema(schema));
const validator = (file, definition) => ajv.getSchema(`${schemas.find((s) => s.$id.endsWith(`/${file}.schema.json`)).$id}#/$defs/${definition}`);
const intent = validator("transaction-request", "tbcIntent");
const request = validator("transaction-request", "transactionRequest");
const record = validator("integration", "contractRecord");
const policy = validator("integration", "contractPolicy");
const capabilities = validator("provider", "capabilities");
const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const id = "11".repeat(32);
const metadata = { name: "NFT", symbol: "N", description: "synthetic", attributes: [
  { traitType: "text", value: "x" }, { traitType: "flag", value: true }, { traitType: "number", value: -1 },
] };
const create = { type: "tbc721-standard-create-collection", version: "1.0", name: "Collection", description: "", supply: "3", media: { kind: "uri", uri: "ipfs://synthetic" } };
const mint = { type: "tbc721-standard-mint", version: "1.0", collectionId: id, slot: 1, ...metadata };
const batch = { type: "tbc721-standard-batch-mint", version: "1.0", collectionId: id, items: [{ slot: 1, ...metadata }, { slot: 3, to: address, ...metadata }] };
const transfer = { type: "tbc721-standard-transfer", version: "1.0", contractId: id, to: address };
const valid = (check, value) => assert.equal(check(value), true, JSON.stringify(check.errors));

test("capabilities declare exact NFT operations without inventing Provider methods", () => {
  for (const chainId of ["tbc:mainnet", "tbc:testnet"]) {
    const value = {
      standard: "1.0.0", provider: "1.0.0", chainId,
      methods: { tbc_signTransaction: "1.0", tbc_sendTransaction: "1.0" },
      intents: Object.fromEntries([create, mint, batch, transfer].map(({ type }) => [type, ["1.0"]])),
      limits: { workflowSteps: 5, transactionBundleSize: 32 }, profiles: ["core"],
    };
    valid(capabilities, value);
    for (const type of ["tbc721-standard-mystery", "tbc721-standard-transfer-v1", "tbc721-standard-mint.extra"]) {
      assert.equal(capabilities({ ...value, intents: { [type]: ["1.0"] } }), false, type);
    }
    assert.equal(capabilities({ ...value, methods: { "tbc721-standard-transfer": "1.0" } }), false);
  }
});

test("new NFT action names and optional atomic payment on both network IDs", () => {
  for (const action of [create, { ...create, to: address }, mint, batch, transfer, { ...transfer, payment: { to: address, amount: "1234" } }]) {
    valid(intent, action);
    for (const chainId of ["tbc:mainnet", "tbc:testnet"]) valid(request, {
      version: "1.0", chainId, from: address, intent: action,
      constraints: { inputOutpoints: [{ txid: id, vout: 0 }] },
    });
  }
  for (const action of [{ ...mint, type: "tbc721-standard-mint-v1" }, { ...batch, to: address },
    { ...mint, slot: 0 }, { ...mint, slot: 4294967296 }, { ...create, supply: "2001" },
    { ...mint, attributes: [{ traitType: "x", value: 1.5 }] },
    { ...mint, attributes: [{ traitType: "x", value: null }] },
    { ...transfer, payment: { to: address, amount: "01" } },
    { ...batch, items: [] }, { ...batch, items: Array(33).fill(batch.items[0]) },
  ]) assert.equal(intent(action), false);
});

test("new NFT metadata media has the same bounded shape as Rust normalization", () => {
  for (const media of [{ kind: "uri", uri: "ar://test" },
    { kind: "base64", mediaType: "image/png", data: "eA==", sha256: "00".repeat(32) }]) valid(intent, { ...mint, media });
  for (const media of [{ kind: "uri", uri: "http://test" }, { kind: "uri", uri: "ipfs://test", mediaType: "image/png" },
    { kind: "base64", mediaType: "image/png", data: "not base64", sha256: id },
    { kind: "base64", mediaType: "Image/PNG", data: "eA==", sha256: id },
    { kind: "uri", uri: `ipfs://${"x".repeat(2048)}` }]) assert.equal(intent({ ...mint, media }), false);
});

test("new NFT identity cannot be mislabeled FT or stablecoin", () => {
  const value = { contractId: id, family: "nft", protocolVersion: "tbc721", standardId: "tbc721-standard",
    templateRevision: "a97688ec62777b01e93c8486e0505b56701f48dc8cf7947637ece57fe88df104",
    creationTxid: id, genesisOutpoint: { txid: id, vout: 0 }, currentOutpoint: { txid: id, vout: 0 } };
  valid(record, value); valid(record, { ...value, family: "collection" });
  for (const field of ["standardId", "templateRevision", "genesisOutpoint"]) {
    const bad = structuredClone(value); delete bad[field]; assert.equal(record(bad), false);
  }
  for (const patch of [{ family: "ft" }, { family: "stablecoin" }, { protocolVersion: "1.0" },
    { templateRevision: "00".repeat(32) }, { standardId: "tbc20-standard" }, { genesisOutpoint: { txid: id, vout: 1 } }]) {
    assert.equal(record({ ...value, ...patch }), false);
  }
  for (const family of ["collection", "nft"]) valid(policy, { family, allowedVersions: ["1.0", "tbc721"], createVersion: "tbc721" });
  for (const family of ["ft", "pool", "stablecoin"]) assert.equal(policy({ family, allowedVersions: ["tbc721"] }), false);
});

test("historical NFT creation and transfer interfaces stay available", () => {
  valid(intent, { ...create, type: "tbc.collection.create" });
  const historical = { ...mint, type: "tbc.nft.mint" }; delete historical.slot;
  valid(intent, historical); valid(intent, { ...transfer, type: "tbc.nft.transfer" });
  valid(record, { contractId: id, family: "nft", protocolVersion: "1.0", creationTxid: id, currentOutpoint: { txid: id, vout: 0 } });
});
