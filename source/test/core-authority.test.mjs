import assert from "node:assert/strict";
import test from "node:test";
import * as providerSession from "../scripts/lib/provider-session-conformance.mjs";

const CHAIN_A = "tbc:mainnet";
const CHAIN_B = "tbc:other";
const ACCOUNT_A = `${CHAIN_A}:1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH`;
const ACCOUNT_B = `${CHAIN_A}:1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP`;

const context = {
  sessionId: "session-transfer-1",
  transport: "webview",
  origin: "https://example.test",
  topOrigin: "https://example.test",
  frame: "top",
  navigationId: "nav-1",
  createdAt: "2026-08-31T12:00:00Z",
};

const session = {
  version: "1.0",
  scope: {
    walletProfile: "turing-wallet",
    sessionId: context.sessionId,
  },
  state: {
    version: "1.0",
    sessionId: context.sessionId,
    revision: "7",
    connected: true,
    activeChainId: CHAIN_A,
    activeAccountIds: [ACCOUNT_A],
  },
};

function withState(patch) {
  return {
    ...session,
    scope: { ...session.scope },
    state: { ...session.state, ...patch },
  };
}

test("classifies Provider authority drift before consuming an effect", () => {
  const classify = providerSession.classifyAuthorityChange;
  assert.equal(typeof classify, "function");

  assert.equal(classify(context, session, context, session), null);
  assert.equal(
    classify(context, session, context, withState({
      revision: "8",
      activeChainId: CHAIN_B,
      activeAccountIds: [`${CHAIN_B}:1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH`],
    })),
    "CHAIN_CHANGED",
  );
  assert.equal(
    classify(context, session, context, withState({
      revision: "8",
      activeAccountIds: [ACCOUNT_B],
    })),
    "ACCOUNT_CHANGED",
  );
  assert.equal(
    classify(context, session, context, withState({ revision: "8" })),
    "SESSION_REVOKED",
  );
  assert.equal(
    classify(context, session, { ...context, navigationId: "nav-2" }, session),
    "NAVIGATION_CHANGED",
  );
  assert.equal(
    classify(context, session, { ...context, origin: "https://other.test" }, session),
    "ORIGIN_CHANGED",
  );
});

test("rejects a malformed Provider Session snapshot", () => {
  const validate = providerSession.validateProviderSessionSnapshot;
  assert.equal(typeof validate, "function");
  assert.doesNotThrow(() => validate(session, context));
  assert.throws(
    () => validate(withState({ activeAccountIds: [ACCOUNT_B, ACCOUNT_A] }), context),
    /PROVIDER_SESSION_ACCOUNTS_NOT_SORTED/,
  );
  assert.throws(
    () => validate(withState({
      activeAccountIds: [`${CHAIN_B}:1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH`],
    }), context),
    /PROVIDER_SESSION_ACCOUNT_CHAIN_MISMATCH/,
  );
  assert.throws(
    () => validate({ ...session, scope: { ...session.scope, sessionId: "other" } }, context),
    /PROVIDER_SESSION_SCOPE_MISMATCH/,
  );
});
