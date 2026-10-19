import { createTbcClient } from "@tbc/kit";

function submittedTxid(result, label) {
  const submitted = result?.transactions?.filter((item) => item?.role === "primary" && item?.status === "submitted");
  if (submitted?.length !== 1 || !/^[0-9a-f]{64}$/u.test(submitted[0].txid)) {
    throw new Error(`${label} did not return one submitted primary transaction`);
  }
  return submitted[0].txid;
}

/**
 * The wallet owns approval, signing, indexing visibility and broadcast recovery.
 * The DApp carries forward submitted identities; submission is not confirmation.
 */
export async function runNftThreeStep(provider) {
  const wallet = await createTbcClient({ network: "testnet", provider }).connect();
  const collectionResult = await wallet.tbc721.createCollection({
    name: "Example Collection",
    description: "One public Kit NFT flow",
    supply: "1",
    media: { kind: "uri", uri: "ipfs://replace-with-collection-metadata" },
  });
  const collectionId = submittedTxid(collectionResult, "collection create");

  const mintResult = await wallet.tbc721.mint({
    collectionId,
    slot: 1,
    name: "Example NFT",
    symbol: "ENFT",
    description: "Minted through the canonical Kit intent",
    attributes: [{ traitType: "edition", value: 1 }],
  });
  const contractId = submittedTxid(mintResult, "NFT mint");

  const transferResult = await wallet.tbc721.transfer({
    contractId,
    to: wallet.account,
  });
  return Object.freeze({ collectionId, contractId, transferTxid: submittedTxid(transferResult, "NFT transfer") });
}
