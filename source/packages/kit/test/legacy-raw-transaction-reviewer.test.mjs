import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { hashCanonical } from "@tbc-wallet/core";
import { decodeTxRaw as decodePublishedTxRaw } from "tbc-tx-parser";
import tbcContract from "tbc-contract";

import { parseTbcTransaction, turingTransactionId } from "../dist/esm/api.js";
import {
  createTbcDefaultAssociatedTransactionReviewer,
  createTbcDefaultRawTransactionReviewer,
  createTbcNetworkContext,
  createWasmTbcKeylessEngine,
} from "../dist/esm/wallet.js";
import { REAL_FT_MINT_FIXTURE } from "./fixtures/real-ft-mint.mjs";
import { decodeTxRaw as decodePortableTxRaw } from "../dist/esm/vendor/tbc-tx-parser/index.js";
import { buildNftCodeScripts } from "../dist/esm/vendor/tbc-tx-parser/adapters/nft-code-scripts.js";

const SOURCE_TXID = "1a17f1e2ed29f27c29ca70bc1336e7c9b5ca9d8c33f37f9a0dab3d86b703da76";
const ORIGIN_TXID = "6f49bc706bc8e71edce4237e64f0bcf5e51f65189a07c54be41472c9218b2adf";
const CHAIN_ID = "tbc:testnet";
const materialNative = await createWasmTbcKeylessEngine(await readFile(new URL(
  '../artifacts/wasm/tbc_keyless_wasm.wasm', import.meta.url,
)));
const CONTEXT = Object.freeze({
  origin: "https://reviewer.test",
  chainId: CHAIN_ID,
  accountId: `${CHAIN_ID}:1LEF3thAWxd4WG8nvtjPb4An6kGCoweUu6`,
  sessionId: "reviewer-session",
  navigationId: "reviewer-navigation",
});

function littleEndian(value, bytes) {
  let remaining = BigInt(value);
  const output = [];
  for (let index = 0; index < bytes; index += 1) {
    output.push(Number(remaining & 0xffn).toString(16).padStart(2, "0"));
    remaining >>= 8n;
  }
  return output.join("");
}

function varint(value) {
  if (value < 0xfd) return value.toString(16).padStart(2, "0");
  if (value <= 0xffff) return `fd${littleEndian(value, 2)}`;
  return `fe${littleEndian(value, 4)}`;
}

function output(satoshis, script) {
  return `${littleEndian(satoshis, 8)}${varint(script.length / 2)}${script}`;
}

function selfTransferRaw(codeScript, tapeScript) {
  return [
    littleEndian(10, 4),
    "01",
    Buffer.from(SOURCE_TXID, "hex").reverse().toString("hex"),
    littleEndian(0, 4),
    "00",
    "ffffffff",
    "02",
    output(500, codeScript),
    output(0, tapeScript),
    littleEndian(0, 4),
  ].join("");
}

