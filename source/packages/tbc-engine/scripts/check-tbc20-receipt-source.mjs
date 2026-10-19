#!/usr/bin/env node
/** Current Kit + source-only keyless WASM receipt gate. Synthetic funds only.
 * Builds Cargo target, never delivery artifacts. No live HTTP, keys or POST.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const rust = path.join(root, "packages/tbc-engine/rust");
function check(condition, message) { if (!condition) throw new Error(message); }

async function main() {
  check(process.argv.length === 2, "This source gate accepts no arguments");
  const compiled = spawnSync("cargo", ["build", "--offline", "--locked", "--release", "-p",
    "tbc-keyless-wasm", "--target", "wasm32-unknown-unknown"], {
    cwd: rust, env: { ...process.env, RUSTFLAGS: '--cfg getrandom_backend="unsupported"' },
    encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  check(!compiled.error && compiled.status === 0, "Source keyless WASM build failed; output withheld");
  const bundled = await build({ stdin: { contents: `
      export { createWasmTbcKeylessEngine } from './packages/kit/src/keyless.ts';
      export { verifyTransfer } from './packages/kit/src/receipt-verification.ts';
      export { inspectTbcTransaction } from './packages/kit/src/testnet-validation.ts';
    `, resolveDir: root, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "node", target: "node22", logLevel: "silent",
  });
  const kit = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`);
  const engine = await kit.createWasmTbcKeylessEngine(readFileSync(path.join(rust,
    "target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm")));
  const fixture = JSON.parse(readFileSync(path.join(rust, "fixtures/tbc20-standard-transfer.json"), "utf8"));
  const genesis = fixture.stages.find((item) => item.id === "genesis");
  const genesisTx = kit.inspectTbcTransaction(genesis.signedRaw);
  const codeScript = Buffer.from(genesisTx.transaction.outputs[0].scriptPubKey).toString("hex");
  const tapeScript = Buffer.from(genesisTx.transaction.outputs[1].scriptPubKey).toString("hex");
  const owner = fixture.request.ownerAddress;
  const results = [];
  for (const network of ["mainnet", "testnet"]) {
    for (const stage of fixture.stages.filter((item) => ["genesis", "transfer", "merge"].includes(item.id))) {
      const transaction = kit.inspectTbcTransaction(stage.signedRaw);
      const origin = network === "mainnet" ? "https://api.turingbitchain.io" : "https://api.tbcdev.org";
      const requests = [];
      let inspections = 0;
      const fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        check(url.origin === origin && (init?.method ?? "GET") === "GET", "Network mixing or non-read request");
        requests.push(url.pathname);
        let data;
        if (url.pathname === `/api/tbc/decode/txid/${transaction.txid}`) {
          data = { txid: transaction.txid, hex: stage.signedRaw, confirmations: "0",
            vout: transaction.transaction.outputs.map((output, n) => ({ n, valueSat: output.satoshis.toString(),
              scriptPubKey: { hex: Buffer.from(output.scriptPubKey).toString("hex"), addresses: [] } })) };
        } else if (url.pathname === `/api/tbc/ft/info/contract/${genesis.txid}`) {
          // Long symbols are legal in the new template, not the old metadata
          // profile. This exercises automatic Code-based profile selection.
          data = { code_script: codeScript, tape_script: tapeScript, amount: fixture.request.mintAmount,
            decimal: 6, name: "T", symbol: "S".repeat(52) };
        } else throw new Error("Unexpected receipt request");
        return new Response(JSON.stringify({ code: "200", data }), { status: 200,
          headers: { "content-type": "application/json" } });
      };
      const result = await kit.verifyTransfer({ network, fetch, txid: transaction.txid,
        recipient: { address: owner }, asset: { kind: "ft", contractId: genesis.txid },
        amount: { mode: "exact", atomic: fixture.request.mintAmount }, minimumConfirmations: "0",
        assetInspector: { execute: async (operation, requestJson) => {
          inspections++;
          const response = await engine.execute(operation, requestJson);
          const decoded = JSON.parse(response);
          check(decoded.contractStandardId === "tbc20-standard", "New expected Code identity was not recognized");
          check(decoded.outputs.length === (stage.id === "transfer" ? 2 : 1), "New output count differs");
          check(decoded.outputs.every((item) => item.standardId === "tbc20-standard" && item.contractCodeMatches),
            "New receipt outputs did not bind the asset");
          return response;
        } },
      });
      check(result.content.status === "matched", `${network}/${stage.id} receipt did not match`);
      check(result.content.amount.actualAtomic === fixture.request.mintAmount,
        "Receipt must sum all recipient outputs, not pretend to measure net wallet balance gain");
      check(result.observation.status === "mempool" && result.policy.status === "satisfied", "Explicit zero confirmation handling differs");
      check(result.source.origin === origin && result.source.chainId === `tbc:${network}`, "Receipt network identity differs");
      check(requests.length === 2 && inspections === 1, "Receipt repeated fetching or local inspection");
      check(result.queries.decode === 1 && result.queries.assetMetadata === 1 && result.queries.transactionRaw === 0
        && result.queries.mempool === 0 && result.queries.post === 0, "Receipt request budget changed");
      results.push(`${network}/${stage.id}:reads=2,inspect=1`);
    }
  }
  // A mixed-version consumer must keep the existing receipt path usable with
  // this same new binary and the same local profile resolver.
  const old = JSON.parse(readFileSync(path.join(root, "packages/kit/test/fixtures/controlled-pool.json"), "utf8"));
  const oldGenesis = kit.inspectTbcTransaction(old.rawTransactions[old.ftContractId]);
  const oldRaw = old.rawTransactions[old.ownerCandidate.txid];
  const oldTx = kit.inspectTbcTransaction(oldRaw);
  let oldReads = 0, oldInspections = 0;
  const oldResult = await kit.verifyTransfer({ network: "testnet", txid: oldTx.txid,
    recipient: { address: old.address }, asset: { kind: "ft", contractId: old.ftContractId },
    amount: { mode: "minimum", atomic: "500000" }, minimumConfirmations: "0",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      check(url.origin === "https://api.tbcdev.org" && (init?.method ?? "GET") === "GET", "Unexpected old receipt origin/method");
      oldReads++;
      let data;
      if (url.pathname === `/api/tbc/decode/txid/${oldTx.txid}`) {
        data = { txid: oldTx.txid, hex: oldRaw, confirmations: "0",
          vout: oldTx.transaction.outputs.map((output, n) => ({ n, valueSat: output.satoshis.toString(),
            scriptPubKey: { hex: Buffer.from(output.scriptPubKey).toString("hex"), addresses: [] } })) };
      } else if (url.pathname === `/api/tbc/ft/info/contract/${old.ftContractId}`) {
        data = { code_script: Buffer.from(oldGenesis.transaction.outputs[0].scriptPubKey).toString("hex"),
          tape_script: Buffer.from(oldGenesis.transaction.outputs[1].scriptPubKey).toString("hex"),
          amount: "100000000", decimal: 6, name: "Controlled Pool Token", symbol: "CPT" };
      } else throw new Error("Unexpected old receipt request");
      return new Response(JSON.stringify({ code: "200", data }), { status: 200 });
    },
    assetInspector: { execute: async (operation, requestJson) => {
      oldInspections++;
      const response = await engine.execute(operation, requestJson);
      check(JSON.parse(response).contractStandardId === undefined, "Historical asset misidentified as new standard");
      return response;
    } },
  });
  check(oldResult.content.status === "matched" && oldResult.content.amount.actualAtomic === "500000", "Historical FT receipt regressed");
  check(oldReads === 2 && oldInspections === 1, "Historical receipt request/inspection budget changed");
  results.push("historical-ft:reads=2,inspect=1");
  console.log(`TBC20_RECEIPT_SOURCE_PASS ${results.join(" ")}; target-only WASM, synthetic data, POST=0`);
}

main().catch((error) => {
  console.error(`TBC20_RECEIPT_SOURCE_FAIL ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
});
