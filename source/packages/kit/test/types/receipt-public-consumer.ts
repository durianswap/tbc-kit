import {
  TBC_ATOMIC_DECIMALS,
  TransferVerificationError,
  createTbcClient,
  createTransferVerifier,
  formatTbcAtomicAmount,
  parseTbcDisplayAmount,
  verifyTransfer,
  type TransferVerificationResult,
  type VerifyTransferOptions,
} from "../../dist/types/index.js";

declare const fetch: typeof globalThis.fetch;
declare const txid: string;
declare const address: string;
declare const contractId: string;

const native: VerifyTransferOptions = {
  network: "testnet",
  fetch,
  txid,
  recipient: { address },
  asset: { kind: "tbc" },
  amount: { mode: "exact", atomic: "1000000" },
  minimumConfirmations: "1",
};
const ft: VerifyTransferOptions = {
  ...native,
  asset: { kind: "ft", contractId },
  amount: { mode: "minimum", atomic: "1" },
};
const nft: VerifyTransferOptions = {
  network: "testnet",
  fetch,
  txid,
  recipient: { address },
  asset: { kind: "nft", contractId },
  minimumConfirmations: "0",
};
const lp: VerifyTransferOptions = {
  ...native,
  asset: { kind: "lp", contractId },
  amount: { mode: "minimum", atomic: "1" },
};

const result: Promise<TransferVerificationResult> = verifyTransfer(native);
const verifier = createTransferVerifier({ network: "mainnet", fetch });
const client = createTbcClient({ network: "testnet", api: { fetch } });
void [
  result,
  verifyTransfer(ft),
  verifyTransfer(nft),
  verifyTransfer(lp),
  formatTbcAtomicAmount("1", TBC_ATOMIC_DECIMALS),
  parseTbcDisplayAmount("0.000001", TBC_ATOMIC_DECIMALS),
  TransferVerificationError,
  verifier.verify({
    txid,
    recipient: { address },
    asset: { kind: "tbc" },
    minimumConfirmations: "0",
  }),
  client.verifyTransfer({
    txid,
    recipient: { address },
    asset: { kind: "nft", contractId },
    minimumConfirmations: "1",
  }),
];

// @ts-expect-error NFT is a unique singleton identity, not a fungible amount.
const invalidNft: VerifyTransferOptions = { ...nft, amount: { mode: "exact", atomic: "1" } };
void invalidNft;
