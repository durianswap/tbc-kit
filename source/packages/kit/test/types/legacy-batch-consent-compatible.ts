import type { KitHostEvidenceReader } from "../../dist/types/sqlite.js";
import {
  createLegacyBatchConsentMachine,
  type LegacyBatchConsentIntent,
  type TbcKitWebViewVerifiedNavigation,
} from "../../dist/types/wallet.js";

interface MobileApprovalBindingPayload {
  readonly version: "1.0";
  readonly method: string;
  readonly operationKind: "message" | "permission" | "typedData";
  readonly contextHash: string;
  readonly origin: string;
  readonly sessionId: string;
  readonly chainId?: string;
  readonly chainIds?: readonly string[];
  readonly accountId?: string;
  readonly requestHash: string;
  readonly operationHash: string;
  readonly expiresAt: string;
}

interface MobileApprovalIntentRecord {
  readonly intentId: string;
  readonly callId: string;
  readonly params: Readonly<{
    readonly binding: Readonly<{
      readonly bindingHash: string;
      readonly payload: MobileApprovalBindingPayload;
    }>;
    readonly preview: Readonly<{
      readonly operationKind: string;
      readonly transactionCount?: number;
      readonly totalFee?: string;
    }>;
  }>;
  readonly facts: Readonly<{
    readonly operationKind: "message" | "permission" | "transaction" | "typedData";
    readonly method: string;
    readonly contextHash: string;
    readonly requestHash: string;
    readonly operationHash: string;
    readonly previewHash: string;
    readonly expiresAt: string;
    readonly accountId?: string;
    readonly chainId?: string;
  }>;
  readonly createdAt: string;
  readonly decision?: Readonly<{
    readonly status: "approved" | "rejected";
    readonly approvalId?: string;
  }>;
}

declare const store: KitHostEvidenceReader;
declare const intent: MobileApprovalIntentRecord;
declare const navigation: TbcKitWebViewVerifiedNavigation;

const compatibleIntent: LegacyBatchConsentIntent = intent;

const machine = createLegacyBatchConsentMachine({
  store,
  journal: {
    async readIntent(): Promise<MobileApprovalIntentRecord | null> {
      return intent;
    },
  },
  readAccount: async () => "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  presentRequest: async () => undefined,
  createConflictError: (message) => new TypeError(message),
});

void machine.prepare(
  navigation,
  "request",
  "tbc:testnet",
  { message: "{}", encoding: "utf8" },
);
void machine.authorizeRequest(intent);
void machine.review(compatibleIntent);
