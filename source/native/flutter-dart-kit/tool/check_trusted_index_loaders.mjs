// Source TypeScript readers + source WASM vs immutable synthetic capture plans.
// All HTTP is intercepted. Never broadcast or use a private wallet key.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const repo=resolve(import.meta.dirname,'../../..'),out=process.argv[2];assert(out);
const built=await build({stdin:{contents:`
export {createDefaultTbcChainDataResolver} from './packages/kit/src/default-chain-data.ts';
export {createTestnetClient} from './packages/kit/src/testnet-client.ts';
export {createProductionPoolMaterialSource} from './packages/kit/src/pool-material.ts';
export {inspectTbcTransaction} from './packages/kit/src/testnet-validation.ts';
export {createWasmTbcKeylessEngine} from './packages/kit/src/keyless.ts';
export {createWasmTbcEngineBackend} from './packages/tbc-engine/src/wasm.ts';
export {chainDataRequirement} from './packages/core/src/index.ts';`,resolveDir:repo,loader:'ts'},
 alias:{'@tbc-wallet/core':join(repo,'packages/core/src/index.ts')},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const sourceKit=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
const installed=process.argv[4]&&resolve(process.argv[4]),require=createRequire(import.meta.url);
const kit=installed?Object.assign({},...['wallet','api','engine'].map(m=>require(join(installed,'dist/cjs',m+'.cjs')))):sourceKit;
const wasm=resolve(process.argv[3]??join(repo,'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release'));
const engine=await kit.createWasmTbcEngineBackend(await readFile(join(wasm,'tbc_engine_wasm.wasm')));
const keyless=await kit.createWasmTbcKeylessEngine(await readFile(join(wasm,'tbc_keyless_wasm.wasm')));
const inspect=raw=>kit.inspectTbcTransaction(raw).transaction;
const samples=[];
for(const file of ['amm-business-signing','lp-signing','fungible-signing','stablecoin-signing','nft-signing','pool2-signing','pool2-positive-floor','pool2-maintenance','pool2-maintenance-positive-floor','unified-pool-signing']){
 for(const s of JSON.parse(await readFile(join(repo,`native/flutter-dart-kit/test/fixtures/${file}.json`))).cases){
  if(s.audit&&s.result?.transactions)samples.push({...s,file});
 }
}
for(const s of JSON.parse(await readFile(join(repo,'native/contract173-upgrade/high-level173.json'))).cases)samples.push({...s,file:'high-level173'});
const raws=new Map(samples.flatMap(s=>s.audit.material.snapshot.payload.parents.map(p=>[p.txid,p.rawTransaction])));
const script=s=>Buffer.from(s).toString('hex');
function info(code,tape,coin=false){
 const b=Buffer.from(tape);let total=0n;for(let i=3;i<51;i+=8)total+=b.readBigUInt64LE(i);
 return{code_script:script(code),tape_script:script(tape),[coin?'supply':'amount']:String(total),decimal:6,name:'Fixture',symbol:'FX'};
}
function ftInfo(id){const t=inspect(raws.get(id));return info(t.outputs[0].scriptPubKey,t.outputs[1].scriptPubKey);}
function coinInfo(s,record){
 const p=s.audit.material.snapshot.payload;
 const base=record.protocolVersion==='coin'?samples.find(v=>v.name==='current-coin-transfer'):s;
 const r=base.audit.material.snapshot.payload.contracts[0];
 const mint=inspect(raws.get(record.protocolVersion==='coin'?r.currentOutpoint.txid:record.creationTxid));
 return{...info(mint.outputs[3].scriptPubKey,mint.outputs[4].scriptPubKey,true),stablecoin_id:record.contractId,utxo:{txid:r.currentOutpoint.txid,vout:0}};
}
const checks=[];
for(const s of samples){
 const replies=structuredClone(s.replies),reads=[];
 for(const r of s.audit.material.snapshot.payload.contracts){
  if(r.family==='ft')replies[`/api/tbc/ft/info/contract/${r.contractId}`]=ftInfo(r.contractId);
  if(r.family==='stablecoin')replies[`/api/tbc/stablecoin/info/stablecoinid/${r.contractId}`]=coinInfo(s,r);
  if(r.standardId==='tbc-amm'){
   const raw=raws.get(r.currentOutpoint.txid),meta=JSON.parse(await keyless.execute('inspectAmmMaterial',JSON.stringify({phase:'inspectPool',pool:{txid:r.currentOutpoint.txid,rawTransaction:raw}})));
   replies[`/api/tbc/ft/info/contract/${meta.ftContractId}`]=ftInfo(meta.ftContractId);
   replies[`/api/tbc/pool/poolinfo/poolid/${r.contractId}`]??={txid:r.currentOutpoint.txid,vout:0,value:meta.state.poolValue,pool_code_script:script(inspect(raw).outputs[0].scriptPubKey),ft_contract_id:meta.ftContractId,
    token_balance:meta.state.ftAmount,lp_balance:meta.state.lpAmount,tbc_balance:meta.state.tbcAmount,service_fee_rate:meta.serviceFeeRate};
  }
 }
 const fetch=async(url,init)=>{
  const path=new URL(url).pathname;assert.notEqual(path,'/api/tbc/broadcast');reads.push(path);
  const data=path==='/api/tbc/txo/status'?s.statusReply:replies[path];assert(data,`${s.name}: unexpected ${path}`);
  return new Response(JSON.stringify({code:200,data}));
 };
 const client=kit.createTestnetClient({baseUrl:'https://api.tbcdev.org',fetch});
 const poolMaterial=await kit.createProductionPoolMaterialSource({baseUrl:'https://api.tbcdev.org',fetch,native:keyless,
  confirmationPolicy:{minConfirmations:s.minConfirmations??'0'}});
 const request=s.request,accounts=[s.account,...(s.signingAccounts??[])];
 const resolver=kit.createDefaultTbcChainDataResolver({accounts:{current:async()=>accounts},client,materialNative:keyless,poolMaterial,
  now:()=>Date.parse(s.audit.material.snapshot.payload.capturedAt),snapshotId:()=>s.audit.material.snapshot.payload.snapshotId,
  confirmationPolicy:{minConfirmations:s.minConfirmations??'0'}});
 const snapshot=await resolver.resolve({version:'1.0',chainId:request.chainId,accountId:s.account.accountId,
  requirement:kit.chainDataRequirement(request),...(request.signingRoles?{signingRoles:request.signingRoles,signingAccounts:s.signingAccounts}: {})},s.account);
 assert(snapshot.payload,JSON.stringify({name:s.name,result:snapshot,reads}));
 const planned=JSON.parse(await engine.call('plan',JSON.stringify({...s.audit.material,snapshot})));
 assert.equal(planned.ok,true,JSON.stringify({name:s.name,error:planned.error}));
 for(const f of ['transactions','signingTasks'])assert.deepEqual(planned.result.plan.payload[f],s.audit.plan.payload[f],`${s.name}: ${f}`);
 assert.equal(reads.length,new Set(reads).size,`${s.name}: duplicate ${JSON.stringify(reads)}`);
 checks.push({name:s.name,file:s.file,reads:reads.length,parents:snapshot.payload.parents.length,identicalTransactions:true,identicalSigningTasks:true});
}
await mkdir(out);await writeFile(join(out,'report.json'),JSON.stringify({checks,installedPackage:installed??null,networkRequests:0,broadcasts:0},null,2));
console.log(JSON.stringify({checks:checks.length,networkRequests:0,broadcasts:0}));
