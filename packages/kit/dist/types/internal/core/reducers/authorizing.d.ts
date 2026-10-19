import type { OperationCheckpoint } from "../checkpoint.js";
import { type TransactionEngine, type TwsCapabilityConfiguration } from "../engine.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
declare function capabilities(checkpoint: OperationCheckpoint, chainId: string, accountId: string | undefined, configuration: TwsCapabilityConfiguration | undefined): Readonly<Record<string, unknown>>;
export declare function reduceAuthorizingResponse(checkpoint: OperationCheckpoint, call: PortCall, result: unknown, transactionEngine?: TransactionEngine, capabilityConfiguration?: TwsCapabilityConfiguration): Promise<CoreTransition>;
export { capabilities };