function statusEnvelope(rows) {
  return new Response(JSON.stringify({
    code: "200",
    message: "OK",
    data: { txos: rows },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function undefinedPaths(value, path = "$", paths = []) {
  if (value === undefined) {
    paths.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => undefinedPaths(entry, `${path}[${index}]`, paths));
  } else if (value !== null && typeof value === "object") {
    Object.entries(value).forEach(([key, entry]) => undefinedPaths(entry, `${path}.${key}`, paths));
  }
  return paths;
}

test("portable reviewer parser preserves the published parser result for real FT raw data", async () => {
  const source = parseTbcTransaction(REAL_FT_MINT_FIXTURE.sourceTxraw);
  const sourceTxid = ORIGIN_TXID;
  const inputUtxos = Object.freeze({
    [`${sourceTxid}:0`]: Object.freeze({
      txid: sourceTxid,
      outputIndex: 0,
      satoshis: Number(source.outputs[0].satoshis),
      lockingScript: Buffer.from(source.outputs[0].scriptPubKey).toString("hex"),
      associatedTape: Object.freeze({
        txid: sourceTxid,
        outputIndex: 1,
        satoshis: Number(source.outputs[1].satoshis),
        lockingScript: Buffer.from(source.outputs[1].scriptPubKey).toString("hex"),
      }),
    }),
  });
  const options = Object.freeze({ inputUtxos });
  assert.deepEqual(
    await decodePortableTxRaw(REAL_FT_MINT_FIXTURE.txraw, options),
    await decodePublishedTxRaw(REAL_FT_MINT_FIXTURE.txraw, options),
  );
});

test("portable reviewer parser preserves every canonical NFT code-script version", () => {
  const { NFT } = tbcContract;
  for (const vout of [0, 1, 0xffff_ffff]) {
    assert.deepEqual(buildNftCodeScripts(ORIGIN_TXID, vout), [
      NFT.buildCodeScript(ORIGIN_TXID, vout),
      NFT.buildCodeScript_v1(ORIGIN_TXID, vout),
      NFT.buildCodeScript_v0(ORIGIN_TXID, vout),
    ].map((script) => script.toBuffer().toString("hex").toLowerCase()));
  }
});

test("default raw reviewer uses trusted batched TXO material and the real parser for a confirmed FT contract", async () => {
  const source = parseTbcTransaction(REAL_FT_MINT_FIXTURE.txraw);
  assert.equal(turingTransactionId(REAL_FT_MINT_FIXTURE.txraw), SOURCE_TXID);
  const codeScript = Buffer.from(source.outputs[0].scriptPubKey).toString("hex");
  const tapeScript = Buffer.from(source.outputs[1].scriptPubKey).toString("hex");
  const origin = parseTbcTransaction(REAL_FT_MINT_FIXTURE.sourceTxraw).outputs[0];
  const originScript = Buffer.from(origin.scriptPubKey).toString("hex");
  const raw = selfTransferRaw(codeScript, tapeScript);
  const txid = turingTransactionId(raw);
  const calls = [];
  const reviewer = createTbcDefaultRawTransactionReviewer({
    materialNative,
    network: createTbcNetworkContext({ network: "testnet" }),
    async fetch(input, init) {
      assert.equal(new URL(String(input)).pathname, "/api/tbc/txo/status");
      const body = JSON.parse(String(init.body));
      calls.push(body);
      if (body.txos.length === 1 && body.txos[0].txid === SOURCE_TXID && body.txos[0].index === 0) {
        return statusEnvelope([{
          txid: SOURCE_TXID,
          index: "0",
          spent: false,
          value: "500",
          scriptPubKey: codeScript,
          height: "1",
        }]);
      }
      return statusEnvelope(body.txos.map(({ txid, index }) => txid === SOURCE_TXID && index === 1
        ? {
            txid: SOURCE_TXID,
            index: "1",
            spent: false,
            value: "0",
            scriptPubKey: tapeScript,
            height: "1",
          }
        : {
            txid: ORIGIN_TXID,
            index: "0",
            spent: false,
            value: origin.satoshis.toString(),
            scriptPubKey: originScript,
            height: "1",
          }));
    },
  });
  const request = Object.freeze({
    txraws: Object.freeze([raw]),
    utxos_satoshis: Object.freeze([Object.freeze([500])]),
    script_pubkeys: Object.freeze([Object.freeze([codeScript])]),
  });

  const [first, duplicate] = await Promise.all([
    reviewer.review({ request, context: CONTEXT, transactionIds: [txid] }),
    reviewer.review({ request, context: CONTEXT, transactionIds: [txid] }),
  ]);
  assert.deepEqual(first, duplicate);
  assert.deepEqual(undefinedPaths(first.preview), [], "default real FT preview contains no undefined value");
  const previewTransaction = first.preview.transactions[0];
  assert.deepEqual(
    {
      protocol: previewTransaction.classification.protocol,
      action: previewTransaction.classification.action,
      conformance: previewTransaction.classification.conformance,
    },
    { protocol: "ft", action: "transfer", conformance: "indeterminate" },
  );
  const ftGroup = previewTransaction.groups.find((group) => group.asset.type === "ft");
  assert.equal(Object.hasOwn(ftGroup.asset, "contractId"), false, "optional unknown contractId is omitted");
  assert.deepEqual(
    { symbol: ftGroup.asset.symbol, name: ftGroup.asset.name, decimal: ftGroup.asset.decimal },
    { symbol: "RFN", name: "parser-real-normal-1781250016969", decimal: 6 },
    "available FT identity remains approval-visible",
  );
  assert.equal(ftGroup.flows[0].amount.raw, "100000000000", "required FT amount remains approval-visible");
  assert.equal(ftGroup.flows[0].from.address, "171pqj2d5Ud1RYs5nbANiJGiZ1d2Da91SZ");
  assert.equal(ftGroup.flows[0].to.address, "171pqj2d5Ud1RYs5nbANiJGiZ1d2Da91SZ");
  assert.equal(ftGroup.flows[0].recognized, true);
  assert.equal(previewTransaction.txid, txid, "exact raw transaction identity remains approval-visible");
  assert.equal(calls.length, 2, "concurrent equal reviews share each of the two idempotent reads");
  assert.deepEqual(calls, [
    { txos: [{ txid: SOURCE_TXID, index: 0 }] },
    { txos: [
      { txid: SOURCE_TXID, index: 1 },
      { txid: ORIGIN_TXID, index: 0 },
    ] },
  ]);
  assert.deepEqual(first.verifiedInputs, [[{
    txid: SOURCE_TXID,
    vout: 0,
    satoshis: 500,
    scriptPubKey: codeScript,
    spent: false,
  }]]);
  const transaction = first.preview.transactions[0];
  assert.equal(transaction.txid, txid);
  assert.equal(transaction.classification.protocol, "ft");
  assert.notEqual(transaction.classification.conformance, "nonstandard");
  assert.ok(transaction.groups.length > 0);
  assert.ok(transaction.groups.every((group) =>
    group.flows.length > 0 && group.flows.every((flow) => flow.recognized === true)
  ));
});

test("default raw reviewer rejects stale material and missing contract dependencies before approval", async () => {
  const source = parseTbcTransaction(REAL_FT_MINT_FIXTURE.txraw);
  const codeScript = Buffer.from(source.outputs[0].scriptPubKey).toString("hex");
  const tapeScript = Buffer.from(source.outputs[1].scriptPubKey).toString("hex");
  const raw = selfTransferRaw(codeScript, tapeScript);
  const txid = turingTransactionId(raw);
  let missingTape = false;
  const reviewer = createTbcDefaultRawTransactionReviewer({
    materialNative,
    network: createTbcNetworkContext({ network: "testnet" }),
    async fetch(_input, init) {
      const body = JSON.parse(String(init.body));
      if (body.txos[0].index === 0) {
        return statusEnvelope([{
          txid: SOURCE_TXID,
          index: "0",
          spent: false,
          value: "500",
          scriptPubKey: codeScript,
        }]);
      }
      return statusEnvelope(missingTape ? [] : [{
        txid: SOURCE_TXID,
        index: "1",
        spent: false,
        value: "0",
        scriptPubKey: tapeScript,
      }]);
    },
  });
  const base = {
    txraws: [raw],
    utxos_satoshis: [[500]],
    script_pubkeys: [[codeScript]],
  };
  await assert.rejects(
    reviewer.review({
      request: { ...base, utxos_satoshis: [[501]] },
      context: CONTEXT,
      transactionIds: [txid],
    }),
    /trusted material mismatch/u,
  );
  missingTape = true;
  await assert.rejects(
    reviewer.review({ request: base, context: CONTEXT, transactionIds: [txid] }),
    /contract context unavailable/u,
  );
  await assert.rejects(
    reviewer.review({ request: base, context: { ...CONTEXT, chainId: "tbc:wrong" }, transactionIds: [txid] }),
    /network mismatch/u,
  );
});

test("default associated reviewer materializes child transactions and trusts only the constructed local chain", async () => {
  const prevTxid = "22".repeat(32);
  const sourceRaw = [
    littleEndian(10, 4),
    "01",
    Buffer.from(prevTxid, "hex").reverse().toString("hex"),
    littleEndian(0, 4),
    "00",
    "ffffffff",
    "01",
    output(900, "76a914d2eb868eee7a7ee4238e67a646f3caeca5ffc2c788ac"),
    littleEndian(0, 4),
  ].join("");
  const script = "76a914d2eb868eee7a7ee4238e67a646f3caeca5ffc2c788ac";
  const request = Object.freeze({
    sourceTxraw: sourceRaw,
    sourceUtxos: Object.freeze([Object.freeze({
      txId: prevTxid,
      outputIndex: 0,
      satoshis: 1_000,
      script,
      scriptSigType: "p2pkh",
    })]),
    inputs: Object.freeze([Object.freeze([Object.freeze({
      outputIndex: 0,
      scriptSigType: "p2pkh",
    })])]),
    outputs: Object.freeze([Object.freeze([Object.freeze({
      satoshis: 800,
      script,
    })])]),
  });
  let reads = 0;
  const reviewer = createTbcDefaultAssociatedTransactionReviewer({
    materialNative,
    network: createTbcNetworkContext({ network: "testnet" }),
    async fetch(_input, init) {
      reads += 1;
      const body = JSON.parse(String(init.body));
      assert.deepEqual(body, { txos: [{ txid: prevTxid, index: 0 }] });
      return statusEnvelope([{
        txid: prevTxid,
        index: "0",
        spent: false,
        value: "1000",
        scriptPubKey: script,
        height: "1",
      }]);
    },
  });
  const result = await reviewer.review({
    request,
    operationDigest: hashCanonical({ kind: "signAssociated", request }),
    context: CONTEXT,
  });
  assert.equal(reads, 1, "constructed child outputs never trigger a network lookup");
  assert.equal(result.preview.transactions.length, 2);
  assert.ok(result.preview.transactions.every((transaction) =>
    transaction.groups.length > 0 && transaction.groups.every((group) =>
      group.flows.length > 0 && group.flows.every((flow) => flow.recognized === true)
    )
  ));
  assert.equal(result.verifiedInputs[1][0].satoshis, 900);

  await assert.rejects(
    reviewer.review({
      request: {
        ...request,
        sourceUtxos: [{ ...request.sourceUtxos[0], scriptSigType: "tbc20_coin" }],
      },
      operationDigest: hashCanonical({
        kind: "signAssociated",
        request: {
          ...request,
          sourceUtxos: [{ ...request.sourceUtxos[0], scriptSigType: "tbc20_coin" }],
        },
      }),
      context: CONTEXT,
    }),
    /Unsupported Legacy associated signing type/u,
  );
});
