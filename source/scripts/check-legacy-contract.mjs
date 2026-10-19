import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { repositoryRoot } from "./lib/repository.mjs";

const CONTRACT_ROOT = "contracts/legacy-window-turing/v1";
const ASSET_PATHS = Object.freeze([
  `${CONTRACT_ROOT}/README.md`,
  `${CONTRACT_ROOT}/contract.json`,
  `${CONTRACT_ROOT}/contract.schema.json`,
  `${CONTRACT_ROOT}/provenance.json`,
  `${CONTRACT_ROOT}/vectors/baseline-a.json`,
  `${CONTRACT_ROOT}/vectors/baseline-b.json`,
]);
const REQUIRED_METHODS = Object.freeze([
  "connect",
  "disconnect",
  "isConnected",
  "getPubKey",
  "getAddress",
  "getNetwork",
  "getInfo",
  "on",
  "removeListener",
  "getBalance",
  "sendTransaction",
  "signTransaction",
  "signAssociatedTransaction",
  "signMessage",
  "encrypt",
  "decrypt",
  "sendBatchRequest",
  "mergeUtxos",
  "mergeFtUtxos",
  "mergeStableCoinUtxos",
]);
const REQUIRED_EVENTS = Object.freeze([
  "TuringReady",
  "TuringResponse",
  "TuringAccountChanged",
  "TuringNetworkChanged",
]);
const REQUIRED_BASELINE_B = Object.freeze([
  "p2pkh-sign-only",
  "p2pkh-broadcast",
  "durian-ft-transfer-sign-only",
  "durian-lp-increase-sign-only",
  "durian-lp-consume-sign-only",
  "durian-pool-mint-source-order",
  "durian-pool-init-single",
  "durian-ft-create-broadcast",
  "legacy-bitcoin-magic-message",
  "durian-sign-message-public-key-alias",
  "dependent-batch-txids",
]);

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortedUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
  return [...values].sort();
}

function assertValid(validate, value, label) {
  if (!validate(value)) {
    throw new Error(`${label} failed schema validation: ${JSON.stringify(validate.errors)}`);
  }
}

