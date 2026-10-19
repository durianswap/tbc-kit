#!/usr/bin/env node
// Diagnostic only: test alternate fee encoding/calculation against UNCHANGED
// compiled contracts. In-memory SDK adapters are explicitly listed below.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import {resolve,join,relative} from 'node:path';
import {build} from 'esbuild';

const [upstreamArg,depsArg]=process.argv.slice(2);
assert.ok(upstreamArg&&depsArg&&process.argv.length===4);
const upstream=resolve(upstreamArg),deps=createRequire(join(resolve(depsArg),'package.json'));
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986';
execFileSync(process.execPath,[new URL('./check-amm-code-source.mjs',import.meta.url).pathname,upstream,resolve(depsArg)],{stdio:'pipe',timeout:30000});
const modifiedSources=[];
const built=await build({stdin:{contents:`export const PoolNFT3=require('./lib/contract/poolNFT3.0.js').PoolNFT3;
export const TBC20=require('./lib/contract/tbc20.js');
export const fees=require('./lib/util/poolnft3/fees.js');
export const tape=require('./lib/util/poolnft3/tape.js');
export const privateKeySigner=require('./lib/util/poolnft3/transaction.js').privateKeySigner;`,resolveDir:upstream},
  bundle:true,write:false,metafile:true,platform:'node',format:'cjs',target:'node22',external:['tbc-lib-js'],
  resolveExtensions:['.js','.json'],logLevel:'silent',plugins:[{name:'allow-zero-retention-in-quote-only',setup(api){
    api.onLoad({filter:/poolnft3\/math\.js$/},({path})=>{
      let contents=readFileSync(path,'utf8');
      // Allow quote preparation to reach the actual VM with equality. Never
      // modify bytecode, VM or transaction validators to obtain a pass.
      for(const [oldValue,newValue]of [
        ['poolValueIncrementSat <= effectiveTbcIncrementSat','poolValueIncrementSat < effectiveTbcIncrementSat'],
        ['poolValueDecrementSat >= grossTbcOutSat','poolValueDecrementSat > grossTbcOutSat'],
      ]){assert.equal(contents.split(oldValue).length,2);contents=contents.replace(oldValue,newValue);}
      modifiedSources.push({path:relative(upstream,path),adaptedSha256:createHash('sha256').update(contents).digest('hex')});
      return{contents,loader:'js'};
    });
  }}]});
