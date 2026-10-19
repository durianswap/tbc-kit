import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("current Mobile Core/Host consumers typecheck from Kit-only declarations", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(root, "node_modules/typescript/bin/tsc"),
      "-p",
      resolve(root, "packages/kit/test/tsconfig.core-host-public.json"),
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
