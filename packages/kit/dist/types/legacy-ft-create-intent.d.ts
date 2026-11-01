export interface LegacyFtCreateIntentResolver {
    readonly resolve: (request: unknown, addressFrom: string) => Promise<Readonly<Record<string, unknown>>>;
}
export declare class LegacyFtCreateParameterError extends Error {
}
export declare function createLegacyFtCreateIntentResolver(options: {
    readonly chainId: string;
}): LegacyFtCreateIntentResolver;
