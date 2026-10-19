import {
  createLegacyAssociatedTransactionService,
  createLegacyFtTransferIntentResolver,
  createLegacyPoolIntentResolver,
  createTbcKitLegacyWebViewNativeController,
  createTbcLegacyMetadataResolver,
  createTbcNetworkContext,
  type LegacyAssociatedTransactionJournal,
  type LegacyFtCreateIntentResolver,
  type LegacyFtTransferIntentResolver,
  type LegacyPoolIntentResolver,
  type LegacyStandardWorkflowBatchAdapter,
  type TbcKitLegacyBitcoinMessagePreparer,
  type TbcKitLegacyTransactionContextReader,
  type TbcKitWebViewNativeHandlers,
  type TbcKitWebViewVerifiedNavigation,
} from "../../dist/types/wallet.js";

declare const navigation: TbcKitWebViewVerifiedNavigation;
declare const handlers: TbcKitWebViewNativeHandlers;
declare const bitcoinMessages: TbcKitLegacyBitcoinMessagePreparer;
declare const intents: LegacyFtTransferIntentResolver;
declare const ftCreateIntents: LegacyFtCreateIntentResolver;
declare const poolIntents: LegacyPoolIntentResolver;
declare const readTransactionContext: TbcKitLegacyTransactionContextReader;
declare const genericBatch: LegacyStandardWorkflowBatchAdapter;
declare const fetch: typeof globalThis.fetch;
declare const associatedJournal: LegacyAssociatedTransactionJournal;

const network = createTbcNetworkContext({ network: "testnet" });
const metadata = createTbcLegacyMetadataResolver({ network, fetch });
const defaultFtIntents = createLegacyFtTransferIntentResolver({
  chainId: network.chainId,
  metadata,
});
const defaultPoolIntents = createLegacyPoolIntentResolver({
  chainId: network.chainId,
  metadata,
});
const associatedTransactions = createLegacyAssociatedTransactionService({
  journal: associatedJournal,
});
void [defaultFtIntents, defaultPoolIntents];

const controller = createTbcKitLegacyWebViewNativeController({
  navigation,
  chainId: "tbc:testnet",
  platform: "ios",
  walletVersion: "mobile-candidate",
  handlers,
  bitcoinMessages,
  genericBatch,
  transactions: {
    ftCreateIntents,
    ftTransferIntents: intents,
    poolIntents,
    readTransactionContext,
  },
  post: () => undefined,
});

const params = {
  flag: "FT_TRANSFER",
  broadcastEnabled: false,
};
if (controller.supportsRequest("sendTransaction", params)) {
  void controller.acceptPageMessage("serialized-page-message");
}
