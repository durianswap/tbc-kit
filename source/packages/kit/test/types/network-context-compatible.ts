import {
  createDefaultTbcNetwork,
  createTbcNetworkContext,
  type TbcKitBroadcastJournal,
  type KitWalletAccount,
} from "../../dist/types/wallet.js";

declare const accounts: Readonly<{
  current: () => Promise<readonly KitWalletAccount[]>;
}>;
declare const fetch: typeof globalThis.fetch;
declare const journal: TbcKitBroadcastJournal;

const testnet = createTbcNetworkContext({ network: "testnet" });
const mainnet = createTbcNetworkContext({ network: "mainnet" });
const custom = createTbcNetworkContext({
  network: "testnet",
  endpoint: {
    kind: "trusted-custom",
    apiOrigin: "https://audited.example",
    rpcOrigin: "https://audited-rpc.example",
    trustId: "wallet-audit-17",
  },
});

for (const network of [testnet, mainnet, custom]) {
  const runtime = createDefaultTbcNetwork({
    network,
    accounts,
    fetch,
    broadcast: { journal },
  });
  const chainId: string = runtime.network.chainId;
  void chainId;
}
