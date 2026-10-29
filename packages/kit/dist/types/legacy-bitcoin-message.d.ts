import { type EncodedSigningMessage } from "./internal/core/index.js";
/** Wallet-owned Bitcoin Signed Message digest; no page-supplied digest is read. */
export declare function digestTbcLegacyBitcoinMessage(input: Readonly<{
    version: "1.0";
    message: EncodedSigningMessage;
}>): string;
/** Private WebView adapter helper. Flutter's SHA backend is native and verified at startup. */
export declare function prepareTbcLegacyBitcoinMessage(input: Readonly<{
    message: string;
    encoding: "utf8" | "hex" | "base64";
}>): Promise<Readonly<{
    message: string;
    encoding: "utf8" | "hex" | "base64";
    digest: string;
}>>;
//# sourceMappingURL=legacy-bitcoin-message.d.ts.map