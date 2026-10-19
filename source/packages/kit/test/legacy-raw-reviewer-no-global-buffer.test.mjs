import assert from "node:assert/strict";
import { Buffer as PortableBuffer } from "node:buffer";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const SOURCE_TXID = "1a17f1e2ed29f27c29ca70bc1336e7c9b5ca9d8c33f37f9a0dab3d86b703da76";
const ORIGIN_TXID = "6f49bc706bc8e71edce4237e64f0bcf5e51f65189a07c54be41472c9218b2adf";
const CHAIN_ID = "tbc:testnet";

function littleEndian(value, bytes) {
  let remaining = BigInt(value);
  const output = [];
  for (let index = 0; index < bytes; index += 1) {
    output.push(Number(remaining & 0xffn).toString(16).padStart(2, "0"));
    remaining >>= 8n;
  }
  return output.join("");
}

function output(satoshis, script) {
  const length = script.length / 2;
  const encodedLength = length < 0xfd
    ? length.toString(16).padStart(2, "0")
    : `fd${littleEndian(length, 2)}`;
  return `${littleEndian(satoshis, 8)}${encodedLength}${script}`;
}

function selfTransferRaw(codeScript, tapeScript) {
  return [
    littleEndian(10, 4),
    "01",
    PortableBuffer.from(SOURCE_TXID, "hex").reverse().toString("hex"),
    littleEndian(0, 4),
    "00",
    "ffffffff",
    "02",
    output(500, codeScript),
    output(0, tapeScript),
    littleEndian(0, 4),
  ].join("");
}

function statusEnvelope(rows, url) {
  const body = JSON.stringify({ code: "200", message: "OK", data: { txos: rows } });
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null },
    text: async () => body,
  };
}

test("default real FT reviewer executes without a global Buffer", async () => {
  const originalBuffer = globalThis.Buffer;
  try {
    globalThis.Buffer = undefined;
    const [{ parseTbcTransaction, turingTransactionId }, wallet, fixture] = await Promise.all([
      import("../dist/esm/api.js"),
      import("../dist/esm/wallet.js"),
      import("./fixtures/real-ft-mint.mjs"),
    ]);
    const source = parseTbcTransaction(fixture.REAL_FT_MINT_FIXTURE.txraw);
    const codeScript = PortableBuffer.from(source.outputs[0].scriptPubKey).toString("hex");
    const tapeScript = PortableBuffer.from(source.outputs[1].scriptPubKey).toString("hex");
    const origin = parseTbcTransaction(fixture.REAL_FT_MINT_FIXTURE.sourceTxraw).outputs[0];
    const originScript = PortableBuffer.from(origin.scriptPubKey).toString("hex");
    const raw = selfTransferRaw(codeScript, tapeScript);
    const reviewer = wallet.createTbcDefaultRawTransactionReviewer({
      materialNative: await wallet.createWasmTbcKeylessEngine(Uint8Array.from(await readFile(
        new URL('../artifacts/wasm/tbc_keyless_wasm.wasm', import.meta.url),
      ))),
      network: wallet.createTbcNetworkContext({ network: "testnet" }),
      async fetch(_input, init) {
        const body = JSON.parse(String(init.body));
        return statusEnvelope(body.txos.map(({ txid, index }) => txid === SOURCE_TXID && index === 0
          ? { txid, index: "0", spent: false, value: "500", scriptPubKey: codeScript, height: "1" }
          : txid === SOURCE_TXID && index === 1
            ? { txid, index: "1", spent: false, value: "0", scriptPubKey: tapeScript, height: "1" }
            : { txid: ORIGIN_TXID, index: "0", spent: false, value: origin.satoshis.toString(), scriptPubKey: originScript, height: "1" }), String(_input));
      },
    });
    const result = await reviewer.review({
      request: {
        txraws: [raw],
        utxos_satoshis: [[500]],
        script_pubkeys: [[codeScript]],
      },
      context: {
        origin: "https://bufferless.test",
        chainId: CHAIN_ID,
        accountId: `${CHAIN_ID}:1LEF3thAWxd4WG8nvtjPb4An6kGCoweUu6`,
        sessionId: "bufferless-session",
        navigationId: "bufferless-navigation",
      },
      transactionIds: [turingTransactionId(raw)],
    });
    assert.equal(result.preview.transactions[0].classification.protocol, "ft");
  } finally {
    globalThis.Buffer = originalBuffer;
  }
});

