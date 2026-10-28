import {
  getTbcWallets,
  subscribeTbcWallets,
} from "./wallet-standard-browser.js";
import {
  createTbcClientWithWalletDiscovery,
  type CreateTbcClientOptions,
  type TbcClient,
} from "./client.js";

export function createTbcClient(options: CreateTbcClientOptions): TbcClient {
  return createTbcClientWithWalletDiscovery(options, {
    get: getTbcWallets,
    subscribe: (listener) => subscribeTbcWallets(listener),
  });
}

export type {
  CreateTbcClientOptions,
  TbcClient,
  TbcConnectedWallet,
  Tbc721MintJobInput,
  Tbc721SingleBatchMintInput,
  TbcConnectOptions,
  TbcDappMultiRoundMergeInput,
  TbcDappMultiRoundMergeResult,
  TbcEncodedMessage,
  TbcTypedDataInput,
  TbcWalletBuildInput,
  TbcWalletProposalInput,
  TbcWorkflowOrderedResult,
  TbcWorkflowOrderedStepResult,
  TbcWorkflowSendResult,
} from "./client.js";
