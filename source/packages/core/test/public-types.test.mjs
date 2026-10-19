import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const generator = path.join(root, "scripts/generate-core-types.mjs");
const generated = path.join(root, "packages/core/src/generated/protocol-types.ts");
const consumer = path.join(root, "packages/core/test/types/public-api-consumer.ts");
const tsc = path.join(root, "node_modules/.bin/tsc");

function run(command, args) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8" });
}

test("regenerates the schema-owned public types byte-for-byte", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tws-core-types-"));
  const output = path.join(directory, "protocol-types.ts");
  try {
    const first = run(process.execPath, [generator, "--output", output]);
    assert.equal(first.status, 0, first.stderr);
    const firstBytes = readFileSync(output);

    const second = run(process.execPath, [generator, "--output", output]);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readFileSync(output), firstBytes);

    writeFileSync(output, Buffer.concat([firstBytes, Buffer.from("\n// drift\n")]));
    const drift = run(process.execPath, [generator, "--check", "--output", output]);
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /generated Core types are stale/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps checked-in public types fresh and consumable under strict TypeScript", () => {
  const check = run(process.execPath, [generator, "--check", "--output", generated]);
  assert.equal(check.status, 0, check.stderr);

  const compile = run(tsc, [
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
  ]);
  assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
});
