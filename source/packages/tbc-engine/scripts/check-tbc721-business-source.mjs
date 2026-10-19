#!/usr/bin/env node
// Build synthetic Engine plans, then verify every signed input in the pinned
// independent JS VM and compare business outputs with the actual SDK methods.
// Only generated reports go to a temporary directory. No network/delivery files.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInThisContext} from 'node:vm';
import {build} from 'esbuild';

async function main(){
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 const [arg,depsArg]=process.argv.slice(2);assert.ok(arg&&depsArg&&process.argv.length===4,'Usage: FIXED_UPSTREAM DEPENDENCY_DIRECTORY');
 const upstream=resolve(arg),deps=resolve(depsArg),require=createRequire(join(deps,'package.json'));
 const commit='af77616121db340e15bb8b73c197bc2f8d1ee986';
 // Also checks the complete tbc-lib-js byte tree, codec artifact and proof oracle.
 execFileSync(process.execPath,[join(root,'packages/tbc-engine/scripts/check-tbc721-upstream-proof.mjs'),upstream,deps],{stdio:'pipe',timeout:30000});
 const built=await build({entryPoints:[join(upstream,'lib/contract/tbc721.ts')],bundle:true,write:false,metafile:true,
   platform:'node',format:'cjs',target:'node22',external:['tbc-lib-js','tbc-lib-js/*'],logLevel:'silent'});
 for(const name of Object.keys(built.metafile.inputs)){
   const path=resolve(name),rel=relative(upstream,path);assert.ok(!rel.startsWith('..'));
   const pinned=execFileSync('git',['-C',upstream,'show',`${commit}:${rel}`],{maxBuffer:4*1024*1024});
   assert.deepEqual(readFileSync(path),pinned,`Changed upstream dependency ${rel}`);
 }
 const module={exports:{}};
 // tbc-lib-js uses callback instanceof Function. Keep the pinned SDK and lib
 // in one realm so this oracle does not mistake a cross-realm callback for bytes.
 const load=runInThisContext(`(function(module,exports,Buffer,require){${built.outputFiles[0].text}\n})`,{filename:'pinned-tbc721-sdk.cjs',timeout:10000});
 load(module,module.exports,Buffer,function(name){
   if(name==='tbc-lib-js'||name.startsWith('tbc-lib-js/'))return require(name);
   throw Error('Unexpected executable dependency '+name);
 });
 const SDK=module.exports,tbc=require('tbc-lib-js');
 const reportDir=mkdtempSync(join(tmpdir(),'tbc721-business-')),reportPath=join(reportDir,'report.json');
 execFileSync('cargo',['test','--offline','--locked','-p','tbc-engine-core','--test','tbc721_transaction'],{
   cwd:join(root,'packages/tbc-engine/rust'),env:{...process.env,TBC721_SYNTHETIC_REPORT:reportPath},stdio:'pipe',encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
 const report=JSON.parse(readFileSync(reportPath));assert.equal(report.syntheticFunding,true);assert.equal(report.network,false);assert.equal(report.publicScalar,'1');
 const key=new tbc.PrivateKey(new tbc.crypto.BN(1)),owner=key.toAddress().toString();
 const parents=new Map();const seed=new tbc.Transaction(report.fundingRaw);parents.set(seed.id,seed);
 const inputRef=(tx,vin)=>{const i=tx.inputs[vin],p=parents.get(i.prevTxId.toString('hex'));assert.ok(p,'Missing local parent');const o=p.outputs[i.outputIndex];
   return {txId:p.id,outputIndex:i.outputIndex,script:o.script.toHex(),satoshis:o.satoshis};};
 const meta=output=>JSON.parse(output.script.chunks[2].buf.toString());
 let count=0,inputs=0;const fees=[];
 for(const group of report.cases)for(const [index,raw] of group.raws.entries()){
   const tx=new tbc.Transaction(raw),refs=tx.inputs.map((_,vin)=>inputRef(tx,vin));
   tx.inputs.forEach((input,vin)=>{input.output=new tbc.Transaction.Output({script:tbc.Script.fromHex(refs[vin].script),satoshis:refs[vin].satoshis});
     const result=tx.verifyScript(vin);assert.equal(result.success,true,`${group.role} input ${vin}: ${result.error}`);inputs++;});
   const paid=refs.reduce((sum,r)=>sum+r.satoshis,0)-tx.outputs.reduce((sum,o)=>sum+o.satoshis,0);
   assert.equal(paid,group.fees[index]);assert.ok(paid>=Math.max(80,Math.ceil(raw.length/2*80/1000)));
   let sdkRaw,businessCount;
   if(group.role==='collection'){
     sdkRaw=SDK.createCollection(owner,key,meta(tx.outputs[0]),refs);businessCount=4;
   }else if(group.role==='batch-mint'){
     sdkRaw=SDK.createNFT(refs[0].txId,owner,key,meta(tx.outputs[2]),refs.slice(1),refs[0]);businessCount=3;
   }else{
     const parent=parents.get(refs[0].txId),grandparent=parents.get(parent.inputs[0].prevTxId.toString('hex'));
     const nft=new SDK(refs[0].txId);
     if(group.role==='payment'){
       const amount=tx.outputs[3].satoshis,decimal=`${Math.floor(amount/1000000)}.${String(amount%1000000).padStart(6,'0')}`;
       sdkRaw=nft.transferNFTWithTBC(owner,owner,tx.outputs[3].script.toAddress().toString(),key,refs.slice(2),parent,grandparent,decimal);businessCount=4;
     }else{sdkRaw=nft.transferNFT(owner,owner,key,refs.slice(2),parent,grandparent);businessCount=3;}
   }
   const sdk=new tbc.Transaction(sdkRaw);assert.equal(sdk.version,tx.version);
   for(let i=0;i<businessCount;i++)assert.deepEqual({hex:tx.outputs[i].script.toHex(),satoshis:tx.outputs[i].satoshis},
     {hex:sdk.outputs[i].script.toHex(),satoshis:sdk.outputs[i].satoshis},`${group.role} business output ${i}`);
   const sdkFee=refs.reduce((sum,r)=>sum+r.satoshis,0)-sdk.outputs.reduce((sum,o)=>sum+o.satoshis,0);
   fees.push({role:group.role,engineFee:paid,sdkFee,maximumSignedBytes:group.maximumSignedBytes[index],actualSignedBytes:raw.length/2});
   parents.set(tx.id,tx);count++;
 }
 console.log(JSON.stringify({status:'TBC721_BUSINESS_SOURCE_PASS',transactions:count,vmInputs:inputs,upstreamBusinessOutputs:'matched',fees,reportPath,POST:0}));
}
main().catch(error=>{console.error('TBC721_BUSINESS_SOURCE_FAIL '+error.message);
 console.error(String(error.stack??'').split('\n').slice(1,9).join('\n'));process.exitCode=1;});
