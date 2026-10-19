import { bytesToHex } from "@tbc-wallet/core";

const CONTROLLED_FT_CONTRACT_ID = "da4d797f6165cc433ea8a9bcb55f2ff0d086a0726b34bfec438b75c81428549c";
const CONTROLLED_POOL_CONTRACT_ID = "833314696679b62d7626ee4ebeb0256a0df09a0cd235f317559821617389e1e9";
const CONTROLLED_POOL_REMOVE_CONTRACT_ID = "8d51833710a6b1723cc1c1b684e31c0e38ffad7d9ae9673981c2ece4c84e205f";
import { OFFICIAL_TBC_TESTNET_API_ORIGIN } from "../src/testnet-client.js";
import {
  assertRawTransaction,
  assertTestnetAddress,
  parseTbcTransaction,
  turingTransactionId,
} from "../src/testnet-validation.js";
import controlledPool from "./fixtures/controlled-pool.json";
import controlledPoolRemove from "./fixtures/controlled-pool-remove.json";

const TIP_HEIGHT = 1000;
const UTXO_HEIGHT = 990;
const UTXO_SATOSHIS = 5000;

const CONTROLLED_POOL = Object.freeze({
  ...controlledPool,
  rawTransactions: Object.freeze(
    Object.fromEntries(
      Object.entries(controlledPool.rawTransactions).map(([txid, raw]) => [
        txid,
        assertRawTransaction(raw),
      ]),
    ),
  ),
});
const CONTROLLED_POOL_REMOVE = Object.freeze({
  ...controlledPoolRemove,
  rawTransactions: Object.freeze(
    Object.fromEntries(
      Object.entries(controlledPoolRemove.rawTransactions).map(
        ([txid, raw]) => [txid, assertRawTransaction(raw)],
      ),
    ),
  ),
});
const CONTROLLED_POOL_REMOVE_CURRENT_RAW =
  CONTROLLED_POOL_REMOVE.rawTransactions[CONTROLLED_POOL_REMOVE.poolInfo.txid];
const CONTROLLED_POOL_REMOVE_CURRENT =
  CONTROLLED_POOL_REMOVE_CURRENT_RAW === undefined
    ? undefined
    : parseTbcTransaction(CONTROLLED_POOL_REMOVE_CURRENT_RAW);
const CONTROLLED_POOL_REMOVE_POOL_FT_OUTPUT =
  CONTROLLED_POOL_REMOVE_CURRENT?.outputs[2];
const CONTROLLED_POOL_REMOVE_FTLP_OUTPUT =
  CONTROLLED_POOL_REMOVE_CURRENT?.outputs[4];
if (
  CONTROLLED_POOL_REMOVE.address !== CONTROLLED_POOL.address ||
  CONTROLLED_POOL_REMOVE.poolContractId !==
    CONTROLLED_POOL_REMOVE_CONTRACT_ID ||
  CONTROLLED_POOL_REMOVE.poolInfo.ft_contract_id !==
    CONTROLLED_POOL_REMOVE.ftContractId ||
  CONTROLLED_POOL_REMOVE.poolInfo.vout !== 0 ||
  CONTROLLED_POOL_REMOVE_POOL_FT_OUTPUT?.satoshis !== 500n ||
  CONTROLLED_POOL_REMOVE_FTLP_OUTPUT?.satoshis !== 500n ||
  Object.entries(CONTROLLED_POOL_REMOVE.rawTransactions).some(
    ([txid, raw]) => turingTransactionId(raw) !== txid,
  )
) {
  throw new Error("Controlled Pool remove fixture identity mismatch");
}
const CONTROLLED_POOL_CREATION_RAW =
  CONTROLLED_POOL.rawTransactions[CONTROLLED_POOL.poolContractId];
const CONTROLLED_POOL_CREATION =
  CONTROLLED_POOL_CREATION_RAW === undefined
    ? undefined
    : parseTbcTransaction(CONTROLLED_POOL_CREATION_RAW);
const CONTROLLED_POOL_CREATION_OUTPUT = CONTROLLED_POOL_CREATION?.outputs[0];
if (
  CONTROLLED_POOL.address !== "1LEF3thAWxd4WG8nvtjPb4An6kGCoweUu6" ||
  CONTROLLED_POOL.poolContractId !== CONTROLLED_POOL_CONTRACT_ID ||
  CONTROLLED_POOL.poolInfo.ft_contract_id !== CONTROLLED_POOL.ftContractId ||
  CONTROLLED_POOL.poolInfo.vout !== 0 ||
  CONTROLLED_POOL_CREATION_OUTPUT === undefined ||
  Object.entries(CONTROLLED_POOL.rawTransactions).some(
    ([txid, raw]) => turingTransactionId(raw) !== txid,
  )
) {
  throw new Error("Controlled Pool fixture identity mismatch");
}
const CONTROLLED_POOL_CREATION_VALUE =
  CONTROLLED_POOL_CREATION_OUTPUT?.satoshis.toString();
