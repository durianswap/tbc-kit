import { verifyCheckpoint, type OperationCheckpoint } from "./checkpoint.js";
import { TwsStateError } from "./errors.js";
import type { AnyPortCall } from "./ports.js";
import { assertValidTws } from "./validation.js";

export const TWS_TRANSITION_KINDS = Object.freeze([
  "continue",
  "waiting",
  "commit",
  "complete",
] as const);

export type TwsTransitionKind = (typeof TWS_TRANSITION_KINDS)[number];

export type CoreTransition =
  | Readonly<{ kind: "continue"; checkpoint: OperationCheckpoint }>
  | Readonly<{
      kind: "waiting";
      checkpoint: OperationCheckpoint;
      calls: readonly AnyPortCall[];
    }>
  | Readonly<{
      kind: "commit";
      checkpoint: OperationCheckpoint;
      mutation: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      kind: "complete";
      checkpoint: OperationCheckpoint;
      completion: Readonly<Record<string, unknown>>;
    }>;

function checked<T extends CoreTransition>(transition: T): T {
  assertValidTws("coreTransition", transition);
  return Object.freeze(transition);
}

export function continueTransition(
  checkpoint: OperationCheckpoint,
): CoreTransition {
  if (checkpoint.payload.pendingCalls.length !== 0) {
    throw new TwsStateError(
      "STATE_MISMATCH",
      "continue requires a checkpoint without pending calls",
    );
  }
  return checked({ kind: "continue", checkpoint });
}

export function waitingTransition(
  checkpoint: OperationCheckpoint,
): CoreTransition {
  checkpoint = verifyCheckpoint(checkpoint, checkpoint.payload.release);
  if (checkpoint.payload.pendingCalls.length === 0) {
    throw new TwsStateError(
      "STATE_MISMATCH",
      "waiting requires at least one pending call",
    );
  }
  const calls = checkpoint.payload.pendingCalls;
  return checked({ kind: "waiting", checkpoint, calls });
}

export function commitTransition(
  checkpoint: OperationCheckpoint,
  mutation: Readonly<Record<string, unknown>>,
): CoreTransition {
  return checked({ kind: "commit", checkpoint, mutation });
}

export function completeTransition(
  checkpoint: OperationCheckpoint,
  completion: Readonly<Record<string, unknown>>,
): CoreTransition {
  return checked({ kind: "complete", checkpoint, completion });
}
