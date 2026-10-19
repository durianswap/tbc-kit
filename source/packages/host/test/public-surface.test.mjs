import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TEST_LEASE_SCHEDULER } from "./fixtures/lease-scheduler.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestUrl = new URL("../package.json", import.meta.url);
const runtimeUrl = new URL("../dist/esm/index.js", import.meta.url);
const indexedDbUrl = new URL("../dist/esm/indexeddb.js", import.meta.url);
const sqliteUrl = new URL("../dist/esm/sqlite.js", import.meta.url);
const registryUrl = new URL("../../../registry/integration-ports.json", import.meta.url);
const tsc = path.join(root, "node_modules/.bin/tsc");

const EXPECTED_PORTS = Object.freeze([
  "accounts",
  "chainData",
  "policy",
  "permissionStore",
  "approval",
  "signer",
  "crypto",
  "reviewedTransaction",
  "broadcast",
  "clock",
  "entropy",
]);

const EXPECTED_METHODS = Object.freeze([
  "cancelOperation",
  "inspectOperation",
  "recoverPendingOperations",
  "resumeOperation",
  "startOperation",
]);

function compile(file) {
  return spawnSync(
    tsc,
    [
      "--noEmit",
      "--strict",
      "--exactOptionalPropertyTypes",
      "--noUncheckedIndexedAccess",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      file,
    ],
    { cwd: root, encoding: "utf8" },
  );
}

test("publishes only the root and opt-in durable Store entry points", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

  assert.equal(manifest.name, "@tbc-wallet/host");
  assert.equal(manifest.version, "1.0.0-draft.6.16");
  assert.deepEqual(Object.keys(manifest.exports).sort(), [
    ".",
    "./indexeddb",
    "./sqlite",
  ]);
  assert.deepEqual(manifest.files, ["dist", "README.md", "LICENSE"]);
  assert.deepEqual(manifest.dependencies, {
    "@tbc-wallet/core": "1.0.0-draft.6.10",
  });
});
test("exports nine required plus two optional Host Port names and five driver methods", async () => {
  const runtime = await import(runtimeUrl);
  const registry = JSON.parse(await readFile(registryUrl, "utf8"));
  const registeredPorts = registry.ports.map((port) => port.name);

  assert.deepEqual(runtime.TWS_HOST_PORT_NAMES, EXPECTED_PORTS);
  assert.deepEqual(runtime.TWS_HOST_PORT_NAMES, registeredPorts);
  assert.deepEqual(runtime.TWS_HOST_DRIVER_METHODS, EXPECTED_METHODS);

  const inert = async () => {
    throw new Error("inert public-surface fixture");
  };
  const host = runtime.createTwsHost({
    core: {},
    ports: Object.fromEntries(EXPECTED_PORTS.map((name) => [name, inert])),
    store: {},
    authority: { read: inert, compareAndSwapSession: inert },
    ownerId: "surface-test-owner",
    ...TEST_LEASE_SCHEDULER,
  });

  assert.deepEqual(Object.keys(host).sort(), EXPECTED_METHODS);
  assert.equal("executeTransaction" in runtime, false);
  assert.equal("signAndSend" in runtime, false);
  assert.equal("executeTransaction" in host, false);
  assert.equal("signAndSend" in host, false);
});

test("keeps optional durable Stores outside the root entry", async () => {
  const runtime = await import(runtimeUrl);
  const indexedDb = await import(indexedDbUrl);
  const sqlite = await import(sqliteUrl);

  assert.equal("createIndexedDbTwsHostStore" in runtime, false);
  assert.equal("createSqliteTwsHostStore" in runtime, false);
  assert.equal(typeof indexedDb.createIndexedDbTwsHostStore, "function");
  assert.equal(typeof sqlite.createSqliteTwsHostStore, "function");
  assert.equal(sqlite.TWS_HOST_SQLITE_MAX_CANONICAL_JSON_BYTES, 4 * 1024 * 1024);
  assert.deepEqual(Object.keys(sqlite).sort(), [
    "TWS_HOST_SQLITE_MAX_CANONICAL_JSON_BYTES",
    "TWS_HOST_SQLITE_SCHEMA_VERSION",
    "TWS_HOST_SQLITE_TABLES",
    "createSqliteTwsHostStore",
  ]);
});

test("compiles the exact registered Host boundary under strict TypeScript", () => {
  for (const fixture of ["valid.ts", "invalid.ts"]) {
    const result = compile(path.join(root, "packages/host/test/types", fixture));
    assert.equal(result.status, 0, `${fixture}\n${result.stdout}\n${result.stderr}`);
  }
});
