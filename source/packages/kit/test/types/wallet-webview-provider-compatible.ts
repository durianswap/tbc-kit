import {
  createTbcKitWebViewNativeController,
  type TbcKitWebViewJsonRpcRequest,
  type TbcKitWebViewNativeHandlers,
  type TbcKitWebViewNativeOptions,
  type TbcKitWebViewVerifiedNavigation,
} from "../../dist/types/wallet.js";
import type {
  TbcWebViewNativeHandlers,
  TbcWebViewNativeOptions,
} from "../../../provider/dist/types/webview.js";

declare const providerHandlers: TbcWebViewNativeHandlers;
declare const providerOptions: TbcWebViewNativeOptions;
declare const kitRequest: TbcKitWebViewJsonRpcRequest;
declare const kitNavigation: TbcKitWebViewVerifiedNavigation;

const kitHandlers: TbcKitWebViewNativeHandlers = providerHandlers;
const kitOptions: TbcKitWebViewNativeOptions = providerOptions;

void providerHandlers.send(kitRequest, kitNavigation);
void createTbcKitWebViewNativeController({
  ...kitOptions,
  handlers: kitHandlers,
});
