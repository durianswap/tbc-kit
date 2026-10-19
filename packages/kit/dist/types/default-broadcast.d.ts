import type { TbcKitBroadcastJournal, TbcKitBroadcastJournalRecord } from "./broadcast-journal.js";
import { type TestnetClient } from "./testnet-client.js";
import type { KitHostPortCall } from "./wallet-runtime.js";
import { type TbcNetworkContext } from "./network-context.js";
export interface DefaultTbcBroadcastOptions {
    readonly client: TestnetClient;
    readonly journal: TbcKitBroadcastJournal;
    readonly network: TbcNetworkContext;
    /** New unified runtimes scope recovery by source identity. Legacy wrapper disables this for in-place Testnet recovery. */
    readonly scopeJournal?: boolean;
    /** Wallet-owned active account scope; used only to isolate journal recovery. */
    readonly accountScopeHash?: () => Promise<string>;
}
export interface DefaultTbcBroadcast {
    readonly network: TbcNetworkContext;
    readonly submit: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
    readonly submitBatch: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
    readonly reconcile: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
    /** Lists durable submit-boundary records without resuming Core or signing. */
    readonly listRecovery: (limit?: number) => Promise<readonly TbcKitBroadcastJournalRecord[]>;
    /** Explicit status-only recovery. It never submits transaction bytes. */
    readonly recover: (txids: readonly string[]) => Promise<unknown>;
}
export type DefaultTbcTestnetBroadcastOptions = Omit<DefaultTbcBroadcastOptions, "network">;
export type DefaultTbcTestnetBroadcast = DefaultTbcBroadcast;
export declare function createDefaultTbcBroadcast(options: DefaultTbcBroadcastOptions): DefaultTbcBroadcast;
export declare function createDefaultTbcTestnetBroadcast(options: DefaultTbcTestnetBroadcastOptions): DefaultTbcTestnetBroadcast;
