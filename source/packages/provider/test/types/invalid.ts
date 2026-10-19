import type {
  TbcProvider,
  TbcProviderTransport,
  TbcTransportDelivery,
} from "../../src/index.js";

declare const provider: TbcProvider;
declare const delivery: TbcTransportDelivery;

// @ts-expect-error Named parameters cannot be replaced with positional parameters.
void provider.request({ method: "tbc_switchChain", params: [] });

// @ts-expect-error Methods without parameters only accept omitted params or an empty tuple.
void provider.request({ method: "tbc_chainId", params: {} });

// @ts-expect-error The chain ID result is not an account array.
const wrongResult: Promise<readonly string[]> = provider.request({
  method: "tbc_chainId",
});

// @ts-expect-error Known events receive their registered payload type.
provider.on("chainChanged", (chainId: readonly string[]) => void chainId);

const bareResponseTransport = {
  // @ts-expect-error Transport send returns an atomic delivery, not a bare response.
  send: async () => delivery.response,
  subscribe: () => () => undefined,
} satisfies TbcProviderTransport;

// @ts-expect-error Provider never exposes a Host or signing shortcut.
void provider.signAndSend;
// @ts-expect-error Provider never exposes trusted context.
void provider.currentContext;

void [wrongResult, bareResponseTransport];

