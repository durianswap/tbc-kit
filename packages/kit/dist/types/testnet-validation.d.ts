export type TestnetNodeErrorCode = "INVALID_CONFIG" | "INVALID_INPUT" | "NODE_REQUEST_FAILED" | "NODE_RESPONSE_INVALID";
export declare class TestnetNodeError extends Error {
    readonly name = "TestnetNodeError";
    readonly code: TestnetNodeErrorCode;
    constructor(code: TestnetNodeErrorCode, message: string);
}
/** Recognizes node errors across independently bundled package entry points. */
export declare function isTestnetNodeError(value: unknown): value is TestnetNodeError;
export interface TbcAddress {
    readonly address: string;
    readonly p2pkhVersion: number;
    readonly publicKeyHash: string;
    readonly scriptPubKey: string;
}
export type TestnetAddress = TbcAddress & Readonly<{
    p2pkhVersion: 0;
}>;
/** Pure inverse of address validation, for trusted script-derived recipients. */
export declare function tbcAddressFromPublicKeyHash(hash: string, p2pkhVersion: number): string;
export declare function assertTbcAddress(address: string, p2pkhVersion: number): TbcAddress;
/** Backwards-compatible Testnet validator. Mainnet currently has the same
 * P2PKH version, but callers must still bind transactions by chainId. */
export declare function assertTestnetAddress(address: string): TestnetAddress;
export declare function assertHash32(value: string): string;
export declare function assertRawTransaction(value: string): string;
export interface ParsedTbcTransaction {
    readonly version: 10;
    readonly inputs: readonly Readonly<{
        txid: string;
        vout: number;
        scriptSig: Uint8Array;
        sequence: number;
    }>[];
    readonly outputs: readonly Readonly<{
        satoshis: bigint;
        scriptPubKey: Uint8Array;
    }>[];
    readonly locktime: number;
}
export declare function parseTbcTransaction(raw: string): ParsedTbcTransaction;
/** Internal unsigned-plan parser, NOT a valid transaction/receipt verifier.
 * Different planned parents may both use the all-zero txid placeholder and
 * output zero. Callers must bind those positions with the shared exact-edge
 * resolver. Real outpoint duplicates and any unlocking script still fail. */
export declare function parseTbcUnsignedTemplate(raw: string): ParsedTbcTransaction;
export declare function turingTransactionId(raw: string): string;
/** Wallet-private read-only inspection. No authority, UTXO or confirmation state. */
export declare function inspectTbcTransaction(raw: string): Readonly<{
    transaction: ParsedTbcTransaction;
    txid: string;
}>;
