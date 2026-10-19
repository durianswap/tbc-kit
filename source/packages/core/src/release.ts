import {
  GENERATED_TWS_RELEASE,
  GENERATED_TWS_RELEASE_FINGERPRINT,
} from "./generated/v1-candidate-release.js";

export interface TwsProtocolRelease {
  readonly version: "1.0.0-candidate.3";
  readonly schemaBundleSha256: string;
  readonly registryBundleSha256: string;
}

export const TWS_RELEASE: TwsProtocolRelease = Object.freeze(
  GENERATED_TWS_RELEASE,
);

export const TWS_RELEASE_FINGERPRINT =
  GENERATED_TWS_RELEASE_FINGERPRINT;

// A protocol commit is assigned only when the Candidate is frozen at a clean
// repository commit. Null prevents pre-release worktree state from masquerading
// as an immutable release.
export const TWS_PROTOCOL_COMMIT = null;
