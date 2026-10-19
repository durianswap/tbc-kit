import type {
  TbcWebViewPageMessage,
  TbcWebViewVerifiedNavigation,
} from "@tbc-wallet/provider/webview";

const forgedFrame: TbcWebViewVerifiedNavigation = {
  webViewInstanceId: "webview-1",
  sessionId: "session-1",
  navigationId: "navigation-1",
  committedUrl: "https://dapp.example/app",
  origin: "https://dapp.example",
  topOrigin: "https://dapp.example",
  // @ts-expect-error WebView transport supports the verified top frame only.
  frame: "iframe",
  createdAt: "2026-09-02T00:00:00Z",
};

const forgedCancel: TbcWebViewPageMessage = {
  channel: "tws-webview/1",
  type: "cancel",
  sessionId: "session-1",
  navigationId: "navigation-1",
  messageId: "page-1",
  requestId: "rpc-1",
  // @ts-expect-error A page can request only DApp AbortSignal cancellation.
  reason: "NAVIGATION_CHANGED",
};

void forgedFrame;
void forgedCancel;

