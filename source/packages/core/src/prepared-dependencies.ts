import { TwsEngineError } from "./errors.js";

export interface PreparedInputDependency {
  readonly inputIndex: number;
  readonly sourceTransactionId: string;
  readonly sourceOutputIndex: number;
}

/** Exact input edges, shared by DApp preparation and wallet re-verification. */
export function resolvePreparedInputDependencies(
  zeroInputs: readonly Readonly<{ inputIndex: number; sourceOutputIndex: number }>[],
  dependsOn: readonly string[],
  knownIds: ReadonlySet<string>,
  explicit?: readonly PreparedInputDependency[],
): readonly PreparedInputDependency[] {
  const fail = (): never => { throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH",
    "prepared deferred inputs do not map exactly to earlier plan dependencies"); };
  if (new Set(dependsOn).size !== dependsOn.length || dependsOn.some((id) => !knownIds.has(id))) fail();
  if (explicit === undefined && zeroInputs.length !== dependsOn.length) fail();
  if (explicit !== undefined && (explicit.length === 0 || explicit.length !== zeroInputs.length)) fail();
  const usedParents = new Set<string>();
  const usedOutputs = new Set<string>();
  const result = zeroInputs.map((input, index) => {
    const source = explicit?.[index] ?? { ...input, sourceTransactionId: dependsOn[index]! };
    if (source.inputIndex !== input.inputIndex || source.sourceOutputIndex !== input.sourceOutputIndex ||
        !dependsOn.includes(source.sourceTransactionId)) fail();
    const output = `${source.sourceTransactionId}:${source.sourceOutputIndex}`;
    if (usedOutputs.has(output)) fail();
    usedOutputs.add(output); usedParents.add(source.sourceTransactionId);
    return Object.freeze({ ...source });
  });
  if (usedParents.size !== dependsOn.length) fail();
  return Object.freeze(result);
}
