// Internal only: this is the existing checkpoint ownership set, shared with
// generated validators. No public export or caller-supplied trust marker.
// Only checkpoint.ts registers its cloned, validated, deeply frozen snapshots.
export const verifiedCheckpoints = new WeakSet<object>();
