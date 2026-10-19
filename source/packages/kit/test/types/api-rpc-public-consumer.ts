import {
  createTbcOfficialApi,
  type TbcDecimalInteger,
  type TbcAttemptEvent,
  type TbcRetryPolicy,
} from "../../dist/types/api.js";
import {
  createTbcNodeAdminRpcClient,
  createTbcReadRpcClient,
  createTbcWalletRpcClient,
} from "../../dist/types/rpc.js";

declare const fetch: typeof globalThis.fetch;

const retryPolicy: TbcRetryPolicy = { maxAttempts: 4, baseDelayMs: 25, maxDelayMs: 1_000, jitter: "full" };
const onAttempt = (event: TbcAttemptEvent) => {
  if (event.type === "retry") { const delay: number = event.delayMs; void delay; }
  else { const duration: number = event.durationMs; void duration; }
};
const api = createTbcOfficialApi({ network: "testnet", fetch, retryPolicy, totalTimeoutMs: 30_000, onAttempt });
const health: Promise<{ readonly tip_height: TbcDecimalInteger }> = api.health();
const raw = api.rawTransaction({ txid: "11".repeat(32) });
const ft = api.ftUtxosByCombineScript({
  combine_script: "00",
  contract_id: "22".repeat(32),
  limit: 10,
});

const read = createTbcReadRpcClient({ url: "https://rpc.example", fetch, retryPolicy, totalTimeoutMs: 30_000, onAttempt });
const height: Promise<string> = read.getblockcount();
const block = read.getblock({ blockhash: "33".repeat(32), verbose: true });

const admin = createTbcNodeAdminRpcClient({
  url: "https://rpc.example",
  fetch,
  trustedServer: true,
});
const stop = admin.stop();

const wallet = createTbcWalletRpcClient({
  url: "https://rpc.example/wallet/primary",
  fetch,
  trustedServer: true,
});
const balances = wallet.listunspent({ minconf: "0" });

void [health, raw, ft, height, block, stop, balances];

// @ts-expect-error Public read RPC excludes node management calls.
read.stop();
// @ts-expect-error This method is registered only on regtest and stays on the trusted admin surface.
read.waitaftervalidatingblock({ blockhash: "44".repeat(32), action: "wait" });
// @ts-expect-error Named parameters must match the v3.3.1 registration table.
read.getblock({ height: 1 });
// @ts-expect-error API path parameters are endpoint-specific.
api.rawTransaction({ hash: "11".repeat(32) });
