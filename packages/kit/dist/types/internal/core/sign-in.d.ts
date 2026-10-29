import type { EncodedSigningMessage } from "./signing-artifacts.js";
export interface TbcSignInMessageFields {
    readonly domain: string;
    readonly uri: string;
    readonly address: string;
    readonly chainId: string;
    readonly nonce: string;
    readonly issuedAt: string;
    readonly expirationTime: string;
    readonly statement?: string;
}
export declare function serializeTbcSignInMessage(input: TbcSignInMessageFields): string;
export declare function parseTbcSignInMessage(value: string): TbcSignInMessageFields;
export declare function inspectTbcSignInMessage(message: EncodedSigningMessage): TbcSignInMessageFields | undefined;
export declare function assertTbcSignInWalletContext(fields: TbcSignInMessageFields, expected: Readonly<{
    origin: string;
    chainId: string;
    address: string;
    now: string;
}>): void;
//# sourceMappingURL=sign-in.d.ts.map