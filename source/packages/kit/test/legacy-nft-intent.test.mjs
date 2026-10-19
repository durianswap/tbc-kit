import assert from "node:assert/strict";
import test from "node:test";

import { createLegacyNftIntentResolver } from "../dist/esm/wallet.js";

const CHAIN_ID = "tbc:testnet";
const SOURCE = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const RECIPIENT = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
const COLLECTION_ID = "11".repeat(32);
const NFT_ID = "22".repeat(32);

test("Legacy collection, NFT mint and transfer map to the same canonical intents", async () => {
  const resolver = createLegacyNftIntentResolver({ chainId: CHAIN_ID });
  const collection = await resolver.resolve({
    flag: "COLLECTION_CREATE", broadcastEnabled: false,
    collection_data: JSON.stringify({
      collectionName: "Legacy Collection", description: "Canonical mapping", supply: 2,
      file: "ipfs://legacy-collection",
    }),
  }, SOURCE);
  assert.deepEqual(collection.intent, {
    type: "tbc.collection.create", version: "1.0", name: "Legacy Collection",
    description: "Canonical mapping", supply: "2",
    media: { kind: "uri", uri: "ipfs://legacy-collection" },
  });
  assert.match(collection.clientRequestId, /^legacy-nft:[0-9a-f]{64}$/u);

  const mint = await resolver.resolve({
    flag: "NFT_CREATE", collection_id: COLLECTION_ID, broadcastEnabled: false,
    nft_data: JSON.stringify({
      nftName: "Legacy NFT", symbol: "LNFT", description: "Canonical mapping",
      attributes: JSON.stringify([{ traitType: "rarity", value: "genesis" }]),
      file: "data:image/png;base64,AQIDBA==",
    }),
  }, SOURCE);
  assert.deepEqual(mint.intent, {
    type: "tbc.nft.mint", version: "1.0", collectionId: COLLECTION_ID,
    name: "Legacy NFT", symbol: "LNFT", description: "Canonical mapping",
    attributes: [{ traitType: "rarity", value: "genesis" }],
    media: {
      kind: "base64", mediaType: "image/png", data: "AQIDBA==",
      sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
    },
  });

  const transfer = await resolver.resolve({
    flag: "NFT_TRANSFER", nft_contract_address: NFT_ID, address: RECIPIENT,
  }, SOURCE);
  assert.deepEqual(transfer.intent, {
    type: "tbc.nft.transfer", version: "1.0", contractId: NFT_ID, to: RECIPIENT,
  });
});

test("Legacy NFT mapping rejects ambiguous bytes, hidden fields and invalid identities", async () => {
  const resolver = createLegacyNftIntentResolver({ chainId: CHAIN_ID });
  await assert.rejects(() => resolver.resolve({
    flag: "COLLECTION_CREATE",
    collection_data: JSON.stringify({ collectionName: "C", description: "D", supply: 1, file: "AQIDBA==" }),
  }, SOURCE));
  await assert.rejects(() => resolver.resolve({
    flag: "NFT_CREATE", collection_id: COLLECTION_ID,
    nft_data: JSON.stringify({ nftName: "N", symbol: "N", description: "D", attributes: "[]", hidden: true }),
  }, SOURCE), /Unsupported Legacy NFT field/u);
  await assert.rejects(() => resolver.resolve({
    flag: "NFT_TRANSFER", nft_contract_address: "not-a-contract", address: RECIPIENT,
  }, SOURCE));
  await assert.rejects(() => resolver.resolve({
    flag: "NFT_TRANSFER", nft_contract_address: NFT_ID, address: "not-an-address",
  }, SOURCE));
});
