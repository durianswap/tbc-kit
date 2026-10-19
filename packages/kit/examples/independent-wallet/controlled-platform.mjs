import { secp256k1 } from "@noble/curves/secp256k1.js";

export const CHAIN_ID = "tbc:testnet";
export const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
export const RECIPIENT = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
export const ACCOUNT_ID = `${CHAIN_ID}:${ADDRESS}`;
export const PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
export const FT_CONTRACT_ID = "cd".repeat(32);
export const POOL_CONTRACT_ID = "ab".repeat(32);

const NATIVE_TXID = "11".repeat(32);

function envelope(data) {
  return new Response(JSON.stringify({ code: "200", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A deterministic, offline platform driver. It performs no network I/O; the
 * supplied fetch function answers only the public Testnet reads used below.
 */
export function createControlledPlatform() {
  const http = [];
  const fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    http.push(`${method} ${url.pathname}`);
    if (method !== "GET") throw new Error("Controlled independent wallet never broadcasts");
    if (url.pathname === "/api/tbc/nodeinfo") {
      return envelope({ blocks: 1000, bestblockhash: "aa".repeat(32) });
    }
    if (url.pathname === `/api/tbc/utxo/address/${ADDRESS}`) {
      return envelope({
        utxos: [{ txid: NATIVE_TXID, index: 0, value: "20000", height: 990 }],
      });
    }
    if (url.pathname === `/api/tbc/ft/info/contract/${FT_CONTRACT_ID}`) {
      return envelope({
        code_script: "01",
        tape_script: "02",
        amount: "1000000",
        decimal: 6,
        name: "Independent Token",
        symbol: "IDP",
      });
    }
    if (url.pathname === `/api/tbc/pool/poolinfo/poolid/${POOL_CONTRACT_ID}`) {
      return envelope({ ft_contract_id: FT_CONTRACT_ID });
    }
    throw new Error(`Unexpected controlled request: ${method} ${url.pathname}`);
  };

  // Test-only scalar 1. Production wallets replace this entire closure with
  // their Secure Enclave, Vault, hardware wallet, or audited native signer.
  const testOnlyKey = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 1 : 0));
  const signer = Object.freeze({
    async sign(params) {
      const signature = secp256k1.sign(params.task.digest, testOnlyKey, {
        prehash: false,
        lowS: true,
      });
      const recoverable = params.task.signatureEncoding === "compact65-recoverable";
      return Object.freeze({
        taskId: params.task.taskId,
        signatureEncoding: recoverable ? "compact65-recoverable" : "compact64",
        signature: recoverable
          ? `${(31 + signature.recovery).toString(16)}${signature.toCompactHex()}`
          : signature.toCompactHex(),
      });
    },
  });

  return Object.freeze({ fetch, signer, http });
}

export function createMemoryAssociatedJournal() {
  const records = new Map();
  const write = async (record) => {
    const current = records.get(record.operationDigest);
    if (current !== undefined && current.requestJson !== record.requestJson) return structuredClone(current);
    records.set(record.operationDigest, structuredClone(record));
    return structuredClone(records.get(record.operationDigest));
  };
  return Object.freeze({
    async read(operationDigest) {
      const record = records.get(operationDigest);
      return record === undefined ? null : structuredClone(record);
    },
    prepare: write,
    complete: write,
  });
}
