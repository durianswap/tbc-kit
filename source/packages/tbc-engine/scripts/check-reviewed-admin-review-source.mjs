// Source reviewer with real keyless WASM and public fixed SDK transactions.
// Official API responses are synthetic; no external HTTP, custody or broadcast.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {registerHooks,createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {reviewedAdminControllerFixture} from './lib/reviewed-admin-controller-fixture.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const directory=await mkdtemp(join(tmpdir(),'tbc-reviewed-admin-review-')),vectorsPath=join(directory,'public-vectors.json');
const controllerMode=process.env.TBC_REVIEWED_ADMIN_CONTROLLER==='1';
if(controllerMode)await writeFile(vectorsPath,JSON.stringify(reviewedAdminControllerFixture(root)),{flag:'wx'});
else
execFileSync('cargo',['test','--offline','--locked','-p','tbc-keyless-core','--test','reviewed_coin_admin'],{
 cwd:join(root,'packages/tbc-engine/rust'),env:{...process.env,TBC_REVIEWED_ADMIN_OUTPUT:vectorsPath},stdio:'pipe',timeout:60000});
const vectors=JSON.parse(await readFile(vectorsPath));assert.equal(vectors.rows.length,3);
const bundled=await build({stdin:{contents:`
export * from './packages/kit/src/reviewed-coin-admin.ts';
export {createTbcDefaultAssociatedTransactionReviewer} from './packages/kit/src/reviewed-transaction-reviewer.ts';
export {createTbcNetworkContext} from './packages/kit/src/network-context.ts';
export {createWasmTbcKeylessEngine} from './packages/kit/src/keyless.ts';
export {hashCanonical,assertValidTws} from './packages/core/src/index.ts';`,resolveDir:root},
 alias:{'@tbc-wallet/core':join(root,'packages/core/src/index.ts')},
 plugins:[{name:'parser',setup(b){b.onResolve({filter:/^\.\/vendor\/tbc-tx-parser\/index\.js$/},()=>({path:join(root,'packages/kit/dist/esm/vendor/tbc-tx-parser/index.js')}));}}],
 banner:{js:"import {createRequire as ar} from 'node:module'; const require=ar(import.meta.url);"},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const url=new URL('../../../packages/kit/src/.reviewed-admin-review-source.mjs',import.meta.url).href;
const hooks=registerHooks({resolve(s,c,n){return s===url?{url,shortCircuit:true}:n(s,c)},load(u,c,n){return u===url?{source:bundled.outputFiles[0].text,format:'module',shortCircuit:true}:n(u,c)}});
const kit=await import(url);hooks.deregister();
const wasmPath=join(root,'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm'),wasmBytes=await readFile(wasmPath);
const native=await kit.createWasmTbcKeylessEngine(wasmBytes),require=createRequire(join(root,'package.json')),tbc=require('tbc-lib-js');
globalThis.fetch=()=>{throw Error('External HTTP forbidden');};
const network=kit.createTbcNetworkContext({network:'testnet',endpoint:{kind:'trusted-custom',apiOrigin:'https://devapi.tbcdev.org',trustId:'public-fixture'}});
const feeKey=vectors.rows[0].prepare.publicKey,adminKey='02'+vectors.rows[0].stage.signingTasks[0].publicKey;
const identity=publicKey=>{const address=new tbc.PublicKey(publicKey).toAddress().toString();return {chainId:network.chainId,address,accountId:`${network.chainId}:${address}`,publicKey};};
const fee=identity(feeKey),admin=identity(adminKey),roles=[{role:'coin-admin',account:admin}];
assert.equal(kit.reviewedCoinAdministrator(roles,network.chainId,network.profile.p2pkhVersion),adminKey);
const rows=[];let negativeCases=0;
for(const vector of vectors.rows){
 const original=structuredClone(vector.prepare.request),marked=structuredClone(original);
 for(const input of [marked.sourceUtxos,...marked.inputs].flat())if(input.signingPublicKey){delete input.signingPublicKey;input.signingRole='coin-admin';}
 const bound=await kit.bindReviewedCoinAdminMaterial({request:marked,publicKey:adminKey,native});assert.deepEqual(bound,original);
 const unchanged=JSON.stringify(marked);await assert.rejects(kit.bindReviewedCoinAdminMaterial({request:marked,publicKey:feeKey,native}));negativeCases++;
 assert.equal(JSON.stringify(marked),unchanged);
 const parents=new Map();for(const input of [original.sourceUtxos,...original.inputs].flat()){
  for(const raw of [input.preTx,...(input.ancestorTransactions??[])].filter(Boolean)){const tx=new tbc.Transaction(raw);parents.set(tx.id,tx);}
 }
 const code=original.sourceUtxos.find(i=>i.scriptSigType==='tbc20-stablecoin').script,assetId='bc'.repeat(32);let reads=0,proofs=0;
 const tracked={execute:async(op,json)=>{if(op==='prepareReviewedStage')proofs++;return native.execute(op,json);}};
 const reviewer=kit.createTbcDefaultAssociatedTransactionReviewer({network,materialNative:tracked,fetch:async(url,init)=>{
  reads++;const u=new URL(String(url));assert.equal(u.origin,'https://devapi.tbcdev.org');let data;
  if(u.pathname==='/api/tbc/txo/status')data={txos:JSON.parse(init.body).txos.map(p=>{const o=parents.get(p.txid)?.outputs[Number(p.index)];assert.ok(o,'must reuse provisional local outputs');return {txid:p.txid,index:String(p.index),value:String(o.satoshis),scriptPubKey:o.script.toHex(),spent:false,height:'1'};})};
  else if(u.pathname.includes('/decode/txid/')){const txid=u.pathname.split('/').at(-1),p=parents.get(txid);assert.ok(p);data={txid,contract_id:assetId,output:p.outputs.map((_,vout)=>({txid,vout}))};}
  else if(u.pathname.includes('/info/'))data={stablecoin_id:assetId,code_script:code};
  else throw Error('Unexpected material read');return new Response(JSON.stringify({code:'200',data}),{status:200});
 }});
 const context={origin:'https://reviewed-admin.test',chainId:network.chainId,accountId:fee.accountId,sessionId:'review-admin',navigationId:'review-admin'};
 const args={request:bound,operationDigest:kit.hashCanonical({kind:'signAssociated',request:bound}),context,publicKey:feeKey,signingRoles:roles};
 const review=await reviewer.review(args),acceptedReads=reads,acceptedProofs=proofs;
 assert.equal(acceptedReads,4);assert.equal(acceptedProofs,1+original.inputs.length);
 assert.equal(review.preview.transactions.length,1+original.inputs.length);
 const locks=review.preview.transactions.flatMap(t=>t.coinLocks);
 assert.ok(locks.some(l=>l.authorization==='administrator'));
 assert.ok(locks.every(l=>l.authorization==='administrator'?l.position==='input'&&l.scriptLockChecked===false:l.position==='output'));
 assert.ok(locks.every(l=>l.chainMaturityChecked===false));
 const approvalPreview={operationKind:'transaction',assetFlows:[],totalFee:'0',transactionCount:review.preview.transactions.length,
  warnings:[],irreversible:true,signingRoles:roles,coinLocks:review.preview.transactions.flatMap(t=>t.coinLocks.map(l=>({...l,transactionIndex:t.index})))};
 kit.assertValidTws('approvalPreview',approvalPreview);
 const unboundPreview={...approvalPreview};delete unboundPreview.signingRoles;
 assert.throws(()=>kit.assertValidTws('approvalPreview',unboundPreview));negativeCases++;
 for(const signingRoles of [undefined,[{role:'coin-admin',account:fee}],[{role:'coin-admin',account:{...admin,address:fee.address}}]]){
  await assert.rejects(reviewer.review({...args,signingRoles}));negativeCases++;
 }
 if(controllerMode){
  const unsignedRole=structuredClone(bound);
  for(const input of [unsignedRole.sourceUtxos,...unsignedRole.inputs].flat())delete input.signingPublicKey;
  await assert.rejects(reviewer.review({...args,request:unsignedRole,signingRoles:undefined,
   operationDigest:kit.hashCanonical({kind:'signAssociated',request:unsignedRole})}),/address controller/);negativeCases++;
  assert.ok(locks.some(l=>l.controller?.type==='contract'&&l.controller.hash==='22'.repeat(20)));
  assert.ok(locks.filter(l=>l.controller).every(l=>l.owner===undefined));
 }
 rows.push({id:vector.id,acceptedReads,acceptedProofs,transactions:review.preview.transactions.length,
  coinLocks:locks.map(({position,index,lockTime,authorization,scriptLockChecked})=>({position,index,lockTime,authorization,scriptLockChecked}))});
}
const files=['packages/kit/src/reviewed-coin-admin.ts','packages/kit/src/reviewed-token-holder-flows.ts',
 'packages/kit/src/reviewed-lop-flows.ts','packages/kit/src/reviewed-transaction-reviewer.ts','packages/kit/src/reviewed-transaction-types.ts',
 'schemas/integration.schema.json','packages/core/src/generated/validators.ts',
 'packages/tbc-engine/scripts/check-reviewed-admin-review-source.mjs',
 ...(controllerMode?['packages/tbc-engine/scripts/check-coin-proof-source.mjs','packages/tbc-engine/scripts/lib/reviewed-admin-controller-fixture.mjs']:[])];
const report={status:'PASS_SOURCE_REVIEWED_ADMIN_REVIEW',at:new Date().toISOString(),controllerMode,rows,negativeCases,wasmSha256:sha(wasmBytes),
 sourceHashes:Object.fromEntries(await Promise.all(files.map(async f=>[f,sha(await readFile(join(root,f)))]))),
 actualHttp:0,signatures:0,broadcast:0,goalComplete:false,
 limitations:['This check covers shared reviewer and public-role binding only, not custody','No new immutable candidate, device or real chain evidence']};
const body=JSON.stringify(report,null,2)+'\n',path=join(directory,'report.json');await writeFile(path,body,{flag:'wx'});
console.log(JSON.stringify({status:report.status,path,sha256:sha(body),rows:rows.length,negativeCases}));
