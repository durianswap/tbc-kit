// Immutable Kit oracle for unified current/historical FT usage. Public scalar
// one and fabricated funding only; no RPC, POST or old-asset creation endpoint.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {secp256k1} from '@noble/curves/secp256k1';
const base=resolve(import.meta.dirname,'..'),repo=resolve(base,'../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=v=>sha(canonical(v));
const archive=join(repo,'release/kit-amm4-20261011/tbc-kit-0.1.0-platform-slim.20261011.4.tgz');
const archiveSha256=sha(await readFile(archive));
assert.equal(archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
const work=await mkdtemp('/private/tmp/tbc-dart-fungible-oracle-');
execFileSync('tar',['-xzf',archive,'-C',work]);await symlink(join(repo,'node_modules'),join(work,'node_modules'),'dir');
const load=p=>import(pathToFileURL(join(work,'package/dist/esm',p)));
const kit=await load('wallet.node.js'),eng=await load('engine.node.js'),key=await load('keyless.js'),api=await load('api.js');
const wasm=await readFile(join(work,'package/artifacts/wasm/tbc_engine_wasm.wasm'));
const keyless=await key.createWasmTbcKeylessEngine(await readFile(join(work,'package/artifacts/wasm/tbc_keyless_wasm.wasm')));
const engine=await eng.createWasmTbcEngineBackend(wasm);
async function call(method,input){const r=JSON.parse(await engine.call(method,canonical(input)));assert.equal(r.ok,true,JSON.stringify(r.error));return r.result;}
const sources={};
async function fixture(path){const b=await readFile(join(repo,path));sources[path]=sha(b);return JSON.parse(b);}
const current=await fixture('packages/tbc-engine/rust/fixtures/tbc20-standard-transfer.json');
const historical=await fixture('packages/kit/test/fixtures/controlled-pool-key1.json');
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',publicKey='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
assert.equal(current.request.ownerAddress,address);assert.equal(historical.address,address);
const now='2026-10-12T14:00:00.123Z',account={chainId:'tbc:testnet',address,publicKey,accountId:`tbc:testnet:${address}`};
const cases=[];
async function capture(name,{contract,rows,native,raw,intent,minConfirmations='0'}){
 const trace=[],snapshotId='fungible-'+name;
 const replies={'/api/tbc/nodeinfo':{blocks:1000,bestblockhash:'aa'.repeat(32)},
  [`/api/tbc/utxo/address/${address}`]:{utxos:native},
  [`/api/tbc/ft/utxo/combinescript/${current.request.controllerHex}/contract/${contract}`]:{utxos:rows},
  ...Object.fromEntries(Object.entries(raw).map(([id,txraw])=>['/api/tbc/txraw/txid/'+id,{txraw}]))};
 const network=kit.createDefaultTbcNetwork({network:kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account]},poolNative:keyless,now:()=>Date.parse(now),snapshotId:()=>snapshotId,
  confirmationPolicy:{minConfirmations},fetch:async(input,init)=>{assert.equal(init?.method??'GET','GET');const path=new URL(String(input)).pathname;trace.push(path);assert(replies[path],path);return new Response(JSON.stringify({code:'200',data:replies[path]}));}});
 const request={version:'1.0',chainId:account.chainId,from:address,intent:{version:'1.0',contractId:contract,...intent},constraints:{maxFee:'10000'}};
 const amount=intent.type.endsWith('.merge')?undefined:(intent.amount??intent.receivers.reduce((sum,r)=>sum+BigInt(r.amount),0n).toString());
 const requirement={intentType:intent.type,includeAncestry:true,contractIds:[contract],
  ...(intent.payment?{nativeAmount:intent.payment.amount}:{}),
  assets:[{kind:'native',...(intent.payment?{minimumAmount:intent.payment.amount}:{})},{kind:'ft',contractId:contract,...(amount?{minimumAmount:amount}:{})}]};
 const snapshot=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);
 assert(snapshot.snapshotHash,name+JSON.stringify(snapshot));
 const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash,name+JSON.stringify(policy));
 const normalized=await call('normalizeRequest',{version:'1.0',request});assert.equal(canonical(normalized.request),canonical(request));
 const material={version:'1.0',...normalized,snapshot,policy};
 const {plan}=await call('plan',material);assert.equal((await call('validate',{...material,plan,phase:'plan'})).valid,true);
 const context={sessionId:'offline-'+name,navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',transport:'webview',frame:'top',createdAt:now};
 const payload={version:'1.0',method:'tbc_signTransaction',operationKind:'transaction',contextHash:hash(context),origin:context.origin,sessionId:context.sessionId,chainId:account.chainId,accountId:account.accountId,requestHash:normalized.requestHash,operationHash:plan.planHash,expiresAt:plan.payload.expiresAt};
 const binding={payload,bindingHash:hash(payload)};
 const approval={status:'approved',approvalId:'offline-'+name,approvalToken:'public-fixture-only',bindingHash:binding.bindingHash,approvedAt:now,expiresAt:payload.expiresAt};
 assert.equal((await call('validate',{...material,plan,binding,approval,phase:'pre-sign'})).valid,true);
 const signatures=plan.payload.signingTasks.map(t=>{assert.equal(t.publicKey,publicKey);assert.equal(t.signatureEncoding,'compact64');return {taskId:t.taskId,signatureEncoding:t.signatureEncoding,signature:secp256k1.sign(t.digest,1n,{lowS:true,prehash:false}).toCompactHex()};});
 const args={...material,plan,binding,approval,signatures},final=await call('finalize',args);
 assert(final.bundle,name+':dependent-stage-not-captured');assert.equal(final.validation.valid,true);
 assert.equal((await call('validate',{...args,bundle:final.bundle,phase:'finalized'})).valid,true);
 const coldTrace=[...trace];trace.length=0;
 const warm=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert.equal(canonical(warm),canonical(snapshot));
 const c={name,network:'testnet',now,snapshotId,minConfirmations,method:'tbc_signTransaction',account,request,context,replies,coldTrace,warmTrace:[...trace],result:final.bundle,audit:{material,plan,preview:plan.payload.preview,binding,approval,signatures}};
 cases.push(c);console.log(JSON.stringify({name,version:snapshot.payload.contracts[0].protocolVersion,reads:coldTrace.length,warm:trace.length,tasks:signatures.length,fee:final.bundle.totalFee}));return c;
}
const stage=current.stages[2],raw=Object.fromEntries(current.stages.map(s=>[s.txid,s.signedRaw]));
const native=[{txid:stage.txid,index:stage.outputs.at(-1).vout,value:stage.outputs.at(-1).value,height:990}];
const rows=stage.tokenOutputs.map(t=>({txid:stage.txid,index:t.codeVout,tbc_value:'500',ft_value:t.amount,height:990}));
const shared={contract:current.stages[1].txid,rows,native,raw};
await capture('current-transfer-multiple-inputs',{...shared,intent:{type:'tbc20.transfer',to:address,amount:'100000'}});
await capture('current-transfer-receivers',{...shared,intent:{type:'tbc20.transfer',receivers:[{to:address,amount:'1000'},{to:address,amount:'2000'}]}});
await capture('current-merge',{...shared,intent:{type:'tbc20.merge'}});
await capture('current-merge-token-only',{...shared,native:[],intent:{type:'tbc20.merge'}});
const oldShared={contract:historical.ftContractId,rows:[{...historical.ownerCandidate,height:990}],native:[{txid:'22'.repeat(32),index:0,value:'10000000',height:990}],raw:historical.rawTransactions};
const split=await capture('historical-transfer',{...oldShared,intent:{type:'tbc20.transfer',to:address,amount:'250000'}});
await capture('historical-transfer-payment',{...oldShared,intent:{type:'tbc20.transfer',to:address,amount:'250000',payment:{to:address,amount:'1000'}}});
const tx=split.result.transactions[0],parsed=api.inspectTbcTransaction(tx.rawTransaction).transaction;
const out=parsed.outputs,splitRaw={...historical.rawTransactions,[tx.txid]:tx.rawTransaction};
const oldRows=[];
for(let i=0;i<out.length-1;i++){
 if(out[i].satoshis!==500n||out[i+1].satoshis!==0n)continue;
 const found=JSON.parse(await keyless.execute('inspectTokenMaterial',JSON.stringify({phase:'identifyPairs',pairs:[{codeScript:Buffer.from(out[i].scriptPubKey).toString('hex'),codeSatoshis:500,tapeScript:Buffer.from(out[i+1].scriptPubKey).toString('hex'),tapeSatoshis:0}]})));
 const identity=found.identities[0];assert.equal(identity.family,'tbc20');
 oldRows.push({txid:tx.txid,index:i,tbc_value:'500',ft_value:identity.balanceRaw,height:990});
}
assert.equal(oldRows.length,2);
await capture('historical-merge',{...oldShared,rows:oldRows,raw:splitRaw,intent:{type:'tbc20.merge'}});
await writeFile(join(base,'test/fixtures/fungible-signing.json'),JSON.stringify({status:'FROZEN_FUNGIBLE_ORACLE',archiveSha256,wasmSha256:sha(wasm),sources,publicScalarOneOnly:true,networkHttp:0,broadcasts:0,cases},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'SAVED',cases:cases.length,work}));
