import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("packaged frontend/backend example signs, consumes once, rejects replay, and binds the address", async () => {
  const { stdout, stderr } = await execute(
    process.execPath,
    [new URL("../examples/sign-in/run.mjs", import.meta.url).pathname],
    { timeout: 30_000 },
  );
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    status: "pass",
    standardMessage: "tbc-message",
    typedData: "tbc-typed-data",
    signInProviderRequests: 1,
    challengeState: "consumed",
    replay: "rejected",
    sessionCreatedBy: "backend",
    mismatchedKeyChallengeState: "issued",
  });
});
