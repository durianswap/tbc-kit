import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const built=await build({stdin:{contents:'export * from "./src/reviewed-signing-roles.ts";',resolveDir:new URL('../',import.meta.url).pathname},bundle:true,write:false,format:'cjs',platform:'node'});
const module={exports:{}};new Function('module','exports','require',built.outputFiles[0].text)(module,module.exports,createRequire(import.meta.url));
const {resolveReviewedSigningRoles:resolve,assertReviewedSigningRolePreview:check}=module.exports;
const owner={chainId:'tbc:testnet',address:'owner',accountId:'tbc:testnet:owner',publicKey:'0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'};
const admin={chainId:'tbc:testnet',address:'admin',accountId:'tbc:testnet:admin',publicKey:'02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'};
const input={signingProfile:'tbc20-stablecoin',signingRole:'coin-admin'};
const request={chainId:owner.chainId,from:owner.address,signingRoles:[{role:'coin-admin',accountId:admin.accountId}],
 request:{payload:{format:'associated',sourceInputs:[input,{signingProfile:'p2pkh'}],children:[]}}};
test('Reviewed roles select trusted accounts; default management needs no second account',()=>{
 assert.deepEqual(resolve(request,[owner,admin]),[{role:'coin-admin',account:admin}]);
 const same=structuredClone(request);delete same.signingRoles;
 assert.deepEqual(resolve(same,[owner]),[{role:'coin-admin',account:owner}]);
 const child=structuredClone(request);child.request.payload.sourceInputs=[];child.request.payload.children=[{inputs:[input]}];
 assert.deepEqual(resolve(child,[owner,admin]),[{role:'coin-admin',account:admin}]);
 const holder=structuredClone(same);delete holder.request.payload.sourceInputs[0].signingRole;
 assert.equal(resolve(holder,[owner]),undefined);check(holder,[owner],{});
});
test('raw input role markers resolve the same trusted Coin administrator, never page keys',()=>{
 const raw=structuredClone(request);raw.request.payload={format:'raw',transactions:[{rawTransaction:'00',inputs:[{satoshis:'500',scriptPubKey:'51',signingRole:'coin-admin'},{satoshis:'1',scriptPubKey:'51'}]}]};
 assert.deepEqual(resolve(raw,[owner,admin]),[{role:'coin-admin',account:admin}]);
 delete raw.signingRoles;assert.deepEqual(resolve(raw,[owner]),[{role:'coin-admin',account:owner}]);
 raw.request.payload.transactions[0].inputs[0].signingRole='pool-controller';assert.throws(()=>resolve(raw,[owner]));
});
test('Reviewed rejects unselected, ambiguous, cross-chain and unrelated role requests',()=>{
 for(const accounts of [[owner],[owner,admin,admin],[owner,{...admin,publicKey:owner.publicKey}]])assert.throws(()=>resolve(request,accounts));
 for(const mutate of [r=>r.signingRoles[0].accountId='tbc:mainnet:admin',r=>r.signingRoles=[],
  r=>r.signingRoles[0].role='pool-controller',r=>delete r.request.payload.sourceInputs[0].signingRole,
  r=>r.request.payload.sourceInputs[0].signingProfile='p2pkh',r=>r.request.payload.format='raw']){
  const bad=structuredClone(request);mutate(bad);assert.throws(()=>resolve(bad,[owner,admin]));
 }
});
test('Reviewed approval role identity must match Host resolution, not merely a valid review hash',()=>{
 const signingRoles=resolve(request,[owner,admin]);assert.deepEqual(check(request,[owner,admin],{signingRoles}),signingRoles);
 for(const preview of [{},{signingRoles:[{role:'coin-admin',account:owner}]},{signingRoles:[...signingRoles,...signingRoles]}])
  assert.throws(()=>check(request,[owner,admin],preview));
 const holder=structuredClone(request);delete holder.signingRoles;delete holder.request.payload.sourceInputs[0].signingRole;
 assert.throws(()=>check(holder,[owner],{signingRoles}));
});
