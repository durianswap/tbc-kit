export interface PreparedInputDependency {
    readonly inputIndex: number;
    readonly sourceTransactionId: string;
    readonly sourceOutputIndex: number;
}
/** Exact input edges, shared by DApp preparation and wallet re-verification. */
export declare function resolvePreparedInputDependencies(zeroInputs: readonly Readonly<{
    inputIndex: number;
    sourceOutputIndex: number;
}>[], dependsOn: readonly string[], knownIds: ReadonlySet<string>, explicit?: readonly PreparedInputDependency[]): readonly PreparedInputDependency[];
//# sourceMappingURL=prepared-dependencies.d.ts.map