import { assertValidTws, base64Decode, canonicalize, hashCanonical } from "@tbc-wallet/core";

import { normalizeLegacyAssociatedTransactionRequest } from "./legacy-associated-transaction.js";
import {
  normalizeLegacyRawTransactionRequest,
  normalizeLegacyRawTransactionResult,
  type LegacyRawTransactionResult,
} from "./legacy-generic-capabilities.js";
import {
  normalizeLegacyGenericBatchRequests,
  type LegacyGenericBatchRequest,
} from "./legacy-generic-batch.js";
import type { TbcProviderEvent } from "./provider-transport.js";
import type {
  TbcReviewedTransactionInput,
  TbcWorkflowRequest,
  TbcWorkflowStep,
} from "./prepared.js";
import type { KitSupportedIntent, KitTransactionRequest } from "./public-types.js";
import type {
  StandardApprovalPreparationHandle,
  StandardApprovalPreparationStart,
} from "./standard-approval-preparation.js";

type LegacyWorkflowDelivery = Readonly<{
  deliveryId: string;
  response: unknown;
  events: readonly unknown[];
}>;

export type LegacyStandardWorkflowContext = Readonly<{
  origin: string;
  chainId: string;
  sessionId: string;
  navigationId: string;
}>;

export interface LegacyStandardWorkflowBatchAdapter {
  /** Optional capability probe; omission means the adapter accepts all secure methods. */
  readonly supports?: (
    method:
      | "signTransaction"
      | "signAssociatedTransaction"
      | "encrypt"
      | "decrypt"
      | "sendBatchRequest",
  ) => boolean;
  readonly execute: (input: Readonly<{
    requestId: string;
    requests: unknown;
    context: LegacyStandardWorkflowContext;
  }>) => Promise<Readonly<{
    deliveryId: string;
    results: readonly unknown[];
    events: readonly TbcProviderEvent[];
  }>>;
}

