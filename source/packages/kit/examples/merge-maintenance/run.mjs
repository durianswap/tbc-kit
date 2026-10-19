import { createTbcClient } from "@tbc/kit";

/**
 * The DApp identifies only the asset family. The wallet selects a bounded,
 * deterministic input set, shows one approval, signs, and broadcasts once.
 */
export async function runMergeMaintenance(provider, { ftContractId, poolContractId }) {
  const wallet = await createTbcClient({ network: "testnet", provider }).connect();
  return Object.freeze({
    tbc: await wallet.tbc.merge(),
    ft: await wallet.tbc20.merge({ contractId: ftContractId }),
    poolFt: await wallet.amm.mergeToken({ poolContractId }),
    ftlp: await wallet.tbc20Lp.merge({ poolContractId }),
  });
}
