import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const schemaDirectory = new URL("../schemas/", import.meta.url);
const schemas = readdirSync(schemaDirectory).filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(new URL(name, schemaDirectory), "utf8")));
const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
ajv.addFormat("uri", /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]*$/u);
ajv.addFormat("date-time", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u);
schemas.forEach((schema) => ajv.addSchema(schema));
const validator = (file, definition) => {
  const schema = schemas.find((candidate) => candidate.$id.endsWith(`/${file}.schema.json`));
  return ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
};
const intent = validator("transaction-request", "tbcIntent");
const request = validator("transaction-request", "transactionRequest");
const record = validator("integration", "contractRecord");
const evidence = validator("prepared-transaction", "contractEvidence");
const amountLimit = validator("integration", "amountLimit");
const contractPolicy = validator("integration", "contractPolicy");
const chainDataResolveParams = validator("integration", "chainDataResolveParams");
const capabilities = validator("provider", "capabilities");
const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const hash = "11".repeat(32);
const templateRevision = "0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84";
const binding = {
  standardId: "tbc20-standard", protocolVersion: "tbc20", templateRevision,
  genesisOutpoint: { txid: hash, vout: 0 },
};
const create = { type: "tbc20-standard-create", version: "1.0", name: "New Token", symbol: "NEW", decimals: 6, initialSupply: "123456" };
const transfer = { type: "tbc20-standard-transfer", version: "1.0", contractId: hash, to: address, amount: "9223372036854775808" };
const merge = { type: "tbc20-standard-merge", version: "1.0", contractId: hash };
function valid(check, value) {
  assert.equal(check(value), true, JSON.stringify(check.errors));
}

test("new create/transfer/merge use exact action names in ordinary mainnet and testnet requests", () => {
  for (const value of [create, { ...create, to: address }, transfer, merge]) {
    valid(intent, value);
    for (const chainId of ["tbc:mainnet", "tbc:testnet"]) {
      valid(request, { version: "1.0", chainId, from: address, intent: value });
    }
  }
  for (const type of ["tbc20.transfer", "tbc20-transfer", "tbc20-standard-transfer-v1"]) {
    assert.equal(intent({ ...transfer, type }), false);
  }
});

test("raw integer quantities and metadata bounds reject misleading or oversized wire inputs", () => {
  for (const amount of ["0", "01", "1.0", "1e3", "-1", 1, "9".repeat(40)]) {
    assert.equal(intent({ ...transfer, amount }), false);
  }
  for (const patch of [
    { decimals: 19 }, { decimals: -1 }, { decimals: 1.5 },
    { initialSupply: "0" }, { initialSupply: "1.5" }, { initialSupply: "9".repeat(20) },
    { name: "" }, { name: "x".repeat(54) }, { symbol: "HAS SPACE" },
    { symbol: "代币" }, { privateKey: "not-an-allowed-field" },
  ]) assert.equal(intent({ ...create, ...patch }), false);
  // Numeric u128/i64 and combined UTF-8/NFC limits remain explicit Engine
  // semantic checks, not silently approximated with JavaScript numbers here.
  valid(intent, { ...create, decimals: 18, initialSupply: "9223372036854775807" });
  valid(intent, { ...transfer, amount: (36n * ((1n << 63n) - 1n)).toString() });
  assert.equal(intent({ ...transfer, contractId: "not-a-hash" }), false);
  assert.equal(intent({ ...merge, amount: "1" }), false);
});

test("new ContractRecord requires complete coherent template and origin binding", () => {
  const value = { contractId: hash, family: "ft", creationTxid: hash, currentOutpoint: { txid: hash, vout: 0 }, ...binding };
  valid(record, value);
  for (const field of ["standardId", "templateRevision", "genesisOutpoint"]) {
    const incomplete = structuredClone(value);
    delete incomplete[field];
    assert.equal(record(incomplete), false, field);
  }
  for (const patch of [
    { family: "stablecoin" }, { protocolVersion: "4.0" },
    { standardId: "tbc20-stablecoin" }, { templateRevision: "00".repeat(32) },
    { genesisOutpoint: { txid: hash, vout: -1 } },
    { genesisOutpoint: { txid: hash, vout: 1 } },
    { genesisOutpoint: { txid: hash, vout: 4294967296 } },
    { genesisOutpoint: { txid: hash, vout: 0, trusted: true } },
  ]) assert.equal(record({ ...value, ...patch }), false);
});

