import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { materializeCheckpoints } from "../../../scripts/lib/lifecycle-conformance.mjs";
import * as core from "../dist/esm/index.js";

const [lifecycle, states] = await Promise.all([
  readFile(new URL("../../../test-vectors/checkpoints.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../../../registry/operation-states.json", import.meta.url), "utf8").then(JSON.parse),
]);
const checkpoint = materializeCheckpoints(lifecycle).find(
  (entry) => entry.id === "authorizing",
).checkpoint;

test("cancellation mapping covers all eleven frozen reasons", () => {
  assert.equal(states.cancellationReasons.length, 11);
  for (const expected of states.cancellationReasons) {
    assert.deepEqual(core.cancellationPolicy(expected.reason, true), {
      terminalState: expected.terminalState,
      delivery: expected.delivery === "conditional" ? "respond" : expected.delivery,
      providerCode: expected.providerCode,
      executionErrorName: expected.executionErrorName,
      retryable: expected.retryable,
    });
    if (expected.delivery === "conditional") {
      assert.deepEqual(core.cancellationPolicy(expected.reason, false), {
        terminalState: expected.terminalState,
        delivery: "suppress",
        providerCode: null,
        executionErrorName: null,
        retryable: expected.retryable,
      });
    }
  }
});

test("cancellation completion never invents a response for an unreachable channel", () => {
  assert.deepEqual(core.providerCompletionForCancellation("REQUEST_ABORTED", "rpc-1", true), {
    delivery: "suppress",
    cancellationReason: "REQUEST_ABORTED",
  });
  assert.deepEqual(core.providerCompletionForCancellation("SESSION_REVOKED", "rpc-1", false), {
    delivery: "suppress",
    cancellationReason: "SESSION_REVOKED",
  });

  const expired = core.providerCompletionForCancellation("REQUEST_EXPIRED", "rpc-1", true);
  assert.equal(expired.delivery, "respond");
  assert.equal(expired.response.id, "rpc-1");
  assert.equal(expired.response.error.code, -32000);
  assert.deepEqual(expired.response.error.data, {
    name: "REQUEST_EXPIRED",
    stage: "validation",
    retryable: false,
  });
  assert.deepEqual(expired.events, []);
});

test("cancel authority is optional only when the reason itself proves it unavailable", () => {
  const optionalReasons = [
    "REQUEST_ABORTED",
    "TRANSPORT_CLOSED",
    "PROTOCOL_RELEASE_CHANGED",
  ];
  for (const reason of optionalReasons) {
    assert.equal(core.isCancelAuthorityOptional(reason), true);
    assert.equal(
      core.isValidTws("cancelInput", {
        version: "1.0",
        checkpoint,
        reason,
      }),
      true,
      reason,
    );
  }

  for (const reason of ["USER_REJECTED", "CHAIN_CHANGED", "REQUEST_EXPIRED"]) {
    assert.equal(core.isCancelAuthorityOptional(reason), false);
    assert.equal(
      core.isValidTws("cancelInput", {
        version: "1.0",
        checkpoint,
        reason,
      }),
      false,
      reason,
    );
  }
});
