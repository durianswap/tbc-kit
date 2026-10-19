import type { TbcProvider } from "../../dist/types/index.js";
import type { TbcProvider as PrivateProvider } from "../../../provider/dist/types/index.js";

declare const provider: TbcProvider;
declare const privateProvider: PrivateProvider;

const compatiblePrivateProvider: TbcProvider = privateProvider;

async function consumeTypedProvider(): Promise<void> {
  const account = await provider.request({
    method: "tbc_getAccount",
    params: {},
  });
  account.address satisfies string;

  const accounts = await provider.request({
    method: "tbc_accounts",
    params: [],
  });
  accounts[0] satisfies string | undefined;

  await provider.request({
    method: "wallet_requestPermissions",
    params: [
      {
        tbc_accounts: {
          chains: ["tbc:00000000000000000000000000000001"],
          maxAccounts: 1,
        },
      },
    ],
  });
}

void consumeTypedProvider;
void compatiblePrivateProvider;
