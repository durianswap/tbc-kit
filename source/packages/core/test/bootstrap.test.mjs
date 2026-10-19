import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as tws from "../dist/esm/index.js";

const provider = JSON.parse(
  await readFile(new URL("../../../test-vectors/provider.json", import.meta.url), "utf8"),
);
const currentContext = provider.trustedContexts[0].context;
const currentSession = provider.providerSessions.sessionA;
const input = {
  version: "1.0",
  release: tws.TWS_RELEASE,
  request: { jsonrpc: "2.0", id: "bootstrap-1", method: "tbc_chainId" },
  currentContext,
  currentSession,
};

test("bootstrap start is deterministic and waits only for trusted clock", async () => {
  const core = tws.createTwsCore();
  assert.deepEqual(Object.keys(core), ["start", "resume", "acknowledgeCommit", "cancel"]);
  assert.deepEqual(tws.TWS_TRANSITION_KINDS, ["continue", "waiting", "commit", "complete"]);

  const originalNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => {
    throw new Error("ambient clock used");
  };
  Math.random = () => {
    throw new Error("ambient entropy used");
  };
  let first;
  try {
    first = await core.start(input);
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }
  const second = await core.start(structuredClone(input));

  assert.deepEqual(first, second);
  assert.equal(first.kind, "waiting");
  assert.equal(first.checkpoint.payload.state, "initializing");
  assert.equal(first.checkpoint.payload.revision, "0");
  assert.deepEqual(first.checkpoint.payload.operation, {
    method: "tbc_chainId",
    params: [],
  });
  assert.deepEqual(first.calls, first.checkpoint.payload.pendingCalls);
  assert.deepEqual(first.calls.map((call) => call.operation), ["clock.now"]);
  assert.deepEqual(first.calls[0].params, { version: "1.0" });
  assert.deepEqual(tws.verifyCheckpoint(first.checkpoint), first.checkpoint);
  assert.equal(tws.isValidTws("coreTransition", first), true);
});

test("bootstrap clock response creates the first self-contained continue checkpoint", async () => {
  const core = tws.createTwsCore();
  const waiting = await core.start(input);
  const transition = await core.resume({
    version: "1.0",
    checkpoint: waiting.checkpoint,
    response: {
      version: "1.0",
      callId: waiting.calls[0].callId,
      result: { now: "2026-09-01T08:00:00Z" },
    },
    currentContext,
    currentSession,
  });

  assert.equal(transition.kind, "continue");
  assert.equal(transition.checkpoint.payload.state, "validating");
  assert.equal(transition.checkpoint.payload.revision, "1");
  assert.equal(
    transition.checkpoint.payload.previousCheckpointHash,
    waiting.checkpoint.checkpointHash,
  );
  assert.equal(transition.checkpoint.payload.createdAt, "2026-09-01T08:00:00Z");
  assert.equal(transition.checkpoint.payload.updatedAt, "2026-09-01T08:00:00Z");
  assert.equal(transition.checkpoint.payload.expiresAt, "2026-09-01T08:05:00.000Z");
  assert.deepEqual(transition.checkpoint.payload.memory, {
    trustedTime: "2026-09-01T08:00:00Z",
  });
  assert.deepEqual(transition.checkpoint.payload.data, {
    trustedTime: "2026-09-01T08:00:00Z",
  });
  assert.deepEqual(transition.checkpoint.payload.pendingCalls, []);
  assert.equal(tws.isValidTws("coreTransition", transition), true);
});