test("browser-resolved Buffer executes the parser uint64 path without a global Buffer", async () => {
  const originalBuffer = globalThis.Buffer;
  const directory = await mkdtemp(path.join(tmpdir(), "tbc-kit-browser-buffer-"));
  try {
    globalThis.Buffer = undefined;
    const parserEntry = new URL("../dist/esm/vendor/tbc-tx-parser/index.js", import.meta.url).pathname;
    const bundled = await build({
      bundle: true,
      format: "esm",
      nodePaths: (process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean),
      platform: "browser",
      stdin: {
        contents: `
          import { Buffer } from "buffer";
          const originalSubarray = Buffer.prototype.subarray;
          Buffer.prototype.subarray = function (...args) {
            const result = originalSubarray.apply(this, args);
            return new Uint8Array(result);
          };
          export { decodeTxRaw } from ${JSON.stringify(parserEntry)};
          export { parseTbcTransaction, turingTransactionId } from ${JSON.stringify(new URL("../dist/esm/api.js", import.meta.url).pathname)};
          export { createTbcDefaultRawTransactionReviewer, createTbcNetworkContext, createWasmTbcKeylessEngine } from ${JSON.stringify(new URL("../dist/esm/wallet.js", import.meta.url).pathname)};
        `,
        resolveDir: new URL("..", import.meta.url).pathname,
        sourcefile: "candidate95-browser-parser-entry.mjs",
      },
      write: false,
    });
    const output = path.join(directory, "parser.mjs");
    await writeFile(output, bundled.outputFiles[0].contents);
    const [browserKit, api, fixture] = await Promise.all([
      import(`${pathToFileURL(output).href}?candidate=93`),
      import("../dist/esm/api.js"),
      import("./fixtures/real-ft-mint.mjs"),
    ]);
    const source = api.parseTbcTransaction(fixture.REAL_FT_MINT_FIXTURE.sourceTxraw);
    const decoded = await browserKit.decodeTxRaw(fixture.REAL_FT_MINT_FIXTURE.txraw, {
      inputUtxos: {
        [`${ORIGIN_TXID}:0`]: {
          txid: ORIGIN_TXID,
          outputIndex: 0,
          satoshis: Number(source.outputs[0].satoshis),
          lockingScript: PortableBuffer.from(source.outputs[0].scriptPubKey).toString("hex"),
          associatedTape: {
            txid: ORIGIN_TXID,
            outputIndex: 1,
            satoshis: Number(source.outputs[1].satoshis),
            lockingScript: PortableBuffer.from(source.outputs[1].scriptPubKey).toString("hex"),
          },
        },
      },
    });
    assert.equal(decoded.txid, SOURCE_TXID);
    assert.ok(decoded.chain.outputs.length > 0);
    const reviewedSource = browserKit.parseTbcTransaction(fixture.REAL_FT_MINT_FIXTURE.txraw);
    const codeScript = PortableBuffer.from(reviewedSource.outputs[0].scriptPubKey).toString("hex");
    const tapeScript = PortableBuffer.from(reviewedSource.outputs[1].scriptPubKey).toString("hex");
    const originScript = PortableBuffer.from(source.outputs[0].scriptPubKey).toString("hex");
    const raw = selfTransferRaw(codeScript, tapeScript);
    const reviewer = browserKit.createTbcDefaultRawTransactionReviewer({
      materialNative: await browserKit.createWasmTbcKeylessEngine(Uint8Array.from(await readFile(
        new URL('../artifacts/wasm/tbc_keyless_wasm.wasm', import.meta.url),
      ))),
      network: browserKit.createTbcNetworkContext({ network: "testnet" }),
      async fetch(input, init) {
        const body = JSON.parse(String(init.body));
        return statusEnvelope(body.txos.map(({ txid, index }) => txid === SOURCE_TXID && index === 0
          ? { txid, index: "0", spent: false, value: "500", scriptPubKey: codeScript, height: "1" }
          : txid === SOURCE_TXID && index === 1
            ? { txid, index: "1", spent: false, value: "0", scriptPubKey: tapeScript, height: "1" }
            : { txid: ORIGIN_TXID, index: "0", spent: false, value: source.outputs[0].satoshis.toString(), scriptPubKey: originScript, height: "1" }), String(input));
      },
    });
    const review = await reviewer.review({
      request: { txraws: [raw], utxos_satoshis: [[500]], script_pubkeys: [[codeScript]] },
      context: {
        origin: "https://typed-array.test",
        chainId: CHAIN_ID,
        accountId: `${CHAIN_ID}:1LEF3thAWxd4WG8nvtjPb4An6kGCoweUu6`,
        sessionId: "typed-array-session",
        navigationId: "typed-array-navigation",
      },
      transactionIds: [browserKit.turingTransactionId(raw)],
    });
    assert.equal(review.preview.transactions[0].classification.protocol, "ft");
    assert.doesNotMatch(
      await readFile(new URL("../dist/esm/vendor/tbc-tx-parser/decode-tx-raw.js", import.meta.url), "utf8"),
      /prevTxRaw\.copy/u,
    );
  } finally {
    globalThis.Buffer = originalBuffer;
    await rm(directory, { recursive: true, force: true });
  }
});

test("CJS scoped Buffer bindings preserve the original strict directive", async () => {
  const root = new URL("../dist/cjs/vendor/tbc-tx-parser/vendor/tbc-lib-js/", import.meta.url);
  const pending = [root];
  let checked = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const url = new URL(entry.name, directory);
      if (entry.isDirectory()) {
        pending.push(new URL(`${entry.name}/`, directory));
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const source = await readFile(url, "utf8");
        if (source.includes("var Buffer = require('buffer').Buffer;")) {
          checked += 1;
          assert.doesNotMatch(
            source,
            /^var Buffer = require\('buffer'\)\.Buffer;\r?\n(?:'use strict'|"use strict");?/u,
          );
          if (/^(?:'use strict'|"use strict");?/u.test(source)) {
            assert.match(source, /^(?:'use strict'|"use strict");?\r?\nvar Buffer = require\('buffer'\)\.Buffer;/u);
          }
        }
      }
    }
  }
  assert.ok(checked > 0);
});
