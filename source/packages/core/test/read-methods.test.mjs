import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as tws from "../dist/esm/index.js";

const provider = JSON.parse(
  await readFile(new URL("../../../test-vectors/provider.json", import.meta.url), "utf8"),
);
const integration = JSON.parse(
  await readFile(new URL("../../../test-vectors/integration.json", import.meta.url), "utf8"),
);
const permissions = JSON.parse(
  await readFile(new URL("../../../test-vectors/permissions.json", import.meta.url), "utf8"),
);

const context = provider.trustedContexts[0].context;
const session = provider.providerSessions.sessionA;
const mainnet = session.state.activeChainId;
const testnet = "tbc:testnet";
const account = integration.portData.accountsResult.accounts[0];
const validPermission = permissions.result[0];
const metadataPermission = {
  ...validPermission,
  id: "permission-account-metadata",
  parentCapability: "tbc_accountMetadata",
  caveats: validPermission.caveats.map((caveat) =>
    caveat.type === "restrictMethods"
      ? { ...caveat, value: ["tbc_accountMetadata"] }
      : caveat,
  ),
};
const expiredPermission = {
  ...validPermission,
  id: "permission-expired",
  caveats: [
    ...validPermission.caveats,
    { type: "expiresAt", value: "2026-08-31T23:59:59Z" },
  ],
};

function startInput(id, method, params) {
  return {
    version: "1.0",
    release: tws.TWS_RELEASE,
    request: {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    },
    currentContext: context,
    currentSession: session,
  };
}

function responseFor(call, permissionByChain = {}) {
  if (call.operation === "clock.now") {
    return { now: "2026-09-01T08:00:00Z" };
  }
  if (call.operation === "permissionStore.load") {
    return {
      revision: "0",
      permissions: permissionByChain[call.params.scope.chainId] ?? [],
    };
  }
  if (call.operation === "accounts.resolve") {
    return {
      accounts: call.params.accountIds.includes(account.accountId) ? [account] : [],
    };
  }
  throw new Error(`unexpected Port operation: ${call.operation}`);
}

async function drive(
  method,
  params,
  permissionByChain = {},
  id = method,
  dependencies = {},
) {
  const core = tws.createTwsCore(dependencies);
  const trace = [];
  let transition = await core.start(startInput(id, method, params));
  while (transition.kind !== "complete") {
    trace.push(transition);
    if (transition.kind === "continue") {
      transition = await core.resume({
        version: "1.0",
        checkpoint: transition.checkpoint,
        currentContext: context,
        currentSession: session,
      });
      continue;
    }
    assert.equal(transition.kind, "waiting");
    const call = transition.calls.at(-1);
    transition = await core.resume({
      version: "1.0",
      checkpoint: transition.checkpoint,
      response: {
        version: "1.0",
        callId: call.callId,
        result: responseFor(call, permissionByChain),
      },
      currentContext: context,
      currentSession: session,
    });
  }
  trace.push(transition);
  return { transition, trace };
}

function resultOf(transition) {
  return transition.completion.response.result;
}

test("read methods use the active TBC session and never request privileged effects", async () => {
  const chain = await drive("tbc_chainId");
  assert.equal(resultOf(chain.transition), mainnet);
  assert.deepEqual(
    chain.trace.map(({ checkpoint }) => checkpoint.payload.state),
    ["initializing", "validating", "completed"],
  );

  const allowed = { [mainnet]: [expiredPermission, validPermission], [testnet]: [] };
  const listed = await drive("wallet_getPermissions", undefined, allowed);
  assert.deepEqual(resultOf(listed.transition), [validPermission]);
  assert.deepEqual(
    listed.trace.flatMap((item) => item.kind === "waiting" ? item.calls : [])
      .map(({ operation }) => operation),
    ["clock.now", "permissionStore.load", "permissionStore.load", "permissionStore.load"],
  );

  const accounts = await drive("tbc_accounts", undefined, allowed);
  assert.deepEqual(resultOf(accounts.transition), [account.address]);
  assert.deepEqual(
    accounts.trace.map(({ checkpoint }) => checkpoint.payload.state),
    ["initializing", "validating", "authorizing", "resolving", "completed"],
  );
  const operations = accounts.trace.flatMap((item) =>
    item.kind === "waiting" ? item.calls.map(({ operation }) => operation) : [],
  );
  assert.deepEqual(operations, ["clock.now", "permissionStore.load", "accounts.resolve"]);
  assert.equal(operations.includes("approval.request"), false);
  assert.equal(operations.includes("signer.sign"), false);
  assert.equal(operations.includes("broadcast.submit"), false);
});

