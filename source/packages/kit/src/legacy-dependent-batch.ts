import { withLegacyDependentTxids } from "./legacy-batch.js";
import { turingTransactionId } from "./testnet-validation.js";

export interface LegacyDependentBatchProgress {
  readonly completed: 0 | 1 | 2;
  readonly total: 2;
  readonly stage: "signing" | "finalizing";
}

export interface LegacyDependentBatchFirstStep<T> {
  readonly value: T;
  readonly result: unknown;
  readonly rawTransactions: readonly string[];
  readonly acknowledge?: () => void | Promise<void>;
}

export interface LegacyDependentBatchSecondStep<T> {
  readonly value: T;
  readonly result: unknown;
}

export type LegacyDependentBatchOutcome<TFirst, TSecond> =
  | Readonly<{ readonly status: "invalid-template" }>
  | Readonly<{
      readonly status: "first-error";
      readonly first: LegacyDependentBatchFirstStep<TFirst>;
    }>
  | Readonly<{
      readonly status: "second-error";
      readonly first: LegacyDependentBatchFirstStep<TFirst>;
      readonly second: LegacyDependentBatchSecondStep<TSecond>;
    }>
  | Readonly<{
      readonly status: "complete";
      readonly first: LegacyDependentBatchFirstStep<TFirst>;
      readonly second: LegacyDependentBatchSecondStep<TSecond>;
    }>;

export interface LegacyDependentBatchCoordinator {
  run<TFirst, TSecond>(input: Readonly<{
    readonly messageTemplate: unknown;
    readonly executeFirst: () => Promise<LegacyDependentBatchFirstStep<TFirst>>;
    readonly executeSecond: (
      message: Readonly<{ readonly message: string; readonly encoding: "utf8" }>,
    ) => Promise<LegacyDependentBatchSecondStep<TSecond>>;
  }>): Promise<LegacyDependentBatchOutcome<TFirst, TSecond>>;
}

function isBusinessError(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    Object.hasOwn(result, "error")
  );
}

/** Fixed two-step Legacy dependency coordination; all authority stays injected. */
export function createLegacyDependentBatchCoordinator(options: Readonly<{
  readonly onProgress?: (progress: LegacyDependentBatchProgress) => void;
}> = {}): LegacyDependentBatchCoordinator {
  const report = (progress: LegacyDependentBatchProgress): void => {
    try {
      options.onProgress?.(Object.freeze(progress));
    } catch {
      // Presentation diagnostics never alter execution semantics.
    }
  };
  return Object.freeze({
    async run<TFirst, TSecond>(input: Readonly<{
      readonly messageTemplate: unknown;
      readonly executeFirst: () => Promise<LegacyDependentBatchFirstStep<TFirst>>;
      readonly executeSecond: (
        message: Readonly<{ readonly message: string; readonly encoding: "utf8" }>,
      ) => Promise<LegacyDependentBatchSecondStep<TSecond>>;
    }>): Promise<LegacyDependentBatchOutcome<TFirst, TSecond>> {
      if (withLegacyDependentTxids(input.messageTemplate, []) === undefined) {
        return Object.freeze({ status: "invalid-template" as const });
      }
      report({ completed: 0, total: 2, stage: "signing" });
      const first = await input.executeFirst();
      if (isBusinessError(first.result)) {
        return Object.freeze({ status: "first-error" as const, first });
      }
      report({ completed: 1, total: 2, stage: "signing" });
      if (
        !Array.isArray(first.rawTransactions) ||
        first.rawTransactions.length === 0 ||
        first.rawTransactions.some((raw) => typeof raw !== "string")
      ) {
        throw new Error("Invalid Legacy dependent batch result");
      }
      const message = withLegacyDependentTxids(
        input.messageTemplate,
        first.rawTransactions.map((raw) => turingTransactionId(raw)),
      );
      if (message === undefined) {
        throw new Error("Invalid Legacy dependent batch message");
      }
      await first.acknowledge?.();
      const second = await input.executeSecond(message);
      if (isBusinessError(second.result)) {
        return Object.freeze({ status: "second-error" as const, first, second });
      }
      report({ completed: 2, total: 2, stage: "finalizing" });
      return Object.freeze({ status: "complete" as const, first, second });
    },
  });
}
