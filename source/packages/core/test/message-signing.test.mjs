import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as tws from "../dist/esm/index.js";

const provider = JSON.parse(
  await readFile(new URL("../../../test-vectors/provider.json", import.meta.url), "utf8"),
);
const signing = JSON.parse(
  await readFile(new URL("../../../test-vectors/signing.json", import.meta.url), "utf8"),
);
const session = provider.providerSessions.sessionA;
const baseContext = provider.trustedContexts[0].context;
const CHAIN_ID = "tbc:mainnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 1 : 0);

function originFor(vector) {
  return vector.method === "tbc_signMessage"
    ? "https://example.test"
    : vector.result.envelope.domain.origin;
}

function requestFor(vector) {
  const envelope = vector.result.envelope;
  if (vector.method === "tbc_signMessage") {
    return {
      version: "1.0",
      chainId: CHAIN_ID,
      from: vector.result.address,
      message: envelope.message,
    };
  }
  return {
    version: "1.0",
    chainId: CHAIN_ID,
    from: vector.result.address,
    data: {
      domain: envelope.domain,
      types: envelope.types,
      primaryType: envelope.primaryType,
      message: envelope.message,
    },
  };
}

function permission(name, vector) {
  return {
    id: `permission-${name}`,
    parentCapability: name,
    invoker: originFor(vector),
    date: Date.parse("2026-08-31T11:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [CHAIN_ID] },
      { type: "restrictAccounts", value: [vector.result.accountId] },
      { type: "restrictMethods", value: [name] },
    ],
  };
}

async function drive(vector, options = {}) {
  const context = {
    ...baseContext,
    origin: originFor(vector),
    topOrigin: originFor(vector),
  };
  const core = options.core ?? tws.createTwsCore(options.dependencies);
  const ports = [];
  const checkpoints = [];
  const clocks = [
    "2026-08-31T12:00:00Z",
    "2026-08-31T12:00:05Z",
    "2026-08-31T12:00:11Z",
  ];
  const request = requestFor(vector);
  const params = (
    options.domainOrigin === undefined && options.domainChainId === undefined
  ) || request.data === undefined
    ? request
    : {
        ...request,
        data: {
          ...request.data,
          domain: {
            ...request.data.domain,
            ...(options.domainOrigin === undefined
              ? {}
              : { origin: options.domainOrigin }),
            ...(options.domainChainId === undefined
              ? {}
              : { chainId: options.domainChainId }),
          },
        },
      };
  let transition = await core.start({
    version: "1.0",
    release: tws.TWS_RELEASE,
    request: {
      jsonrpc: "2.0",
      id: `message-${vector.id}`,
      method: vector.method,
      params: {
        ...params,
        ...(options.clientRequestId === undefined
          ? {}
          : { clientRequestId: options.clientRequestId }),
      },
    },
    currentContext: context,
    currentSession: session,
  });
  for (let steps = 0; transition.kind !== "complete"; steps += 1) {
    assert.ok(steps < 20, "message signing did not terminate");
    checkpoints.push(transition.checkpoint);
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
    const call = transition.calls[0];
    ports.push(structuredClone(call));
    let result;
    if (call.operation === "clock.now") {
      result = { now: clocks.shift() };
    } else if (call.operation === "permissionStore.load") {
      result = {
        revision: "0",
        permissions: [
          permission("tbc_accounts", vector),
          permission(vector.method, vector),
        ],
      };
    } else if (call.operation === "accounts.resolve") {
      result = {
        accounts: [{
          address: vector.result.address,
          accountId: vector.result.accountId,
          chainId: CHAIN_ID,
          publicKey: vector.result.publicKey,
        }],
      };
    } else if (call.operation === "approval.request") {
      result = {
        status: "approved",
        approvalId: `approval-${vector.id}`,
        approvalToken: `approval-token-${vector.id}`,
        bindingHash: call.params.binding.bindingHash,
        approvedAt: "2026-08-31T12:00:10Z",
        expiresAt: call.params.binding.payload.expiresAt,
      };
    } else if (call.operation === "signer.sign") {
      const signature = options.scalar === undefined
        ? Buffer.from(vector.result.signature, "base64").toString("hex")
        : (() => {
            const signed = secp256k1.sign(call.params.task.digest, options.scalar, {
              prehash: false,
              lowS: true,
            });
            return `${(31 + signed.recovery).toString(16)}${signed.toCompactHex()}`;
          })();
      result = {
        taskId: call.params.task.taskId,
        signatureEncoding: "compact65-recoverable",
        signature: options.invalidSignature
          ? `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`
          : signature,
      };
    } else {
      throw new Error(`unexpected operation ${call.operation}`);
    }
    const response = {
      version: "1.0",
      callId: call.callId,
      result,
    };
    const checkpoint = options.tamperCheckpoint?.(transition.checkpoint, call) ??
      transition.checkpoint;
    transition = await core.resume({
      version: "1.0",
      checkpoint,
      response,
      currentContext: context,
      currentSession: session,
    });
  }
  checkpoints.push(transition.checkpoint);
  return { transition, ports, checkpoints };
}

