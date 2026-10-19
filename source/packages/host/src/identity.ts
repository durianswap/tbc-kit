import {
  hashCanonical,
  type PortCall,
  type PortOperation,
  type SchemaCoreTransition,
} from "@tbc-wallet/core";
import type {
  TwsAuthoritySnapshot,
  TwsProviderCompletion,
  TwsProviderSessionMutation,
} from "./types.js";

export function deriveHostAuthorityIdentity(
  authority: TwsAuthoritySnapshot,
): string {
  return hashCanonical({ domain: "tws-host-authority/1", authority });
}

export function deriveHostTransitionIdentity(
  transition: SchemaCoreTransition,
): string {
  return hashCanonical({ domain: "tws-host-transition/1", transition });
}

export function deriveHostCallIdentity<K extends PortOperation>(
  call: PortCall<K>,
): string {
  return hashCanonical({ domain: "tws-host-call/1", call });
}

export function deriveHostSessionCommitIdentity(
  mutation: TwsProviderSessionMutation,
): string {
  return hashCanonical({ domain: "tws-host-session-commit/1", mutation });
}

export function deriveHostCompletionIdentity(
  completion: TwsProviderCompletion,
): string {
  return hashCanonical({ domain: "tws-host-completion/1", completion });
}

export function deriveHostDeliveryId(input: {
  readonly operationId: string;
  readonly completionIdentity: string;
}): string {
  return hashCanonical({
    domain: "tws-host-delivery/1",
    operationId: input.operationId,
    completionIdentity: input.completionIdentity,
  });
}
