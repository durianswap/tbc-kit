declare const messages: {
    readonly SELECTED_INPUT_SPENT: "An explicitly selected transaction output is already spent";
    readonly SELECTED_INPUT_UNAVAILABLE: "An explicitly selected transaction output is unavailable";
    readonly INPUT_BUDGET_EXCEEDED: "The selected inputs exceed the configured input budget";
    readonly CANDIDATE_LIMIT_EXCEEDED: "The funding candidate set exceeds the supported bound";
    readonly NFT_NO_AVAILABLE_SLOT: "The collection has no available mint slot";
};
export declare class MaterialBusinessError extends Error {
    readonly reason: keyof typeof messages;
    constructor(reason: keyof typeof messages);
}
export {};
