import { createTbcClient } from "@tbc/kit";

/**
 * Burns the wallet-selected whole FTLP outputs for one Pool. The DApp cannot
 * choose an amount, receiver, fee input, outpoint, or confirmation shortcut.
 */
export async function burnFtlp(provider, poolContractId) {
  const wallet = await createTbcClient({ network: "testnet", provider }).connect();
  return wallet.tbc20Lp.burn({ poolContractId });
}
