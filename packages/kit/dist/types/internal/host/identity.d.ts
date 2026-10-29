import { type PortCall, type PortOperation, type SchemaCoreTransition } from "../core/index.js";
import type { TwsAuthoritySnapshot, TwsProviderCompletion, TwsProviderSessionMutation } from "./types.js";
export declare function deriveHostAuthorityIdentity(authority: TwsAuthoritySnapshot): string;
export declare function deriveHostTransitionIdentity(transition: SchemaCoreTransition): string;
export declare function deriveHostCallIdentity<K extends PortOperation>(call: PortCall<K>): string;
export declare function deriveHostSessionCommitIdentity(mutation: TwsProviderSessionMutation): string;
export declare function deriveHostCompletionIdentity(completion: TwsProviderCompletion): string;
export declare function deriveHostDeliveryId(input: {
    readonly operationId: string;
    readonly completionIdentity: string;
}): string;
//# sourceMappingURL=identity.d.ts.map