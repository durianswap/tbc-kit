import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const consumer = path.join(root, "packages/core/test/types/public-api-consumer.ts");
const registryUrl = new URL("../../../registry/integration-ports.json", import.meta.url);
const runtimeUrl = new URL("../dist/esm/index.js", import.meta.url);
const tsc = path.join(root, "node_modules/.bin/tsc");

test("exports the exact Registry operation set without a string fallback", async () => {
  const registry = JSON.parse(await readFile(registryUrl, "utf8"));
  const expected = registry.ports.flatMap((port) =>
    port.operations.map((operation) => operation.name),
  );
  const runtime = await import(runtimeUrl);

  assert.deepEqual(runtime.TWS_PORT_OPERATIONS, expected);
});

test("compiles precise Core, Engine, call, and response contracts", () => {
  const compile = spawnSync(
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
      consumer,
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
});
