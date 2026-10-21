import { createHash } from "node:crypto";

// Explicit known outputs from the original signed TBC transfer vector. This
// adapts only the later approval envelope; it never calls the Engine under test
// and never replaces the original unsigned bytes, digest, signature or txid.
const outputs = [
  { kind: "native", outputIndices: [0], amountAtomic: "1000", nativeValueAtomic: "1000",
    recipient: "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP", warnings: [] },
  { kind: "native", outputIndices: [1], amountAtomic: "8920", nativeValueAtomic: "8920",
    recipient: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", warnings: [] },
];
const sorted = value => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
const hash = value => createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
export function withOutputReview(input) {
  const fixture = structuredClone(input);
  fixture.plan.payload.transactions[0].outputReview = structuredClone(outputs);
  fixture.plan.planHash = hash(fixture.plan.payload);
  fixture.binding.payload.operationHash = fixture.plan.planHash;
  fixture.binding.bindingHash = hash(fixture.binding.payload);
  fixture.approval.bindingHash = fixture.binding.bindingHash;
  return fixture;
}
