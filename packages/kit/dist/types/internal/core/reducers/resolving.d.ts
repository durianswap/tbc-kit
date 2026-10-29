import type { OperationCheckpoint } from "../checkpoint.js";
import type { LegacyBitcoinMessageDigest, TransactionEngine, TwsCapabilityConfiguration } from "../engine.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
export declare function reduceResolvingResponse(checkpoint: OperationCheckpoint, call: PortCall, resultValue: unknown, engine?: TransactionEngine, legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest, capabilityConfiguration?: TwsCapabilityConfiguration): CoreTransition | Promise<CoreTransition>;
//# sourceMappingURL=resolving.d.ts.map