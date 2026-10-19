import type { KitProvider } from "./public-types.js";
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
export interface TbcMessageSignatureResult {
    readonly version: "1.0";
    readonly scheme: "tbc-message" | "legacy-bitcoin-message";
    readonly algorithm: "secp256k1-recoverable-ecdsa-sha256d";
    readonly address: string;
    readonly accountId: string;
    readonly publicKey: string;
    readonly envelope: Readonly<Record<string, unknown>>;
    readonly canonical: string;
    readonly signingPayload?: string;
    readonly digest: string;
    readonly signature: string;
}
export interface TbcSignInInput {
    readonly provider: KitProvider;
    readonly chainId: `tbc:${string}`;
    readonly address: string;
    /** URI authority, for example `app.example`. */
    readonly domain: string;
    readonly uri: string;
    /** Backend-issued, single-use challenge. */
    readonly nonce: string;
    readonly issuedAt?: string;
    readonly expirationTime?: string;
    readonly statement?: string;
    readonly clientRequestId?: string;
}
export interface TbcSignInResult {
    readonly message: string;
    readonly fields: TbcSignInMessageFields;
    readonly signature: TbcMessageSignatureResult;
}
export interface VerifyTbcSignInOptions {
    readonly result: TbcSignInResult;
    readonly expected: Readonly<{
        readonly domain: string;
        readonly uri: string;
        readonly chainId: `tbc:${string}`;
        readonly address: string;
        readonly now?: string;
    }>;
    /**
     * Atomically consume the backend challenge. It must return false when the
     * nonce was already consumed, unknown, expired, or bound to other fields.
     */
    readonly consumeChallenge: (challenge: TbcSignInMessageFields) => boolean | Promise<boolean>;
}
export declare function createSignInMessage(input: Omit<TbcSignInInput, "provider" | "clientRequestId">): Readonly<{
    message: string;
    fields: TbcSignInMessageFields;
}>;
export declare function signIn(input: TbcSignInInput): Promise<TbcSignInResult>;
export declare function verifySignIn(options: VerifyTbcSignInOptions): Promise<TbcSignInMessageFields>;
