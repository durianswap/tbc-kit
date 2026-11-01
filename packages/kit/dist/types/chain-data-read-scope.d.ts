import type { TestnetClient } from "./testnet-client.js";
/** One bounded preparation only. Never retain mutable observations across requests. */
export declare function createChainDataReadScope(client: TestnetClient): TestnetClient;