test("typed-data domain mismatch returns Invalid Params without closing the session", async () => {
  const vector = signing.vectors.find(({ method }) => method === "tbc_signTypedData");
  assert.ok(vector);
  const core = tws.createTwsCore();
  for (const mismatch of [
    { domainOrigin: "https://evil.test" },
    { domainChainId: "tbc:testnet" },
  ]) {
    const invalid = await drive(vector, { core, ...mismatch });
    assert.deepEqual(invalid.transition.completion.response.error, {
      code: -32602,
      message: "typed-data domain differs from the trusted chain or origin",
    });
    assert.deepEqual(invalid.transition.completion.events, []);
    assert.equal(
      invalid.ports.some(({ operation }) =>
        ["approval.request", "signer.sign", "broadcast.submit"].includes(operation)
      ),
      false,
    );
  }

  const valid = await drive(vector, { core });
  assert.equal(valid.transition.completion.response.result.digest, vector.result.digest);
  assert.deepEqual(
    valid.ports.filter(({ operation }) =>
      ["approval.request", "signer.sign"].includes(operation)
    ).map(({ operation }) => operation),
    ["approval.request", "signer.sign"],
  );
});

test("typed-data artifact mismatch remains a fatal internal integrity error", async () => {
  const vector = signing.vectors.find(({ method }) => method === "tbc_signTypedData");
  assert.ok(vector);
  await assert.rejects(
    drive(vector, {
      tamperCheckpoint(checkpoint, call) {
        if (call.operation !== "approval.request") return checkpoint;
        const tampered = structuredClone(checkpoint);
        tampered.payload.memory.typedDataEnvelope = {
          ...tampered.payload.memory.typedDataEnvelope,
          message: {
            ...tampered.payload.memory.typedDataEnvelope.message,
            amount: "1000001",
          },
        };
        tampered.checkpointHash = tws.hashCanonical(tampered.payload);
        return tampered;
      },
    }),
    (error) =>
      error instanceof tws.TwsEngineError &&
      error.code === "ENGINE_ARTIFACT_MISMATCH",
  );
});

for (const vector of signing.vectors) {
  test(`message signing reproduces ${vector.id} after approval`, async () => {
    const result = await drive(vector);
    assert.deepEqual(result.transition.completion.response.result, vector.result);
    assert.equal(
      result.ports.some(({ operation }) =>
        ["chainData.resolve", "policy.resolve", "broadcast.submit"].includes(operation),
      ),
      false,
    );
    assert.deepEqual(
      result.ports.filter(({ operation }) =>
        ["approval.request", "signer.sign"].includes(operation),
      ).map(({ operation }) => operation),
      ["approval.request", "signer.sign"],
    );
    const envelope = result.checkpoints.find(
      ({ payload }) =>
        payload.memory.messageEnvelope !== undefined ||
        payload.memory.typedDataEnvelope !== undefined,
    );
    assert.ok(envelope);
    assert.equal(
      envelope.payload.memory.approvalBinding.payload.operationHash,
      vector.result.digest,
    );
    const approval = result.ports.find(({ operation }) =>
      operation === "approval.request"
    );
    assert.equal(
      approval.params.preview.scheme,
      vector.method === "tbc_signMessage" ? "tbc-message" : "tbc-typed-data",
    );
  });
}