test("Prepared evidence carries the same binding without treating caller labels as trust", () => {
  const value = { contractId: hash, family: "ft", sourceTransactionId: hash, ...binding };
  valid(evidence, value);
  for (const field of ["standardId", "protocolVersion", "templateRevision", "genesisOutpoint"]) {
    const incomplete = structuredClone(value);
    delete incomplete[field];
    assert.equal(evidence(incomplete), false, field);
  }
  assert.equal(evidence({ ...value, family: "nft" }), false);
  assert.equal(evidence({ ...value, templateRevision: "00".repeat(32) }), false);
  assert.equal(evidence({ ...value, trusted: true }), false);
  const schema = schemas.find((candidate) => candidate.$id.endsWith("/prepared-transaction.schema.json"));
  assert.match(schema.$defs.contractEvidence.$comment, /untrusted/iu);
  assert.match(schema.$defs.contractEvidence.$comment, /independently match/iu);
});

test("historical records, Prepared evidence and old create intent remain unchanged at this stage", () => {
  const oldRecord = { contractId: hash, family: "ft", protocolVersion: "4.0", creationTxid: hash, currentOutpoint: { txid: hash, vout: 0 } };
  const oldEvidence = { contractId: hash, family: "ft", sourceTransactionId: hash };
  valid(record, oldRecord);
  valid(evidence, oldEvidence);
  valid(intent, { ...create, type: "tbc.ft.create" });
  assert.equal(record({ ...oldRecord, templateRevision }), false);
  assert.equal(record({ ...oldRecord, protocolVersion: "tbc20" }), false);
  assert.equal(evidence({ ...oldEvidence, genesisOutpoint: binding.genesisOutpoint }), false);
});

test("tbc20 policies are confined to FT family and FT amount scopes", () => {
  valid(contractPolicy, { family: "ft", allowedVersions: ["4.0", "tbc20"], createVersion: "tbc20" });
  for (const family of ["collection", "nft", "stablecoin", "pool"]) {
    assert.equal(contractPolicy({ family, allowedVersions: ["4.0", "tbc20"] }), false);
    assert.equal(contractPolicy({ family, allowedVersions: ["4.0"], createVersion: "tbc20" }), false);
    valid(contractPolicy, { family, allowedVersions: ["4.0"], createVersion: "4.0" });
  }
  for (const scope of ["ft-total", "ft-slot"]) {
    valid(amountLimit, { scope, protocolVersion: "tbc20", maximum: "9223372036854775807" });
  }
  for (const scope of ["native", "stablecoin-total", "stablecoin-slot", "lp-slot", "pool-state"]) {
    assert.equal(amountLimit({ scope, protocolVersion: "tbc20", maximum: "1" }), false);
    valid(amountLimit, { scope, protocolVersion: "4.0", maximum: "1" });
  }
  assert.equal(contractPolicy({ family: "ft", allowedVersions: ["tbc20-standard"] }), false);
});

test("Host Chain Data params accept exactly the new intent names on both networks", () => {
  for (const chainId of ["tbc:mainnet", "tbc:testnet"]) {
    for (const value of [create, transfer, merge]) {
      const params = {
        version: "1.0", chainId, accountId: `${chainId}:${address}`,
        requirement: {
          intentType: value.type, includeAncestry: value !== create,
          ...(value === create ? {} : { contractIds: [hash] }),
          inputOutpoints: [{ txid: hash, vout: 0 }],
          assets: value === create ? [{ kind: "native" }] : [
            { kind: "native" }, { kind: "ft", contractId: hash, ...(value === transfer ? { minimumAmount: value.amount } : {}) },
          ],
        },
      };
      valid(chainDataResolveParams, params);
      for (const intentType of ["tbc20-standard-burn", "tbc20-standard-create-v1", "tbc20-transfer", "tbc.unknown"]) {
        assert.equal(chainDataResolveParams({ ...params, requirement: { ...params.requirement, intentType } }), false, intentType);
      }
    }
  }
});

test("getCapabilities accepts the three TBC20 intents and rejects undeclared operation names", () => {
  for (const chainId of ["tbc:mainnet", "tbc:testnet"]) {
    const value = {
      standard: "1.0.0", provider: "1.0.0", chainId,
      methods: { tbc_signTransaction: "1.0", tbc_sendTransaction: "1.0" },
      intents: { "tbc.ft.transfer": ["1.0"], ...Object.fromEntries([create, transfer, merge].map(({ type }) => [type, ["1.0"]])) },
      limits: { workflowSteps: 5, transactionBundleSize: 32 }, profiles: ["core", "assets"],
    };
    valid(capabilities, value);
    for (const type of ["tbc20-standard-burn", "tbc20-standard-transfer-v1", "tbc20-other-transfer", "tbc721-standard-mystery", "tbc20-standard-transfer.extra"]) {
      assert.equal(capabilities({ ...value, intents: { [type]: ["1.0"] } }), false, type);
    }
    assert.equal(capabilities({ ...value, methods: { "tbc20-standard-transfer": "1.0" } }), false);
  }
});
