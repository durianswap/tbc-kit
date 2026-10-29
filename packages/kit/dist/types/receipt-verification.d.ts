import { type TestnetFetch } from "./testnet-client.js";
export declare const TBC_ATOMIC_DECIMALS: 6;
export declare const TBC_MAINNET_API_ORIGIN: "https://api.turingbitchain.io";
export type TransferNetwork = "mainnet" | "testnet";
/** Exact integer-to-display conversion; this never uses floating point. */
export declare function formatTbcAtomicAmount(atomic: string, assetDecimals: number): string;
/** Exact display-to-integer conversion; excess precision is rejected, never rounded. */
export declare function parseTbcDisplayAmount(display: string, assetDecimals: number): string;
export type TransferAsset = Readonly<{
    kind: "tbc";
}> | Readonly<{
    kind: "ft";
    contractId: string;
}> | Readonly<{
    kind: "stablecoin";
    contractId: string;
}>
/** LP identity is the Pool creation transaction ID, not its underlying FT. */
 | Readonly<{
    kind: "lp";
    contractId: string;
}> | Readonly<{
    kind: "nft";
    contractId: string;
}>;
export type TransferAmountExpectation = Readonly<{
    mode: "exact";
    atomic: string;
}> | Readonly<{
    mode: "minimum";
    atomic: string;
}>;
export type TransferRecipient = Readonly<{
    address: string;
    scriptPubKey?: never;
}> | Readonly<{
    address?: never;
    scriptPubKey: string;
}>;
export interface CreateTransferVerifierOptions {
    readonly network: TransferNetwork;
    readonly fetch?: TestnetFetch;
    readonly baseUrl?: string;
    readonly allowedOrigins?: readonly string[];
    readonly requestTimeoutMs?: number;
    /** Optional host/bundler adapter. Keyless WASM loads only for token/NFT receipts. */
    readonly assetInspector?: Readonly<{
        execute: (operation: string, requestJson: string) => Promise<string>;
    }>;
}
interface VerifyTransferInputBase {
    readonly txid: string;
    readonly recipient: TransferRecipient;
    readonly minimumConfirmations: string;
    readonly now?: () => number;
}
export type VerifyTransferInput = VerifyTransferInputBase & (Readonly<{
    asset: Extract<TransferAsset, {
        kind: "tbc" | "ft" | "stablecoin" | "lp";
    }>;
    /** Omit when the caller genuinely does not know the expected quantity. */
    amount?: TransferAmountExpectation;
}> | Readonly<{
    asset: Extract<TransferAsset, {
        kind: "nft";
    }>;
    /** NFT identity is unique and singleton; fungible amount expectations do not apply. */
    amount?: never;
}>);
export type VerifyTransferOptions = CreateTransferVerifierOptions & VerifyTransferInput;
export interface TransferVerifier {
    readonly network: TransferNetwork;
    readonly chainId: `tbc:${string}`;
    readonly verify: (input: VerifyTransferInput) => Promise<TransferVerificationResult>;
}
export type TransferObservation = Readonly<{
    status: "not-found";
}> | Readonly<{
    status: "confirmation-unknown";
}> | Readonly<{
    status: "mempool" | "confirmed";
    confirmations: string;
}> | Readonly<{
    status: "request-failed" | "invalid-response";
    code: "NODE_REQUEST_FAILED" | "NODE_RESPONSE_INVALID";
}>;
export type TransferConfirmationPolicy = Readonly<{
    minimumConfirmations: string;
    status: "satisfied" | "insufficient" | "unavailable";
}>;
export type TransferAmountResult = Readonly<{
    expectation: "not-checked";
    status: "not-checked";
    actualAtomic: string;
    denomination: "atomic";
}> | Readonly<{
    expectation: "exact" | "minimum";
    expectedAtomic: string;
    status: "matched" | "mismatched";
    actualAtomic: string;
    denomination: "atomic";
}> | Readonly<{
    expectation: "not-checked";
    status: "not-checked";
    actualAtomic: string;
    decimals: number;
    actualDisplay: string;
}> | Readonly<{
    expectation: "exact" | "minimum";
    expectedAtomic: string;
    status: "matched" | "mismatched";
    actualAtomic: string;
    decimals: number;
    actualDisplay: string;
}> | Readonly<{
    expectation: "not-checked" | "exact" | "minimum";
    expectedAtomic?: string;
    status: "unavailable";
    decimals?: number;
}> | Readonly<{
    expectation: "nft-singleton";
    status: "matched" | "mismatched" | "unavailable";
    actualAtomic?: "1";
}>;
export type TransferContent = Readonly<{
    status: "matched" | "mismatched" | "unsupported" | "unavailable";
    recipient: Readonly<{
        scriptPubKey: string;
        status: "matched" | "mismatched" | "unavailable";
    }>;
    asset: Readonly<{
        kind: TransferAsset["kind"];
        identity?: string;
        status: "matched" | "mismatched" | "unsupported" | "unavailable";
    }>;
    amount: TransferAmountResult;
    matchedOutputs: readonly Readonly<{
        vout: number;
        amountAtomic: string;
        tapeVout?: number;
        /** Raw Coin/LP lock field, not a maturity/spendability claim. Receipt arrival
         * can match while an administrator-imposed lock still prevents spending. */
        lockTime?: number;
    }>[];
    reasons: readonly string[];
}>;
export interface TransferVerificationResult {
    readonly txid: string;
    readonly checkedAt: string;
    readonly observation: TransferObservation;
    readonly content: TransferContent;
    readonly policy: TransferConfirmationPolicy;
    readonly queries: Readonly<{
        decode: number;
        mempool: number;
        assetMetadata: number;
        transactionRaw: number;
        post: 0;
    }>;
    readonly source: Readonly<{
        network: TransferNetwork;
        chainId: `tbc:${string}`;
        origin: string;
        trustModel: "configured-node-api-plus-local-raw-validation";
    }>;
}
export declare class TransferVerificationError extends Error {
    readonly name = "TransferVerificationError";
    readonly code: "INVALID_INPUT" | "UNSUPPORTED_NETWORK";
    constructor(code: "INVALID_INPUT" | "UNSUPPORTED_NETWORK", message: string);
}
/** Create one network-bound verifier and reuse its client, in-flight ledger, and inspector. */
export declare function createTransferVerifier(options: CreateTransferVerifierOptions): TransferVerifier;
/**
 * One-shot explicit read-only payment evidence check. Prefer a client-bound
 * verifier for repeated calls. Neither path connects a wallet, requests
 * approval, signs, broadcasts, or records merchant orders.
 */
export declare function verifyTransfer(options: VerifyTransferOptions): Promise<TransferVerificationResult>;
export {};
//# sourceMappingURL=receipt-verification.d.ts.map