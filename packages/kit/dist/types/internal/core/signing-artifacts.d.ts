export declare function canonicalSigningEnvelope(envelope: unknown): string;
export interface EncodedSigningMessage {
    readonly encoding: "utf8" | "hex" | "base64";
    readonly data: string;
}
export declare function decodeSigningMessage(message: EncodedSigningMessage): Uint8Array;
export declare function signingPayload(envelope: unknown): Uint8Array;
export declare function signingEnvelopeDigest(envelope: unknown): string;
