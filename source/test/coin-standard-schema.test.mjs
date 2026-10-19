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
const transfer = { type: "tbc20-stablecoin-transfer", version: "1.0", contractId: id, to: address, amount: "250" };
const merge = { type: "tbc20-stablecoin-merge", version: "1.0", contractId: id };
const multiple = { type: transfer.type, version: "1.0", contractId: id, receivers: [{ to: address, amount: "250" }] };
const valid = (check, value) => assert.equal(check(value), true, JSON.stringify(check.errors));

test("explicit Coin admin is scoped to issuance/management across all request forms", () => {
  const roles = [{ role: "coin-admin", accountId: `tbc:testnet:${address}` }];
  const actions = [
    { type: "tbc20-stablecoin-create", version: "1.0", name: "Coin", symbol: "C", decimals: 0, initialSupply: "10" },
    { type: "tbc20-stablecoin-mint", version: "1.0", contractId: id, to: address, amount: "1" },
    { type: "tbc20-stablecoin-freeze", version: "1.0", contractId: id, targetOutpoints: [{ txid: id, vout: 3 }], lockTime: "900000" },
    { type: "tbc20-stablecoin-unfreeze", version: "1.0", contractId: id, targetOutpoints: [{ txid: id, vout: 3 }] },
  ];
  for (const action of actions) {
    const value = { version: "1.0", chainId: "tbc:testnet", from: address, intent: action, signingRoles: roles };
    valid(request, value);
    valid(validator("workflow", "transactionStep"), { id: "admin", kind: "transaction", dependsOn: [], intent: action, signingRoles: roles });
    assert.equal(request({ ...value, signingRoles: [{ ...roles[0], role: "pool-controller" }] }), false);
  }
  for (const action of [transfer, merge, { ...transfer, type: "tbc.stablecoin.transfer" },
    { type: "tbc-amm-swap", version: "1.0", poolContractId: id, direction: "tbc-to-ft", amount: "10000", minimumOutput: "0" }]) {
    assert.equal(request({ version: "1.0", chainId: "tbc:testnet", from: address, intent: action, signingRoles: roles }), false);
  }
  // All four forms must use one role/intent policy, including externally prepared transactions.
  for (const [file, definition] of [["transaction-request", "transactionRequest"], ["prepared-transaction", "preparedTransactionRequest"],
    ["workflow", "transactionStep"], ["prepared-workflow", "preparedTransactionStep"]]) {
    const schema = schemas.find(s => s.$id.endsWith(`/${file}.schema.json`)).$defs[definition];
    assert.ok(schema.allOf.some(rule => rule.$ref?.endsWith("#/$defs/signingRoleIntentScope")));
  }
});

test("Coin management binds exact targets and separates mint from lock changes", () => {
  const point = { txid: id, vout: 3 };
  const freeze = { type: "tbc20-stablecoin-freeze", version: "1.0", contractId: id,
    targetOutpoints: [point], lockTime: "4294967295" };
  const unfreeze = { type: "tbc20-stablecoin-unfreeze", version: "1.0", contractId: id, targetOutpoints: [point] };
  const mint = { type: "tbc20-stablecoin-mint", version: "1.0", contractId: id,
    certificateOutpoint: { txid: id, vout: 0 }, amount: "25", to: address };
  const { certificateOutpoint, ...unpinnedMint } = mint;
  valid(intent, unpinnedMint);
  for (const action of [freeze, unfreeze, mint]) {
    valid(intent, action);
    for (const chainId of ["tbc:mainnet", "tbc:testnet"]) valid(request, { version: "1.0", chainId, from: address, intent: action });
    assert.equal(intent({ ...action, receivers: [{ to: address, amount: "1" }] }), false);
    assert.equal(intent({ ...action, payment: { to: address, amount: "24" } }), false);
  }
  for (const bad of [{ ...freeze, targetOutpoints: [] }, { ...freeze, targetOutpoints: [point, point] },
    { ...freeze, lockTime: "0" }, { ...freeze, lockTime: 1 }, { ...freeze, lockTime: "01" },
    { ...unfreeze, lockTime: "0" }, { ...mint, certificateOutpoint: point }, { ...mint, amount: "0" },
    { ...mint, targetOutpoints: [point] }, { ...transfer, targetOutpoints: [point] },
  ]) assert.equal(intent(bad), false);
});

test("Coin holder intents preserve atomic units, exact inputs and both networks", () => {
  for (const action of [transfer, merge, multiple, { ...transfer, payment: { to: address, amount: "24" } }]) {
    valid(intent, action);
    for (const chainId of ["tbc:mainnet", "tbc:testnet"]) valid(request, {
      version: "1.0", chainId, from: address, intent: action,
      constraints: { inputOutpoints: [{ txid: id, vout: 3 }] },
    });
  }
  for (const action of [{ ...transfer, amount: "0" }, { ...transfer, amount: "1.5" },
    { ...transfer, amount: "01" }, { ...transfer, amount: 250 },
    { ...transfer, receivers: multiple.receivers }, { ...multiple, receivers: [] },
    { ...multiple, receivers: Array(8).fill(multiple.receivers[0]) },
    { ...merge, to: address }, { ...merge, payment: { to: address, amount: "24" } },
    { ...transfer, type: "tbc20-stablecoin-transfer-v1" },
  ]) assert.equal(intent(action), false);
});

test("Coin identity binds its own template and issuer source output zero", () => {
  const value = { contractId: id, family: "stablecoin", protocolVersion: "coin", standardId: "tbc20-stablecoin",
    templateRevision: "c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3",
    creationTxid: id, genesisOutpoint: { txid: id, vout: 0 }, currentOutpoint: { txid: id, vout: 3 } };
  valid(record, value);
  for (const field of ["standardId", "templateRevision", "genesisOutpoint"]) {
    const bad = structuredClone(value); delete bad[field]; assert.equal(record(bad), false);
  }
  for (const patch of [{ family: "ft" }, { family: "nft" }, { protocolVersion: "1.0" },
    { standardId: "tbc20-standard" }, { templateRevision: "00".repeat(32) },
    { genesisOutpoint: { txid: id, vout: 3 } }, { genesisOutpoint: { txid: id, vout: 4 } },
  ]) assert.equal(record({ ...value, ...patch }), false);
  valid(policy, { family: "stablecoin", allowedVersions: ["1.0", "coin"] });
  for (const family of ["ft", "nft", "pool"]) assert.equal(policy({ family, allowedVersions: ["coin"] }), false);
});

test("Coin capability names are exact operations, not new Provider methods", () => {
  const value = { standard: "1.0.0", provider: "1.0.0", chainId: "tbc:testnet",
    methods: { tbc_signTransaction: "1.0" }, intents: { [transfer.type]: ["1.0"], [merge.type]: ["1.0"] },
    limits: { workflowSteps: 5, transactionBundleSize: 32 }, profiles: ["core"] };
  valid(capabilities, value);
  for (const type of ["tbc20-stablecoin-mystery", "tbc20-stablecoin-transfer-v1"])
    assert.equal(capabilities({ ...value, intents: { [type]: ["1.0"] } }), false);
  assert.equal(capabilities({ ...value, methods: { [transfer.type]: "1.0" } }), false);
});

test("old stablecoin holder interfaces and records are not removed", () => {
  valid(intent, { ...transfer, type: "tbc.stablecoin.transfer" });
  valid(intent, { ...merge, type: "tbc.stablecoin.merge" });
  valid(record, { contractId: id, family: "stablecoin", protocolVersion: "1.0", creationTxid: id,
    currentOutpoint: { txid: id, vout: 0 } });
});
