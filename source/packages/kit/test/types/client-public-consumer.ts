import type {
  KitExpiringTransactionConstraints,
  TbcConnectedWallet,
} from "../../dist/types/index.js";

declare const wallet: TbcConnectedWallet;

const expiring = {
  expiresAt: "2099-09-20T04:00:00Z",
  maxFee: "5000",
} satisfies KitExpiringTransactionConstraints;

void wallet.pool.buy({
  poolContractId: "22".repeat(32),
  receiver: wallet.account,
  tbcAmount: "1000",
  minimumFtAmount: "1",
  constraints: expiring,
});

void wallet.pool.sell({
  poolContractId: "22".repeat(32),
  receiver: wallet.account,
  ftAmount: "1000",
  minimumTbcAmount: "1",
  constraints: { expiresAt: "2099-09-20T04:00:00Z" },
});

// @ts-expect-error Direct Pool swaps require a caller-selected replay deadline.
void wallet.pool.buy({
  poolContractId: "22".repeat(32),
  receiver: wallet.account,
  tbcAmount: "1000",
  minimumFtAmount: "1",
});

// Non-swap methods retain optional constraints.
void wallet.sendTbc({ to: wallet.account, amount: "1" });

void wallet.walletBuild.signWorkflow({
  clientRequestId: "workflow-direct",
  steps: [{
    id: "send",
    kind: "transaction",
    dependsOn: [],
    intent: {
      version: "1.0",
      type: "tbc.transfer",
      to: wallet.account,
      amount: "1",
    },
  }],
});

void wallet.crypto.encrypt({
  message: { encoding: "utf8", data: "hello" },
});

void wallet.crypto.decrypt({
  ciphertext: "QklFMQ==".repeat(32),
});