test("account reads filter permissions, select the first authorized account, and allow empty lists", async () => {
  const allowed = { [mainnet]: [validPermission] };
  const empty = await drive("tbc_accounts", undefined, {});
  assert.deepEqual(resultOf(empty.transition), []);
  assert.equal(
    empty.trace.some((item) => item.kind === "waiting" && item.calls.some((call) => call.operation === "accounts.resolve")),
    false,
  );

  const selected = await drive(
    "tbc_getAccount",
    {},
    { [mainnet]: [validPermission, metadataPermission] },
  );
  assert.deepEqual(resultOf(selected.transition), {
    ...account,
    features: ["tbc:provider"],
  });

  const unauthorized = await drive(
    "tbc_getAccount",
    { address: "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP" },
    { [mainnet]: [validPermission, metadataPermission] },
  );
  assert.equal(unauthorized.transition.checkpoint.payload.state, "failed");
  assert.equal(unauthorized.transition.completion.response.error.code, 4100);
});

test("capabilities are chain-scoped, transport-scoped, and do not shrink with permissions", async () => {
  const capabilities = await drive("tbc_getCapabilities", {}, {});
  assert.deepEqual(resultOf(capabilities.transition), provider.capabilities);
  assert.equal(resultOf(capabilities.transition).chainId, mainnet);
  assert.deepEqual(resultOf(capabilities.transition).profiles, ["core", "transport:webview"]);

  const otherChain = await drive("tbc_getCapabilities", { chainId: testnet }, {});
  assert.equal(resultOf(otherChain.transition).chainId, testnet);
  assert.deepEqual(resultOf(otherChain.transition).methods, provider.capabilities.methods);

  const unauthorized = await drive(
    "tbc_getCapabilities",
    { chainId: mainnet, address: account.address },
    {},
  );
  assert.equal(unauthorized.transition.checkpoint.payload.state, "failed");
  assert.equal(unauthorized.transition.completion.response.error.code, 4100);
});

test("trusted wallet capability scopes override the conservative default by chain and account", async () => {
  const walletIntents = [
    "tbc721.transfer",
    "tbc20.transfer",
    "tbc20Stablecoin.transfer",
    "tbc.transfer",
    "tbc.maintenance.merge",
    "tbc.nft.transfer",
    "tbc.ft.transfer",
    "tbc.ft.merge",
    "tbc20-standard-create",
    "tbc721-standard-create-collection",
    "tbc721-standard-mint",
    "tbc.stablecoin.transfer",
    "tbc.stablecoin.merge",
    "tbc.pool.liquidity.add",
    "tbc.pool.liquidity.remove",
    "tbc.pool.ft.merge",
    "tbc.pool.ftlp.merge",
    "tbc.pool.ftlp.burn",
    "tbc.pool.swap.exactTbcForToken",
    "tbc.pool.swap.exactTokenForTbc",
  ];
  const dependencies = {
    capabilities: {
      version: "1.0",
      scopes: [
        {
          chainId: mainnet,
          intents: walletIntents,
          profiles: ["core", "assets"],
        },
        {
          chainId: mainnet,
          accountId: account.accountId,
          intents: ["tbc.transfer"],
          profiles: ["core"],
          limits: { workflowSteps: 2, transactionBundleSize: 4 },
        },
      ],
    },
  };
  const chain = await drive(
    "tbc_getCapabilities",
    {},
    {},
    "configured-chain-capabilities",
    dependencies,
  );
  assert.deepEqual(Object.keys(resultOf(chain.transition).intents), walletIntents);
  assert.deepEqual(resultOf(chain.transition).profiles, [
    "core",
    "assets",
    "transport:webview",
  ]);

  const scoped = await drive(
    "tbc_getCapabilities",
    { chainId: mainnet, address: account.address },
    { [mainnet]: [validPermission] },
    "configured-account-capabilities",
    dependencies,
  );
  assert.deepEqual(resultOf(scoped.transition).intents, {
    "tbc.transfer": ["1.0"],
  });
  assert.deepEqual(resultOf(scoped.transition).limits, {
    workflowSteps: 2,
    transactionBundleSize: 4,
  });
  assert.deepEqual(resultOf(scoped.transition).profiles, [
    "core",
    "transport:webview",
  ]);
});