for(const file of Object.keys(built.metafile.inputs)){
  if(file==='<stdin>')continue;
  const path=resolve(file),rel=relative(upstream,path);assert.ok(!rel.startsWith('..'));
  assert.deepEqual(readFileSync(path),execFileSync('git',['-C',upstream,'show',`${commit}:${rel}`],{maxBuffer:8*1024*1024}));
}
const module={exports:{}};
runInThisContext(`(function(module,exports,require){${built.outputFiles[0].text}\n})`)(module,module.exports,name=>{
  assert.ok(name==='tbc-lib-js'||name.startsWith('tbc-lib-js/')||name==='node:crypto');return deps(name);
});
const {PoolNFT3,TBC20,fees,tape,privateKeySigner}=module.exports;
const tbc=deps('tbc-lib-js'),payer=new tbc.PrivateKey(new tbc.crypto.BN(1)),controller=new tbc.PrivateKey(new tbc.crypto.BN(2));
let lastFailure;
// Read-only diagnostic callback; execution and its return value remain original.
tbc.Script.Interpreter.prototype.stepListener=function(step){
  if(this.errstr)lastFailure={pc:step.pc,operations:this.script.chunks.slice(Math.max(0,step.pc-2),step.pc+1)
    .map(chunk=>tbc.Opcode.fromNumber(chunk.opcodenum).toString())};
};
const address=payer.toAddress().toString(),signer=privateKeySigner(payer),p2pkh=tbc.Script.buildPublicKeyHashOut(address);
const originalEncode=tape.encodePoolTape,originalDecode=tape.decodePoolTape;
let policy;
// Proposed diagnostic packing only: 10-bit total, 10-bit LP, 4-bit discriminator.
// It fits the existing three immutable bytes, with no preset index on chain.
const packedPolicy=()=>0xa00000+policy.lpFeeBps*1024+policy.totalFeeBps;
fees.resolveSwapFeePolicy=()=>policy;
fees.calculateSwapFees=base=>{
  const totalFeeSat=base*BigInt(policy.totalFeeBps)/10000n,lpFeeSat=base*BigInt(policy.lpFeeBps)/10000n;
  const serviceFeeAccruedSat=totalFeeSat-lpFeeSat,serviceFeePaidSat=serviceFeeAccruedSat>=10n?serviceFeeAccruedSat:0n;
  return{baseTbcSat:base,totalFeeSat,lpFeeSat,serviceFeeAccruedSat,serviceFeePaidSat,
    serviceFeeRetainedSat:serviceFeeAccruedSat-serviceFeePaidSat,poolFeeRetainedSat:totalFeeSat-serviceFeePaidSat,netAmountSat:base-totalFeeSat};
};
tape.encodePoolTape=fields=>{
  const bytes=originalEncode(fields);bytes.writeUIntLE(packedPolicy(),128,3);return bytes;
};
tape.decodePoolTape=value=>{
  const decoded=originalDecode(value),bytes=Buffer.isBuffer(value)?value:value.toBuffer();
  assert.equal(bytes.readUIntLE(128,3),packedPolicy());
  // Only adapts the old SDK object's expected fields for this experiment.
  // Production would expose canonical feePolicy, never this dummy lpPlan.
  return{...decoded,serviceFeeRate:policy.totalFeeBps,lpPlan:0};
};
const cases=[];let vmInputs=0;
const ref=(tx,vout)=>({txId:tx.id,outputIndex:vout,script:tx.outputs[vout].script.toHex(),satoshis:tx.outputs[vout].satoshis});
for(const [total,lp]of [[35,25],[47,13],[600,300],[600,600],[600,0],[0,0]]){
  for(const controlled of [false,true]){
    policy={totalFeeBps:total,lpFeeBps:lp,serviceFeeAddress:address,servicePayoutThresholdSat:10n,lpPlan:0};
    const funding=new tbc.Transaction().from({txId:'11'.repeat(32),outputIndex:0,script:p2pkh.toHex(),satoshis:3000000})
      .to(address,2999000).fee(1000).sign(payer);
    const history=new Map([[funding.id,funding]]),steps=[];
    const keep=tx=>{
      for(const [index,input]of tx.inputs.entries()){
        const parent=history.get(input.prevTxId.toString('hex'));assert.ok(parent);input.output=parent.outputs[input.outputIndex];
        const verdict=tx.verifyScript(index);assert.ok(verdict.success,verdict.error);vmInputs++;
      }
      history.set(tx.id,tx);return tx;
    };
    const ft=new TBC20().mint(payer,address,1000000n,ref(funding,0));keep(ft.sourceTransaction);keep(ft.transaction);
    const pool=new PoolNFT3({ftGenesisTx:ft.transaction,authorization:controlled?
      {kind:'controller',controllerPubKeyHashes:[tbc.crypto.Hash.sha256ripemd160(controller.publicKey.toBuffer()).toString('hex')]}:{kind:'public'}});
    const fund=r=>({parentTx:r.transaction,outputIndex:r.changeVout,signer});
    const asset=(r,role)=>({parentTx:r.transaction,outputIndex:r.layout.assetOutputs.find(a=>a.role===role).codeVout,signer,ancestors:history});
    const source=r=>({parentTx:r.transaction,ancestorTx:history.get(r.transaction.inputs[0].prevTxId.toString('hex'))});
    const auth=controlled?{controllerSigner:privateKeySigner(controller)}:{};
    const attempt=async(name,create)=>{
      lastFailure=undefined;
      try{const result=await create().sign();keep(result.transaction);steps.push({name,passed:true});return result;}
      catch(error){steps.push({name,passed:false,error:error.message,failureSite:lastFailure});return undefined;}
    };
    const minted=await attempt('create',()=>pool.prepareMintPoolNFT({funding:{parentTx:ft.transaction,outputIndex:ft.transaction.outputs.length-1,signer}}));
    assert.ok(minted);
    const added=await attempt('add',()=>pool.prepareAddLP({pool:source(minted),poolFT:asset(minted,'pool-ft'),
      userFT:{parentTx:ft.transaction,outputIndex:0,signer,ancestors:history},funding:fund(minted),
      incrementSat:100000n,firstFtAmountRaw:200000n,lpReceiverAddress:address,...auth}));
    assert.ok(added);
    const bought=await attempt('buy',()=>pool.prepareSwapFT({pool:source(added),poolFT:asset(added,'pool-ft'),funding:fund(added),
      inputTbcSat:10000n,minFtOutRaw:1n,receiverAddress:address,...auth}));
    const sellFrom=bought??added;
    const sold=await attempt('sell',()=>pool.prepareSwapTBC({pool:source(sellFrom),poolFT:asset(sellFrom,'pool-ft'),
      userFT:asset(sellFrom,bought?'user-ft':'ft-change'),funding:fund(sellFrom),inputFtRaw:1000n,minTbcOutSat:1n,receiverAddress:address,...auth}));
    const removeFrom=sold??sellFrom;
    await attempt('remove',()=>pool.prepareRemoveLP({pool:source(removeFrom),poolFT:asset(removeFrom,'pool-ft'),userLP:asset(added,'new-lp'),
      funding:fund(removeFrom),burnAmountRaw:10000n,receiverAddress:address,...auth}));
    cases.push({totalFeeBps:total,lpFeeBps:lp,controlled,steps});
  }
}
assert.equal(cases.length,12);
for(const row of cases)for(const step of row.steps){
  const expected=row.lpFeeBps!==0||!['buy','sell'].includes(step.name);
  assert.equal(step.passed,expected,`${row.totalFeeBps}/${row.lpFeeBps}/${step.name}`);
  if(!expected)assert.ok(step.error.includes('local input validation failed'));
}
delete tbc.Script.Interpreter.prototype.stepListener;
console.log(JSON.stringify({scope:'Feasibility only; original compiled scripts and validators, explicit in-memory SDK fee/codec adapters',
  sourceCommit:commit,modifiedSources,vmInputs,networkRequests:0,broadcasts:0,cases},null,2));
