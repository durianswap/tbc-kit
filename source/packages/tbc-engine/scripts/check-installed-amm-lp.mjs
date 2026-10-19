// Exact installed WASM against public synthetic Native/SDK vectors. No network,
// wallet keys, device changes or broadcast. This is package evidence, not live acceptance.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
const [consumerArg,profile]=process.argv.slice(2);
assert.ok(consumerArg&&process.argv.length<=4&&(profile===undefined||['--timelock','--special','--lp'].includes(profile)),'Usage: EXACT_INSTALLED_KIT_CONSUMER [--timelock|--special|--lp]');
const installed=join(resolve(consumerArg),'node_modules/@tbc/kit');
const manifest=JSON.parse(await readFile(join(installed,'package.json')));
const provenance=JSON.parse(await readFile(join(installed,'artifacts/provenance.json')));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(provenance.package,`@tbc/kit@${manifest.version}`);
for(const entry of provenance.artifacts)assert.equal(hash(await readFile(join(installed,entry.path))),entry.sha256,entry.path);
const {createWasmTbcEngineBackend}=await import(pathToFileURL(join(installed,'dist/esm/engine.js')));
const bytes=await readFile(join(installed,'artifacts/wasm/tbc_engine_wasm.wasm'));
const wasm=await createWasmTbcEngineBackend(bytes);
const methods={normalizeRequestParams:['normalizeRequest','normalizeRequestResult'],planParams:['plan','planResult'],
  validateParams:['validate','validationResult'],finalizeParams:['finalize','finalizeResult']};
const special=[
  ['timelock_public','public_timelock_uses_shared_plan_approval_and_finalize','TIMELOCK_PUBLIC'],
  ['htlc_public','public_htlc_uses_shared_plan_approval_and_finalize','HTLC_PUBLIC'],
  ['htlc_public','public_htlc_token_lifecycle_uses_shared_bound_signatures','HTLC_PUBLIC'],
  ['lop_public','public_lop_create_uses_shared_bound_signer_and_finalize','LOP_PUBLIC'],
  ['lop_public','public_lop_cancel_uses_shared_bound_signer_and_finalize','LOP_PUBLIC'],
  ['lop_public','public_lop_match_uses_shared_bound_signer_and_finalize','LOP_PUBLIC'],
];
const suites=profile==='--special'?special:profile==='--timelock'?[
  ['timelock_public','public_timelock_uses_shared_plan_approval_and_finalize','TIMELOCK_PUBLIC'],
]:[
  ['amm_public','four_public_amm_creates_bind_funded_continuation_and_match_sdk','AMM'],
  ['amm_public','eight_public_amm_actions_match_sdk_raw_with_shared_account_and_binding','AMM'],
  ['amm_public','explicit_controller_amm_actions_and_continuation_match_sdk','AMM'],
  ['lp_public','six_public_lp_flows_match_sdk_without_current_pool_read','LP'],
  ['lp_public','public_lp_lock_uses_same_signer_and_preserves_change_lock','LP'],
];
const results=[];
for(const [target,selected,marker] of suites.filter(([target])=>profile!=='--lp'||target==='lp_public')){
  const run=spawnSync('cargo',['test','--locked','--offline','-p','tbc-engine-core','--test',target,
    selected,'--','--exact','--nocapture'],{cwd:resolve(import.meta.dirname,'../rust'),
    // Explicit-controller continuation took 120.90s in a successful standalone
    // run on the loaded host. Bound execution, but do not kill it at 120s.
    env:{...process.env,[`${marker}_DUMP_WIRE`]:'1'},encoding:'utf8',timeout:240000,maxBuffer:32*1024*1024});
  assert.ok(!run.error&&run.status===0&&/test result: ok\. 1 passed; 0 failed;/.test(run.stdout),
    `${target}/${selected} Native source gate failed (${JSON.stringify({status:run.status,signal:run.signal,error:run.error?.code,stdoutBytes:Buffer.byteLength(run.stdout??''),stderrBytes:Buffer.byteLength(run.stderr??'')})}); material withheld`);
  let pending,calls=0;const counts={};
  for(const line of run.stdout.split(/\r?\n/)){
    const prefix=`${marker}_WIRE:`;if(!line.startsWith(prefix))continue;
    let wire;try{wire=JSON.parse(line.slice(prefix.length));}catch{throw Error('Malformed wire; material withheld');}
    const method=methods[wire.definition];
    if(method){
      assert.equal(pending,undefined,'Missing prior result');
      const response=JSON.parse(await wasm.call(method[0],JSON.stringify(wire.value)));
      assert.equal(response.ok,true,`Packaged ${method[0]} rejected input; material withheld`);
      pending={definition:method[1],value:response.result};counts[method[0]]=(counts[method[0]]??0)+1;
    }else{
      assert.ok(pending?.definition===wire.definition&&isDeepStrictEqual(pending.value,wire.value),
        `Packaged ${wire.definition} differs; material withheld`);
      pending=undefined;calls++;
    }
  }
  assert.equal(pending,undefined);assert.ok(calls>0);assert.equal(Object.keys(counts).length,4);
  results.push({target,selected,calls,counts});
}
console.log(JSON.stringify({status:profile==='--special'?'INSTALLED_SPECIAL_CONTRACTS_PASS':profile==='--timelock'?'INSTALLED_TIMELOCK_PASS':profile==='--lp'?'INSTALLED_LP_PASS':'INSTALLED_AMM_LP_PASS',candidate:manifest.version,consumer:resolve(consumerArg),
  wasmSha256:hash(bytes),results,synthetic:true,externalReads:0,transactionBroadcasts:0,deviceAcceptance:false}));
