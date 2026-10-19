// Test-only frozen Kit/WASM comparator shared by further family migrations.
// No network transport, production account, private wallet or broadcast.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {secp256k1} from '@noble/curves/secp256k1';
export const base=resolve(import.meta.dirname,'..'),repo=resolve(base,'../..');
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export const hash=v=>sha(canonical(v));
export const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',publicKey='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
export const account={chainId:'tbc:testnet',address,publicKey,accountId:`tbc:testnet:${address}`};
export const now='2026-10-12T14:00:00.123Z';
export async function frozenOracle(){
 const archive=join(repo,'release/kit-amm4-20261011/tbc-kit-0.1.0-platform-slim.20261011.4.tgz');
 const archiveSha256=sha(await readFile(archive));
 assert.equal(archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
 const work=await mkdtemp('/private/tmp/tbc-dart-family-oracle-');
 execFileSync('tar',['-xzf',archive,'-C',work]);await symlink(join(repo,'node_modules'),join(work,'node_modules'),'dir');
 const load=p=>import(pathToFileURL(join(work,'package/dist/esm',p)));
 const kit=await load('wallet.node.js'),eng=await load('engine.node.js'),key=await load('keyless.js'),api=await load('api.js');
 const wasm=await readFile(join(work,'package/artifacts/wasm/tbc_engine_wasm.wasm'));
 const keyless=await key.createWasmTbcKeylessEngine(await readFile(join(work,'package/artifacts/wasm/tbc_keyless_wasm.wasm')));
 const engine=await eng.createWasmTbcEngineBackend(wasm);
 async function call(method,input){const r=JSON.parse(await engine.call(method,canonical(input)));assert.equal(r.ok,true,JSON.stringify(r.error));return r.result;}
 async function sign(name,request,snapshot,policy,{captureStages=false,fixtureRoleAccounts=[]}={}){
  // Explicit public fixture role only; never a general key lookup or adapter.
  const fixtureKeys=new Map([[publicKey,1n]]);
  assert(fixtureRoleAccounts.length<=1);
  if(fixtureRoleAccounts.length){
   const role=fixtureRoleAccounts[0],key='02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
   assert.deepEqual(role,{chainId:account.chainId,address:'1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',accountId:account.chainId+':1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',publicKey:key});
   assert.deepEqual(request.signingRoles,[{role:'pool-controller',accountId:role.accountId}]);
   assert.deepEqual(snapshot.payload.signingAccounts,fixtureRoleAccounts);fixtureKeys.set(key,2n);
  }else assert.equal(snapshot.payload.signingAccounts,undefined);
  const normalized=await call('normalizeRequest',{version:'1.0',request});assert.equal(canonical(normalized.request),canonical(request));
  const material={version:'1.0',...normalized,snapshot,policy},{plan}=await call('plan',material);
  assert.equal((await call('validate',{...material,plan,phase:'plan'})).valid,true);
  const context={sessionId:'offline-'+name,navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',transport:'webview',frame:'top',createdAt:now};
  const payload={version:'1.0',method:'tbc_signTransaction',operationKind:'transaction',contextHash:hash(context),origin:context.origin,sessionId:context.sessionId,chainId:account.chainId,accountId:account.accountId,requestHash:normalized.requestHash,operationHash:plan.planHash,expiresAt:plan.payload.expiresAt};
  const binding={payload,bindingHash:hash(payload)},approval={status:'approved',approvalId:'offline-'+name,approvalToken:'public-fixture-only',bindingHash:binding.bindingHash,approvedAt:now,expiresAt:payload.expiresAt};
  assert.equal((await call('validate',{...material,plan,binding,approval,phase:'pre-sign'})).valid,true);
  let tasks=plan.payload.signingTasks,continuation,final;const stages=[];
  for(let stage=0;stage<plan.payload.transactions.length;stage++){
   const signatures=tasks.map(t=>{const key=fixtureKeys.get(t.publicKey);assert(key,'Unknown public fixture role');assert.equal(t.signatureEncoding,'compact64');return {taskId:t.taskId,signatureEncoding:t.signatureEncoding,signature:secp256k1.sign(t.digest,key,{lowS:true,prehash:false}).toCompactHex()};});
   const args={...material,plan,binding,approval,signatures,...(continuation?{continuation}:{})};final=await call('finalize',args);
   assert.equal((await call('validate',{...args,phase:'finalized',...(final.bundle?{bundle:final.bundle}:{pending:final})})).valid,true);
   stages.push({stage,tasks,signatures,...(continuation?{continuation}:{}),result:final});
   if(final.bundle){assert.equal(final.validation.valid,true);break;}
   assert(captureStages,name+':dependent-stage-not-captured');assert.equal(final.status,'pending');continuation=final.continuation;tasks=final.signingRequests;
  }
  assert(final?.bundle,name+':incomplete-stages');
  return {context,result:final.bundle,audit:{material,plan,preview:plan.payload.preview,binding,approval,signatures:stages.flatMap(s=>s.signatures),...(captureStages?{stages}:{})}};
 }
 return {kit,keyless,api,call,sign,archiveSha256,wasmSha256:sha(wasm),work};
}