export interface LegacyStandardWorkflowBatchOptions {
  readonly chainId: string;
  /** Immutable trusted WebView/session binding for this adapter instance. */
  readonly context: LegacyStandardWorkflowContext;
  readonly readAccount: () => Promise<Readonly<{ address: string; accountId: string }>>;
  /** Shared Legacy transaction mapper only; execution remains inside the standard workflow. */
  readonly resolveSendTransaction: (input: Readonly<{
    params: unknown;
    chainId: string;
    from: string;
  }>) => Promise<KitTransactionRequest<KitSupportedIntent>>;
  /** Canonical shared lifecycle; Legacy only maps and forwards the opaque handle. */
  readonly beginApprovalPreparation?: (
    input: StandardApprovalPreparationStart,
  ) => StandardApprovalPreparationHandle;
  readonly executeWorkflow: (request: Readonly<{
    id: string | number;
    method: "tbc_signWorkflow";
    params: TbcWorkflowRequest;
    approvalPreparation?: StandardApprovalPreparationHandle;
  }>) => Promise<LegacyWorkflowDelivery>;
  /** Independent single-operation route; it must not synthesize a workflow. */
  readonly executeAction: (request: Readonly<{
    id: string | number;
    method: "tbc_signReviewedTransaction" | "tbc_encrypt" | "tbc_decrypt";
    params: unknown;
    approvalPreparation?: StandardApprovalPreparationHandle;
  }>) => Promise<LegacyWorkflowDelivery>;
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  if (Reflect.ownKeys(value).some((key) =>
    typeof key !== "string" || !allowed.includes(key)
  )) {
    throw new TypeError(`Unsupported Legacy ${label} field`);
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Invalid Legacy ${label}`);
  }
  return value;
}

function atomicValue(value: unknown, label: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)) return value;
  throw new TypeError(`Invalid Legacy ${label}`);
}

function signingProfile(value: unknown): "p2pkh" | "ft" | "ft-contract" | "contract-template" {
  if (value === "p2pkh") return "p2pkh";
  if (value === "tbc20") return "ft";
  if (value === "tbc20_contract") return "ft-contract";
  if (value === "other") return "contract-template";
  throw new TypeError("Unsupported Legacy associated signing type");
}

function associatedInput(value: unknown): Readonly<Record<string, unknown>> {
  if (!plainRecord(value)) throw new TypeError("Invalid Legacy associated input");
  assertExactKeys(value, [
    "txId",
    "outputIndex",
    "satoshis",
    "script",
    "scriptSigType",
    "preTx",
    "prePreTxData",
    "contractTx",
    "ftVersion",
    "unfinishedScriptSig",
  ], "associated input");
  const optional = (legacy: string, standard: string, normalize: (item: unknown) => unknown) =>
    Object.hasOwn(value, legacy) ? { [standard]: normalize(Reflect.get(value, legacy)) } : {};
  const outputIndex = Reflect.get(value, "outputIndex");
  if (!Number.isSafeInteger(outputIndex) || Number(outputIndex) < 0) {
    throw new TypeError("Invalid Legacy associated output index");
  }
  return Object.freeze({
    ...optional("txId", "txid", (item) => stringValue(item, "associated txid").toLowerCase()),
    outputIndex,
    ...optional("satoshis", "satoshis", (item) => atomicValue(item, "associated value")),
    ...optional("script", "scriptPubKey", (item) => stringValue(item, "associated script")),
    signingProfile: signingProfile(Reflect.get(value, "scriptSigType")),
    ...optional("preTx", "previousTransaction", (item) => stringValue(item, "previous transaction")),
    ...optional("prePreTxData", "previousOutputContext", (item) => stringValue(item, "previous output context")),
    ...optional("contractTx", "contractTransaction", (item) => stringValue(item, "contract transaction")),
    ...optional("ftVersion", "contractVersion", (item) => {
      if (!Number.isInteger(item) || Number(item) < 1 || Number(item) > 3) {
        throw new TypeError("Invalid Legacy contract version");
      }
      return item;
    }),
    ...optional("unfinishedScriptSig", "unlockingScriptTemplate", (item) =>
      stringValue(item, "unlocking script template")),
  });
}

export function mapLegacyRawTransactionToReviewed(
  input: unknown,
): TbcReviewedTransactionInput {
  const request = normalizeLegacyRawTransactionRequest(input);
  return Object.freeze({
    payload: Object.freeze({
      format: "raw" as const,
      transactions: Object.freeze(request.txraws.map((rawTransaction, index) =>
        Object.freeze({
          rawTransaction,
          inputs: Object.freeze(request.utxos_satoshis[index]!.map((satoshis, inputIndex) =>
            Object.freeze({
              satoshis: String(satoshis),
              scriptPubKey: request.script_pubkeys[index]![inputIndex]!,
            }))),
        })
      )),
    }),
  });
}

export function mapLegacyAssociatedTransactionToReviewed(
  input: unknown,
): TbcReviewedTransactionInput {
  const request = normalizeLegacyAssociatedTransactionRequest(input);
  assertExactKeys(request, ["sourceTxraw", "sourceUtxos", "inputs", "outputs"], "associated request");
  const sourceUtxos = Reflect.get(request, "sourceUtxos");
  const inputs = Reflect.get(request, "inputs") ?? [];
  const outputs = Reflect.get(request, "outputs") ?? [];
  if (!Array.isArray(sourceUtxos) || !Array.isArray(inputs) || !Array.isArray(outputs)) {
    throw new TypeError("Invalid Legacy associated transaction matrix");
  }
  return Object.freeze({
    payload: Object.freeze({
      format: "associated" as const,
      sourceTransaction: stringValue(Reflect.get(request, "sourceTxraw"), "source transaction"),
      sourceInputs: Object.freeze(sourceUtxos.map(associatedInput)),
      children: Object.freeze(inputs.map((row, index) => {
        const outputRow = outputs[index];
        if (!Array.isArray(row) || !Array.isArray(outputRow)) {
          throw new TypeError("Invalid Legacy associated transaction row");
        }
        return Object.freeze({
          inputs: Object.freeze(row.map(associatedInput)),
          outputs: Object.freeze(outputRow.map((value) => {
            if (!plainRecord(value)) throw new TypeError("Invalid Legacy associated output");
            assertExactKeys(value, ["satoshis", "script"], "associated output");
            return Object.freeze({
              satoshis: atomicValue(Reflect.get(value, "satoshis"), "associated output value"),
              scriptPubKey: stringValue(Reflect.get(value, "script"), "associated output script"),
            });
          })),
        });
      })),
    }),
  });
}

function messageParams(params: unknown): Readonly<{ message: string; encoding: "utf8" | "hex" | "base64" }> {
  if (!plainRecord(params)) throw new TypeError("Invalid Legacy signMessage request");
  const encoding = Reflect.get(params, "encoding") === "utf-8"
    ? "utf8"
    : Reflect.get(params, "encoding");
  if (encoding !== "utf8" && encoding !== "hex" && encoding !== "base64") {
    throw new TypeError("Invalid Legacy signMessage encoding");
  }
  return Object.freeze({
    message: stringValue(Reflect.get(params, "message"), "signMessage message"),
    encoding,
  });
}

function cryptoMessage(params: unknown, field: "message" | "encryptedMessage"): string {
  if (!plainRecord(params)) throw new TypeError("Invalid Legacy crypto request");
  return stringValue(Reflect.get(params, field), `crypto ${field}`);
}

async function workflowStep(
  request: LegacyGenericBatchRequest,
  index: number,
  options: LegacyStandardWorkflowBatchOptions,
  from: string,
): Promise<TbcWorkflowStep> {
  const id = `legacy-${String(index + 1)}`;
  if (request.method === "sendTransaction") {
    const transaction = clone(await options.resolveSendTransaction({
      params: request.params,
      chainId: options.chainId,
      from,
    }));
    assertValidTws("transactionRequest", transaction);
    if (transaction.chainId !== options.chainId || transaction.from !== from) {
      throw new TypeError("Legacy transaction mapper changed the bound account or chain");
    }
    return Object.freeze({
      id,
      kind: "transaction" as const,
      dependsOn: Object.freeze([]),
      intent: transaction.intent,
      ...(transaction.constraints === undefined ? {} : { constraints: transaction.constraints }),
    });
  }
  if (request.method === "signTransaction") {
    return Object.freeze({
      id,
      kind: "reviewedTransaction" as const,
      dependsOn: Object.freeze([]),
      request: mapLegacyRawTransactionToReviewed(request.params),
    });
  }
  if (request.method === "signAssociatedTransaction") {
    return Object.freeze({
      id,
      kind: "reviewedTransaction" as const,
      dependsOn: Object.freeze([]),
      request: mapLegacyAssociatedTransactionToReviewed(request.params),
    });
  }
  if (request.method === "signMessage") {
    const message = messageParams(request.params);
    const sourceId = `legacy-${String(index)}`;
    return Object.freeze({
      id,
      kind: "message" as const,
      dependsOn: request.dependsOn === undefined ? Object.freeze([]) : Object.freeze([sourceId]),
      message: Object.freeze({ encoding: message.encoding, data: message.message }),
      ...(request.dependsOn === undefined
        ? {}
        : {
            bindings: Object.freeze([Object.freeze({
              target: request.dependsOn,
              source: Object.freeze({ stepId: sourceId, output: "transactionIds" as const }),
            })]),
          }),
    });
  }
  if (request.method === "encrypt") {
    return Object.freeze({
      id,
      kind: "encrypt" as const,
      dependsOn: Object.freeze([]),
      algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1" as const,
      message: Object.freeze({ encoding: "utf8" as const, data: cryptoMessage(request.params, "message") }),
    });
  }
  return Object.freeze({
    id,
    kind: "decrypt" as const,
    dependsOn: Object.freeze([]),
    algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1" as const,
    ciphertext: cryptoMessage(request.params, "encryptedMessage"),
  });
}

async function mapNormalizedLegacyGenericBatchToWorkflow(
  requests: readonly LegacyGenericBatchRequest[],
  options: LegacyStandardWorkflowBatchOptions,
): Promise<TbcWorkflowRequest> {
  const account = await options.readAccount();
  if (account.accountId !== `${options.chainId}:${account.address}`) {
    throw new TypeError("Legacy workflow account identity mismatch");
  }
  // The Legacy grammar permits dependencies only for message result binding.
  // Mapping is read-only, so independent translation may overlap while
  // Promise.all preserves the exact source order.
  const steps: readonly TbcWorkflowStep[] = await Promise.all(
    requests.map((request, index) =>
      workflowStep(request, index, options, account.address)
    ),
  );
  const firstIntent = steps[0]?.kind === "transaction" ? steps[0].intent : undefined;
  const migratedFeeCap = requests.length === 2 &&
    requests[0]?.method === "sendTransaction" &&
    requests[1]?.method === "signMessage" &&
    requests[1]?.dependsOn !== undefined
    ? firstIntent?.type === "tbc.transfer"
      ? "1000"
      : firstIntent?.type === "tbc.ft.transfer"
        ? "10000"
        : undefined
    : undefined;
  const workflow: TbcWorkflowRequest = Object.freeze({
    version: "1.0",
    chainId: options.chainId as `tbc:${string}`,
    from: account.address,
    failureMode: "continue-independent",
    ...(migratedFeeCap === undefined ? {} : { maxTotalFee: migratedFeeCap }),
    steps: Object.freeze(steps),
  });
  assertValidTws("workflowRequest", workflow);
  return workflow;
}

export async function mapLegacyGenericBatchToWorkflow(
  input: unknown,
  options: LegacyStandardWorkflowBatchOptions,
): Promise<TbcWorkflowRequest> {
  return mapNormalizedLegacyGenericBatchToWorkflow(
    normalizeLegacyGenericBatchRequests(input),
    options,
  );
}

function transactionRaws(result: unknown): readonly string[] {
  if (!plainRecord(result) || !Array.isArray(Reflect.get(result, "transactions"))) {
    throw new Error("Invalid standard workflow transaction result");
  }
  const raws = (Reflect.get(result, "transactions") as readonly unknown[]).map((value) => {
    if (!plainRecord(value)) throw new Error("Invalid standard workflow transaction result");
    return stringValue(Reflect.get(value, "rawTransaction"), "workflow raw transaction");
  });
  return Object.freeze(raws);
}

function decodeMessage(value: unknown): string {
  if (!plainRecord(value)) throw new Error("Invalid standard workflow crypto message");
  const encoding = Reflect.get(value, "encoding");
  const data = stringValue(Reflect.get(value, "data"), "workflow crypto message");
  if (encoding === "utf8") return data;
  if (encoding === "hex") {
    const bytes = new Uint8Array(data.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(data.slice(index * 2, index * 2 + 2), 16);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (encoding === "base64") {
    return new TextDecoder("utf-8", { fatal: true }).decode(base64Decode(data));
  }
  throw new Error("Invalid standard workflow crypto message");
}

function legacyResult(request: LegacyGenericBatchRequest, step: unknown): unknown {
  if (!plainRecord(step)) throw new Error("Invalid standard workflow step result");
  if (Reflect.get(step, "status") === "failed" || Reflect.get(step, "status") === "skipped") {
    const error = Reflect.get(step, "error");
    return Object.freeze({
      error: Reflect.get(step, "status") === "skipped"
        ? "Previous request failed or produced no txids"
        : plainRecord(error) && typeof Reflect.get(error, "message") === "string"
          ? Reflect.get(error, "message")
          : "Workflow step failed",
    });
  }
  const result = Reflect.get(step, "result");
  if (request.method === "sendTransaction") {
    const raws = transactionRaws(result);
    return Object.freeze({ txraw: raws.join(",") });
  }
  if (request.method === "signAssociatedTransaction") {
    return Object.freeze({ txraws: transactionRaws(result) });
  }
  if (request.method === "signTransaction") {
    if (!plainRecord(result)) throw new Error("Invalid standard raw signing result");
    const signatures = Reflect.get(result, "detachedSignatures");
    const rawRequest = normalizeLegacyRawTransactionRequest(request.params);
    return normalizeLegacyRawTransactionResult({ sigs: signatures }, rawRequest);
  }
  if (request.method === "signMessage") {
    if (!plainRecord(result) || !plainRecord(Reflect.get(result, "envelope"))) {
      throw new Error("Invalid standard workflow message result");
    }
    const envelope = Reflect.get(result, "envelope") as Readonly<Record<string, unknown>>;
    const message = Reflect.get(envelope, "message");
    return Object.freeze({
      address: Reflect.get(result, "address"),
      maddress: Reflect.get(result, "address"),
      pubkey: Reflect.get(result, "publicKey"),
      pubKey: Reflect.get(result, "publicKey"),
      message: plainRecord(message) ? Reflect.get(message, "data") : undefined,
      sig: Reflect.get(result, "signature"),
    });
  }
  if (request.method === "encrypt") {
    if (!plainRecord(result)) throw new Error("Invalid standard workflow encrypt result");
    return Object.freeze({ encryptedMessage: Reflect.get(result, "ciphertext") });
  }
  if (!plainRecord(result)) throw new Error("Invalid standard workflow decrypt result");
  return Object.freeze({ decryptedMessage: decodeMessage(Reflect.get(result, "message")) });
}

async function standaloneAction(
  request: LegacyGenericBatchRequest,
  options: LegacyStandardWorkflowBatchOptions,
): Promise<Readonly<{
  method: "tbc_signReviewedTransaction" | "tbc_encrypt" | "tbc_decrypt";
  params: Readonly<Record<string, unknown>>;
}>> {
  const account = await options.readAccount();
  if (account.accountId !== `${options.chainId}:${account.address}`) {
    throw new TypeError("Legacy action account identity mismatch");
  }
  const common = Object.freeze({
    version: "1.0" as const,
    chainId: options.chainId,
    from: account.address,
  });
  if (request.method === "signTransaction") {
    return Object.freeze({
      method: "tbc_signReviewedTransaction" as const,
      params: Object.freeze({ ...common, request: mapLegacyRawTransactionToReviewed(request.params) }),
    });
  }
  if (request.method === "signAssociatedTransaction") {
    return Object.freeze({
      method: "tbc_signReviewedTransaction" as const,
      params: Object.freeze({ ...common, request: mapLegacyAssociatedTransactionToReviewed(request.params) }),
    });
  }
  if (request.method === "encrypt") {
    return Object.freeze({
      method: "tbc_encrypt" as const,
      params: Object.freeze({
        ...common,
        algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1" as const,
        message: Object.freeze({ encoding: "utf8" as const, data: cryptoMessage(request.params, "message") }),
      }),
    });
  }
  if (request.method === "decrypt") {
    return Object.freeze({
      method: "tbc_decrypt" as const,
      params: Object.freeze({
        ...common,
        algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1" as const,
        ciphertext: cryptoMessage(request.params, "encryptedMessage"),
      }),
    });
  }
  throw new TypeError("Legacy standalone action is unsupported");
}

function standaloneLegacyResult(request: LegacyGenericBatchRequest, result: unknown): unknown {
  if (!plainRecord(result)) throw new Error("Invalid standard wallet action result");
  if (request.method === "signTransaction") {
    return normalizeLegacyRawTransactionResult(
      { sigs: Reflect.get(result, "detachedSignatures") },
      normalizeLegacyRawTransactionRequest(request.params),
    );
  }
  if (request.method === "signAssociatedTransaction") {
    return Object.freeze({ txraws: transactionRaws(result) });
  }
  if (request.method === "encrypt") {
    return Object.freeze({ encryptedMessage: Reflect.get(result, "ciphertext") });
  }
  if (request.method === "decrypt") {
    return Object.freeze({ decryptedMessage: decodeMessage(Reflect.get(result, "message")) });
  }
  throw new TypeError("Legacy standalone action is unsupported");
}

export function createLegacyStandardWorkflowBatchAdapter(
  options: LegacyStandardWorkflowBatchOptions,
): LegacyStandardWorkflowBatchAdapter {
  if (
    options === null ||
    typeof options !== "object" ||
    !plainRecord(options.context) ||
    typeof options.readAccount !== "function" ||
    typeof options.resolveSendTransaction !== "function" ||
    (options.beginApprovalPreparation !== undefined &&
      typeof options.beginApprovalPreparation !== "function") ||
    typeof options.executeWorkflow !== "function" ||
    typeof options.executeAction !== "function"
  ) {
    throw new TypeError("Legacy standard workflow batch dependencies are required");
  }
  return Object.freeze({
    async execute(input: Parameters<LegacyStandardWorkflowBatchAdapter["execute"]>[0]) {
      if (
        typeof input.requestId !== "string" ||
        input.requestId.length === 0 ||
        canonicalize(input.context) !== canonicalize(options.context)
      ) {
        throw new Error("Legacy standard workflow session changed");
      }
      const requests = normalizeLegacyGenericBatchRequests(input.requests);
      if (input.context.chainId !== options.chainId) {
        throw new Error("Legacy standard workflow network changed");
      }
      const workflowRequestId = hashCanonical(Object.freeze({
        version: "1.0" as const,
        route: "legacy-standard-workflow" as const,
        context: input.context,
        requestId: input.requestId,
      }));
      const preparationStart = {
        requestId: workflowRequestId,
        requestCount: requests.length,
        inputHash: hashCanonical(Object.freeze({
          version: "1.0" as const,
          context: input.context,
          requests,
        })),
      };
      if (
        requests.length === 1 &&
        (requests[0]!.method === "signTransaction" ||
          requests[0]!.method === "signAssociatedTransaction" ||
          requests[0]!.method === "encrypt" ||
          requests[0]!.method === "decrypt")
      ) {
        const action = await standaloneAction(requests[0]!, options);
        const approvalPreparation = options.beginApprovalPreparation?.({
          ...preparationStart,
          method: action.method,
        });
        try {
          const delivery = await options.executeAction({
            id: workflowRequestId,
            method: action.method,
            params: Object.freeze({
              ...action.params,
              clientRequestId: `legacy-standard:${workflowRequestId}`,
            }),
            ...(approvalPreparation === undefined ? {} : { approvalPreparation }),
          });
          if (!/^[0-9a-f]{64}$/u.test(delivery.deliveryId)) {
            throw new Error("Invalid standard wallet action delivery identity");
          }
          if (!plainRecord(delivery.response)) throw new Error("Invalid standard wallet action delivery");
          const responseError = Reflect.get(delivery.response, "error");
          if (responseError !== undefined) {
            const code = plainRecord(responseError) ? Reflect.get(responseError, "code") : undefined;
            const message = code === 4001
              ? "User cancelled the batch request"
              : plainRecord(responseError) && typeof Reflect.get(responseError, "message") === "string"
                ? String(Reflect.get(responseError, "message"))
                : "Legacy standard wallet action failed";
            return Object.freeze({
              deliveryId: delivery.deliveryId,
              results: Object.freeze([Object.freeze({ error: message })]),
              events: Object.freeze(delivery.events.map((event) => event as TbcProviderEvent)),
            });
          }
          return Object.freeze({
            deliveryId: delivery.deliveryId,
            results: Object.freeze([standaloneLegacyResult(
              requests[0]!,
              Reflect.get(delivery.response, "result"),
            )]),
            events: Object.freeze(delivery.events.map((event) => event as TbcProviderEvent)),
          });
        } catch (error) {
          approvalPreparation?.cancel("failed");
          throw error;
        }
      }
      const approvalPreparation = options.beginApprovalPreparation?.({
        ...preparationStart,
        method: "tbc_signWorkflow",
      });
      try {
        const mapped = await mapNormalizedLegacyGenericBatchToWorkflow(requests, options);
        const workflow = Object.freeze({
          ...mapped,
          clientRequestId: `legacy-standard:${workflowRequestId}`,
        });
        assertValidTws("workflowRequest", workflow);
        const delivery = await options.executeWorkflow({
          id: workflowRequestId,
          method: "tbc_signWorkflow",
          params: workflow,
          ...(approvalPreparation === undefined ? {} : { approvalPreparation }),
        });
        if (!/^[0-9a-f]{64}$/u.test(delivery.deliveryId)) {
          throw new Error("Invalid standard workflow delivery identity");
        }
        if (!plainRecord(delivery.response)) throw new Error("Invalid standard workflow delivery");
        const responseError = Reflect.get(delivery.response, "error");
        if (responseError !== undefined) {
          const code = plainRecord(responseError) ? Reflect.get(responseError, "code") : undefined;
          const message = code === 4001
            ? "User cancelled the batch request"
            : plainRecord(responseError) && typeof Reflect.get(responseError, "message") === "string"
              ? String(Reflect.get(responseError, "message"))
              : "Legacy standard workflow failed";
          return Object.freeze({
            deliveryId: delivery.deliveryId,
            results: Object.freeze(requests.map(() => Object.freeze({ error: message }))),
            events: Object.freeze(delivery.events.map((event) => event as TbcProviderEvent)),
          });
        }
        const result = Reflect.get(delivery.response, "result");
        if (!plainRecord(result) || !Array.isArray(Reflect.get(result, "steps"))) {
          throw new Error("Invalid standard workflow result");
        }
        const steps = Reflect.get(result, "steps") as readonly unknown[];
        if (steps.length !== requests.length) throw new Error("Standard workflow result length mismatch");
        return Object.freeze({
          deliveryId: delivery.deliveryId,
          results: Object.freeze(requests.map((request, index) => legacyResult(request, steps[index]))),
          events: Object.freeze(delivery.events.map((event) => event as TbcProviderEvent)),
        });
      } catch (error) {
        approvalPreparation?.cancel("failed");
        throw error;
      }
    },
  });
}
