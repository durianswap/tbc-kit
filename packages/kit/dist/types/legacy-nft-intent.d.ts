export interface LegacyNftIntentResolver {
    readonly resolve: (request: unknown, addressFrom: string) => Promise<Readonly<Record<string, unknown>>>;
}
/** Historical provider DTO -> the same canonical intents as public walletBuild. */
export declare function createLegacyNftIntentResolver(options: Readonly<{
    chainId: string;
}>): LegacyNftIntentResolver;
//# sourceMappingURL=legacy-nft-intent.d.ts.map