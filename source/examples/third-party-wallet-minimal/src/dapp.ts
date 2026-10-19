import type {
  TbcProvider,
  TbcProviderMethodMap,
} from "@tbc-wallet/provider";

export async function connectAndSendTbc(
  provider: TbcProvider,
  transfer: TbcProviderMethodMap["tbc_sendTransaction"]["params"],
): Promise<Readonly<{
  accounts: TbcProviderMethodMap["tbc_requestAccounts"]["result"];
  submitted: TbcProviderMethodMap["tbc_sendTransaction"]["result"];
}>> {
  const accounts = await provider.request({ method: "tbc_requestAccounts" });
  if (!accounts.includes(transfer.from)) {
    throw new Error("The transfer account was not authorized.");
  }
  const submitted = await provider.request({
    method: "tbc_sendTransaction",
    params: transfer,
  });
  return Object.freeze({ accounts, submitted });
}
