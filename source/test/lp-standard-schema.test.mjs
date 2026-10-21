import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const directory = new URL("../schemas/", import.meta.url);
const schemas = readdirSync(directory).filter((n) => n.endsWith(".json"))
  .map((n) => JSON.parse(readFileSync(new URL(n, directory), "utf8")));
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addFormat("uri", /^[A-Za-z][A-Za-z0-9+.-]*:/u);
ajv.addFormat("date-time", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u);
schemas.forEach((s) => ajv.addSchema(s));
const validator = (file, name) => ajv.getSchema(`${schemas.find((s) => s.$id.endsWith(`/${file}.schema.json`)).$id}#/$defs/${name}`);
const request = validator("transaction-request", "transactionRequest");
const record = validator("integration", "contractRecord");
const evidence = validator("prepared-transaction", "contractEvidence");
const policy = validator("integration", "contractPolicy");
const amountLimit = validator("integration", "amountLimit");
const capabilities = validator("provider", "capabilities");
const id = "11".repeat(32), address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const valid = (check, value) => assert.equal(check(value), true, JSON.stringify(check.errors));
const intents = [
  { type: "tbc20-lp-transfer", version: "1.0", poolContractId: id, amount: "40000", to: address },
  { type: "tbc20-lp-lock", version: "1.0", poolContractId: id, amount: "40000", lockTime: "900000" },
  { type: "tbc20-lp-merge", version: "1.0", poolContractId: id },
  { type: "tbc20-lp-unlock", version: "1.0", poolContractId: id },
];
test("LP exact intents retain atomic quantities and isolate lock/maintenance fields on both networks", () => {
  for (const chainId of ["tbc:mainnet", "tbc:testnet"]) for (const intent of intents) {
    const value = { version: "1.0", chainId, from: address, intent };
    valid(request, value);
    for (const field of ["payment", "receivers", "contractId", "name"])
      assert.equal(request({ ...value, intent: { ...intent, [field]: "1" } }), false);
  }
  for (const intent of [{ ...intents[0], amount: "0" }, { ...intents[0], amount: "01" },
    { ...intents[0], amount: 1 }, { ...intents[1], to: address }, { ...intents[1], lockTime: "0" },
    { ...intents[2], amount: "1" }, { ...intents[3], lockTime: "0" }])
    assert.equal(request({ version: "1.0", chainId: "tbc:testnet", from: address, intent }), false);
});

