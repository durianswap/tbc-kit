#!/usr/bin/env node
// Source-only receipt gate. Default: synthetic data; --live-readonly: two public GETs.
// Never signs, POSTs, or changes delivery artifacts.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const rust = path.join(root, "packages/tbc-engine/rust");
function check(value, message) { if (!value) throw new Error(message); }

async function main() {
  check(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--live-readonly"), "Unexpected arguments");
  const built = spawnSync("cargo", ["build", "--offline", "--locked", "--release", "-p", "tbc-keyless-wasm",
    "--target", "wasm32-unknown-unknown"], { cwd: rust, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, RUSTFLAGS: '--cfg getrandom_backend="unsupported"' }, maxBuffer: 8 * 1024 * 1024 });
  check(!built.error && built.status === 0, "Source WASM build failed; output withheld");
  const bundle = await build({ stdin: { contents: `
    export { createWasmTbcKeylessEngine } from './packages/kit/src/keyless.ts';
    export { verifyTransfer } from './packages/kit/src/receipt-verification.ts';
    export { inspectTbcTransaction } from './packages/kit/src/testnet-validation.ts';
  `, resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node", target: "node22", logLevel: "silent" });
  const kit = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
  const engine = await kit.createWasmTbcKeylessEngine(readFileSync(path.join(rust,
    "target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm")));
  const fixture = JSON.parse(readFileSync(path.join(rust, "fixtures/coin-proof.json"), "utf8"));
  const parent = kit.inspectTbcTransaction(fixture.vectors[0].parentRaw);
  const code = Buffer.from(parent.transaction.outputs[3].scriptPubKey).toString("hex");
  const tape = Buffer.from(parent.transaction.outputs[4].scriptPubKey).toString("hex");
  const contractId = "ab".repeat(32); // Synthetic API asset label; trusted API identity boundary.
  const owner = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
  let cases = 0;
  for (const network of ["mainnet", "testnet"]) {
    for (const id of ["first-0", "merge-0", "again-0"]) {
      const stage = fixture.vectors.find((item) => item.id === id);
      const tx = kit.inspectTbcTransaction(stage.signedRaw);
      for (const scenario of ["exact", "unknown-amount", "wrong-amount", "wrong-recipient", "wrong-asset", "bad-metadata", "bad-lock", "wrong-profile"]) {
        let reads = 0, inspections = 0;
        const origin = network === "mainnet" ? "https://api.turingbitchain.io" : "https://api.tbcdev.org";
        const result = await kit.verifyTransfer({ network, txid: tx.txid,
          recipient: { address: scenario === "wrong-recipient" ? "1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb" : owner },
          asset: { kind: scenario === "wrong-profile" ? "ft" : "stablecoin", contractId }, minimumConfirmations: "0",
          ...(scenario === "unknown-amount" ? {} : { amount: { mode: "exact", atomic: scenario === "wrong-amount" ? "1001" : "1000" } }),
          fetch: async (input, init) => {
            const url = new URL(String(input));
            check(url.origin === origin && (init?.method ?? "GET") === "GET", "Network mixing or non-read request");
            reads++;
            let data;
            if (url.pathname === `/api/tbc/decode/txid/${tx.txid}`) {
              data = { txid: tx.txid, hex: stage.signedRaw, confirmations: "0",
                vout: tx.transaction.outputs.map((output, n) => ({ n, valueSat: output.satoshis.toString(),
                  scriptPubKey: { hex: Buffer.from(output.scriptPubKey).toString("hex"), addresses: [] } })) };
            } else if (url.pathname === `/api/tbc/stablecoin/info/stablecoinid/${contractId}`
              || url.pathname === `/api/tbc/ft/info/contract/${contractId}`) {
              data = { stablecoin_id: scenario === "bad-metadata" ? "cd".repeat(32) : contractId,
                code_script: scenario === "wrong-asset" ? "51" : code, tape_script: tape,
                supply: "1000", amount: "1000", decimal: 0, name: "Offline Coin", symbol: "OFF" };
            } else throw new Error("Unexpected receipt request");
            return new Response(JSON.stringify({ code: "200", data }), { status: 200 });
          },
          assetInspector: { execute: async (operation, request) => {
            inspections++;
            const response = JSON.parse(await engine.execute(operation, request));
            if (scenario === "bad-lock") response.outputs[0].lockTime = -1;
            return JSON.stringify(response);
          } },
        });
        const expected = ["exact", "unknown-amount"].includes(scenario) ? "matched"
          : ["bad-metadata", "bad-lock", "wrong-profile"].includes(scenario) ? "unavailable" : "mismatched";
        check(result.content.status === expected, `${network}/${id}/${scenario}: expected ${expected}, got ${result.content.status}`);
        check(reads === 2 && inspections === (scenario === "bad-metadata" ? 0 : 1), "Receipt request/inspection budget changed");
        check(result.queries.decode === 1 && result.queries.assetMetadata === 1 && result.queries.post === 0
          && result.queries.mempool === 0 && result.queries.transactionRaw === 0, "Receipt query counters differ");
        check(result.source.chainId === `tbc:${network}` && result.source.origin === origin, "Network identity differs");
        if (expected === "matched") {
          check(result.content.amount.actualAtomic === "1000", "Recipient output sum differs");
          check(result.content.matchedOutputs.every((output) => output.lockTime === 0), "Receipt lock metadata missing");
          check(result.observation.status === "mempool" && result.policy.status === "satisfied", "Zero-confirmation semantics changed");
          if (scenario === "unknown-amount") check(result.content.amount.status === "not-checked", "Unknown amount falsely verified");
        }
        cases++;
      }
    }
  }
  if (process.argv[2] === "--live-readonly") {
    const asset = "adf34e37243821c8542b577202b4282bae7bb2687ad260c4ccb1feaf52ba9f0d";
    const txid = "e2631551e50cbaae744ae3f440b0c5350661ad2a1f86bfcc8e4bfa13e6b5c1ea";
    const allowed = new Set([`/api/tbc/decode/txid/${txid}`, `/api/tbc/stablecoin/info/stablecoinid/${asset}`]);
    let reads = 0, inspections = 0;
    const result = await kit.verifyTransfer({ network: "testnet", txid, asset: { kind: "stablecoin", contractId: asset },
      recipient: { address: "143KgKGcse57nXBnXyJwtQrf2KP4KWto59" }, minimumConfirmations: "0",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        check(url.origin === "https://api.tbcdev.org" && allowed.has(url.pathname) && (init?.method ?? "GET") === "GET", "Live read boundary violated");
        reads++;
        check(reads <= 2, "Live request budget exceeded");
        return fetch(input, { ...init, redirect: "error" });
      },
      assetInspector: { execute: async (operation, request) => { inspections++; return engine.execute(operation, request); } },
    });
    check(result.content.status === "matched", `Live receipt did not match: ${result.content.status}`);
    check(reads === 2 && inspections === 1, "Live receipt budget differs");
    console.log(`COIN_RECEIPT_LIVE_READONLY_PASS reads=2 inspect=1 atomic=${result.content.amount.actualAtomic} observation=${result.observation.status} POST=0; public observation only, not an authorized spending account`);
  }
  console.log(`COIN_RECEIPT_SOURCE_PASS cases=${cases} reads=2/case inspect<=1/case POST=0; synthetic data, no delivery changes`);
}
main().catch((error) => { console.error(`COIN_RECEIPT_SOURCE_FAIL ${error instanceof Error ? error.message : "unknown"}`); process.exitCode = 1; });
