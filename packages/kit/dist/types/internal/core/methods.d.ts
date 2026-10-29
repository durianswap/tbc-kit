export type TwsMethodPath = "session-read" | "permission-read" | "account-read" | "permission-request" | "switch-chain" | "message-signing" | "sign-transaction" | "send-transaction" | "sign-workflow" | "send-workflow" | "wallet-action" | "disconnect";
export type TwsMethodCategory = "transaction" | "non-transaction";
export interface TwsMethodDefinition {
    readonly name: string;
    readonly version: "1.0";
    readonly profile: "core" | "defi";
    readonly authorizationMode: string;
    readonly permissions: readonly string[];
    readonly approval: string;
    readonly operationKind: string | null;
    readonly effect: string;
    readonly paramsKind: "none" | "named" | "positional";
    readonly path: TwsMethodPath;
    readonly category: TwsMethodCategory;
}
export declare const TWS_METHOD_DEFINITIONS: readonly TwsMethodDefinition[];
export declare function getTwsMethod(name: string): TwsMethodDefinition;
export declare function assertMethodParams(definition: TwsMethodDefinition, params: unknown): void;
//# sourceMappingURL=methods.d.ts.map