if (CONTROLLED_POOL_CREATION_VALUE === undefined) {
  throw new Error("Controlled Pool creation value is unavailable");
}
const CONTROLLED_FT_CREATION_RAW =
  CONTROLLED_POOL.rawTransactions[CONTROLLED_POOL.ftContractId];
const CONTROLLED_FT_CREATION =
  CONTROLLED_FT_CREATION_RAW === undefined
    ? undefined
    : parseTbcTransaction(CONTROLLED_FT_CREATION_RAW);
const CONTROLLED_FT_CODE = CONTROLLED_FT_CREATION?.outputs[0];
const CONTROLLED_FT_TAPE = CONTROLLED_FT_CREATION?.outputs[1];
if (
  CONTROLLED_POOL.ftContractId !== CONTROLLED_FT_CONTRACT_ID ||
  CONTROLLED_FT_CODE?.satoshis !== 500n ||
  CONTROLLED_FT_TAPE?.satoshis !== 0n
) {
  throw new Error("Controlled FT ancestry fixture identity mismatch");
}
const CONTROLLED_FT = Object.freeze({
  address: CONTROLLED_POOL.address,
  baseCodeScript: bytesToHex(CONTROLLED_FT_CODE.scriptPubKey),
  contractId: CONTROLLED_POOL.ftContractId,
  decimal: 6,
  name: "Controlled Pool Token",
  ownerCandidate: CONTROLLED_POOL.ownerCandidate,
  symbol: "CPT",
  tapeScript: bytesToHex(CONTROLLED_FT_TAPE.scriptPubKey),
  totalSupplyRaw: "10000000",
});
const CONTROLLED_FT_OWNER_HASH = assertTestnetAddress(
  CONTROLLED_FT.address,
).publicKeyHash;

interface ParentFixture {
  readonly address: string;
  readonly rawTransaction: string;
  readonly scriptPubKey: string;
  readonly txid: string;
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ code: "200", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function parentFixture(address: string, satoshis: number): ParentFixture {
  const scriptPubKey = assertTestnetAddress(address).scriptPubKey;
  const rawTransaction = [
    "0a000000",
    "01",
    "00".repeat(32),
    "00000000",
    "00",
    "ffffffff",
    "01",
    u64Hex(BigInt(satoshis)),
    (scriptPubKey.length / 2).toString(16).padStart(2, "0"),
    scriptPubKey,
    "00000000",
  ].join("");
  return Object.freeze({
    address,
    rawTransaction,
    scriptPubKey,
    txid: turingTransactionId(rawTransaction),
  });
}

function u64Hex(value: bigint): string {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setBigUint64(0, value, true);
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
}

function requestBody(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.body !== undefined && init.body !== null) return String(init.body);
  if (input instanceof Request) return input.text();
  return Promise.resolve("");
}

function decodedFixture(rawTransaction: string, txid: string) {
  const parsed = parseTbcTransaction(rawTransaction);
  return Object.freeze({
    txid,
    hex: rawTransaction,
    confirmations: TIP_HEIGHT - UTXO_HEIGHT + 1,
    vout: parsed.outputs.map((output, index) =>
      Object.freeze({
        n: index,
        valueSat: output.satoshis.toString(),
        scriptPubKey: Object.freeze({
          hex: bytesToHex(output.scriptPubKey),
          addresses: Object.freeze([]),
        }),
      }),
    ),
  });
}

