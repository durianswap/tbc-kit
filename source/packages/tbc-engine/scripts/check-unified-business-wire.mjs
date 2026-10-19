#!/usr/bin/env node
// Source-only Engine route proof. Synthetic fixtures captured in memory;
// never touches delivery artifacts, network, custody or installed wallets.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";
const rust = fileURLToPath(new URL("../rust/", import.meta.url));
const pool = process.argv.includes("--pool");
function cargo(args, env = {}) {
  const run = spawnSync("cargo", args, { cwd: rust, env: { ...process.env, ...env },
    encoding: "utf8", timeout: 300_000, maxBuffer: (pool ? 256 : 32) * 1024 * 1024 });
  if (run.error || run.status !== 0) throw new Error("Rust source command failed; captured material withheld");
  return run.stdout;
}
try {
  const output = cargo(["test", "--offline", "--locked", "-p", "tbc-engine-core",
    ...(pool ? ["--test", "pool", "--test", "amm_public", "--test", "lp_public"] : ["--test", "ft", "--test", "nft_stablecoin", "--test", "tbc20_public", "--test", "coin_public", "--test", "tbc721_public"]),
    "unified_", "--", "--test-threads=1", "--nocapture"], { UNIFIED_BUSINESS_DUMP_WIRE: "1" });
  const marker = "UNIFIED_BUSINESS_WIRE:";
  const records = output.split(/\r?\n/u).filter(line => line.includes(marker))
    .map(line => JSON.parse(line.slice(line.indexOf(marker) + marker.length)));
  const plans = records.filter(r => r.method === "plan");
  if (plans.length !== (pool ? 66 : 26)) throw new Error("Unexpected current/historical operation pair count");
  cargo(["build", "--offline", "--locked", "--release", "-p", "tbc-engine-wasm", "--target", "wasm32-unknown-unknown"],
    { RUSTFLAGS: '--cfg getrandom_backend="unsupported"' });
  const bundled = await build({ entryPoints: [fileURLToPath(new URL("../src/wasm.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
  const { createWasmTbcEngineBackend } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`);
  const wasm = await createWasmTbcEngineBackend(readFileSync(`${rust}/target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm`));
  if (pool) {
    cargo(["build", "--offline", "--locked", "--release", "-p", "tbc-keyless-wasm", "--target", "wasm32-unknown-unknown"],
      { RUSTFLAGS: '--cfg getrandom_backend="unsupported"' });
    const helper = await build({entryPoints:[fileURLToPath(new URL("../../kit/src/keyless.ts",import.meta.url))],
      bundle:true,write:false,format:"esm",platform:"node",logLevel:"silent"});
    const { createWasmTbcKeylessEngine } = await import(`data:text/javascript;base64,${Buffer.from(helper.outputFiles[0].contents).toString("base64")}`);
    const keyless = await createWasmTbcKeylessEngine(readFileSync(`${rust}/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm`));
    const originMarker="UNIFIED_POOL_ORIGIN_WIRE:";
    const origins=output.split(/\r?\n/u).filter(line=>line.includes(originMarker)).map(line=>JSON.parse(line.slice(line.indexOf(originMarker)+originMarker.length)));
    if(origins.length!==33)throw new Error("Unexpected Pool origin pair count");
    for(const row of origins)if(!isDeepStrictEqual(JSON.parse(await keyless.execute("inspectAmmMaterial",JSON.stringify(row.input))),row.result))
      throw new Error("Pool origin Native/WASM mismatch");
  }
  const coreBundle = await build({ entryPoints: [fileURLToPath(new URL("../../core/src/validation.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
  const { assertValidTws } = await import(`data:text/javascript;base64,${Buffer.from(coreBundle.outputFiles[0].contents).toString("base64")}`);
  const schemas = { normalizeRequest: ["normalizeRequestParams", "normalizeRequestResult"],
    plan: ["planParams", "planResult"], validate: ["validateParams", "validationResult"], finalize: ["finalizeParams", "finalizeResult"] };
  for (const [i, r] of records.entries()) {
    for (const [name, value] of [[schemas[r.method][0], r.input], [schemas[r.method][1], r.result.result]]) {
      try { assertValidTws(name, value); }
      catch (error) {
        console.error(JSON.stringify({ schema: name, fixture: i, issues: error.issues?.map(({ instancePath, keyword }) => ({ instancePath, keyword })) }));
        throw new Error(`Schema ${name} rejects fixture ${i}; material withheld`);
      }
    }
    if (!isDeepStrictEqual(JSON.parse(await wasm.call(r.method, JSON.stringify(r.input))), r.result)) {
      throw new Error(`Source parity differs at record ${i}; material withheld`);
    }
  }
  const timings = [];
  const capabilityBundle=await build({entryPoints:[fileURLToPath(new URL('../../kit/src/business-capabilities.ts',import.meta.url))],
    bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
  const {TBC_KIT_WALLET_INTENTS,TBC_KIT_UNIFIED_TEMPLATE_SUPPORT}=await import(`data:text/javascript;base64,${Buffer.from(capabilityBundle.outputFiles[0].contents).toString('base64')}`);
  const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  for (let i=0;i<plans.length;i+=2) {
    const pair = plans.slice(i,i+2);
    if (!/^(?:(tbc20|tbc20Stablecoin)\.(transfer|merge)|tbc721\.transfer|tbc20Lp\.(transfer|lock|unlock|merge|burn)|amm\.(swap|addLiquidity|removeLiquidity|mergeToken))$/u.test(pair[1].input.request.intent.type)) throw new Error("Pair order mismatch");
    const concrete=pair[0].input.request.intent.type, unified=pair[1].input.request.intent.type;
    const profile=pool?(concrete.startsWith('tbc.pool.')?'historical-pool2':'tbc-amm')
      :concrete.startsWith('tbc20-standard-')?'tbc20-standard':concrete.startsWith('tbc20-stablecoin-')?'tbc20-stablecoin'
      :concrete.startsWith('tbc721-standard-')?'tbc721-standard':concrete.startsWith('tbc.ft.')?'historical-ft-v4'
      :concrete.startsWith('tbc.stablecoin.')?'historical-stablecoin-v4':'historical-nft';
    if(!TBC_KIT_WALLET_INTENTS.includes(unified)||!TBC_KIT_UNIFIED_TEMPLATE_SUPPORT[profile]?.includes(unified))
      throw new Error('Unified capability matrix omits a verified implementation');
    if(!isDeepStrictEqual(pair[1].result.result.plan.payload.preview.contractExecution,
      {businessType:unified,implementation:concrete,generation:profile.startsWith('historical-')?'historical':'current'}))
      throw new Error('Bound contract implementation display differs from selected builder');
    const inputs = pair.map(r=>JSON.stringify(r.input)); const samples=[[],[]];
    for (let round=0;round<14;round++) {
      for (const k of round%2 ? [1,0] : [0,1]) {
        const start=performance.now(); await wasm.call("plan", inputs[k]);
        if (round>=2) samples[k].push(performance.now()-start);
      }
    }
    timings.push({ concrete:pair[0].input.request.intent.type, unified:pair[1].input.request.intent.type,
      concreteMedianMs:Number(median(samples[0]).toFixed(3)), unifiedMedianMs:Number(median(samples[1]).toFixed(3)) });
  }
  console.log(JSON.stringify({ result:"UNIFIED_BUSINESS_SOURCE_PARITY_PASS", calls:records.length,
    operationPairs:plans.length/2, capabilityPairs:plans.length/2, ...(pool ? {poolOriginParity:33} : {}), schemaChecks:records.length*2, http:0, broadcast:0, deliveryArtifactsChanged:false, warmedWasmPlanTimings:timings }));
} catch (error) {
  console.error("Unified business source gate failed; captured fixture material withheld. Use focused Rust tests for diagnostics.");
  if (error instanceof Error && /^Schema [A-Za-z]+ rejects fixture [0-9]+; material withheld$/u.test(error.message)) console.error(error.message);
  process.exitCode=1;
}
