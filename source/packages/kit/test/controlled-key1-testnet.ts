import { bytesToHex } from "@tbc-wallet/core";
import { OFFICIAL_TBC_TESTNET_API_ORIGIN } from "../src/testnet-client.js";
import {
  parseTbcTransaction,
  turingTransactionId,
} from "../src/testnet-validation.js";
import fixtureJson from "./fixtures/controlled-pool-key1.json" with { type: "json" };
import { createControlledTestnetFetch } from "./controlled-testnet.js";

const TIP_HEIGHT = 1000;
const UTXO_HEIGHT = 990;
const FIXTURE = Object.freeze(fixtureJson);
const CREATION = parseTbcTransaction(FIXTURE.rawTransactions[FIXTURE.poolContractId]);
const FT_CREATION = parseTbcTransaction(FIXTURE.rawTransactions[FIXTURE.ftContractId]);
const CURRENT = parseTbcTransaction(FIXTURE.rawTransactions[FIXTURE.poolInfo.txid]);
const FT_CODE = FT_CREATION.outputs[0];
const FT_TAPE = FT_CREATION.outputs[1];

if (
  FIXTURE.address !== "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH" ||
  FIXTURE.poolInfo.ft_contract_id !== FIXTURE.ftContractId ||
  FIXTURE.poolInfo.vout !== 0 ||
  CURRENT.outputs[2]?.satoshis !== 500n ||
  CURRENT.outputs[4]?.satoshis !== 500n ||
  FT_CODE?.satoshis !== 500n ||
  FT_TAPE?.satoshis !== 0n ||
  Object.entries(FIXTURE.rawTransactions).some(([txid, raw]) => turingTransactionId(raw) !== txid)
) {
  throw new Error("Controlled key1 fixture identity mismatch");
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ code: "200", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function method(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function decoded(rawTransaction: string, txid: string) {
  const parsed = parseTbcTransaction(rawTransaction);
  return {
    txid,
    hex: rawTransaction,
    confirmations: TIP_HEIGHT - UTXO_HEIGHT + 1,
    vout: parsed.outputs.map((output, index) => ({
      n: index,
      valueSat: output.satoshis.toString(),
      scriptPubKey: { hex: bytesToHex(output.scriptPubKey), addresses: [] },
    })),
  };
}

export const CONTROLLED_KEY1_POOL = Object.freeze({
  address: FIXTURE.address,
  ftContractId: FIXTURE.ftContractId,
  poolContractId: FIXTURE.poolContractId,
});

export function createControlledKey1TestnetFetch(
  options: Readonly<{
    nativeUtxoSatoshis?: number;
    poolOperation?: "increase" | "remove" | "swap-to-token" | "swap-to-tbc";
    poolState?: "live" | "uninitialized";
  }> = {},
): typeof globalThis.fetch {
  const fallback = createControlledTestnetFetch({
    nativeUtxoSatoshis: options.nativeUtxoSatoshis,
  });
  const poolOperation = options.poolOperation ?? "increase";
  const poolState = options.poolState ?? "live";

  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const requestMethod = method(input, init);
    if (url.origin !== OFFICIAL_TBC_TESTNET_API_ORIGIN) {
      throw new Error("Unexpected controlled Testnet origin");
    }

    if (
      requestMethod === "GET" &&
      url.pathname === `/api/tbc/pool/poolinfo/poolid/${FIXTURE.poolContractId}`
    ) {
      return response(poolState === "uninitialized" ? {
        ...FIXTURE.poolInfo,
        lp_balance: "0",
        tbc_balance: "0",
        token_balance: "0",
        txid: FIXTURE.poolContractId,
        value: CREATION.outputs[0]!.satoshis.toString(),
      } : FIXTURE.poolInfo);
    }

    if (
      requestMethod === "GET" &&
      url.pathname === `/api/tbc/ft/info/contract/${FIXTURE.ftContractId}`
    ) {
      return response({
        code_script: bytesToHex(FT_CODE!.scriptPubKey),
        tape_script: bytesToHex(FT_TAPE!.scriptPubKey),
        amount: "10000000",
        decimal: 6,
        name: "Controlled Pool Token",
        symbol: "CPT",
      });
    }

    if (
      requestMethod === "GET" &&
      url.pathname.startsWith("/api/tbc/ft/utxo/combinescript/") &&
      url.pathname.endsWith(`/contract/${FIXTURE.ftContractId}`)
    ) {
      const utxos = ["remove", "swap-to-token"].includes(poolOperation)
        ? [{
            txid: FIXTURE.poolInfo.txid,
            index: 2,
            tbc_value: 500,
            ft_value: FIXTURE.poolInfo.token_balance,
          }]
        : [FIXTURE.ownerCandidate];
      return response({ utxos });
    }

    if (
      requestMethod === "GET" &&
      poolOperation === "remove" &&
      /^\/api\/tbc\/pool\/lputxo\/scriptpubkeyhash\/[0-9a-f]{64}$/u.test(url.pathname)
    ) {
      return response({
        utxos: [{
          txid: FIXTURE.poolInfo.txid,
          index: 4,
          tbc_balance: 500,
          lp_balance: FIXTURE.poolInfo.lp_balance,
          lock_time: 0,
        }],
      });
    }

    const txid = url.pathname.match(/^\/api\/tbc\/(?:txraw\/txid|decode\/txid)\/([0-9a-f]{64})$/u)?.[1];
    const raw = txid === undefined ? undefined : FIXTURE.rawTransactions[txid as keyof typeof FIXTURE.rawTransactions];
    if (requestMethod === "GET" && txid !== undefined && raw !== undefined) {
      return url.pathname.includes("/txraw/")
        ? response({ txraw: raw })
        : response(decoded(raw, txid));
    }

    return fallback(input, init);
  };
}