test("readable-chain vectors preserve plain-message bytes and bind the new typed-data network domain", () => {
  assert.deepEqual(
    signing.vectors.map(({ magic, payloadHex, result }) => ({
      magic,
      payloadHexSha256: createHash("sha256").update(payloadHex).digest("hex"),
      signingPayloadSha256: createHash("sha256")
        .update(result.signingPayload)
        .digest("hex"),
      digest: result.digest,
    })),
    [
      {
        magic: "TBC Signed Message:\n",
        payloadHexSha256: "12dfdc6ff71f6d4fbabdffc9753e0226ea0f0ee2a48b68aab4241f7b76b01a2b",
        signingPayloadSha256: "b305579b1decc11d4e8d6b207f85d55da39b02d08aa377ec765e0b8f6d348f3b",
        digest: "9452bf3a7862e15fef3720c927acf0be51a6f53513bb1f6f3870fdeead113eb4",
      },
      {
        magic: "TBC Signed Typed Data:\n",
        payloadHexSha256: "d3bd8ebb775aa0c2099c51394d084d84cca803933870e2bd3898c88931dba992",
        signingPayloadSha256: "9c1ebcf4b9c6f94c3abf1ade23a73a73695d91b3f989ede1b248b06ce3e90d7e",
        digest: "f1f7a18c429e124ae6e67c40d611dfb1dcccfdf3160dc77000924c4e1c0945f8",
      },
    ],
  );
});

test("message signing rejects a recoverable signature that does not verify", async () => {
  await assert.rejects(
    drive(signing.vectors[0], { invalidSignature: true }),
    (error) =>
      error instanceof tws.TwsStateError && error.code === "PORT_RESULT_INVALID",
  );
});

test("wallet-trusted Legacy Bitcoin digest binds approval, Signer, and result", async () => {
  const digest = "dcbe45621b28154774991a549de8cd58c72ed87bc7d04e0688e80047071259ab";
  const scalar = Uint8Array.from({ length: 32 }, (_, index) =>
    index === 31 ? 1 : 0,
  );
  const vector = structuredClone(
    signing.vectors.find(({ method }) => method === "tbc_signMessage"),
  );
  assert.ok(vector);
  vector.result.publicKey = Buffer.from(
    secp256k1.getPublicKey(scalar, true),
  ).toString("hex");
  const calls = [];
  const result = await drive(vector, {
    clientRequestId: `legacy-bitcoin:${digest}`,
    scalar,
    dependencies: {
      legacyBitcoinMessageDigest: async (input) => {
        calls.push(structuredClone(input));
        return digest;
      },
    },
  });
  assert.deepEqual(calls, [{
    version: "1.0",
    requestId: `message-${vector.id}`,
    message: vector.result.envelope.message,
  }]);
  const approval = result.ports.find(({ operation }) =>
    operation === "approval.request"
  );
  const signer = result.ports.find(({ operation }) => operation === "signer.sign");
  assert.equal(approval.params.binding.payload.operationHash, digest);
  assert.equal(approval.params.preview.scheme, "tbc-message");
  assert.equal(approval.params.preview.digest, digest);
  assert.equal(signer.params.task.taskId, "legacy-sign-message");
  assert.equal(signer.params.task.digest, digest);
  assert.equal(result.transition.completion.response.result.digest, digest);
  assert.equal(result.transition.completion.response.result.scheme, "legacy-bitcoin-message");
  assert.equal("signingPayload" in result.transition.completion.response.result, false);
});

