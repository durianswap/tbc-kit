import type { TbcTransactionRequest } from "@tbc-wallet/provider";
import { parseTbcAmount } from "./amounts.mjs";

export const TESTNET_CHAIN = "tbc:testnet";

export function makeTransfer(input: {
  from: string; to: string; amount: string; maxFee: string; requestId: string; now: number;
}): TbcTransactionRequest {
  const amount = parseTbcAmount(input.amount);
  const maxFee = parseTbcAmount(input.maxFee);
  if (!/^[1-9A-HJ-NP-Za-km-z]{26,35}$/.test(input.to)) throw new TypeError("请输入完整的 TBC 接收地址。");
  if (BigInt(amount) > 10_000_000n) throw new TypeError("当前测试用例最多发送 10 TBC。");
  if (BigInt(maxFee) > 10_000n) throw new TypeError("当前测试费用上限为 0.01 TBC。");
  return {
    version: "1.0", chainId: TESTNET_CHAIN, from: input.from, clientRequestId: input.requestId,
    intent: { type: "tbc.transfer", version: "1.0", to: input.to, amount },
    constraints: { expiresAt: new Date(input.now + 300_000).toISOString(), maxFee, feePreference: "standard" },
  };
}
