import {
  TBC_WEBVIEW_CHANNEL,
  assertTbcProviderEvent,
  assertTbcProviderRequest,
  assertTbcTransportDelivery,
  createTbcProvider,
  createTbcKitWebViewNativeController,
  decodeTbcWebViewNativeMessage,
  decodeTbcWebViewPageMessage,
  digestTbcWebViewEnvelope,
  encodeTbcWebViewNativeMessage,
  encodeTbcWebViewPageMessage,
  type TbcJsonRpcId,
  type TbcJsonRpcRequest,
  type TbcProviderEvent,
  type TbcTransportCloseReason,
  type TbcTransportDelivery,
  type TbcProviderTransport,
  type TbcWebViewDeliveryInput,
  type TbcWebViewNativeDispatch,
  type TbcWebViewNativeHandlers,
  type TbcWebViewSessionStore,
  type TbcWebViewStoredDelivery,
  type TbcWebViewStoreDecision,
  type TbcWebViewStringChannel,
  type TbcWebViewVerifiedNavigation,
} from "../../dist/types/wallet.js";

declare const candidate: unknown;
declare const requestId: TbcJsonRpcId;
declare const request: TbcJsonRpcRequest;
declare const navigation: TbcWebViewVerifiedNavigation;
declare const channel: TbcWebViewStringChannel;
declare const store: TbcWebViewSessionStore;

const checkedRequest: TbcJsonRpcRequest = assertTbcProviderRequest(candidate);
const checkedEvent: TbcProviderEvent = assertTbcProviderEvent(candidate);
const checkedDelivery: TbcTransportDelivery =
  assertTbcTransportDelivery(candidate, request.method);

function routeEvent(event: TbcProviderEvent): string | undefined {
  if (event.name === "accountsChanged") return event.payload[0];
  if (event.name === "chainChanged") return event.payload;
  return undefined;
}

const handlers: TbcWebViewNativeHandlers = {
  async send(
    input: TbcJsonRpcRequest,
    authority: TbcWebViewVerifiedNavigation,
  ): Promise<TbcWebViewNativeDispatch> {
    void input;
    void authority;
    return checkedDelivery;
  },
  async acknowledgeDelivery(deliveryId, authority) {
    void deliveryId;
    void authority;
  },
  async cancel(id: TbcJsonRpcId, reason, authority) {
    void id;
    void reason;
    void authority;
  },
  async close(reason: TbcTransportCloseReason, authority) {
    void reason;
    void authority;
  },
};

const controller = createTbcKitWebViewNativeController({
  channel,
  store,
  chainId: "tbc:00000000000000000000000000000001",
  handlers,
});

declare const deliveryInput: TbcWebViewDeliveryInput;
declare const storedDelivery: TbcWebViewStoredDelivery;
declare const decision: TbcWebViewStoreDecision;

void controller.acceptPageMessage({
  webViewInstanceId: navigation.webViewInstanceId,
  serialized: "{}",
});
void decodeTbcWebViewPageMessage("{}");
void decodeTbcWebViewNativeMessage("{}");
void digestTbcWebViewEnvelope("{}");
void encodeTbcWebViewPageMessage;
void encodeTbcWebViewNativeMessage;
void TBC_WEBVIEW_CHANNEL;
void routeEvent(checkedEvent);
void requestId;
void checkedRequest;
void deliveryInput;
void storedDelivery;
void decision;

declare const transport: TbcProviderTransport;
const strictProvider = createTbcProvider({ transport });
void strictProvider.request({ method: "tbc_chainId", params: [] });