test("AMM create binds explicit configuration and keeps initial liquidity a separate intent", () => {
  const intent = { type: "tbc-amm-create", version: "1.0", ftContractId: id,
    feePolicy: { lpFeeRate: 25, taxFeeRate: 5, serviceProviderFeeRate: 0, protocolFeeRate: 0, feeAddress: address }, lpTimelock: false };
  for (const chainId of ["tbc:mainnet", "tbc:testnet"]) {
    for (const config of [intent, { ...intent, lpTimelock: true, controllers: ["22".repeat(20)] },
      ...[0, 9999].map(bps => ({ ...intent, feePolicy: { ...intent.feePolicy, lpFeeRate: bps, taxFeeRate: 0 } }))])
      valid(request, { version: "1.0", chainId, from: address, intent: config });
  }
  for (const patch of [{ controllers: [] }, { controllers: ["22".repeat(20), "22".repeat(20)] },
    { controllers: [address] }, { lpPlan: 7 }, { lpTimelock: "false" }, { initialLiquidity: { tbcAmount: "100", ftAmount: "100" } },
    { serviceFeeRate: 35 }, { to: address }, { amount: "100" },
    ...[10000, -1, 1.5].map(lpFeeRate => ({ feePolicy: { ...intent.feePolicy, lpFeeRate } }))])
    assert.equal(request({ version: "1.0", chainId: "tbc:testnet", from: address, intent: { ...intent, ...patch } }), false);
  const { lpTimelock, ...missingMode } = intent;
  assert.equal(request({ version: "1.0", chainId: "tbc:testnet", from: address, intent: missingMode }), false);
});
test("AMM business requests bind direction, atomic budgets and explicit slippage without mixed fields", () => {
  const base = { version: "1.0", poolContractId: id };
  const actions = [
    { ...base, type: "tbc-amm-add-liquidity", budgetAsset: "tbc", amount: "100000", initialFtAmount: "200000", minimumLpAmount: "0" },
    { ...base, type: "tbc-amm-add-liquidity", budgetAsset: "ft", amount: "10000", minimumLpAmount: "0", maximumTbcAmount: "90000" },
    { ...base, type: "tbc-amm-remove-liquidity", lpAmount: "10000", minimumTbcAmount: "0", minimumFtAmount: "0" },
    ...["tbc-to-ft", "ft-to-tbc"].map((direction) => ({ ...base, type: "tbc-amm-swap", direction, amount: "1000", minimumOutput: "0" })),
  ];
  const wrap = (intent, chainId = "tbc:testnet") => ({ version: "1.0", chainId, from: address, intent });
  for (const intent of actions) {
    for (const chainId of ["tbc:mainnet", "tbc:testnet"]) {
      valid(request, wrap(intent, chainId));
      valid(request, wrap({ ...intent, receiver: address, poolStateHash: id }, chainId));
    }
    for (const field of ["contractId", "controllers", "payment", "receivers", "to"])
      assert.equal(request(wrap({ ...intent, [field]: "bad" })), false);
    for (const field of Object.keys(intent).filter((k) => k.startsWith("minimum"))) {
      const missing = { ...intent }; delete missing[field]; assert.equal(request(wrap(missing)), false);
    }
  }
  for (const intent of [{ ...actions[0], budgetAsset: "ft" }, { ...actions[1], amount: "0" },
    { ...actions[2], lpAmount: "01" }, { ...actions[3], amount: 1 }, { ...actions[3], direction: "buy" },
    { ...actions[3], minimumOutput: "-1" }, { ...actions[4], lockTime: "1" }]) assert.equal(request(wrap(intent)), false);
});
test("Pool3 identity requires full template family binding without reinterpreting old records", () => {
  for (const templateRevision of ["c98ecae0a22452ce37bcaf24be0c836521d3de3a75aa8f16cef587b8b6f031b2", "cf7f95c0483b56ad24825591acbce6e82e37890aa0047fc63183d3fb7a7a4ffc"]) {
    const value = { contractId: id, family: "pool", protocolVersion: "pool3", standardId: "tbc-amm", templateRevision,
      genesisOutpoint: { txid: id, vout: 0 }, creationTxid: id, currentOutpoint: { txid: "22".repeat(32), vout: 0 } };
    valid(record, value);
    const { creationTxid, currentOutpoint, ...identity } = value;
    valid(evidence, { ...identity, sourceTransactionId: creationTxid });
    for (const field of ["standardId", "templateRevision", "genesisOutpoint"]) {
      const bad = structuredClone(value); delete bad[field]; assert.equal(record(bad), false);
    }
    for (const patch of [{ family: "ft" }, { protocolVersion: "1.0" }, { templateRevision: "00".repeat(32) },
      { standardId: "tbc20-lp" }, { genesisOutpoint: { txid: id, vout: 1 } }]) assert.equal(record({ ...value, ...patch }), false);
  }
  valid(record, { contractId: id, family: "pool", protocolVersion: "4.0", creationTxid: id, currentOutpoint: { txid: id, vout: 0 } });
  valid(policy, { family: "pool", allowedVersions: ["4.0", "pool3"] });
  assert.equal(policy({ family: "ft", allowedVersions: ["pool3"] }), false);
  for (const scope of ["lp-total", "lp-slot", "pool-state"]) valid(amountLimit, { scope, protocolVersion: "pool3", maximum: "100000" });
  assert.equal(amountLimit({ scope: "stablecoin-total", protocolVersion: "pool3", maximum: "1" }), false);
});
test("LP capabilities are business intents under the existing Provider methods", () => {
  const value = { standard: "1.0.0", provider: "1.0.0", chainId: "tbc:testnet", methods: { tbc_signTransaction: "1.0" },
    intents: Object.fromEntries(intents.map((i) => [i.type, ["1.0"]])), limits: { workflowSteps: 5, transactionBundleSize: 32 }, profiles: ["defi"] };
  valid(capabilities, value);
  assert.equal(capabilities({ ...value, methods: { "tbc20-lp-transfer": "1.0" } }), false);
  assert.equal(capabilities({ ...value, intents: { "tbc20-lp-burn": ["1.0"] } }), false);
});
