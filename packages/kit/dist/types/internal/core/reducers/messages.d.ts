import type { OperationCheckpoint } from "../checkpoint.js";
import type { LegacyBitcoinMessageDigest } from "../engine.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
interface AccountIdentity {
    readonly address: string;
    readonly accountId: string;
    readonly chainId: string;
    readonly publicKey: string;
}
interface SigningTask {
    readonly taskId: string;
    readonly purpose: "message" | "typedData";
    readonly algorithm: "secp256k1-recoverable-ecdsa-sha256d";
    readonly digest: string;
    readonly signatureEncoding: "compact65-recoverable";
    readonly origin: string;
    readonly accountId: string;
    readonly publicKey: string;
}
export declare function normalizeTypedDataTypes(types: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>): {
    [k: string]: Readonly<Record<string, unknown>>[];
};
export declare function beginMessageApproval(checkpoint: OperationCheckpoint, account: AccountIdentity, memory: Readonly<Record<string, unknown>>, legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest): Promise<CoreTransition>;
export declare function assertMessageApprovalArtifacts(checkpoint: OperationCheckpoint): {
    envelope: Readonly<Record<string, unknown>>;
    account: AccountIdentity;
    digest: string;
    legacyBitcoin: boolean;
    binding: import("../bindings.js").ApprovalBinding;
};
export declare function reduceMessageApproval(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): CoreTransition;
export declare function assertRecoverableSignature(task: SigningTask, signatureHex: string): Uint8Array;
export declare function reduceMessageSigningResponse(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown): CoreTransition;
export {};
//# sourceMappingURL=messages.d.ts.map