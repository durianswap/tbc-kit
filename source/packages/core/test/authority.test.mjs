import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as core from "../dist/esm/index.js";

const provider = JSON.parse(
  await readFile(new URL("../../../test-vectors/provider.json", import.meta.url), "utf8"),
);
const expectedContext = provider.trustedContexts[0].context;
const expectedSession = provider.providerSessions.sessionA;

const changed = (value, mutate) => {
  const clone = structuredClone(value);
  mutate(clone);
  return clone;
};

test("authority comparison applies the frozen fail-closed precedence", () => {
  assert.equal(
    core.classifyAuthorityChange(
      expectedContext,
      expectedSession,
      expectedContext,
      expectedSession,
    ),
    null,
  );

  const cases = [
    [
      "SESSION_REVOKED",
      changed(expectedContext, (context) => {
        context.sessionId = "different-session";
        context.origin = "https://other.example";
      }),
      expectedSession,
    ],
    [
      "SESSION_REVOKED",
      expectedContext,
      changed(expectedSession, (session) => {
        session.scope.walletProfile = "other-wallet";
      }),
    ],
    [
      "SESSION_REVOKED",
      expectedContext,
      changed(expectedSession, (session) => {
        session.state.connected = false;
      }),
    ],
    [
      "ORIGIN_CHANGED",
      changed(expectedContext, (context) => {
        context.origin = "https://other.example";
        context.topOrigin = "https://other.example";
      }),
      expectedSession,
    ],
    [
      "NAVIGATION_CHANGED",
      changed(expectedContext, (context) => {
        context.navigationId = "nav-2";
      }),
      expectedSession,
    ],
    [
      "CHAIN_CHANGED",
      expectedContext,
      changed(expectedSession, (session) => {
        session.state.activeChainId = provider.providerSessions.chainB;
        session.state.activeAccountIds = [];
      }),
    ],
    [
      "ACCOUNT_CHANGED",
      expectedContext,
      changed(expectedSession, (session) => {
        session.state.activeAccountIds = [];
      }),
    ],
    [
      "SESSION_REVOKED",
      expectedContext,
      changed(expectedSession, (session) => {
        session.state.revision = "1";
      }),
    ],
  ];

  for (const [reason, currentContext, currentSession] of cases) {
    assert.equal(
      core.classifyAuthorityChange(
        expectedContext,
        expectedSession,
        currentContext,
        currentSession,
      ),
      reason,
    );
    assert.throws(
      () =>
        core.assertAuthorityUnchanged(
          expectedContext,
          expectedSession,
          currentContext,
          currentSession,
        ),
      (error) => error instanceof core.TwsAuthorityError && error.reason === reason,
      reason,
    );
  }
});

test("authority validation rejects invalid session/account relationships", () => {
  const crossChain = changed(expectedSession, (session) => {
    session.state.activeAccountIds = [
      `${provider.providerSessions.chainB}:1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH`,
    ];
  });
  assert.throws(
    () => core.validateAuthoritySnapshot(expectedContext, crossChain),
    (error) => error instanceof core.TwsAuthorityError && error.code === "AUTHORITY_INVALID",
  );
});

test("commit acknowledgment authority must equal the mutation target", () => {
  const mutation = provider.providerSessions.switchA;
  const acknowledgment = provider.providerSessions.commitAck;
  const committedSession = {
    version: "1.0",
    scope: expectedSession.scope,
    state: mutation.payload.target,
  };
  assert.doesNotThrow(() =>
    core.assertProviderCommitAcknowledgment(
      mutation,
      acknowledgment,
      committedSession,
    ),
  );

  assert.throws(
    () =>
      core.assertProviderCommitAcknowledgment(
        mutation,
        { ...acknowledgment, revision: "2" },
        committedSession,
      ),
    (error) => error instanceof core.TwsAuthorityError && error.code === "COMMIT_ACK_MISMATCH",
  );
  assert.throws(
    () =>
      core.assertProviderCommitAcknowledgment(
        mutation,
        acknowledgment,
        expectedSession,
      ),
    (error) => error instanceof core.TwsAuthorityError && error.code === "COMMIT_AUTHORITY_MISMATCH",
  );
});
