import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {hashCanonical} from '@tbc-wallet/core';
import tbcContract from 'tbc-contract';
import {REAL_FT_MINT_FIXTURE} from './fixtures/real-ft-mint.mjs';
import {parseTbcTransaction, turingTransactionId} from '../dist/esm/api.js';

async function source(name) {
 const result=await build({entryPoints:[fileURLToPath(new URL(`../src/${name}.ts`,import.meta.url))],
  bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent',
  banner:{js:`import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(import.meta.url)});`},
  plugins:[{name:'portable-review-parser',setup(b){b.onResolve({filter:/^\.\/vendor\/tbc-tx-parser\/index\.js$/},()=>({path:fileURLToPath(new URL('../dist/esm/vendor/tbc-tx-parser/index.js',import.meta.url))}));}}]});
 return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text+`\n//# sourceURL=review-policy-${name}.mjs`).toString('base64')}`);
}
const {requireReviewedIssuancePolicy:check,normalizeReviewedPolicyMaterial}=await source('reviewed-issuance-policy');
const {createWasmTbcKeylessEngine}=await source('keyless');
const {createTbcDefaultRawTransactionReviewer,createTbcDefaultAssociatedTransactionReviewer,materializeAssociatedReviewRequest}=await source('reviewed-transaction-reviewer');
const {createTbcNetworkContext}=await source('network-context');
const {createTbcStandardWorkflowCapabilities}=await source('standard-workflow-capabilities');
const {createLegacyRawTransactionSigningService,createLegacyAssociatedTransactionSigningService}=await source('legacy-generic-capabilities');
const {createLegacyAssociatedTransactionService}=await source('legacy-associated-transaction');
const wasm=await createWasmTbcKeylessEngine(await readFile(new URL('../../tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm',import.meta.url)));
const context={origin:'https://reviewer.test',chainId:'tbc:testnet',accountId:'tbc:testnet:1LEF3thAWxd4WG8nvtjPb4An6kGCoweUu6',sessionId:'policy-test',navigationId:'policy-nav'};
const p2pkh='76a914'+'01'.repeat(20)+'88ac';
const le=(n,w)=>{let v=BigInt(n),s='';for(let i=0;i<w;i++){s+=(Number(v&255n)).toString(16).padStart(2,'0');v>>=8n;}return s;};
const vi=n=>n<253?le(n,1):'fd'+le(n,2);
const raw=(txid,outputs)=>le(10,4)+'01'+Buffer.from(txid,'hex').reverse().toString('hex')+le(0,4)+'00ffffffff'+vi(outputs.length)+outputs.map(o=>le(o.satoshis,8)+vi(o.scriptPubKey.length/2)+o.scriptPubKey).join('')+le(0,4);
const input={txid:'11'.repeat(32),vout:0,satoshis:100000,scriptPubKey:p2pkh};
const good=raw(input.txid,[{satoshis:99900,scriptPubKey:p2pkh}]);
const row=r=>({rawTransaction:r,txid:turingTransactionId(r)});

function associatedFixtureRequest() {
 return {sourceTxraw:good,sourceUtxos:[{txId:input.txid,outputIndex:0,satoshis:input.satoshis,script:p2pkh,scriptSigType:'p2pkh'}],
  inputs:[[{outputIndex:0,scriptSigType:'p2pkh'}]],outputs:[[{satoshis:99800,script:p2pkh}]]};
}

function associatedFixtureReview(request) {
 const material=materializeAssociatedReviewRequest(request);
 return {preview:{transactions:material.txraws.map((r,index)=>({index,txid:turingTransactionId(r),feeSatoshis:100,classification:{action:'transfer'},
  groups:[{key:'tbc:TBC',asset:{type:'tbc',symbol:'TBC'},flows:[{recognized:true,purpose:'transfer',direction:'out',
   amount:{satoshis:Number(parseTbcTransaction(r).outputs[0].satoshis)},from:{address:context.accountId.slice('tbc:testnet:'.length)},to:{address:context.accountId.slice('tbc:testnet:'.length)}}]}]}))},
  verifiedInputs:material.txraws.map((r,i)=>parseTbcTransaction(r).inputs.map((p,j)=>({txid:p.txid,vout:p.vout,
   satoshis:material.utxos_satoshis[i][j],scriptPubKey:material.script_pubkeys[i][j],spent:false}))),
  policyMaterial:{resolvedOutputs:[]}};
}

test('Legacy associated review must bind actual parent/child txids and every verified prevout before approval',async()=>{
 const mutations=[
  r=>{r.preview.transactions[1].txid='22'.repeat(32);},
  r=>{r.verifiedInputs[1][0].txid='22'.repeat(32);},
  r=>{r.verifiedInputs[1][0].vout=1;},
  r=>{r.verifiedInputs[1][0].satoshis=1;},
  r=>{r.verifiedInputs[1][0].scriptPubKey='51';},
  r=>{r.verifiedInputs[1]=[];},
  r=>{r.verifiedInputs[1][0].spent=true;},
 ];
 for(const mutate of mutations){
  let approvals=0,executes=0;const records=new Map();
  const transactions=createLegacyAssociatedTransactionService({journal:{
   async read(id){return records.get(id)??null;},
   async prepare(record){records.set(record.operationDigest,record);return record;},
   async complete(record){records.set(record.operationDigest,record);return record;}}});
  const service=createLegacyAssociatedTransactionSigningService({transactions,materialNative:wasm,authority:{async assertCurrent(){}},
   approval:{async request(binding){approvals++;return {status:'approved',bindingHash:binding.bindingHash,approvalId:'test'};}},
   executor:{async execute({request}){executes++;return {txraws:materializeAssociatedReviewRequest(request).txraws};}},
   reviewer:{async review({request}){const reviewed=associatedFixtureReview(request);mutate(reviewed);return reviewed;}}});
  await assert.rejects(service.sign(associatedFixtureRequest(),context),/review|material/i);
  assert.equal(approvals,0);assert.equal(executes,0);
 }
});

test('Standard associated review binds concrete child identity and material; policy rejects later issuance before custody',async()=>{
 const account={accountId:context.accountId,address:context.accountId.slice('tbc:testnet:'.length),publicKey:'0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'};
 const navigation={...context,committedUrl:context.origin,topOrigin:context.origin,frame:'top',webViewInstanceId:'policy-test',createdAt:'2026-09-30T00:00:00Z'};
 let loads=0,executes=0,mutation=()=>{};
 const caps=createTbcStandardWorkflowCapabilities({navigation,chainId:context.chainId,account,networkSourceIdentity:'source-test',materialNative:wasm,
  readCurrentAuthority:async()=>({...account,networkSourceIdentity:'source-test'}),now:()=> '2026-09-30T00:00:00Z',
  rawReviewer:{async review(){throw Error('unused');}},
  associatedReviewer:{async review({request}){const result=associatedFixtureReview(request);mutation(result);return result;}},
  privateNative:async()=>{loads++;return {rawSigner:{async sign(){throw Error('unused');}},
   associatedExecutor:{async execute({request,policyMaterial}){executes++;assert.deepEqual(policyMaterial,{resolvedOutputs:[]});return {txraws:materializeAssociatedReviewRequest(request).txraws};}},
   cryptoAdapter:{async encrypt(){throw Error('unused');},async decrypt(){throw Error('unused');}}};}});
 const standard=legacy=>({payload:{format:'associated',sourceTransaction:legacy.sourceTxraw,
  sourceInputs:legacy.sourceUtxos.map(p=>({txid:p.txId,outputIndex:p.outputIndex,satoshis:String(p.satoshis),scriptPubKey:p.script,signingProfile:p.scriptSigType})),
  children:legacy.inputs.map((inputs,i)=>({inputs:inputs.map(p=>({outputIndex:p.outputIndex,signingProfile:p.scriptSigType})),
   outputs:legacy.outputs[i].map(o=>({satoshis:String(o.satoshis),scriptPubKey:o.script}))}))}});
 const request=standard(associatedFixtureRequest());
 const params=r=>({version:'1.0',taskId:'associated-policy',contextHash:'11'.repeat(32),...context,publicKey:account.publicKey,requestHash:hashCanonical(r),request:r});
 const call={operation:'reviewedTransaction.review'};
 for(const mutate of [r=>{r.preview.transactions[1].txid='22'.repeat(32);},r=>{r.verifiedInputs[1][0].txid='22'.repeat(32);},
  r=>{r.verifiedInputs[1][0].satoshis=1;},r=>{r.verifiedInputs[1][0].scriptPubKey='51';},r=>{r.verifiedInputs[1]=[];}]){
  mutation=mutate;await assert.rejects(caps.reviewedTransaction.review(params(request),call),/review|material/i);
 }
 mutation=()=>{};
 const review=await caps.reviewedTransaction.review(params(request),call);
 const task=r=>({taskId:'associated-policy',purpose:'reviewedTransaction',contextHash:'11'.repeat(32),requestHash:hashCanonical(r),reviewHash:review.reviewHash,
  chainId:context.chainId,accountId:account.accountId,publicKey:account.publicKey,request:r,policyMaterial:review.payload.policyMaterial});
 const execution=t=>({version:'1.0',task:t,approval:{status:'approved',approvalId:'public-test',bindingHash:'aa'.repeat(32)}});
 const {NFT}=tbcContract;const invalid=associatedFixtureRequest();invalid.outputs=[[{satoshis:200,script:NFT.buildCodeScript('22'.repeat(32),1).toHex()},
  {satoshis:100,script:NFT.buildHoldScript(account.address).toHex()},
  {satoshis:0,script:NFT.buildTapeScript({nftName:'Public',symbol:'N',description:'',attributes:'[]'}).toHex()}]];
 await assert.rejects(caps.reviewedTransaction.review(params(standard(invalid)),call),/issuance policy rejected/);
 await assert.rejects(caps.reviewedTransaction.execute(execution(task(standard(invalid))),{operation:'reviewedTransaction.execute'}),/issuance policy rejected/);
 const changed=task(request);changed.policyMaterial={resolvedOutputs:[{...input,satoshis:'1'}]};
 await assert.rejects(caps.reviewedTransaction.execute(execution(changed),{operation:'reviewedTransaction.execute'}),/input material conflict/);
 assert.equal(loads,0);assert.equal(executes,0);
 const result=await caps.reviewedTransaction.execute(execution(task(request)),{operation:'reviewedTransaction.execute'});
 assert.equal(result.bundle.transactions.length,2);assert.equal(loads,1);assert.equal(executes,1);
});

test('Legacy associated retains valid parent-child execution but refuses later old issuance before approval',async()=>{
 let approvals=0,executes=0;const records=new Map();
 const transactions=createLegacyAssociatedTransactionService({journal:{async read(id){return records.get(id)??null;},
  async prepare(record){records.set(record.operationDigest,record);return record;},async complete(record){records.set(record.operationDigest,record);return record;}}});
 const service=createLegacyAssociatedTransactionSigningService({transactions,materialNative:wasm,authority:{async assertCurrent(){}},
  approval:{async request(binding){approvals++;assert.deepEqual(binding.review.policyMaterial,{resolvedOutputs:[]});return {status:'approved',bindingHash:binding.bindingHash,approvalId:'test'};}},
  executor:{async execute({request}){executes++;return {txraws:materializeAssociatedReviewRequest(request).txraws};}},
  reviewer:{async review({request}){return associatedFixtureReview(request);}}});
 const {NFT}=tbcContract,address=context.accountId.slice('tbc:testnet:'.length),invalid=associatedFixtureRequest();
 invalid.outputs=[[{satoshis:200,script:NFT.buildCodeScript('22'.repeat(32),1).toHex()},
  {satoshis:100,script:NFT.buildHoldScript(address).toHex()},
  {satoshis:0,script:NFT.buildTapeScript({nftName:'Public',symbol:'N',description:'',attributes:'[]'}).toHex()}]];
 await assert.rejects(service.sign(invalid,context),/issuance policy rejected/);assert.equal(approvals,0);assert.equal(executes,0);
 const result=await service.sign(associatedFixtureRequest(),context);
 assert.equal(result.status,'approved');assert.equal(result.result.txraws.length,2);assert.equal(approvals,1);assert.equal(executes,1);
});

test('material snapshot rejects accessors, noncanonical values and duplicate claims without invoking getters',()=>{
 let reads=0;const output={...input,satoshis:String(input.satoshis)};
 for(const value of [{resolvedOutputs:[{...output,satoshis:'01'}]},{resolvedOutputs:[output,output]},
  {resolvedOutputs:[{...output,get scriptPubKey(){reads++;return p2pkh;}}]},
  {get resolvedOutputs(){reads++;return [output];}}, {resolvedOutputs:[],approved:true}]) {
  assert.throws(()=>normalizeReviewedPolicyMaterial(value));
 }
 assert.equal(reads,0);const result=normalizeReviewedPolicyMaterial({resolvedOutputs:[output]});
 output.satoshis='1';assert.equal(result.resolvedOutputs[0].satoshis,'100000');assert.ok(Object.isFrozen(result.resolvedOutputs[0]));
});

test('custom Standard review cannot authorize old issuance; execution rechecks material before loading custody',async()=>{
 const account={accountId:context.accountId,address:context.accountId.slice('tbc:testnet:'.length),publicKey:'0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'};
 const navigation={...context,committedUrl:context.origin,topOrigin:context.origin,frame:'top',webViewInstanceId:'policy-test',createdAt:'2026-09-30T00:00:00Z'};
 let loads=0,signs=0;
 const caps=createTbcStandardWorkflowCapabilities({navigation,chainId:context.chainId,account,networkSourceIdentity:'source-test',materialNative:wasm,
  readCurrentAuthority:async()=>({...account,networkSourceIdentity:'source-test'}),now:()=> '2026-09-30T00:00:00Z',
  rawReviewer:{async review({request,transactionIds}){return {preview:{transactions:transactionIds.map((txid,index)=>({index,txid,feeSatoshis:100,classification:{action:'transfer'},groups:[{key:'tbc:TBC',asset:{type:'tbc',symbol:'TBC'},flows:[{purpose:'transfer',direction:'out',amount:{satoshis:1},from:{address:account.address},to:{address:account.address},recognized:true}]}]}))},
   verifiedInputs:request.txraws.map(r=>parseTbcTransaction(r).inputs.map(p=>({txid:p.txid,vout:p.vout,satoshis:input.satoshis,scriptPubKey:p2pkh,spent:false}))) };}},
  associatedReviewer:{async review(){throw Error('unused');}},
  privateNative:async()=>{loads++;return {rawSigner:{async sign({policyMaterial}){signs++;assert.deepEqual(policyMaterial,{resolvedOutputs:[]});return {sigs:[['30']]};}},associatedExecutor:{async execute(){throw Error('unused');}},cryptoAdapter:{async encrypt(){throw Error('unused');},async decrypt(){throw Error('unused');}}};}});
 const standard=r=>({payload:{format:'raw',transactions:[{rawTransaction:r,inputs:[{satoshis:String(input.satoshis),scriptPubKey:p2pkh}]}]}});
 const params=request=>({version:'1.0',taskId:'policy',contextHash:'11'.repeat(32),...context,publicKey:account.publicKey,requestHash:hashCanonical(request),request});
 const valid=standard(good);const review=await caps.reviewedTransaction.review(params(valid),{operation:'reviewedTransaction.review'});
 assert.deepEqual(review.payload.policyMaterial,{resolvedOutputs:[]});assert.equal(review.reviewHash,hashCanonical(review.payload));
 const task=request=>({taskId:'policy',purpose:'reviewedTransaction',contextHash:'11'.repeat(32),requestHash:hashCanonical(request),reviewHash:review.reviewHash,chainId:context.chainId,accountId:account.accountId,publicKey:account.publicKey,request,policyMaterial:review.payload.policyMaterial});
 const execution=task=>({version:'1.0',task,approval:{status:'approved',approvalId:'public-test',bindingHash:'aa'.repeat(32)}});
 const {NFT}=tbcContract;
 const mint=raw(input.txid,[{satoshis:200,scriptPubKey:NFT.buildCodeScript('22'.repeat(32),1).toHex()},
  {satoshis:100,scriptPubKey:NFT.buildHoldScript(account.address).toHex()},
  {satoshis:0,scriptPubKey:NFT.buildTapeScript({nftName:'Public',symbol:'N',description:'',attributes:'[]'}).toHex()}]);
 await assert.rejects(caps.reviewedTransaction.review(params(standard(mint)),{operation:'reviewedTransaction.review'}),/issuance policy rejected/);
 await assert.rejects(caps.reviewedTransaction.execute(execution(task(standard(mint))),{operation:'reviewedTransaction.execute'}),/issuance policy rejected/);
 const tampered=task(valid);tampered.policyMaterial={resolvedOutputs:[{...input,satoshis:'1'}]};
 await assert.rejects(caps.reviewedTransaction.execute(execution(tampered),{operation:'reviewedTransaction.execute'}),/input material conflict/);
 assert.equal(loads,0);assert.equal(signs,0);
 await caps.reviewedTransaction.execute(execution(task(valid)),{operation:'reviewedTransaction.execute'});
 assert.equal(loads,1);assert.equal(signs,1);
});

test('source WASM permits shared collection but rejects newly issued historical NFT Code',async()=>{
 const {NFT}=tbcContract;const address='1LEF3thAWxd4WG8nvtjPb4An6kGCoweUu6';
 const collection=raw(input.txid,[{satoshis:0,scriptPubKey:NFT.buildTapeScript({collectionName:'Public',description:'',supply:1,file:''}).toHex()},
  {satoshis:100,scriptPubKey:NFT.buildMintScript(address).toHex()}]);
 await check(wasm,[row(collection)],[input]);
 const mint=raw(input.txid,[{satoshis:200,scriptPubKey:NFT.buildCodeScript('22'.repeat(32),1).toHex()},
  {satoshis:100,scriptPubKey:NFT.buildHoldScript(address).toHex()},
  {satoshis:0,scriptPubKey:NFT.buildTapeScript({nftName:'Public',symbol:'N',description:'',attributes:'[]'}).toHex()}]);
 await assert.rejects(check(wasm,[row(mint)],[input]),/issuance policy rejected/);
});

test('Legacy custom raw reviewer cannot bypass the same policy before approval or signing',async()=>{
 let approvals=0,signs=0;
 const service=createLegacyRawTransactionSigningService({materialNative:wasm,authority:{async assertCurrent(){}},
  approval:{async request(binding){approvals++;return {status:'approved',bindingHash:binding.bindingHash,approvalId:'test'};}},
  signer:{async sign(){signs++;return {sigs:[['30']]};}},
  reviewer:{async review({request,transactionIds}){return {
   preview:{transactions:transactionIds.map((txid,index)=>({index,txid,groups:[{flows:[{recognized:true}]}]}))},
   verifiedInputs:request.txraws.map(r=>parseTbcTransaction(r).inputs.map(p=>({txid:p.txid,vout:p.vout,satoshis:input.satoshis,scriptPubKey:p2pkh,spent:false})))
  };}}});
 const {NFT}=tbcContract,address=context.accountId.slice('tbc:testnet:'.length);
 const mint=raw(input.txid,[{satoshis:200,scriptPubKey:NFT.buildCodeScript('22'.repeat(32),1).toHex()},
  {satoshis:100,scriptPubKey:NFT.buildHoldScript(address).toHex()},
  {satoshis:0,scriptPubKey:NFT.buildTapeScript({nftName:'Public',symbol:'N',description:'',attributes:'[]'}).toHex()}]);
 const request=r=>({txraws:[r],utxos_satoshis:[[input.satoshis]],script_pubkeys:[[p2pkh]]});
 await assert.rejects(service.sign(request(mint),context),/issuance policy rejected/);assert.equal(approvals,0);assert.equal(signs,0);
 const result=await service.sign(request(good),context);assert.equal(result.status,'approved');assert.equal(approvals,1);assert.equal(signs,1);
});

test('source WASM prepare checks every raw/associated transaction before producing the first digest',async()=>{
 const publicKey='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
 const goodRequest={format:'raw',publicKey,request:{txraws:[good],utxosSatoshis:[[input.satoshis]],scriptPubkeys:[[p2pkh]]}};
 const stage=JSON.parse(await wasm.execute('prepareReviewedStage',JSON.stringify(goodRequest)));
 assert.equal(stage.digests.length,1);
 const {NFT}=tbcContract,address=context.accountId.slice('tbc:testnet:'.length);
 const outputs=[{satoshis:200,scriptPubKey:NFT.buildCodeScript('22'.repeat(32),1).toHex()},
  {satoshis:100,scriptPubKey:NFT.buildHoldScript(address).toHex()},
  {satoshis:0,scriptPubKey:NFT.buildTapeScript({nftName:'Public',symbol:'N',description:'',attributes:'[]'}).toHex()}];
 const child=raw(turingTransactionId(good),outputs);
 const batch={...goodRequest,request:{txraws:[good,child],utxosSatoshis:[[input.satoshis],[99900]],scriptPubkeys:[[p2pkh],[p2pkh]]}};
 await assert.rejects(wasm.execute('prepareReviewedStage',JSON.stringify(batch)),/historical issuance policy rejected/);
 const associated={format:'associated',publicKey,request:{sourceTxraw:good,
  sourceUtxos:[{txId:input.txid,outputIndex:0,satoshis:input.satoshis,script:p2pkh,scriptSigType:'p2pkh'}],
  inputs:[[{outputIndex:0,scriptSigType:'p2pkh'}]],outputs:[outputs.map(o=>({satoshis:o.satoshis,script:o.scriptPubKey}))]}};
 await assert.rejects(wasm.execute('prepareReviewedStage',JSON.stringify(associated)),/historical issuance policy rejected/);
 await assert.rejects(wasm.execute('prepareReviewedStage',JSON.stringify({...goodRequest,resolvedOutputs:[{...input,satoshis:'1'}]})),/policy material conflict/);
});

test('one batched local call binds txids and omits batch-local output shadows',async()=>{
 const child=raw(turingTransactionId(good),[{satoshis:99800,scriptPubKey:p2pkh}]);let calls=0;
 await check({async execute(op,json){calls++;const r=JSON.parse(json);assert.equal(op,'inspectTokenMaterial');
  assert.equal(r.resolvedOutputs.length,1);assert.equal(r.resolvedOutputs[0].satoshis,'100000');return wasm.execute(op,json);}},
  [row(good),row(child)],[input,{txid:turingTransactionId(good),vout:0,satoshis:99900,scriptPubKey:p2pkh}]);
 assert.equal(calls,1);
 await assert.rejects(check(wasm,[row(good),row(child)],[input,{txid:turingTransactionId(good),vout:0,satoshis:1,scriptPubKey:'51'}]),/local policy material mismatch/);
 await assert.rejects(check(wasm,[row(child),row(good)],[input]),/issuance policy rejected/);
});

test('policy does not substitute for identity or approvals and fails closed without echo or retry',async()=>{
 const ok={verification:'historical-issuance-policy',assetIdentityVerified:false,transactionIds:[turingTransactionId(good)]};
 for(const reply of [{...ok,approved:true},{...ok,assetIdentityVerified:true},{...ok,transactionIds:['22'.repeat(32)]},null]){
  let calls=0;await assert.rejects(check({async execute(){calls++;return JSON.stringify(reply);}},[row(good)],[input]),/Invalid reviewed issuance policy result/);assert.equal(calls,1);
 }
 await assert.rejects(check({async execute(){throw Error('sensitive-unlock-sentinel');}},[row(good)],[input]),e=>!e.message.includes('sensitive-unlock-sentinel'));
 let calls=0;await assert.rejects(check({async execute(){calls++;}},[row(good)],[input,input]),/Invalid reviewed issuance policy material/);assert.equal(calls,0);
});

test('default reviewer invokes local policy before returning review, without another API read',async()=>{
 let http=0,checks=0;
 const reviewer=createTbcDefaultRawTransactionReviewer({network:createTbcNetworkContext({network:'testnet'}),
  materialNative:{async protocolInfo(){return '{}';},async execute(){checks++;throw Error('policy-negative');}},
  async fetch(){http++;return new Response(JSON.stringify({code:'200',message:'OK',data:{txos:[{txid:input.txid,index:'0',spent:false,value:String(input.satoshis),scriptPubKey:p2pkh,height:'1'}]}}),{status:200});}});
 await assert.rejects(reviewer.review({context,transactionIds:[turingTransactionId(good)],request:{txraws:[good],utxos_satoshis:[[input.satoshis]],script_pubkeys:[[p2pkh]]}}),/issuance policy rejected/);
 assert.equal(http,1);assert.equal(checks,1);
});

test('real historical FT transfer reuses two batched reads and one source WASM policy check',async()=>{
 const old=parseTbcTransaction(REAL_FT_MINT_FIXTURE.txraw);const id=turingTransactionId(REAL_FT_MINT_FIXTURE.txraw);
 const origin=parseTbcTransaction(REAL_FT_MINT_FIXTURE.sourceTxraw);const originId=turingTransactionId(REAL_FT_MINT_FIXTURE.sourceTxraw);
 const material=new Map([...[...old.outputs].map((o,i)=>[`${id}:${i}`,{txid:id,index:String(i),spent:false,value:String(o.satoshis),scriptPubKey:Buffer.from(o.scriptPubKey).toString('hex')}]),
  ...origin.outputs.map((o,i)=>[`${originId}:${i}`,{txid:originId,index:String(i),spent:false,value:String(o.satoshis),scriptPubKey:Buffer.from(o.scriptPubKey).toString('hex')}])]);
 const outputs=old.outputs.slice(0,2).map(o=>({satoshis:o.satoshis,scriptPubKey:Buffer.from(o.scriptPubKey).toString('hex')}));const tx=raw(id,outputs);
 let http=0,checks=0;
 const reviewer=createTbcDefaultRawTransactionReviewer({network:createTbcNetworkContext({network:'testnet'}),materialNative:{protocolInfo:wasm.protocolInfo,async execute(op,json){checks++;return wasm.execute(op,json);}},
  async fetch(_url,init){http++;const {txos}=JSON.parse(init.body);return new Response(JSON.stringify({code:'200',message:'OK',data:{txos:txos.map(o=>{const s=material.get(`${o.txid}:${o.index}`);assert.ok(s);return s;})}}),{status:200});}});
 const reviewed=await reviewer.review({context,transactionIds:[turingTransactionId(tx)],request:{txraws:[tx],utxos_satoshis:[[500]],script_pubkeys:[[outputs[0].scriptPubKey]]}});
 assert.equal(reviewed.verifiedInputs.length,1);assert.equal(http,2);assert.equal(checks,1);
});

test('default associated review checks source and child together without fetching local outputs',async()=>{
 let http=0,checks=0;
 const reviewer=createTbcDefaultAssociatedTransactionReviewer({network:createTbcNetworkContext({network:'testnet'}),
  materialNative:{protocolInfo:wasm.protocolInfo,async execute(op,json){checks++;assert.equal(JSON.parse(json).transactions.length,2);return wasm.execute(op,json);}},
  async fetch(_url,init){http++;assert.deepEqual(JSON.parse(init.body).txos,[{txid:input.txid,index:0}]);
   return new Response(JSON.stringify({code:'200',message:'OK',data:{txos:[{txid:input.txid,index:'0',spent:false,value:String(input.satoshis),scriptPubKey:p2pkh}]}}),{status:200});}});
 const request={sourceTxraw:good,sourceUtxos:[{txId:input.txid,outputIndex:0,satoshis:input.satoshis,script:p2pkh,scriptSigType:'p2pkh'}],
  inputs:[[{outputIndex:0,scriptSigType:'p2pkh'}]],outputs:[[{satoshis:99800,script:p2pkh}]]};
 const reviewed=await reviewer.review({context,operationDigest:hashCanonical({kind:'signAssociated',request}),request});
 assert.equal(reviewed.verifiedInputs.length,2);assert.equal(checks,1);assert.equal(http,1);
});

test('historical NFT transfer retains Code/Hold/Tape and reuses the primary Hold read',async()=>{
 const {NFT}=tbcContract;const address=context.accountId.slice('tbc:testnet:'.length);
 const id='44'.repeat(32),origin='22'.repeat(32);
 for(const codeMethod of ['buildCodeScript','buildCodeScript_v1','buildCodeScript_v0']){
  const code=NFT[codeMethod](origin,1).toHex(),hold=NFT.buildHoldScript(address).toHex();
  const tape=NFT.buildTapeScript({nftName:'Public',symbol:'N',description:'',attributes:'[]',file:origin+'01000000'}).toHex();
  const outs=[{satoshis:200,scriptPubKey:code},{satoshis:100,scriptPubKey:hold},{satoshis:0,scriptPubKey:tape}];
  const tx=le(10,4)+'02'+[0,1].map(v=>Buffer.from(id,'hex').reverse().toString('hex')+le(v,4)+'00ffffffff').join('')+
   vi(outs.length)+outs.map(o=>le(o.satoshis,8)+vi(o.scriptPubKey.length/2)+o.scriptPubKey).join('')+le(0,4);
  let http=0,checks=0;const requested=[];
  const reviewer=createTbcDefaultRawTransactionReviewer({network:createTbcNetworkContext({network:'testnet'}),materialNative:{protocolInfo:wasm.protocolInfo,async execute(op,json){checks++;return wasm.execute(op,json);}},
   async fetch(_url,init){http++;const {txos}=JSON.parse(init.body);requested.push(...txos.map(p=>`${p.txid}:${p.index}`));
    return new Response(JSON.stringify({code:'200',message:'OK',data:{txos:txos.map(p=>{
     const out=p.txid===id?outs[p.index]:{satoshis:100,scriptPubKey:NFT.buildMintScript(address).toHex()};assert.ok(out);
     return {txid:p.txid,index:String(p.index),spent:false,value:String(out.satoshis),scriptPubKey:out.scriptPubKey};
    })}}),{status:200});}});
  const result=await reviewer.review({context,transactionIds:[turingTransactionId(tx)],request:{txraws:[tx],utxos_satoshis:[[200,100]],script_pubkeys:[[code,hold]]}});
  assert.equal(result.verifiedInputs[0].length,2);assert.equal(http,2);assert.equal(checks,1);
  assert.equal(requested.filter(p=>p===`${id}:1`).length,1);
 }
});
