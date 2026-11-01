import { type TransactionEngine } from "./internal/core/index.js";
import type { KitWalletOptions, KitWalletSession, KitWalletAuthoritySource, KitWalletAccount, KitWalletNetwork } from "./wallet-runtime.js";
/** Only explicit resource failures from the pinned Engine permit local resizing.
 * Semantic, funding, identity and validation failures must never become retries. */
export declare function nftMintPreparationResource(error: unknown): "plan-bytes" | "continuation-bytes" | "inputs" | "outputs" | undefined;
/** Private execution channel over the same Core/Host composition. It is never
 * exposed to the page, and therefore cannot lend job consent to another call.
 * Wallet adapters only render one consent and issue exact Core credentials. */
export declare function createWalletNftMintJob(input: Readonly<{
    account: KitWalletAccount;
    network: KitWalletNetwork;
    engine: TransactionEngine;
    wallet: KitWalletOptions;
    authority: KitWalletAuthoritySource;
    openExecution: (options: KitWalletOptions, authority: KitWalletAuthoritySource) => Promise<KitWalletSession>;
    assertAuthority: () => Promise<void>;
    now: () => number;
    refreshTime: () => Promise<void>;
}>): Readonly<{
    run(params: Parameters<(input: Parameters<typeof import("./nft-mint-job.js").createTbcNftMintJobScope>[0] & Readonly<{
        signal?: AbortSignal;
    }>) => Promise<import("./nft-mint-job.js").TbcNftMintJobResult>>[0]): Promise<import("./nft-mint-job.js").TbcNftMintJobResult>;
}>;
