// Source-only integration harness. Public fixture scalars 1/2; no wallet keys,
// live I/O or broadcast. Frozen oracle and delivery files are not modified.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
import {canonical,hash,sha,address,publicKey,account} from '../flutter-dart-kit/tool/frozen_oracle.mjs';
export {canonical,hash,sha,address,publicKey,account};
export const root=resolve(import.meta.dirname,'../..'),now='2026-10-14T06:00:00.123Z';
export const controller={chainId:account.chainId,address:'1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',accountId:account.chainId+':1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',publicKey:'02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'};
export async function source(path){
  const result=await build({entryPoints:[join(root,path)],bundle:true,write:false,format:'esm',platform:'node',target:'node22',logLevel:'silent',
    banner:{js:`import {createRequire as __fixtureRequire} from 'node:module'; const require=__fixtureRequire(${JSON.stringify(join(root,'packages/kit/package.json'))});`},
    plugins:[{name:'current-internal-sources',setup(b){
      if(process.env.CONTRACT173_DIAGNOSTICS==='1')b.onLoad({filter:/\/default-chain-data\.ts$/},async args=>{
        const contents=await readFile(args.path,'utf8');
        const needle='if (error instanceof ChainDataAuthorizationError) return failure("UNAUTHORIZED");';
        assert.equal(contents.split(needle).length,2);
        return {loader:'ts',contents:contents.replace(needle,'console.error("Offline material diagnostic:", error instanceof Error ? error.message : "non-Error", JSON.stringify((error as {issues?: unknown}).issues)); '+needle)};
      });
      b.onResolve({filter:/^@tbc-wallet\/(core|host|provider|engine)$/},args=>({path:join(root,`packages/${args.path.endsWith('/engine')?'tbc-engine':args.path.split('/').at(-1)}/src/index.ts`)}));
      // Normal source builds install this lazy private parser separately. AMM
      // intents do not invoke it; preserve the real module, not a test stub.
      b.onResolve({filter:/^\.\/vendor\/tbc-tx-parser\/index\.js$/},()=>({path:'file://'+join(root,'packages/kit/dist/esm/vendor/tbc-tx-parser/index.js'),external:true}));
    }}]});
  return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
}
export async function sourceOracle(){
  const [kit,api,eng,key]=await Promise.all(['wallet','api','engine','keyless'].map(p=>source(`packages/kit/src/${p}.ts`)));
  const manifest=JSON.parse(await readFile(join(import.meta.dirname,'runtime-parity-full.json')));
  const wasm=await readFile(join(root,'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm'));
  const keyWasm=await readFile(join(root,'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm'));
  assert.equal(sha(wasm),manifest.artifacts['target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm'].sha256);
  assert.equal(sha(keyWasm),manifest.artifacts['target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm'].sha256);
  const engine=await eng.createWasmTbcEngineBackend(wasm),keyless=await key.createWasmTbcKeylessEngine(keyWasm);
  async function call(method,input){const r=JSON.parse(await engine.call(method,canonical(input)));assert.equal(r.ok,true,JSON.stringify(r.error));return r.result;}
  async function sign(name,request,snapshot,policy){
    const n=await call('normalizeRequest',{version:'1.0',request});assert.equal(canonical(n.request),canonical(request));
    const material={version:'1.0',...n,snapshot,policy},{plan}=await call('plan',material);
    assert.equal((await call('validate',{...material,plan,phase:'plan'})).valid,true);
    const context={sessionId:'offline-'+name,navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',transport:'webview',frame:'top',createdAt:now};
    const payload={version:'1.0',method:'tbc_signTransaction',operationKind:'transaction',contextHash:hash(context),origin:context.origin,sessionId:context.sessionId,
      chainId:account.chainId,accountId:account.accountId,requestHash:n.requestHash,operationHash:plan.planHash,expiresAt:plan.payload.expiresAt};
    const binding={payload,bindingHash:hash(payload)},approval={status:'approved',approvalId:'offline-'+name,approvalToken:'public-fixture-only',bindingHash:binding.bindingHash,approvedAt:now,expiresAt:payload.expiresAt};
    assert.equal((await call('validate',{...material,plan,binding,approval,phase:'pre-sign'})).valid,true);
    const fixtureKeys=new Map([[publicKey,1n],[controller.publicKey,2n]]);
    let tasks=plan.payload.signingTasks,continuation,final;const stages=[];
    for(let stage=0;stage<plan.payload.transactions.length;stage++){
      const signatures=tasks.map(t=>{assert.equal(t.signatureEncoding,'compact64');const key=fixtureKeys.get(t.publicKey);assert(key);return {taskId:t.taskId,signatureEncoding:'compact64',signature:secp256k1.sign(t.digest,key,{lowS:true,prehash:false}).toCompactHex()};});
      const args={...material,plan,binding,approval,signatures,...(continuation?{continuation}:{})};final=await call('finalize',args);
      assert.equal((await call('validate',{...args,phase:'finalized',...(final.bundle?{bundle:final.bundle}:{pending:final})})).valid,true);
      stages.push({stage,tasks,signatures,...(continuation?{continuation}:{}),result:final});
      if(final.bundle){assert.equal(final.validation.valid,true);break;}
      assert.equal(final.status,'pending');continuation=final.continuation;tasks=final.signingRequests;
    }
    assert(final?.bundle);
    return {context,result:final.bundle,audit:{material,plan,preview:plan.payload.preview,binding,approval,signatures:stages.flatMap(s=>s.signatures),stages}};
  }
  return {kit,api,keyless,call,sign,wasmSha256:sha(wasm),keylessWasmSha256:sha(keyWasm)};
}
