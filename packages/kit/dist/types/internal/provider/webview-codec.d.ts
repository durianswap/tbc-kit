import { type TbcWebViewNativeMessage, type TbcWebViewPageMessage } from "./webview-types.js";
export type TbcWebViewValidationKind = "json" | "size" | "page-message" | "native-message";
export declare class TbcWebViewValidationError extends TypeError {
    readonly code: "TBC_WEBVIEW_VALIDATION_FAILED";
    readonly kind: TbcWebViewValidationKind;
    constructor(kind: TbcWebViewValidationKind);
}
export declare function encodeTbcWebViewPageMessage(value: TbcWebViewPageMessage): string;
export declare function decodeTbcWebViewPageMessage(serialized: string): TbcWebViewPageMessage;
export declare function encodeTbcWebViewNativeMessage(value: TbcWebViewNativeMessage): string;
export declare function decodeTbcWebViewNativeMessage(serialized: string): TbcWebViewNativeMessage;
export declare function digestTbcWebViewEnvelope(serialized: string): string;
//# sourceMappingURL=webview-codec.d.ts.map