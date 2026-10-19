import {
  assertApprovalBinding,
  createApprovalBinding,
  type ApprovalReceipt,
} from "../bindings.js";
import { canonicalize } from "../canonical-json.js";
import type { OperationCheckpoint } from "../checkpoint.js";
import { base64Encode } from "../encoding.js";
import { TwsEngineError, TwsStateError } from "../errors.js";
import type { LegacyBitcoinMessageDigest } from "../engine.js";
import { hashCanonical } from "../hash.js";
import type { PortCall } from "../ports.js";
import { verifyTwsRecoverableSignature } from "../recoverable-signature.js";
import {
  canonicalSigningEnvelope,
  signingEnvelopeDigest,
  signingPayload,
} from "../signing-artifacts.js";
import {
  assertTbcSignInWalletContext,
  inspectTbcSignInMessage,
  type TbcSignInMessageFields,
} from "../sign-in.js";
import type { CoreTransition } from "../transitions.js";
import { completeTransition, waitingTransition } from "../transitions.js";
import { readApprovalDecision } from "./approval.js";
import { prepareApprovalWithMemory } from "./approval.js";
import {
  advance,
  completeError,
  completeSuccess,
  makeCalls,
  nextRevision,
  operationOf,
} from "./shared.js";

interface AccountIdentity {
  readonly address: string;
  readonly accountId: string;
  readonly chainId: string;
  readonly publicKey: string;
}

interface SigningTask {
  readonly taskId: string;
  readonly purpose: "message" | "typedData";
  readonly algorithm: "secp256k1-recoverable-ecdsa-sha256d";
  readonly digest: string;
  readonly signatureEncoding: "compact65-recoverable";
  readonly origin: string;
  readonly accountId: string;
  readonly publicKey: string;
}

const LEGACY_BITCOIN_CLIENT_REQUEST_ID =
  /^legacy-bitcoin:([0-9a-f]{64})$/u;

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function accountFromMemory(
  checkpoint: OperationCheckpoint,
  memory: Readonly<Record<string, unknown>> = checkpoint.payload.memory,
): AccountIdentity {
  const operation = operationOf(checkpoint);
  const request = operation.params as {
    readonly chainId: string;
    readonly from: string;
  };
  const resolutions = memory.accountResolutions as readonly {
    readonly result: { readonly accounts: readonly AccountIdentity[] };
  }[];
  const account = resolutions
    .flatMap(({ result }) => result.accounts)
    .find(
      (candidate) =>
        candidate.chainId === request.chainId &&
        candidate.address === request.from &&
        candidate.accountId === `${request.chainId}:${request.from}`,
    );
  if (account === undefined) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "message signing account resolution is missing",
    );
  }
  return account;
}

export function normalizeTypedDataTypes(
  types: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>,
) {
  return Object.fromEntries(
    Object.keys(types).sort().map((name) => [
      name,
      [...(types[name] ?? [])].sort((left, right) =>
        String(left.name).localeCompare(String(right.name), "en"),
      ),
    ]),
  );
}

function envelopeFor(
  checkpoint: OperationCheckpoint,
  account: AccountIdentity,
) {
  const operation = operationOf(checkpoint);
  const request = operation.params as {
    readonly chainId: string;
    readonly from: string;
    readonly message?: unknown;
    readonly data?: {
      readonly domain: Readonly<Record<string, unknown>>;
      readonly types: Readonly<
        Record<string, readonly Readonly<Record<string, unknown>>[]>
      >;
      readonly primaryType: string;
      readonly message: Readonly<Record<string, unknown>>;
    };
  };
  if (operation.method === "tbc_signMessage") {
    return Object.freeze({
      type: "tbc.message",
      version: "1.0",
      message: request.message,
    });
  }
  const data = request.data;
  const context = checkpoint.payload.context as { readonly origin: string };
  if (
    operation.method !== "tbc_signTypedData" ||
    data === undefined ||
    data.domain.chainId !== request.chainId ||
    (data.domain.origin !== undefined && data.domain.origin !== context.origin)
  ) {
    throw new TwsEngineError(
      "ENGINE_INPUT_INVALID",
      "typed-data domain differs from the trusted chain or origin",
    );
  }
  return Object.freeze({
    type: "tbc.typedData",
    version: "1.0",
    domain: Object.freeze({ ...data.domain }),
    types: normalizeTypedDataTypes(data.types),
    primaryType: data.primaryType,
    message: data.message,
  });
}

