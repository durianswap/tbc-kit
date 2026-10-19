import {
  createLegacyCryptoService,
  createLegacyAssociatedTransactionService,
  createLegacyAssociatedTransactionSigningService,
  createTbcDefaultAssociatedTransactionReviewer,
  createTbcDefaultRawTransactionReviewer,
  createLegacyRawTransactionSigningService,
  createLegacyTbcBalanceReader,
  createLegacyWalletPrivateNativeAdapters,
  createTbcKitLegacyWebViewNativeController,
  createTbcNetworkContext,
  type LegacySecureOperationApproval,
  type LegacyAssociatedTransactionJournal,
  type LegacyWalletPrivateNativeBridge,
} from "../../dist/types/wallet.js";

declare const approval: LegacySecureOperationApproval;
declare const journal: LegacyAssociatedTransactionJournal;
declare const privateBridge: LegacyWalletPrivateNativeBridge;
const network = createTbcNetworkContext({ network: "testnet" });
const privateNative = createLegacyWalletPrivateNativeAdapters(privateBridge);

const rawTransactions = createLegacyRawTransactionSigningService({
  approval,
  authority: { async assertCurrent() {} },
  reviewer: createTbcDefaultRawTransactionReviewer({ network }),
  signer: privateNative.rawSigner,
});

const crypto = createLegacyCryptoService({
  approval,
  authority: { async assertCurrent() {} },
  adapter: privateNative.cryptoAdapter,
});

const balances = createLegacyTbcBalanceReader({ network });
const associatedTransactions = createLegacyAssociatedTransactionService({ journal });
const associatedSigning = createLegacyAssociatedTransactionSigningService({
  approval,
  authority: { async assertCurrent() {} },
  reviewer: createTbcDefaultAssociatedTransactionReviewer({ network }),
  transactions: associatedTransactions,
  executor: privateNative.associatedExecutor,
});

declare const base: Parameters<typeof createTbcKitLegacyWebViewNativeController>[0];
void createTbcKitLegacyWebViewNativeController({
  ...base,
  network,
  balances,
});
void [associatedSigning, rawTransactions, crypto];
