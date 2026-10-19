import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as tws from "../dist/esm/index.js";

const provider = JSON.parse(
  await readFile(new URL("../../../test-vectors/provider.json", import.meta.url), "utf8"),
);
const currentContext = provider.trustedContexts[0].context;
const currentSession = provider.providerSessions.sessionA;
const startInput = {
  version: "1.0",
  release: tws.TWS_RELEASE,
  request: { jsonrpc: "2.0", id: "transition-1", method: "tbc_chainId" },
  currentContext,
  currentSession,
};

test("transition algebra rejects missing, unknown, late, and authority-invalid responses", async () => {
  const core = tws.createTwsCore();
  const waiting = await core.start(startInput);

  await assert.rejects(
    core.resume({
      version: "1.0",
      checkpoint: waiting.checkpoint,
      currentContext,
      currentSession,
    }),
    tws.TwsValidationError,
  );
  await assert.rejects(
    core.resume({
      version: "1.0",
      checkpoint: waiting.checkpoint,
      response: {
        version: "1.0",
        callId: "A".repeat(43),
        result: { now: "2026-09-01T08:00:00Z" },
      },
      currentContext,
      currentSession,
    }),
    (error) =>
      error instanceof tws.TwsStateError && error.code === "PORT_RESPONSE_NOT_PENDING",
  );
  await assert.rejects(
    core.resume({
      version: "1.0",
      checkpoint: waiting.checkpoint,
      response: {
        version: "1.0",
        callId: waiting.calls[0].callId,
        result: { now: "2026-09-01T08:00:00Z" },
      },
      currentContext: { ...currentContext, navigationId: "nav-other" },
      currentSession,
    }),
    (error) =>
      error instanceof tws.TwsAuthorityError &&
      error.reason === "NAVIGATION_CHANGED",
  );

  const continued = await core.resume({
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
  await assert.rejects(
    core.resume({
      version: "1.0",
      checkpoint: continued.checkpoint,
      response: {
        version: "1.0",
        callId: waiting.calls[0].callId,
        result: { now: "2026-09-01T08:00:00Z" },
      },
      currentContext,
      currentSession,
    }),
    tws.TwsValidationError,
  );
});

test("cancel creates a pre-clock terminal completion without fabricated authority", async () => {
  const core = tws.createTwsCore();
  const waiting = await core.start(startInput);
  const transition = await core.cancel({
    version: "1.0",
    checkpoint: waiting.checkpoint,
    reason: "TRANSPORT_CLOSED",
  });

  assert.equal(transition.kind, "complete");
  assert.equal(transition.checkpoint.payload.state, "cancelled");
  assert.equal(transition.checkpoint.payload.revision, "1");
  assert.equal("createdAt" in transition.checkpoint.payload, false);
  assert.deepEqual(transition.completion, {
    delivery: "suppress",
    cancellationReason: "TRANSPORT_CLOSED",
  });
  assert.equal(tws.isValidTws("coreTransition", transition), true);

  await assert.rejects(
    core.resume({
      version: "1.0",
      checkpoint: transition.checkpoint,
      currentContext,
      currentSession,
    }),
    (error) => error instanceof tws.TwsStateError && error.code === "TERMINAL_STATE",
  );
});

test("acknowledgeCommit refuses a checkpoint outside provider-session committing", async () => {
  const core = tws.createTwsCore();
  const waiting = await core.start(startInput);
  await assert.rejects(
    core.acknowledgeCommit({
      version: "1.0",
      checkpoint: waiting.checkpoint,
      acknowledgment: provider.providerSessions.commitAck,
      currentContext,
      currentSession,
    }),
    (error) => error instanceof tws.TwsStateError && error.code === "STATE_MISMATCH",
  );
});