function previewFor(
  envelope: Readonly<Record<string, unknown>>,
  digest: string,
  signIn?: TbcSignInMessageFields,
) {
  if (envelope.type === "tbc.message") {
    return Object.freeze({
      operationKind: "message",
      scheme: "tbc-message",
      message: envelope.message,
      digest,
      warnings: Object.freeze([]),
      ...(signIn === undefined ? {} : { signIn }),
    });
  }
  return Object.freeze({
    operationKind: "typedData",
    scheme: "tbc-typed-data",
    domain: envelope.domain,
    types: envelope.types,
    primaryType: envelope.primaryType,
    message: envelope.message,
    digest,
    warnings: Object.freeze([]),
  });
}

function legacyBitcoinMarker(
  checkpoint: OperationCheckpoint,
): string | undefined {
  const operation = operationOf(checkpoint);
  if (operation.method !== "tbc_signMessage") return undefined;
  const params = operation.params as { readonly clientRequestId?: unknown };
  return typeof params.clientRequestId === "string"
    ? LEGACY_BITCOIN_CLIENT_REQUEST_ID.exec(params.clientRequestId)?.[1]
    : undefined;
}

function digestFor(
  checkpoint: OperationCheckpoint,
  envelope: Readonly<Record<string, unknown>>,
): Readonly<{ digest: string; legacyBitcoin: boolean }> {
  const marker = legacyBitcoinMarker(checkpoint);
  const canonical = signingEnvelopeDigest(envelope);
  if (marker === undefined) {
    return Object.freeze({
      digest: canonical,
      legacyBitcoin: false,
    });
  }
  const preview = checkpoint.payload.memory.approvalPreview as
    | { readonly digest?: unknown }
    | undefined;
  if (preview?.digest === canonical) {
    return Object.freeze({ digest: canonical, legacyBitcoin: false });
  }
  if (preview?.digest !== marker) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "Legacy Bitcoin message artifact differs from its request marker",
    );
  }
  return Object.freeze({ digest: marker, legacyBitcoin: true });
}