test("wallet capability configuration rejects inflated profiles and ambiguous scopes", () => {
  assert.throws(
    () => tws.createTwsCore({
      capabilities: {
        version: "1.0",
        scopes: [{
          chainId: mainnet,
          intents: ["tbc.transfer"],
          profiles: ["core", "assets"],
        }],
      },
    }),
    /profiles exceed their declared intents/,
  );
  assert.throws(
    () => tws.createTwsCore({
      capabilities: {
        version: "1.0",
        scopes: [
          { chainId: mainnet, intents: ["tbc.transfer"], profiles: ["core"] },
          { chainId: mainnet, intents: ["tbc.transfer"], profiles: ["core"] },
        ],
      },
    }),
    /Duplicate wallet capability scope/,
  );
});

test("parallel permission loads preserve every unconsumed call byte-for-byte", async () => {
  const core = tws.createTwsCore();
  const first = await core.start(startInput("parallel-permissions", "wallet_getPermissions"));
  const validating = await core.resume({
    version: "1.0",
    checkpoint: first.checkpoint,
    response: {
      version: "1.0",
      callId: first.calls[0].callId,
      result: { now: "2026-09-01T08:00:00Z" },
    },
    currentContext: context,
    currentSession: session,
  });
  const waiting = await core.resume({
    version: "1.0",
    checkpoint: validating.checkpoint,
    currentContext: context,
    currentSession: session,
  });
  assert.equal(waiting.kind, "waiting");
  assert.equal(waiting.calls.length, 2);
  const [unconsumed, consumed] = waiting.calls;
  const consumedResponse = {
    version: "1.0",
    callId: consumed.callId,
    result: responseFor(consumed),
  };
  const remaining = await core.resume({
    version: "1.0",
    checkpoint: waiting.checkpoint,
    response: consumedResponse,
    currentContext: context,
    currentSession: session,
  });
  assert.equal(remaining.kind, "waiting");
  assert.deepEqual(remaining.calls, [unconsumed]);
  assert.deepEqual(remaining.checkpoint.payload.pendingCalls, [unconsumed]);
  assert.deepEqual(tws.verifyCheckpoint(remaining.checkpoint), remaining.checkpoint);

  await assert.rejects(
    core.resume({
      version: "1.0",
      checkpoint: remaining.checkpoint,
      response: consumedResponse,
      currentContext: context,
      currentSession: session,
    }),
    (error) =>
      error instanceof tws.TwsStateError && error.code === "PORT_RESPONSE_NOT_PENDING",
  );
});

test("authority is revalidated before an account Port response is interpreted", async () => {
  const core = tws.createTwsCore();
  let transition = await core.start(startInput("authority-read", "tbc_accounts"));
  while (
    transition.kind !== "waiting" ||
    transition.calls[0].operation !== "accounts.resolve"
  ) {
    if (transition.kind === "continue") {
      transition = await core.resume({
        version: "1.0",
        checkpoint: transition.checkpoint,
        currentContext: context,
        currentSession: session,
      });
    } else {
      const call = transition.calls[0];
      transition = await core.resume({
        version: "1.0",
        checkpoint: transition.checkpoint,
        response: {
          version: "1.0",
          callId: call.callId,
          result: responseFor(call, { [mainnet]: [validPermission] }),
        },
        currentContext: context,
        currentSession: session,
      });
    }
  }

  const call = transition.calls[0];
  await assert.rejects(
    core.resume({
      version: "1.0",
      checkpoint: transition.checkpoint,
      response: {
        version: "1.0",
        callId: call.callId,
        result: responseFor(call),
      },
      currentContext: context,
      currentSession: {
        ...session,
        state: { ...session.state, revision: "1" },
      },
    }),
    (error) => error instanceof tws.TwsAuthorityError && error.reason === "SESSION_REVOKED",
  );
});