export function createControlledTestnetFetch(
  options: Readonly<{
    nativeUtxoSatoshis?: number;
    poolOperation?: "increase" | "remove" | "swap-to-token" | "swap-to-tbc";
    poolState?: "live" | "uninitialized";
  }> = {},
): typeof globalThis.fetch {
  const parents = new Map<string, ParentFixture>();
  const submitted = new Set<string>();
  const nativeUtxoSatoshis = options.nativeUtxoSatoshis ?? UTXO_SATOSHIS;
  const poolState = options.poolState ?? "live";
  const poolOperation = options.poolOperation ?? "increase";
  if (!Number.isSafeInteger(nativeUtxoSatoshis) || nativeUtxoSatoshis <= 0) {
    throw new Error("Invalid controlled native UTXO value");
  }

  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== OFFICIAL_TBC_TESTNET_API_ORIGIN) {
      throw new Error("Unexpected controlled Testnet origin");
    }
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("Unexpected controlled Testnet request");
    }

    const method = requestMethod(input, init);
    if (
      (url.pathname ===
        `/api/tbc/pool/poolinfo/poolid/${CONTROLLED_POOL_CONTRACT_ID}` ||
        url.pathname ===
          `/api/tbc/pool/poolinfo/poolid/${CONTROLLED_POOL_REMOVE_CONTRACT_ID}`) &&
      method === "GET"
    ) {
      if (
        url.pathname.endsWith(CONTROLLED_POOL_REMOVE_CONTRACT_ID) &&
        !["remove", "swap-to-token", "swap-to-tbc"].includes(poolOperation)
      ) {
        throw new Error("Controlled Pool remove fixture is disabled");
      }
      return response(
        url.pathname.endsWith(CONTROLLED_POOL_REMOVE_CONTRACT_ID)
          ? CONTROLLED_POOL_REMOVE.poolInfo
          : poolState === "uninitialized"
            ? {
                ...CONTROLLED_POOL.poolInfo,
                lp_balance: "0",
                tbc_balance: "0",
                token_balance: "0",
                txid: CONTROLLED_POOL.poolContractId,
                value: CONTROLLED_POOL_CREATION_VALUE,
              }
            : CONTROLLED_POOL.poolInfo,
      );
    }

    if (
      url.pathname.startsWith("/api/tbc/ft/utxo/combinescript/") &&
      (url.pathname.endsWith(`/contract/${CONTROLLED_POOL.ftContractId}`) ||
        url.pathname.endsWith(
          `/contract/${CONTROLLED_POOL_REMOVE.ftContractId}`,
        )) &&
      method === "GET"
    ) {
      return response({
        utxos:
          url.pathname.endsWith(
            `/contract/${CONTROLLED_POOL_REMOVE.ftContractId}`,
          ) && poolOperation === "swap-to-tbc"
            ? [CONTROLLED_POOL_REMOVE.ownerCandidate]
            : ["remove", "swap-to-token"].includes(poolOperation) &&
                url.pathname.endsWith(
                  `/contract/${CONTROLLED_POOL_REMOVE.ftContractId}`,
                )
              ? [
                  {
                    txid: CONTROLLED_POOL_REMOVE.poolInfo.txid,
                    index: 2,
                    tbc_value: 500,
                    ft_value: CONTROLLED_POOL_REMOVE.poolInfo.token_balance,
                  },
                ]
              : [CONTROLLED_POOL.ownerCandidate],
      });
    }

    if (
      /^\/api\/tbc\/pool\/lputxo\/scriptpubkeyhash\/[0-9a-f]{64}$/u.test(
        url.pathname,
      ) &&
      method === "GET" &&
      poolOperation === "remove"
    ) {
      return response({
        utxos: [
          {
            txid: CONTROLLED_POOL_REMOVE.poolInfo.txid,
            index: 4,
            tbc_balance: 500,
            lp_balance: CONTROLLED_POOL_REMOVE.poolInfo.lp_balance,
            lock_time: 0,
          },
        ],
      });
    }

    const controlledPoolRawMatch = url.pathname.match(
      /^\/api\/tbc\/txraw\/txid\/([0-9a-f]{64})$/u,
    );
    if (controlledPoolRawMatch !== null && method === "GET") {
      const txid = controlledPoolRawMatch[1];
      const raw =
        txid === undefined
          ? undefined
          : CONTROLLED_POOL.rawTransactions[
              txid as keyof typeof CONTROLLED_POOL.rawTransactions
            ];
      const removeRaw =
        txid === undefined
          ? undefined
          : CONTROLLED_POOL_REMOVE.rawTransactions[
              txid as keyof typeof CONTROLLED_POOL_REMOVE.rawTransactions
            ];
      if (raw !== undefined || removeRaw !== undefined) {
        return response({ txraw: raw ?? removeRaw });
      }
    }

    if (
      (url.pathname ===
        `/api/tbc/ft/info/contract/${CONTROLLED_FT_CONTRACT_ID}` ||
        url.pathname ===
          `/api/tbc/ft/info/contract/${CONTROLLED_POOL_REMOVE.ftContractId}`) &&
      method === "GET"
    ) {
      if (url.pathname.endsWith(`/${CONTROLLED_POOL_REMOVE.ftContractId}`)) {
        const raw = CONTROLLED_POOL_REMOVE.rawTransactions[CONTROLLED_POOL_REMOVE.ftContractId];
        if (!raw) throw new Error("Missing controlled Pool FT issuance");
        const issuance = parseTbcTransaction(raw), tape = issuance.outputs[1]!.scriptPubKey;
        let supply = 0n;
        for (let at = 3; at < 51; at += 8)
          for (let n = 0; n < 8; n++) supply += BigInt(tape[at + n]!) << BigInt(8 * n);
        return response({ code_script: bytesToHex(issuance.outputs[0]!.scriptPubKey),
          tape_script: bytesToHex(tape), amount: supply.toString(), decimal: 6,
          name: "Controlled Pool FT", symbol: "CPFT" });
      }
      return response({
        code_script: CONTROLLED_FT.baseCodeScript,
        tape_script: CONTROLLED_FT.tapeScript,
        amount: CONTROLLED_FT.totalSupplyRaw,
        decimal: CONTROLLED_FT.decimal,
        name: CONTROLLED_FT.name,
        symbol: CONTROLLED_FT.symbol,
      });
    }

    if (
      url.pathname ===
        `/api/tbc/ft/utxo/combinescript/${CONTROLLED_FT_OWNER_HASH}00/contract/${CONTROLLED_FT_CONTRACT_ID}` &&
      method === "GET"
    ) {
      return response({
        utxos: [CONTROLLED_FT.ownerCandidate],
      });
    }

    if (url.pathname === "/api/tbc/nodeinfo" && method === "GET") {
      return response({
        blocks: TIP_HEIGHT,
        bestblockhash: "aa".repeat(32),
      });
    }

    const utxoMatch = url.pathname.match(
      /^\/api\/tbc\/utxo\/address\/([^/]+)$/u,
    );
    if (utxoMatch !== null && method === "GET") {
      const encodedAddress = utxoMatch[1];
      if (encodedAddress === undefined)
        throw new Error("Invalid controlled Testnet address");
      const address = decodeURIComponent(encodedAddress);
      const parent = parentFixture(address, nativeUtxoSatoshis);
      parents.set(parent.txid, parent);
      return response({
        utxos: [
          {
            txid: parent.txid,
            index: 0,
            value: nativeUtxoSatoshis,
            height: UTXO_HEIGHT,
          },
        ],
      });
    }

    const rawMatch = url.pathname.match(
      /^\/api\/tbc\/txraw\/txid\/([0-9a-f]{64})$/u,
    );
    if (rawMatch !== null && method === "GET") {
      const txid = rawMatch[1];
      if (txid === undefined)
        throw new Error("Invalid controlled Testnet transaction");
      const parent = parents.get(txid);
      if (parent === undefined)
        throw new Error("Unknown controlled Testnet transaction");
      return response({ txraw: parent.rawTransaction });
    }

    const decodeMatch = url.pathname.match(
      /^\/api\/tbc\/decode\/txid\/([0-9a-f]{64})$/u,
    );
    if (decodeMatch !== null && method === "GET") {
      const txid = decodeMatch[1];
      if (txid === undefined)
        throw new Error("Invalid controlled Testnet transaction");
      const parent = parents.get(txid);
      if (parent !== undefined) {
        return response({
          txid,
          hex: parent.rawTransaction,
          confirmations: TIP_HEIGHT - UTXO_HEIGHT + 1,
          vout: [
            {
              n: 0,
              valueSat: nativeUtxoSatoshis,
              scriptPubKey: {
                hex: parent.scriptPubKey,
                addresses: [parent.address],
              },
            },
          ],
        });
      }
      const controlledRaw =
        CONTROLLED_POOL.rawTransactions[
          txid as keyof typeof CONTROLLED_POOL.rawTransactions
        ];
      const controlledRemoveRaw =
        CONTROLLED_POOL_REMOVE.rawTransactions[
          txid as keyof typeof CONTROLLED_POOL_REMOVE.rawTransactions
        ];
      const controlledFixtureRaw = controlledRaw ?? controlledRemoveRaw;
      if (controlledFixtureRaw !== undefined) {
        return response(decodedFixture(controlledFixtureRaw, txid));
      }
      if (submitted.has(txid)) {
        return response({ txid, confirmations: 0 });
      }
      throw new Error("Unknown controlled Testnet transaction");
    }

    if (url.pathname === "/api/tbc/broadcasttx" && method === "POST") {
      let payload: unknown;
      try {
        payload = JSON.parse(await requestBody(input, init));
      } catch {
        throw new Error("Invalid controlled Testnet broadcast request");
      }
      if (
        payload === null ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        Reflect.ownKeys(payload).length !== 1 ||
        typeof Reflect.get(payload, "txraw") !== "string"
      ) {
        throw new Error("Invalid controlled Testnet broadcast request");
      }
      const rawTransaction = assertRawTransaction(
        Reflect.get(payload, "txraw"),
      );
      const txid = turingTransactionId(rawTransaction);
      submitted.add(txid);
      return response({ txid });
    }

    throw new Error("Unexpected controlled Testnet request");
  };
}

