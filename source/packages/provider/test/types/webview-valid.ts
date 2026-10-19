import type { TbcProviderTransport } from "@tbc-wallet/provider";
import {
  createTbcWebViewPageTransport,
  createTbcWebViewNativeController,
  type TbcWebViewDeliveryInput,
  type TbcWebViewSessionStore,
  type TbcWebViewStringChannel,
  type TbcWebViewVerifiedNavigation,
} from "@tbc-wallet/provider/webview";

declare const channel: TbcWebViewStringChannel;
declare const store: TbcWebViewSessionStore;
declare const delivery: TbcWebViewDeliveryInput;
declare const nativeHandlers: Parameters<typeof createTbcWebViewNativeController>[0]["handlers"];

const navigation: TbcWebViewVerifiedNavigation = {
  webViewInstanceId: "webview-1",
  sessionId: "session-1",
  navigationId: "navigation-1",
  committedUrl: "https://dapp.example/app",
  origin: "https://dapp.example",
  topOrigin: "https://dapp.example",
  frame: "top",
  createdAt: "2026-09-02T00:00:00Z",
};

const page = createTbcWebViewPageTransport({
  channel,
  isTopFrame: () => true,
});
page.transport satisfies TbcProviderTransport;
const native = createTbcWebViewNativeController({
  channel,
  store,
  chainId: "tbc:00000000000000000000000000000001",
  handlers: nativeHandlers,
});

void navigation;
void channel;
void store;
void delivery;
void native;
