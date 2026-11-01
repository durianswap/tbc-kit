// Internal, fixed reasons only. Core independently allowlists public messages;
// arbitrary API/adapter exception text must never reach a DApp.
const messages = {
  SELECTED_INPUT_SPENT: "An explicitly selected transaction output is already spent",
  SELECTED_INPUT_UNAVAILABLE: "An explicitly selected transaction output is unavailable",
  INPUT_BUDGET_EXCEEDED: "The selected inputs exceed the configured input budget",
  CANDIDATE_LIMIT_EXCEEDED: "The funding candidate set exceeds the supported bound",
  NFT_NO_AVAILABLE_SLOT: "The collection has no available mint slot",
} as const;
export class MaterialBusinessError extends Error {
  constructor(readonly reason: keyof typeof messages) { super(messages[reason]); }
}
