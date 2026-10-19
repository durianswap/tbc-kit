import {
  createLegacyAssociatedTransactionService,
  createLegacyStandardWorkflowBatchAdapter,
  createLegacyFtTransferIntentResolver,
  createLegacyPoolIntentResolver,
  createTbcLegacyMetadataResolver,
} from "@tbc/kit/wallet";

/** Current route: public mapping only; Standard Host owns approval and signing. */
export function createStandardLegacyDefaults({ network, fetch, standard }) {
  const metadata = createTbcLegacyMetadataResolver({ network, fetch });
  return Object.freeze({
    metadata,
    genericBatch: createLegacyStandardWorkflowBatchAdapter({ ...standard, chainId: network.chainId }),
    transactions: Object.freeze({
      ftTransferIntents: createLegacyFtTransferIntentResolver({ chainId: network.chainId, metadata }),
      poolIntents: createLegacyPoolIntentResolver({ chainId: network.chainId, metadata }),
    }),
  });
}

/**
 * @deprecated Historical reference only; not wired into the current controller.
 * Wallet bootstrap: the network context selects one trusted source, while the
 * platform supplies fetch and durable journal drivers.
 */
export function createSharedLegacyDefaults({
  network,
  fetch,
  associatedJournal,
}) {
  const metadata = createTbcLegacyMetadataResolver({ network, fetch });
  const associatedTransactions = createLegacyAssociatedTransactionService({
    journal: associatedJournal,
  });
  return Object.freeze({
    metadata,
    associatedTransactions,
    ftTransfers: createLegacyFtTransferIntentResolver({
      chainId: network.chainId,
      metadata,
    }),
    pools: createLegacyPoolIntentResolver({
      chainId: network.chainId,
      metadata,
    }),
  });
}

/**
 * @deprecated Historical reference only; use Standard Reviewed execution.
 * Called only from the wallet's approved Signer path. `executeWalletNative`
 * owns native unlock and key custody; Kit receives only public request
 * material and the resulting raw transactions.
 */
export async function completeAssociatedFromWalletSigner({
  associatedTransactions,
  operationDigest,
  executeWalletNative,
}) {
  const request = await associatedTransactions.readRequest(operationDigest);
  if (request === null) throw new Error("Unknown associated transaction");
  const result = await executeWalletNative(request);
  return associatedTransactions.complete(operationDigest, result);
}