export function checkLegacyContract(root, options = {}) {
  const schema = readJson(root, `${CONTRACT_ROOT}/contract.schema.json`);
  const contract = readJson(root, `${CONTRACT_ROOT}/contract.json`);
  const baselineA = readJson(root, `${CONTRACT_ROOT}/vectors/baseline-a.json`);
  const baselineB = readJson(root, `${CONTRACT_ROOT}/vectors/baseline-b.json`);
  const provenance = readJson(root, `${CONTRACT_ROOT}/provenance.json`);
  const manifest = readJson(root, `${CONTRACT_ROOT}/manifest.json`);
  const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
  for (const [label, value] of Object.entries({ contract, baselineA, baselineB, provenance, manifest })) {
    assertValid(validate, value, label);
    assert.equal(value.version, contract.version, `${label} version drifted`);
  }

  assert.equal(contract.surface, "window.Turing");
  assert.equal(contract.permissionNamespace, "legacy-window-turing/v1");
  assert.equal(contract.version, "1.0.5");
  assert.equal(contract.authority.source, "native-verified-navigation");
  assert.equal(contract.authority.origin, "canonical-exact-origin");
  assert.equal(contract.permissions.shareWithTws, false);
  assert.deepEqual(contract.permissions.connect, {
    request: "wallet_requestPermissions",
    capabilities: ["tbc_accounts", "tbc_accountMetadata", "tbc_signTransaction"],
    accountRead: "tbc_accounts",
    nativeApprovalCount: 1,
  });
  assert.equal(contract.transport.requestCorrelation, "internal-unique-id");
  assert.equal(contract.transport.pendingBy, "request-id");
  assert.equal(contract.transport.methodNameCorrelation, false);
  assert.equal(
    contract.errors.businessFailureSettlement,
    "resolve",
    "Legacy business failures must resolve",
  );
  assert.equal(contract.errors.businessFailureShape, "{error:string}");
  assert.equal(contract.errors.transportFailureSettlement, "reject");
  assert.equal(contract.execution.hostPorts, 9);
  assert.equal(contract.execution.hostRequired, true);
  assert.equal(contract.execution.adapterMayAccessVault, false);
  assert.equal(contract.execution.adapterMayHoldPrivateKey, false);
  assert.equal(contract.execution.adapterMayRetryBroadcast, false);
  assert.equal(contract.execution.legacyMayEnterEngine, false);
  assert.equal(contract.execution.publicPackagesMayDependOnLegacy, false);
  assert.deepEqual(contract.execution.path, [
    "normalize",
    "plan",
    "approval-binding",
    "wallet-private-signer",
    "finalize",
    "optional-broadcast",
  ]);
  assert.deepEqual(
    sortedUnique(contract.methods.map(({ path: methodPath }) => methodPath), "methods"),
    [...REQUIRED_METHODS].sort(),
  );
  assert.equal(
    contract.methods.find(({ path: methodPath }) => methodPath === "connect")?.target,
    "wallet_requestPermissions -> tbc_accounts",
  );
  assert.deepEqual(
    sortedUnique(contract.events.map(({ name }) => name), "events"),
    [...REQUIRED_EVENTS].sort(),
  );
  assert.equal(baselineA.profile, "baseline-a");
  assert.equal(baselineA.vectors.every(({ required }) => required), true);
  const connectApproved = baselineA.vectors.find(({ id }) => id === "connect-approved");
  assert.deepEqual(connectApproved?.expected.invariants, [
    "permission namespace is legacy-window-turing/v1",
    "one native approval grants tbc_accounts, tbc_accountMetadata, and tbc_signTransaction",
    "getPubKey and the first transaction after connect require no second permission approval",
  ]);
  assert.equal(baselineB.profile, "baseline-b");
  assert.equal(
    baselineB.vectors.every(({ required }) => required),
    true,
    "Baseline B vectors must remain required",
  );
  assert.deepEqual(
    sortedUnique(baselineB.vectors.map(({ id }) => id), "Baseline B vector IDs"),
    [...REQUIRED_BASELINE_B].sort(),
  );
  const signMessageAlias = baselineB.vectors.find(
    ({ id }) => id === "durian-sign-message-public-key-alias",
  );
  assert.equal(signMessageAlias?.expected.value.pubKey, signMessageAlias?.expected.value.pubkey);
  const poolMint = baselineB.vectors.find(({ id }) => id === "durian-pool-mint-source-order");
  assert.deepEqual(poolMint?.input, { flag: "POOLNFT_MINT", broadcastEnabled: false });
  assert.deepEqual(poolMint?.expected.value, { txraw: "pool-source-raw,pool-mint-raw" });
  const poolInit = baselineB.vectors.find(({ id }) => id === "durian-pool-init-single");
  assert.deepEqual(poolInit?.input, { flag: "POOLNFT_INIT", broadcastEnabled: false });
  assert.deepEqual(poolInit?.expected.value, { txraw: "pool-init-raw" });

  if (options.verifyManifest !== false) {
    const actualFiles = ASSET_PATHS.map((relativePath) => ({
      path: relativePath.slice(`${CONTRACT_ROOT}/`.length),
      sha256: sha256(fs.readFileSync(path.join(root, relativePath))),
    })).sort((left, right) => left.path.localeCompare(right.path));
    assert.deepEqual(manifest.files, actualFiles, "Legacy contract asset hashes drifted");
    const bundleInput = actualFiles
      .map(({ path: relativePath, sha256: fileHash }) => `${relativePath}\0${fileHash}\n`)
      .join("");
    assert.equal(manifest.bundleSha256, sha256(Buffer.from(bundleInput, "utf8")));
  }

  return Object.freeze({
    version: contract.version,
    methods: contract.methods.length,
    events: contract.events.length,
    baselineA: baselineA.vectors.length,
    baselineB: baselineB.vectors.length,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkLegacyContract(repositoryRoot(import.meta.url));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
