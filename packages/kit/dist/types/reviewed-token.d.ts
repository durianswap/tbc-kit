import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
export type ReviewedTokenCode = Readonly<{
    standardId: "tbc20-standard" | "tbc20-stablecoin";
    tapeSize: number;
    controller: string;
    codeIdentity: string;
    verification: "exact-template";
    assetIdentityVerified: false;
    originalOutpoint?: Readonly<{
        txid: string;
        vout: number;
    }>;
    coinNftCodeHash?: string;
    adminPubkeyHash?: string;
}>;
export type ReviewedTokenPairInput = Readonly<{
    codeScript: string;
    codeSatoshis: number;
    tapeScript: string;
    tapeSatoshis: number;
    inputLock?: Readonly<{
        sequence: number;
        transactionLockTime: number;
    }>;
}>;
export type ReviewedTokenPair = Readonly<{
    code: ReviewedTokenCode;
    balanceRaw: string;
    lockTime?: number;
    inputLockChecked?: true;
}>;
/** Pure local hints over exact shared codecs. No HTTP or asset-origin authority.
 * Snapshot/dedup before await; repeated scripts retain original positions. */
export declare function inspectReviewedTokenCodes(native: PoolMaterialNativeProviderInput, scripts: readonly string[]): Promise<readonly (ReviewedTokenCode | null)[]>;
/** Adjacent Code/Tape material must already be authenticated by the caller.
 * This checks exact layout/balance/lock only, not ancestry or spendability. */
export declare function inspectReviewedTokenPairs(native: PoolMaterialNativeProviderInput, pairs: readonly ReviewedTokenPairInput[]): Promise<readonly ReviewedTokenPair[]>;
