// Frozen WASM oracle with public scalar-one signatures. No API/POST/key custody.
// Native tests independently consume these exact request/plan/result vectors.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {secp256k1} from '@noble/curves/secp256k1';
const base=resolve(import.meta.dirname,'..'),repo=resolve(base,'../..');
const source=JSON.parse(await readFile(join(base,'test/fixtures/native-transfers.json')));
const sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=v=>sha(canonical(v));
const archive=join(repo,'release/kit-amm4-20261011/tbc-kit-0.1.0-platform-slim.20261011.4.tgz');
assert.equal(sha(await readFile(archive)),source.archiveSha256);
const work=await mkdtemp('/private/tmp/tbc-dart-native-signing-');
execFileSync('tar',['-xzf',archive,'-C',work]);
await symlink(join(repo,'node_modules'),join(work,'node_modules'),'dir');
const {createWasmTbcEngineBackend}=await import(pathToFileURL(join(work,'package/dist/esm/engine.node.js')));
const wasm=await readFile(join(work,'package/artifacts/wasm/tbc_engine_wasm.wasm'));
const engine=await createWasmTbcEngineBackend(wasm);
async function call(method,input){const r=JSON.parse(await engine.call(method,canonical(input)));assert.equal(r.ok,true,JSON.stringify(r.error));return r.result;}
const cases=[];
for(const c of source.cases.filter(c=>c.policy)){
 const n=await call('normalizeRequest',{version:'1.0',request:c.request});
 assert.equal(canonical(n.request),canonical(c.request));
 const material={version:'1.0',request:n.request,requestHash:n.requestHash,snapshot:c.snapshot,policy:c.policy};
 const {plan}=await call('plan',material);
 assert.equal((await call('validate',{...material,plan,phase:'plan'})).valid,true);
 const context={sessionId:'offline-'+c.name,navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',transport:'webview',frame:'top',createdAt:c.now};
 const payload={version:'1.0',method:'tbc_signTransaction',operationKind:'transaction',contextHash:hash(context),origin:context.origin,sessionId:context.sessionId,chainId:c.account.chainId,accountId:c.account.accountId,requestHash:n.requestHash,operationHash:plan.planHash,expiresAt:plan.payload.expiresAt};
 const binding={payload,bindingHash:hash(payload)};
 const approval={status:'approved',approvalId:'offline-'+c.name,approvalToken:'public-fixture-only',bindingHash:binding.bindingHash,approvedAt:c.now,expiresAt:payload.expiresAt};
 assert.equal((await call('validate',{...material,plan,binding,approval,phase:'pre-sign'})).valid,true);
 const signatures=plan.payload.signingTasks.map(t=>{
  assert.equal(t.signatureEncoding,'compact64');
  return {taskId:t.taskId,signatureEncoding:t.signatureEncoding,signature:secp256k1.sign(t.digest,1n,{lowS:true,prehash:false}).toCompactHex()};
 });
 const args={...material,plan,binding,approval,signatures};
 const f=await call('finalize',args);assert.equal(f.validation.valid,true);
 assert.equal((await call('validate',{...args,bundle:f.bundle,phase:'finalized'})).valid,true);
 cases.push({name:c.name,network:c.network,now:c.now,method:'tbc_signTransaction',account:c.account,context,request:c.request,result:f.bundle,audit:{material,plan,preview:plan.payload.preview,binding,approval,signatures}});
}
const report={status:'FROZEN_WASM_NATIVE_SIGNING_ORACLE',archiveSha256:source.archiveSha256,wasmSha256:sha(wasm),publicScalarOneOnly:true,networkHttp:0,broadcasts:0,cases};
await writeFile(join(base,'test/fixtures/native-signing.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,reference:work,cases:cases.map(c=>({name:c.name,tasks:c.audit.signatures.length,fee:c.result.totalFee}))}));
