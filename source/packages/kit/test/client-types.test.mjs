import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("public Pool swap types require an explicit replay deadline", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(root, "node_modules/typescript/bin/tsc"),
      "-p",
      resolve(root, "packages/kit/test/tsconfig.client-public.json"),
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
