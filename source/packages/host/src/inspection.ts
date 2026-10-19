import type { TwsHostOperationRecord } from "./store.js";
import type { TwsHostOperationInspection } from "./types.js";

export function inspectHostOperation(
  record: TwsHostOperationRecord,
): TwsHostOperationInspection {
  return Object.freeze({
    operationId: record.operationId,
    revision: record.revision,
    state: record.transition.checkpoint.payload.state,
    transitionKind: record.transitionKind,
    releaseFingerprint: record.releaseFingerprint,
    terminal: record.terminal,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