export async function beginMessageApproval(
  checkpoint: OperationCheckpoint,
  account: AccountIdentity,
  memory: Readonly<Record<string, unknown>>,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
): Promise<CoreTransition> {
  if (!sameJson(accountFromMemory(checkpoint, memory), account)) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "message account differs from the resolved account",
    );
  }
  const operation = operationOf(checkpoint);
  let envelope: Readonly<Record<string, unknown>>;
  try {
    envelope = envelopeFor(checkpoint, account);
  } catch (error) {
    if (
      operation.method === "tbc_signTypedData" &&
      error instanceof TwsEngineError &&
      error.code === "ENGINE_INPUT_INVALID"
    ) {
      return completeError(checkpoint, -32602, error.message, memory);
    }
    throw error;
  }
  let digest = signingEnvelopeDigest(envelope);
  let legacyBitcoin = false;
  let signIn: TbcSignInMessageFields | undefined;
  if (operation.method === "tbc_signMessage") {
    const request = operation.params as {
      readonly message: Readonly<{
        readonly encoding: "utf8" | "hex" | "base64";
        readonly data: string;
      }>;
    };
    try {
      signIn = inspectTbcSignInMessage(request.message);
      if (signIn !== undefined) {
        assertTbcSignInWalletContext(signIn, {
          origin: (checkpoint.payload.context as { readonly origin: string }).origin,
          chainId: account.chainId,
          address: account.address,
          now: String(checkpoint.payload.createdAt),
        });
      }
    } catch (error) {
      throw new TwsEngineError(
        "ENGINE_INPUT_INVALID",
        error instanceof Error ? error.message : "Invalid TBC Sign-In message",
      );
    }
    if (legacyBitcoinMessageDigest !== undefined) {
      const computed = await legacyBitcoinMessageDigest(Object.freeze({
        version: "1.0",
        requestId: checkpoint.payload.requestId as string | number,
        message: Object.freeze({ ...request.message }),
      }));
      if (computed !== undefined && !/^[0-9a-f]{64}$/u.test(computed)) {
        throw new TwsEngineError(
          "ENGINE_RESULT_INVALID",
          "Trusted Legacy Bitcoin message digest is invalid",
        );
      }
      if (computed !== undefined) {
        const marker = legacyBitcoinMarker(checkpoint);
        if (marker === undefined || computed !== marker) {
          throw new TwsEngineError(
            "ENGINE_ARTIFACT_MISMATCH",
            "Legacy Bitcoin message marker differs from the trusted computation",
          );
        }
        digest = computed;
        legacyBitcoin = true;
      }
    }
  }
  const context = checkpoint.payload.context as {
    readonly origin: string;
    readonly sessionId: string;
  };
  const requestHash = hashCanonical(operation.params);
  const binding = createApprovalBinding({
    version: "1.0",
    method: operation.method,
    operationKind: operation.method === "tbc_signMessage" ? "message" : "typedData",
    contextHash: checkpoint.payload.contextHash,
    origin: context.origin,
    sessionId: context.sessionId,
    chainId: account.chainId,
    accountId: account.accountId,
    requestHash,
    operationHash: digest,
    expiresAt: String(checkpoint.payload.expiresAt),
  });
  return prepareApprovalWithMemory(
    checkpoint,
    binding,
    previewFor(envelope, digest, signIn),
    operation.method === "tbc_signMessage"
      ? { ...memory, requestHash, messageEnvelope: envelope }
      : { ...memory, requestHash, typedDataEnvelope: envelope },
    legacyBitcoin ? digest : undefined,
  );
}

export function assertMessageApprovalArtifacts(
  checkpoint: OperationCheckpoint,
) {
  const operation = operationOf(checkpoint);
  const envelope = (
    operation.method === "tbc_signMessage"
      ? checkpoint.payload.memory.messageEnvelope
      : checkpoint.payload.memory.typedDataEnvelope
  ) as Readonly<Record<string, unknown>> | undefined;
  if (envelope === undefined) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "message signing envelope is missing",
    );
  }
  const account = accountFromMemory(checkpoint);
  const expected = envelopeFor(checkpoint, account);
  const requestHash = hashCanonical(operation.params);
  const selected = digestFor(checkpoint, envelope);
  const digest = selected.digest;
  const context = checkpoint.payload.context as {
    readonly origin: string;
    readonly sessionId: string;
  };
  if (
    !sameJson(envelope, expected) ||
    checkpoint.payload.memory.requestHash !== requestHash
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "message signing envelope differs from its trusted inputs",
    );
  }
  const expectedBinding = createApprovalBinding({
    version: "1.0",
    method: operation.method,
    operationKind: operation.method === "tbc_signMessage" ? "message" : "typedData",
    contextHash: checkpoint.payload.contextHash,
    origin: context.origin,
    sessionId: context.sessionId,
    chainId: account.chainId,
    accountId: account.accountId,
    requestHash,
    operationHash: digest,
    expiresAt: String(checkpoint.payload.expiresAt),
  });
  assertApprovalBinding(
    checkpoint.payload.memory.approvalBinding as typeof expectedBinding,
    expectedBinding.payload,
  );
  if (
    !sameJson(
      checkpoint.payload.memory.approvalPreview,
      previewFor(envelope, digest, operation.method === "tbc_signMessage"
        ? inspectTbcSignInMessage((operation.params as {
            readonly message: Readonly<{
              readonly encoding: "utf8" | "hex" | "base64";
              readonly data: string;
            }>;
          }).message)
        : undefined),
    )
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "message approval preview differs from the signing envelope",
    );
  }
  return {
    envelope,
    account,
    digest,
    legacyBitcoin: selected.legacyBitcoin,
    binding: expectedBinding,
  };
}

