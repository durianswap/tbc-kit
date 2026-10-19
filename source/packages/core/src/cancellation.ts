export type CancellationReason =
  | "USER_REJECTED"
  | "REQUEST_ABORTED"
  | "REQUEST_EXPIRED"
  | "SESSION_REVOKED"
  | "NAVIGATION_CHANGED"
  | "ORIGIN_CHANGED"
  | "CHAIN_CHANGED"
  | "ACCOUNT_CHANGED"
  | "TRANSPORT_CLOSED"
  | "SNAPSHOT_INVALIDATED"
  | "PROTOCOL_RELEASE_CHANGED";

export type CancellationTerminalState =
  | "completed"
  | "rejected"
  | "failed"
  | "cancelled";

export interface CancellationPolicy {
  readonly terminalState: CancellationTerminalState;
  readonly delivery: "respond" | "suppress";
  readonly providerCode: number | null;
  readonly executionErrorName: "REQUEST_EXPIRED" | "CONFLICT" | null;
  readonly retryable: boolean;
}

interface CancellationRegistryEntry
  extends Omit<CancellationPolicy, "delivery"> {
  readonly delivery: "respond" | "suppress" | "conditional";
}

const CANCELLATIONS: Readonly<Record<CancellationReason, CancellationRegistryEntry>> =
  Object.freeze({
    USER_REJECTED: {
      terminalState: "rejected",
      delivery: "respond",
      providerCode: 4001,
      executionErrorName: null,
      retryable: false,
    },
    REQUEST_ABORTED: {
      terminalState: "cancelled",
      delivery: "suppress",
      providerCode: null,
      executionErrorName: null,
      retryable: false,
    },
    REQUEST_EXPIRED: {
      terminalState: "failed",
      delivery: "respond",
      providerCode: -32000,
      executionErrorName: "REQUEST_EXPIRED",
      retryable: false,
    },
    SESSION_REVOKED: {
      terminalState: "cancelled",
      delivery: "conditional",
      providerCode: 4100,
      executionErrorName: null,
      retryable: false,
    },
    NAVIGATION_CHANGED: {
      terminalState: "cancelled",
      delivery: "suppress",
      providerCode: null,
      executionErrorName: null,
      retryable: false,
    },
    ORIGIN_CHANGED: {
      terminalState: "cancelled",
      delivery: "suppress",
      providerCode: null,
      executionErrorName: null,
      retryable: false,
    },
    CHAIN_CHANGED: {
      terminalState: "cancelled",
      delivery: "respond",
      providerCode: 4100,
      executionErrorName: null,
      retryable: false,
    },
    ACCOUNT_CHANGED: {
      terminalState: "cancelled",
      delivery: "respond",
      providerCode: 4100,
      executionErrorName: null,
      retryable: false,
    },
    TRANSPORT_CLOSED: {
      terminalState: "cancelled",
      delivery: "suppress",
      providerCode: null,
      executionErrorName: null,
      retryable: false,
    },
    SNAPSHOT_INVALIDATED: {
      terminalState: "failed",
      delivery: "respond",
      providerCode: -32000,
      executionErrorName: "CONFLICT",
      retryable: true,
    },
    PROTOCOL_RELEASE_CHANGED: {
      terminalState: "cancelled",
      delivery: "conditional",
      providerCode: -32603,
      executionErrorName: null,
      retryable: false,
    },
  });

const OPTIONAL_AUTHORITY_REASONS = new Set<CancellationReason>([
  "REQUEST_ABORTED",
  "TRANSPORT_CLOSED",
  "PROTOCOL_RELEASE_CHANGED",
]);

const MESSAGES: Readonly<Record<CancellationReason, string>> = Object.freeze({
  USER_REJECTED: "User rejected the request",
  REQUEST_ABORTED: "Request was aborted",
  REQUEST_EXPIRED: "Request expired",
  SESSION_REVOKED: "Provider session was revoked",
  NAVIGATION_CHANGED: "Requesting page navigation changed",
  ORIGIN_CHANGED: "Requesting origin changed",
  CHAIN_CHANGED: "Active chain changed",
  ACCOUNT_CHANGED: "Active account changed",
  TRANSPORT_CLOSED: "Transport closed",
  SNAPSHOT_INVALIDATED: "Execution snapshot was invalidated",
  PROTOCOL_RELEASE_CHANGED: "Protocol release changed",
});

function entryFor(reason: CancellationReason): CancellationRegistryEntry {
  const entry = CANCELLATIONS[reason];
  if (!entry) throw new TypeError(`unknown cancellation reason: ${String(reason)}`);
  return entry;
}

export function isCancelAuthorityOptional(reason: CancellationReason): boolean {
  entryFor(reason);
  return OPTIONAL_AUTHORITY_REASONS.has(reason);
}

export function cancellationPolicy(
  reason: CancellationReason,
  channelReachable: boolean,
): CancellationPolicy {
  const entry = entryFor(reason);
  if (entry.delivery === "conditional" && !channelReachable) {
    return Object.freeze({
      terminalState: entry.terminalState,
      delivery: "suppress",
      providerCode: null,
      executionErrorName: null,
      retryable: entry.retryable,
    });
  }
  return Object.freeze({
    terminalState: entry.terminalState,
    delivery: entry.delivery === "conditional" ? "respond" : entry.delivery,
    providerCode: entry.providerCode,
    executionErrorName: entry.executionErrorName,
    retryable: entry.retryable,
  });
}

export function providerCompletionForCancellation(
  reason: CancellationReason,
  requestId: unknown,
  channelReachable: boolean,
): Readonly<Record<string, unknown>> {
  const policy = cancellationPolicy(reason, channelReachable);
  if (policy.delivery === "suppress") {
    return Object.freeze({ delivery: "suppress", cancellationReason: reason });
  }
  const data =
    policy.executionErrorName === null
      ? {}
      : {
          data: {
            name: policy.executionErrorName,
            stage: "validation",
            retryable: policy.retryable,
          },
        };
  return Object.freeze({
    delivery: "respond",
    response: {
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code: policy.providerCode,
        message: MESSAGES[reason],
        ...data,
      },
    },
    events: [],
  });
}
