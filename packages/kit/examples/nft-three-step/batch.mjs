import { createTbcClient } from '@tbc/kit';

/** Call explicitly after choosing the full immutable item list and fee limit.
 * No key access, automatic retries, confirmation claims or independent sends. */
export async function mintNftJob({ provider, network = 'testnet', collectionId, items, maxTotalFee, expiresAt }) {
  const wallet = await createTbcClient({ network, provider }).connect();
  return wallet.tbc721.batchMint({ collectionId, items,
    limits: { maxTotalFee, expiresAt, maxItemsPerBatch: 100 } });
}

export async function transferNftBatch({ provider, network = 'testnet', transfers, maxFee, expiresAt }) {
  const wallet = await createTbcClient({ network, provider }).connect();
  return wallet.tbc721.batchTransfer({ transfers, constraints: { maxFee, expiresAt } });
}
