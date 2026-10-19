import {
  advanceCheckpoint,
  type OperationCheckpoint,
  type OperationCheckpointPayload,
} from "../checkpoint.js";
import {
  createPortCall,
  type PortCall,
  type PortOperation,
  type PortOperationMap,
} from "../ports.js";
import {
  completeTransition,
  type CoreTransition,
} from "../transitions.js";

export const TWS_CHAIN_IDS = Object.freeze([
  "tbc:mainnet",
  "tbc:testnet",
] as const);

export interface ProviderSessionView {
  readonly state: {
    readonly connected: boolean;
    readonly activeChainId: string;
    readonly activeAccountIds: readonly string[];
  };
}

export interface TrustedContextView {
  readonly origin: string;
  readonly transport: "webview" | "extension" | "remote";
}

export function nextRevision(checkpoint: OperationCheckpoint): string {
  return String(BigInt(checkpoint.payload.revision) + 1n);
}

export function earliestExpiry(
  ...timestamps: readonly (string | undefined)[]
): string {
  const defined = timestamps.filter((value): value is string => value !== undefined);
  if (defined.length === 0) {
    throw new TypeError("at least one expiry timestamp is required");
  }
  return defined.reduce((left, right) =>
    Date.parse(left) <= Date.parse(right) ? left : right,
  );
}

export function makeCalls(
  checkpoint: OperationCheckpoint,
  revision: string,
  effects: readonly { readonly operation: string; readonly params: unknown }[],
): readonly PortCall[] {
  return Object.freeze(
    effects.map((effect, effectOrdinal) =>
      createPortCall({
        operationId: checkpoint.payload.operationId,
        checkpointRevision: revision,
        effectOrdinal,
        operation: effect.operation as PortOperation,
        params: effect.params as PortOperationMap[PortOperation]["params"],
      }),
    ),
  );
}

export function advance(
  checkpoint: OperationCheckpoint,
  changes: Readonly<Record<string, unknown>>,
): OperationCheckpoint {
  return advanceCheckpoint(checkpoint, {
    ...checkpoint.payload,
    revision: nextRevision(checkpoint),
    previousCheckpointHash: checkpoint.checkpointHash,
    ...changes,
  } as OperationCheckpointPayload);
}

function completion(
  checkpoint: OperationCheckpoint,
  resultOrError: { readonly result: unknown } | { readonly error: unknown },
  events: readonly Readonly<{ readonly name: string; readonly payload: unknown }>[] =
    Object.freeze([]),
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    delivery: "respond",
    response: {
      jsonrpc: "2.0",
      id: checkpoint.payload.requestId,
      ...resultOrError,
    },
    events,
  });
}

export function completeSuccess(
  checkpoint: OperationCheckpoint,
  result: unknown,
  memory: Readonly<Record<string, unknown>> = checkpoint.payload.memory,
  events: readonly Readonly<{ readonly name: string; readonly payload: unknown }>[] =
    Object.freeze([]),
): CoreTransition {
  const providerCompletion = completion(checkpoint, { result }, events);
  const next = advance(checkpoint, {
    state: "completed",
    pendingCalls: [],
    memory: { ...memory, providerCompletion },
    data: { providerCompletion },
  });
  return completeTransition(next, providerCompletion);
}

export function completeError(
  checkpoint: OperationCheckpoint,
  code: number,
  message: string,
  memory: Readonly<Record<string, unknown>> = checkpoint.payload.memory,
  errorData?: Readonly<Record<string, unknown>>,
): CoreTransition {
  const providerError = { code, message, ...(errorData === undefined ? {} : { data: errorData }) };
  const providerCompletion = completion(checkpoint, { error: providerError });
  const next = advance(checkpoint, {
    state: "failed",
    pendingCalls: [],
    memory,
    data: { providerError },
  });
  return completeTransition(next, providerCompletion);
}

export function operationOf(
  checkpoint: OperationCheckpoint,
): { readonly method: string; readonly params: unknown } {
  return checkpoint.payload.operation as {
    readonly method: string;
    readonly params: unknown;
  };
}
