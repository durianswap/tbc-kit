// SDK-generated synthetic material only. Public scalars1/2; no network/custody.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {createRequire} from 'node:module';

export function reviewedAdminControllerFixture(root){return fixtureFor(root,false,true);}
export function reviewedAdminCooperativeFixture(root,{controller=false}={}){return fixtureFor(root,true,controller);}
function fixtureFor(root,cooperative,controller){
 const fixture=JSON.parse(execFileSync(process.execPath,[join(root,'packages/tbc-engine/scripts/check-coin-proof-source.mjs'),
  '/private/tmp/tbc-associated-upstream-LdkrwT',root,cooperative?(controller?'--emit-admin-musig-controller-fixture':'--emit-admin-musig-fixture'):'--emit-admin-controller-fixture'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:60000}));
 assert.equal(fixture.upstream.commit,'af77616121db340e15bb8b73c197bc2f8d1ee986');
 const tbc=createRequire(join(root,'package.json'))('tbc-lib-js');
 const publicKey='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
 const rows=[0,2].map(index=>{
  const item=fixture.cases[index],parent=new tbc.Transaction(item.parentRaw),tx=new tbc.Transaction(item.signedRaw);
  tx.inputs.forEach(i=>i.setScript(tbc.Script.empty()));
  const sourceUtxos=tx.inputs.map((input,vin)=>{
   assert.equal(input.prevTxId.toString('hex'),parent.id);
   const output=parent.outputs[input.outputIndex],proof=fixture.cases.find(v=>v.signedRaw===item.signedRaw&&v.inputIndex===vin);
   return {txId:parent.id,outputIndex:input.outputIndex,script:output.script.toHex(),satoshis:output.satoshis,
    scriptSigType:proof?'tbc20-stablecoin':'p2pkh',preTx:item.parentRaw,
    ...(proof?{ancestorTransactions:proof.ancestorsRaw,signingPublicKey:proof.publicKeyHex}:{})};
  });
  return {id:(index===0?'freeze':'unfreeze')+(cooperative?'-aggregate-admin':'-contract-held'),prepare:{format:'associated',publicKey,
   request:{sourceTxraw:tx.toString(),sourceUtxos,inputs:[],outputs:[]}},stage:{signingTasks:[{publicKey:item.publicKeyHex}]}};
 });
 const chain=structuredClone(rows[0]),unfreeze=rows[1].prepare.request;
 chain.id=cooperative?'unfreeze-aggregate-admin-child':'unfreeze-contract-held-child';
 chain.prepare.request.inputs=[unfreeze.sourceUtxos.map(i=>{
  const copy={...i};for(const key of ['txId','preTx','ancestorTransactions','script','satoshis'])delete copy[key];return copy;
 })];
 chain.prepare.request.outputs=[new tbc.Transaction(unfreeze.sourceTxraw).outputs.map(o=>({satoshis:o.satoshis,script:o.script.toHex()}))];
 rows.push(chain);
 return {fixtureOnly:true,network:false,...(cooperative?{cooperative:true}:{}),...(controller?{controller:'22'.repeat(20)+'01'}:{}),upstream:fixture.upstream,upstreamVmInputs:fixture.vmInputs,rows};
}
