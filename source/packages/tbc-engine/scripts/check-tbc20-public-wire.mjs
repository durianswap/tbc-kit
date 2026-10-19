#!/usr/bin/env node
/**
 * Offline Rust-source → current JSON Schema interoperability gate.
 * Uses only the public synthetic tbc20_public (or --tbc721) test; no delivery artifacts,
 * network, private wallet keys, or broadcasts. Cargo may update build outputs.
 * --wasm-source also builds a target-only WASM and requires identical results.
 * --upstream-vm independently verifies every finalized input with the pinned
 * installed tbc-lib-js VM; the two switches can be combined.
 * Deliberately never prints captured transaction material, even on failure.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { isDeepStrictEqual } from "node:util";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const rust = fileURLToPath(new URL("../rust/", import.meta.url));
const definitions = Object.freeze([
  "normalizeRequestParams", "normalizeRequestResult",
  "planParams", "planResult",
  "validateParams", "validationResult",
  "finalizeParams", "finalizeResult",
]);
const nftProfile = process.argv.includes("--tbc721");
const coinCreateProfile = process.argv.includes("--coin-create");
const coinManagementProfile = process.argv.includes("--coin-management");
const coinAdminProfile = process.argv.includes("--coin-admin-roles");
const coinProfile = process.argv.includes("--coin") || coinCreateProfile || coinManagementProfile || coinAdminProfile;
const lpBatchProfile = process.argv.includes("--lp-batch");
const lpProfile = process.argv.includes("--lp") || lpBatchProfile;
const ammActionsProfile = process.argv.includes("--amm-actions");
const ammBatchProfile = process.argv.includes("--amm-batch");
const ammControllerProfile = process.argv.includes("--amm-controller");
const ammProfile = process.argv.includes("--amm-create") || ammActionsProfile || ammBatchProfile || ammControllerProfile;
const timelockProfile = process.argv.includes("--timelock");
const htlcTokenProfile = process.argv.includes("--htlc-token");
const htlcProfile = process.argv.includes("--htlc") || htlcTokenProfile;
const lopProfile = process.argv.includes("--lop");
const label = lopProfile ? "LOP_PUBLIC" : htlcProfile ? "HTLC_PUBLIC" : timelockProfile ? "TIMELOCK_PUBLIC" : ammProfile ? "AMM" : lpProfile ? "LP" : coinProfile ? "COIN" : nftProfile ? "TBC721" : "TBC20";
const marker = `${label}_WIRE:`;
const libTreeHash = "b73c8b5996276584981fe5b14f04db3e4cce02c94e7a19cb2b0f64e37206c7e9";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function loadPinnedVm() {
  const dependencies = createRequire(path.join(root, "packages/kit/package.json"));
  const packagePath = dependencies.resolve("tbc-lib-js/package.json");
  if (JSON.parse(readFileSync(packagePath, "utf8")).version !== "1.0.31") {
    throw new Error("Upstream VM requires the installed tbc-lib-js 1.0.31; no download attempted");
  }
  const directory = path.dirname(packagePath);
  const files = [];
  function walk(relative) {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) files.push(name);
      else throw new Error("Upstream VM package has an unexpected non-file member");
    }
  }
  walk("");
  files.sort();
  const manifest = files.map((name) => `${name.split(path.sep).join("/")}\0${sha256(readFileSync(path.join(directory, name)))}\n`).join("");
  if (sha256(manifest) !== libTreeHash) throw new Error("Upstream VM package tree differs from the fixed oracle");
  return dependencies("tbc-lib-js");
}

function verifyFinalizedBundle(tbc, params, result, bundleIndex) {
  if (!params?.snapshot?.payload || !Array.isArray(result?.bundle?.transactions)) {
    throw new Error(`Upstream VM bundle ${bundleIndex}: missing finalized snapshot/bundle`);
  }
  let location = `bundle ${bundleIndex}`;
  const fail = (reason) => { throw new Error(`Upstream VM ${location}: ${reason}; material withheld`); };
  const parse = (raw, txid) => {
    let transaction;
    try { transaction = new tbc.Transaction(raw); }
    catch { fail("transaction parse failed"); }
    if (transaction.id !== txid) fail("transaction ID differs from raw");
    return transaction;
  };
  const parents = new Map();
  for (const [index, parent] of params.snapshot.payload.parents.entries()) {
    location = `bundle ${bundleIndex} parent ${index}`;
    if (parents.has(parent.txid)) fail("duplicate parent ID");
    parents.set(parent.txid, parse(parent.rawTransaction, parent.txid));
  }
  const utxos = new Map();
  for (const [index, utxo] of params.snapshot.payload.utxos.entries()) {
    location = `bundle ${bundleIndex} UTXO ${index}`;
    const key = `${utxo.txid}:${utxo.vout}`;
    if (utxos.has(key)) fail("duplicate UTXO");
    utxos.set(key, utxo);
  }
  const finalized = new Map();
  const spent = new Set();
  let inputs = 0;
  for (const [transactionIndex, item] of result.bundle.transactions.entries()) {
    location = `bundle ${bundleIndex} transaction ${transactionIndex}`;
    const tx = parse(item.rawTransaction, item.txid);
    if (finalized.has(item.txid)) fail("duplicate finalized transaction");
    for (const [inputIndex, input] of tx.inputs.entries()) {
      location = `bundle ${bundleIndex} transaction ${transactionIndex} input ${inputIndex}`;
      const txid = input.prevTxId.toString("hex");
      const key = `${txid}:${input.outputIndex}`;
      if (spent.has(key)) fail("duplicate spend");
      const previous = finalized.get(txid) ?? parents.get(txid);
      const indexed = utxos.get(key);
      let script, satoshis;
      if (previous !== undefined) {
        const output = previous.outputs[input.outputIndex];
        if (output === undefined) fail("previous output index is absent");
        script = output.script.toHex(); satoshis = output.satoshis;
        if (indexed !== undefined && (indexed.scriptPubKey !== script || indexed.satoshis !== String(satoshis))) {
          fail("indexed prevout differs from parent raw");
        }
      } else if (indexed !== undefined) {
        script = indexed.scriptPubKey; satoshis = Number(indexed.satoshis);
      } else { fail("previous output is not in snapshot or earlier bundle transaction"); }
      if (!Number.isSafeInteger(satoshis) || satoshis < 0) fail("prevout amount is not a safe integer");
      let verified;
      try {
        input.output = new tbc.Transaction.Output({ script: tbc.Script.fromHex(script), satoshis });
        verified = tx.verifyScript(inputIndex);
      } catch { fail("script verification threw"); }
      if (verified?.success !== true) {
        if (lopProfile && process.env.LOP_PUBLIC_TRACE === "1") {
          // Diagnostic positions only; never disclose stack operands or scripts.
          const prototype = tbc.Script.Interpreter.prototype, step = prototype.step;
          try {
            prototype.step = function(type) {
              const pc = this.pc, opcode = this.script.chunks[pc]?.opcodenum;
              const passed = step.call(this, type);
              if (!passed) console.error(JSON.stringify({ location, pc, opcode }));
              return passed;
            };
            tx.verifyScript(inputIndex);
          } finally { prototype.step = step; }
        }
        // Do not forward arbitrary exceptions or script bytes. Interpreter error
        // constants remain useful as an exact, non-material failure location.
        const code = typeof verified?.error === "string" && /^[A-Z_0-9]{1,80}$/u.test(verified.error)
          ? verified.error : "SCRIPT_VERIFY_FAILED";
        fail(code);
      }
      spent.add(key); inputs++;
    }
    finalized.set(item.txid, tx);
  }
  return { transactions: finalized.size, inputs };
}

async function main() {
  if (coinAdminProfile && (process.argv.filter(arg => arg === "--coin-admin-roles").length !== 1 ||
      process.argv.slice(2).some(arg => !["--coin-admin-roles", "--wasm-source", "--upstream-vm"].includes(arg)))) {
    throw new Error("--coin-admin-roles is a standalone profile, with optional --wasm-source/--upstream-vm");
  }
  const options = process.argv.slice(2).filter((arg) => arg !== "--coin-admin-roles" && arg !== "--timelock" && arg !== "--htlc" && arg !== "--htlc-token" && arg !== "--lop");
  if (lopProfile && (process.argv.filter(arg => arg === "--lop").length !== 1 || [htlcProfile,timelockProfile,coinProfile,nftProfile,lpProfile,ammProfile].some(Boolean))) {
    throw new Error("--lop is a standalone profile, with optional --wasm-source/--upstream-vm");
  }
  if (htlcProfile && (process.argv.filter((arg) => arg === "--htlc" || arg === "--htlc-token").length !== 1 || [timelockProfile,coinProfile,nftProfile,lpProfile,ammProfile].some(Boolean))) {
    throw new Error("--htlc is a standalone profile, with optional --wasm-source/--upstream-vm");
  }
  if (timelockProfile && (process.argv.filter((arg) => arg === "--timelock").length !== 1 || [coinProfile,nftProfile,lpProfile,ammProfile].some(Boolean))) {
    throw new Error("--timelock is a standalone profile, with optional --wasm-source/--upstream-vm");
  }
  if (new Set(options).size !== options.length || [coinProfile,nftProfile,lpProfile,ammProfile].filter(Boolean).length>1 || [coinCreateProfile,coinManagementProfile,options.includes("--coin")].filter(Boolean).length>1 || (lpBatchProfile && options.includes("--lp")) || [ammActionsProfile,ammBatchProfile,ammControllerProfile,options.includes("--amm-create")].filter(Boolean).length>1 || options.some((arg) => !["--wasm-source", "--upstream-vm", "--tbc721", "--coin", "--coin-create", "--coin-management", "--lp", "--lp-batch", "--amm-create", "--amm-actions", "--amm-batch", "--amm-controller"].includes(arg))) {
    throw new Error("Accepted options: --wasm-source, --upstream-vm and one of --tbc721/--coin/--coin-create/--coin-management/--lp/--lp-batch/--amm-create/--amm-actions/--amm-batch/--amm-controller, once each");
  }
  const wasmSource = options.includes("--wasm-source");
  const upstreamVm = options.includes("--upstream-vm") ? loadPinnedVm() : undefined;
  let wasm;
  if (wasmSource) {
    // Build only into Cargo target; never replace the delivery artifacts.
    const compiled = spawnSync("cargo", ["build", "--offline", "--locked", "--release",
      "-p", "tbc-engine-wasm", "--target", "wasm32-unknown-unknown"], {
      cwd: rust, env: { ...process.env, RUSTFLAGS: '--cfg getrandom_backend="unsupported"' },
      encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (compiled.error || compiled.status !== 0) throw new Error("Source WASM build failed; output withheld");
    const bundled = await build({ entryPoints: [path.join(root, "packages/tbc-engine/src/wasm.ts")],
      bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
    const { createWasmTbcEngineBackend } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`);
    wasm = await createWasmTbcEngineBackend(readFileSync(path.join(rust, "target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm")));
  }
  const schemaDirectory = path.join(root, "schemas");
  const files = readdirSync(schemaDirectory).filter((name) => name.endsWith(".json")).sort();
  if (files.length !== 19) throw new Error(`Expected 19 current schemas, found ${files.length}`);
  const schemas = files.map((name) => JSON.parse(readFileSync(path.join(schemaDirectory, name), "utf8")));
  const integration = schemas[files.indexOf("integration.schema.json")];
  if (typeof integration?.$id !== "string") throw new Error("Integration schema ID is missing");
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
  ajv.addFormat("uri", (value) => {
    try { new URL(value); return true; } catch { return false; }
  });
  ajv.addFormat("date-time", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u);
  for (const schema of schemas) ajv.addSchema(schema);
  const validators = new Map(definitions.map((definition) => {
    const validate = ajv.getSchema(`${integration.$id}#/$defs/${definition}`);
    if (validate === undefined) throw new Error(`Missing integration definition: ${definition}`);
    return [definition, validate];
  }));

  const run = spawnSync("cargo", [
    "test", "--locked", "--offline", "-p", "tbc-engine-core", "--test", lopProfile ? "lop_public" : htlcProfile ? "htlc_public" : timelockProfile ? "timelock_public" : ammProfile ? "amm_public" : lpBatchProfile ? "amm_lp_batch" : lpProfile ? "lp_public" : coinProfile ? "coin_public" : nftProfile ? "tbc721_public" : "tbc20_public",
    coinAdminProfile ? "coin_explicit_admin_lifecycle_binds_both_roles_and_continuation" : lopProfile ? "uses_shared_bound_signer_and_finalize" : htlcTokenProfile ? "public_htlc_token_lifecycle_uses_shared_bound_signatures" : htlcProfile ? "public_htlc_uses_shared_plan_approval_and_finalize" : timelockProfile ? "public_timelock_uses_shared_plan_approval_and_finalize" : ammControllerProfile ? "explicit_controller_amm_actions_and_continuation_match_sdk" : ammBatchProfile ? "public_amm_fragmented_holders_share_bound_maintenance_and_business_signing" : ammActionsProfile ? "eight_public_amm_actions_match_sdk_raw_with_shared_account_and_binding" : ammProfile ? "four_public_amm_creates_bind_funded_continuation_and_match_sdk" : lpBatchProfile ? "public_lp_multiround_uses_shared_binding_and_continuations" : lpProfile ? "six_public_lp_flows_match_sdk_without_current_pool_read" : coinManagementProfile ? "coin_public_management_uses_common_binding_signer_and_conserves_targets" : coinCreateProfile ? "coin_public_creation_uses_approval_bound_schnorr_continuation" : coinProfile ? "coin_public_four_methods_bind_holder_transfer_merge_and_receivers" : nftProfile ? "public_nft_lifecycle_four_phases_and_external_batch_continuation" : "tbc20_public_create_transfer_merge_all_four_validation_phases", "--", ...(lopProfile ? ["--test-threads=1"] : ["--exact"]), "--nocapture",
  ], {
    cwd: rust,
    env: { ...process.env, [`${label}_DUMP_WIRE`]: "1" },
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (run.error !== undefined || run.status !== 0) {
    // Do not forward Cargo stdout/stderr: Rust assertion failures can contain raw transactions.
    throw new Error(`Rust wire test failed (status=${run.status ?? "none"}, signal=${run.signal ?? "none"}, code=${run.error?.code ?? "none"}); captured output withheld`);
  }
  const expectedTests = lopProfile ? 3 : 1;
  if (!run.stdout.includes(`test result: ok. ${expectedTests} passed; 0 failed;`)) {
    throw new Error(`Rust wire gate did not execute exactly ${expectedTests} successful tests`);
  }
  const counts = new Map(definitions.map((definition) => [definition, 0]));
  let total = 0;
  let wasmCalls = 0;
  let pending;
  let latestFinalizeParams;
  const vmCounts = { bundles: 0, transactions: 0, inputs: 0 };
  const wasmMethods = {
    normalizeRequestParams: ["normalizeRequest", "normalizeRequestResult"],
    planParams: ["plan", "planResult"],
    validateParams: ["validate", "validationResult"],
    finalizeParams: ["finalize", "finalizeResult"],
  };
  for (const line of run.stdout.split(/\r?\n/u)) {
    // libtest may print its test-name prefix before the first uncaptured line.
    const offset = line.indexOf(marker);
    if (offset < 0) continue;
    let wire;
    try { wire = JSON.parse(line.slice(offset + marker.length)); }
    catch { throw new Error(`Malformed Rust wire JSON at record ${total + 1}; material withheld`); }
    if (wire === null || typeof wire !== "object" || Array.isArray(wire) ||
        !Object.hasOwn(wire, "value") || !validators.has(wire.definition)) {
      throw new Error(`Unexpected Rust wire definition/envelope at record ${total + 1}; material withheld`);
    }
    const validate = validators.get(wire.definition);
    if (!validate(wire.value)) {
      // AJV errorsText contains schema paths/messages, not the rejected value.
      throw new Error(`${wire.definition}: ${ajv.errorsText(validate.errors, { separator: " | " })}`);
    }
    if (upstreamVm !== undefined) {
      if (wire.definition === "finalizeParams") latestFinalizeParams = wire.value;
      if (wire.definition === "finalizeResult" && wire.value.bundle !== undefined) {
        const checked = verifyFinalizedBundle(upstreamVm, latestFinalizeParams, wire.value, vmCounts.bundles);
        vmCounts.bundles++; vmCounts.transactions += checked.transactions; vmCounts.inputs += checked.inputs;
      }
    }
    if (wasm !== undefined) {
      const method = wasmMethods[wire.definition];
      if (method !== undefined) {
        if (pending !== undefined) throw new Error("Rust wire result is missing before next call");
        const response = JSON.parse(await wasm.call(method[0], JSON.stringify(wire.value)));
        if (response.ok !== true) throw new Error(`Source WASM ${method[0]} rejected native input; material withheld`);
        pending = { definition: method[1], value: response.result };
      } else {
        if (pending?.definition !== wire.definition || !isDeepStrictEqual(pending.value, wire.value)) {
          throw new Error(`Native/WASM output differs for ${wire.definition}; material withheld`);
        }
        pending = undefined;
        wasmCalls++;
      }
    }
    counts.set(wire.definition, counts.get(wire.definition) + 1);
    total += 1;
  }
  const missing = definitions.filter((definition) => counts.get(definition) === 0);
  if (total === 0 || missing.length !== 0) {
    throw new Error(`Incomplete Rust wire coverage: ${total} records; missing ${missing.join(", ")}`);
  }
  if (pending !== undefined) throw new Error("Final native result is missing");
  if (upstreamVm !== undefined && (vmCounts.bundles === 0 || vmCounts.inputs === 0)) throw new Error("Upstream VM did not verify finalized inputs");
  console.log(`${label}_PUBLIC_WIRE_PASS ${total} records; 19 schemas; all 4 methods parameters/results validated`);
  console.log(definitions.map((definition) => `${definition}=${counts.get(definition)}`).join(" "));
  if (wasmSource) console.log(`${label}_SOURCE_WASM_PARITY_PASS ${wasmCalls} calls; delivery artifacts unchanged; POST=0`);
  if (upstreamVm !== undefined) console.log(`${label}_UPSTREAM_VM_PASS ${vmCounts.bundles} bundles; ${vmCounts.transactions} transactions; ${vmCounts.inputs} inputs; pinned tbc-lib-js 1.0.31; POST=0`);
}

try { await main(); }
catch (error) {
  console.error(`${label}_PUBLIC_WIRE_FAIL ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
}
