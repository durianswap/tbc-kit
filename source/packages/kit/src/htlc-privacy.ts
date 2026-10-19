/** Derive a fixed warning without copying, formatting or hashing the secret. */
export function htlcClaimDisclosureWarnings(request: unknown): readonly string[] {
  const claim = (value: unknown): boolean => value !== null && typeof value === "object" &&
    "intent" in value && value.intent !== null && typeof value.intent === "object" &&
    "type" in value.intent && value.intent.type === "tbc-htlc-claim";
  const hasClaim = claim(request) || (request !== null && typeof request === "object" &&
    "steps" in request && Array.isArray(request.steps) && request.steps.some(claim));
  return hasClaim ? ["HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE"] : [];
}
