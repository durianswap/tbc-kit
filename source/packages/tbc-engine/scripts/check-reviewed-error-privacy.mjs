// Public malformed fixtures only; proves actual source WASM error serialization.
// No raw, fixture contents, wallet key, HTTP or broadcast is emitted.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [consumer]=process.argv.slice(2);assert.ok(consumer);
const root=resolve(import.meta.dirname,'../../..'),rust=join(root,'packages/tbc-engine/rust');
const build=spawnSync('cargo',['build','--offline','--locked','--release','-p','tbc-keyless-wasm','--target','wasm32-unknown-unknown'],
  {cwd:rust,env:{...process.env,RUSTFLAGS:'--cfg getrandom_backend="unsupported"'},encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
assert.equal(build.status,0,'Source WASM build failed; output withheld');
const {createWasmTbcKeylessEngine}=await import(pathToFileURL(join(resolve(consumer),'node_modules/@tbc/kit/dist/esm/wallet.js')));
const engine=await createWasmTbcKeylessEngine(readFileSync(join(rust,'target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm')));
const require=createRequire(join(root,'packages/kit/package.json')),tbc=require('tbc-lib-js');
const publicKey='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const script='76a914'+'22'.repeat(20)+'88ac',tx=new tbc.Transaction().from({txId:'11'.repeat(32),outputIndex:0,script,satoshis:10000});
tx.addOutput(new tbc.Transaction.Output({script:tbc.Script.fromHex(script),satoshis:9000}));
const raw={txraws:[tx.uncheckedSerialize()],utxosSatoshis:[[10000]],scriptPubkeys:[[script]]};
const associated={sourceTxraw:raw.txraws[0],sourceUtxos:[{txId:'11'.repeat(32),outputIndex:0,satoshis:10000,script,scriptSigType:'p2pkh'}],inputs:[],outputs:[]};
const marker='PUBLIC_SYNTHETIC_PRIVACY_SENTINEL';let checked=0;
async function rejects(operation,request,expected){
  await assert.rejects(engine.execute(operation,JSON.stringify(request)),error=>{
    assert.equal(error.message,expected);assert.equal(String(error).includes(marker),false);return true;
  });checked++;
}
for(let i=0;i<4;i++){
  const request=structuredClone({format:'associated',request:associated,publicKey});
  if(i===0)request[marker]=true;
  else if(i===1)request.request.sourceUtxos[0].scriptSigType=marker;
  else if(i===2){request.format='raw';request.request=structuredClone(raw);request.request.utxosSatoshis[0][0]=marker;}
  else request.request.sourceUtxos[0].script='OP_'+marker;
  await rejects('prepareReviewedStage',request,['Invalid Reviewed request schema','Invalid Reviewed associated request schema','Invalid Reviewed raw request schema','Invalid input script'][i]);
}
const stage=JSON.parse(await engine.execute('prepareReviewedStage',JSON.stringify({format:'raw',request:raw,publicKey})));
for(let i=0;i<2;i++){
  const request=structuredClone({stage,signatures:[]});
  if(i===0)request.stage.format=marker;else request[marker]=true;
  await rejects('finalizeReviewedStage',request,'Invalid Reviewed request schema');
}
console.log(JSON.stringify({status:'PASS',sourceWasmMalformedCases:checked,externalRequests:0,signatures:0,broadcasts:0,frozenArtifactsModified:false}));