function rejection(checkpoint: OperationCheckpoint): CoreTransition {
  const completion = Object.freeze({
    delivery: "respond",
    response: {
      jsonrpc: "2.0",
      id: checkpoint.payload.requestId,
      error: { code: 4001, message: "User rejected the request" },
    },
    events: [],
  });
  const next = advance(checkpoint, {
    state: "rejected",
    pendingCalls: [],
    data: { cancellationReason: "USER_REJECTED" },
  });
  return completeTransition(next, completion);
}

export function reduceMessageApproval(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): CoreTransition {
  const artifacts = assertMessageApprovalArtifacts(checkpoint);
  const decision = readApprovalDecision(checkpoint, call, resultValue);
  if (decision.status === "rejected") return rejection(checkpoint);
  const purpose = operationOf(checkpoint).method === "tbc_signMessage"
    ? "message"
    : "typedData";
  const task = Object.freeze({
    taskId: purpose === "message"
      ? artifacts.legacyBitcoin
        ? "legacy-sign-message"
        : "sign-message"
      : "sign-typed-data",
    purpose,
    algorithm: "secp256k1-recoverable-ecdsa-sha256d",
    digest: artifacts.digest,
    signatureEncoding: "compact65-recoverable",
    origin: (checkpoint.payload.context as { readonly origin: string }).origin,
    accountId: artifacts.account.accountId,
    publicKey: artifacts.account.publicKey,
  }) as SigningTask;
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [
    { operation: "clock.now", params: { version: "1.0" } },
  ]);
  const next = advance(checkpoint, {
    state: "signing",
    expiresAt: decision.receipt.expiresAt,
    pendingCalls: calls,
    memory: {
      ...checkpoint.payload.memory,
      approvalReceipt: decision.receipt,
      signingTasks: Object.freeze([task]),
    },
    data: { approvalReceipt: decision.receipt, signingTask: task },
  });
  return waitingTransition(next);
}

export function assertRecoverableSignature(
  task: SigningTask,
  signatureHex: string,
): Uint8Array {
  try {
    return verifyTwsRecoverableSignature(
      signatureHex,
      task.digest,
      task.publicKey,
    );
  } catch {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "signer returned an invalid recoverable signature",
    );
  }
}

export function reduceMessageSigningResponse(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): CoreTransition {
  if (call.operation !== "signer.sign") {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "message signing reducer requires signer.sign",
    );
  }
  const artifacts = assertMessageApprovalArtifacts(checkpoint);
  const approval = checkpoint.payload.memory.approvalReceipt as ApprovalReceipt;
  const task = (checkpoint.payload.memory.signingTasks as readonly SigningTask[])[0];
  const params = call.params as {
    readonly version: "1.0";
    readonly approval: ApprovalReceipt;
    readonly task: SigningTask;
  };
  const result = resultValue as {
    readonly taskId: string;
    readonly signatureEncoding: string;
    readonly signature: string;
  };
  if (
    task === undefined ||
    !sameJson(params, { version: "1.0", approval, task }) ||
    result.taskId !== task.taskId ||
    result.signatureEncoding !== task.signatureEncoding ||
    task.digest !== artifacts.digest ||
    task.accountId !== artifacts.account.accountId ||
    task.publicKey !== artifacts.account.publicKey
  ) {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "message signer result differs from its approved task",
    );
  }
  const recoverable = assertRecoverableSignature(task, result.signature);
  const providerResult = Object.freeze({
    version: "1.0",
    scheme: artifacts.legacyBitcoin
      ? "legacy-bitcoin-message"
      : task.purpose === "message"
        ? "tbc-message"
        : "tbc-typed-data",
    algorithm: task.algorithm,
    address: artifacts.account.address,
    accountId: artifacts.account.accountId,
    publicKey: artifacts.account.publicKey,
    envelope: artifacts.envelope,
    canonical: canonicalSigningEnvelope(artifacts.envelope),
    ...(!artifacts.legacyBitcoin
      ? { signingPayload: base64Encode(signingPayload(artifacts.envelope)) }
      : {}),
    digest: artifacts.digest,
    signature: base64Encode(recoverable),
  });
  return completeSuccess(checkpoint, providerResult, {
    ...checkpoint.payload.memory,
    signatures: Object.freeze([resultValue]),
  });
}