test("Legacy Bitcoin marker remains Standard when no trusted route selects it", async () => {
  const vector = signing.vectors.find(({ method }) => method === "tbc_signMessage");
  assert.ok(vector);
  const digest = "dcbe45621b28154774991a549de8cd58c72ed87bc7d04e0688e80047071259ab";
  const standard = await drive(vector, {
    clientRequestId: `legacy-bitcoin:${digest}`,
  });
  const standardSigner = standard.ports.find(
    ({ operation }) => operation === "signer.sign",
  );
  assert.equal(standardSigner.params.task.taskId, "sign-message");
  assert.notEqual(standardSigner.params.task.digest, digest);
});

test("Legacy Bitcoin trusted route rejects a digest mismatch", async () => {
  const vector = signing.vectors.find(({ method }) => method === "tbc_signMessage");
  assert.ok(vector);
  const digest = "dcbe45621b28154774991a549de8cd58c72ed87bc7d04e0688e80047071259ab";
  await assert.rejects(
    drive(vector, {
      clientRequestId: `legacy-bitcoin:${digest}`,
      dependencies: {
        legacyBitcoinMessageDigest: async () => "00".repeat(32),
      },
    }),
    /differs from the trusted computation/,
  );
});

test("utf8, hex, and base64 representations of the same bytes have one digest", () => {
  const text = "Hello, TBC!";
  const messages = [
    { encoding: "utf8", data: text },
    { encoding: "hex", data: Buffer.from(text).toString("hex") },
    { encoding: "base64", data: Buffer.from(text).toString("base64") },
  ];
  const digests = messages.map((message) => tws.signingEnvelopeDigest({
    type: "tbc.message",
    version: "1.0",
    message,
  }));
  assert.equal(new Set(digests).size, 1);
  assert.equal(digests[0], signing.vectors[0].result.digest);
  assert.throws(
    () => tws.decodeSigningMessage({ encoding: "base64", data: "SGVsbG8" }),
    /canonical/,
  );
});

test("wallet recognizes canonical sign-in messages in every supported encoding", async () => {
  const text = tws.serializeTbcSignInMessage({
    domain: "example.test",
    uri: "https://example.test/login",
    address: ADDRESS,
    chainId: CHAIN_ID,
    nonce: "backend_challenge_1234",
    issuedAt: "2026-08-31T11:59:00Z",
    expirationTime: "2026-08-31T12:05:00Z",
  });
  const encoded = [
    { encoding: "utf8", data: text },
    { encoding: "hex", data: Buffer.from(text).toString("hex") },
    { encoding: "base64", data: Buffer.from(text).toString("base64") },
  ];
  for (const message of encoded) {
    const vector = structuredClone(signing.vectors[0]);
    vector.result.envelope.message = message;
    const result = await drive(vector, { scalar: PRIVATE_KEY });
    const approval = result.ports.find(({ operation }) => operation === "approval.request");
    assert.equal(approval.params.preview.signIn.nonce, "backend_challenge_1234");
  }
});

test("wallet rejects a marked sign-in message whose trusted origin differs", async () => {
  const vector = structuredClone(signing.vectors[0]);
  vector.result.envelope.message = {
    encoding: "utf8",
    data: tws.serializeTbcSignInMessage({
      domain: "evil.test",
      uri: "https://evil.test/login",
      address: ADDRESS,
      chainId: CHAIN_ID,
      nonce: "backend_challenge_1234",
      issuedAt: "2026-08-31T11:59:00Z",
      expirationTime: "2026-08-31T12:05:00Z",
    }),
  };
  await assert.rejects(
    drive(vector, { scalar: PRIVATE_KEY }),
    (error) => error instanceof tws.TwsEngineError && error.code === "ENGINE_INPUT_INVALID",
  );
});
