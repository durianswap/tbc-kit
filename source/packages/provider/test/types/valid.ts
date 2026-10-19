import {
  ProviderRpcError,
  createTbcProvider,
  type TbcProvider,
  type TbcProviderEventMap,
  type TbcProviderMethod,
  type TbcProviderMethodMap,
  type TbcProviderTransport,
  type TbcTransportDelivery,
} from "../../src/index.js";
import {
  createInMemoryTransport,
  type TbcInMemoryTransportController,
} from "../../src/in-memory.js";

type CompleteMethodMap = {
  readonly [M in TbcProviderMethod]: {
    readonly params: TbcProviderMethodMap[M]["params"];
    readonly result: TbcProviderMethodMap[M]["result"];
  };
};

declare const provider: TbcProvider;
declare const transport: TbcProviderTransport;
declare const delivery: TbcTransportDelivery;
declare const transaction: TbcProviderMethodMap["tbc_sendTransaction"]["params"];
declare const permissions: TbcProviderMethodMap["wallet_requestPermissions"]["params"];
declare const coverage: CompleteMethodMap;
const concreteProvider: TbcProvider = createTbcProvider({ transport });
const rpcError: ProviderRpcError = new ProviderRpcError(4100, "Unauthorized");
const memory: TbcInMemoryTransportController = createInMemoryTransport({
  handler: async () => delivery,
});

const chain: Promise<string> = provider.request({ method: "tbc_chainId" });
const accounts: Promise<readonly string[]> = provider.request({ method: "tbc_accounts" });
const submitted: Promise<
  TbcProviderMethodMap["tbc_sendTransaction"]["result"]
> = provider.request({ method: "tbc_sendTransaction", params: transaction });
const granted = provider.request({
  method: "wallet_requestPermissions",
  params: permissions,
});

provider.on("chainChanged", (chainId) => {
  const exact: TbcProviderEventMap["chainChanged"] = chainId;
  void exact;
});
provider.on("accountsChanged", (addresses) => {
  const exact: readonly string[] = addresses;
  void exact;
});

void [
  transport,
  delivery,
  coverage,
  concreteProvider,
  memory,
  rpcError,
  chain,
  accounts,
  submitted,
  granted,
];
