export interface TbcNetworkProfile {
    readonly chainId: string;
    readonly p2pkhVersion: number;
    readonly transactionVersion: 10;
}
/** Lightweight immutable profiles with no Native/WASM backend dependency. */
export declare const TBC_MAINNET_PROFILE: TbcNetworkProfile;
export declare const TBC_TESTNET_PROFILE: TbcNetworkProfile;
//# sourceMappingURL=network-profiles.d.ts.map