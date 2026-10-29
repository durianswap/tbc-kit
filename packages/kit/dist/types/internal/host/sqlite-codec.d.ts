import type { TwsHostCallRecord, TwsHostDeliveryRecord, TwsHostLeaseRecord, TwsHostOperationRecord, TwsHostSessionCommitRecord } from "./store.js";
export declare const TWS_HOST_SQLITE_MAX_CANONICAL_JSON_BYTES: number;
export declare function encodeSqliteCanonicalJson(value: unknown): string;
export declare const decodeSqliteOperation: (value: unknown) => TwsHostOperationRecord;
export declare const decodeSqliteCall: (value: unknown) => TwsHostCallRecord;
export declare const decodeSqliteSessionCommit: (value: unknown) => TwsHostSessionCommitRecord;
export declare const decodeSqliteDelivery: (value: unknown) => TwsHostDeliveryRecord;
export declare const decodeSqliteLease: (value: unknown) => TwsHostLeaseRecord;
//# sourceMappingURL=sqlite-codec.d.ts.map