import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsc = path.join(root, "node_modules/.bin/tsc");

function compile(fixture) {
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
      path.join(root, "packages/host/test/types", fixture),
    ],
    { cwd: root, encoding: "utf8" },
  );
}

test("SQLite subpath exposes only the injected transactional driver boundary", () => {
  for (const fixture of ["sqlite-valid.ts", "sqlite-invalid.ts"]) {
    const result = compile(fixture);
    assert.equal(
      result.status,
      0,
      `${fixture}\n${result.stdout}\n${result.stderr}`,
    );
  }
});
