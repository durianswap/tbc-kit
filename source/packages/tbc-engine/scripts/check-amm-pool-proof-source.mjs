#!/usr/bin/env node
// Fixed SDK oracle with public scalar 1/2 and synthetic funding only. No HTTP.
// SDK signs fixtures outside Engine; Rust consumes raw material and public keys.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import {resolve,join,relative} from 'node:path';
import {build} from 'esbuild';
const [upstreamArg,depsArg,mode]=process.argv.slice(2);
assert.ok(upstreamArg&&depsArg&&[undefined,'--emit-fixture','--emit-multi-controller'].includes(mode)&&process.argv.length<=5);
const upstream=resolve(upstreamArg),depsPath=resolve(depsArg),deps=createRequire(join(depsPath,'package.json'));
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986',sha=b=>createHash('sha256').update(b).digest('hex');
execFileSync(process.execPath,[new URL('./check-amm-code-source.mjs',import.meta.url).pathname,upstream,depsPath],{stdio:'pipe',timeout:30000});
// Upstream TBC20 mixes TS exports and module.exports. Consume its committed CJS
// artifact so bundling cannot hoist that assignment into our oracle's exports.
const built=await build({stdin:{contents:`export const PoolNFT3 = require('./lib/contract/poolNFT3.0.js').PoolNFT3;
export const TBC20 = require('./lib/contract/tbc20.js');
export const FTLPTBC20 = require('./lib/contract/ftlpTbc20.js').FTLPTBC20;
export const privateKeySigner = require('./lib/util/poolnft3/transaction.js').privateKeySigner;
export const buildPoolUnlockScript = require('./lib/util/poolnft3/witness.js').buildPoolUnlockScript;`,resolveDir:upstream},
  bundle:true,write:false,metafile:true,platform:'node',format:'cjs',target:'node22',external:['tbc-lib-js'],resolveExtensions:['.js','.json'],logLevel:'silent'});
const sources={};
for(const name of Object.keys(built.metafile.inputs)){
  if(name==='<stdin>')continue;const path=resolve(name),rel=relative(upstream,path);assert.ok(!rel.startsWith('..'));
  const bytes=readFileSync(path);assert.deepEqual(bytes,execFileSync('git',['-C',upstream,'show',`${commit}:${rel}`],{maxBuffer:8*1024*1024}));sources[rel]=sha(bytes);
}
const module={exports:{}};
runInThisContext(`(function(module,exports,require){${built.outputFiles[0].text}\n})`)(module,module.exports,name=>{
  assert.ok(name==='tbc-lib-js'||name.startsWith('tbc-lib-js/')||name==='node:crypto',`oracle dependency ${name}`);return deps(name);
});
const {PoolNFT3,TBC20,privateKeySigner,buildPoolUnlockScript}=module.exports;
const tbc=deps('tbc-lib-js'),key=new tbc.PrivateKey(new tbc.crypto.BN(1));
let controller=new tbc.PrivateKey(new tbc.crypto.BN(2)),publicKey=controller.publicKey.toBuffer();
const address=key.toAddress().toString(),signer=privateKeySigner(key);
const p2pkh=tbc.Script.buildPublicKeyHashOut(address),vectors=[],raws={},sequences=[];let vmInputs=0;
function remember(tx){const raw=tx.uncheckedSerialize();if(raws[tx.id])assert.equal(raws[tx.id],raw);raws[tx.id]=raw;return tx;}
function verify(tx,history){for(const [vin,input]of tx.inputs.entries()){
  const parent=history.get(input.prevTxId.toString('hex'));assert.ok(parent);input.output=parent.outputs[input.outputIndex];
  const verdict=tx.verifyScript(vin);assert.equal(verdict.success,true,tx.id+':'+vin+': '+verdict.error);vmInputs++;
}}
const ref=(tx,vout)=>({txId:tx.id,outputIndex:vout,script:tx.outputs[vout].script.toHex(),satoshis:tx.outputs[vout].satoshis});
function capture(id,result,history,option,controlled){
  const signed=result.transaction,parent=history.get(signed.inputs[0].prevTxId.toString('hex'));
  const ancestor=history.get(parent.inputs[0].prevTxId.toString('hex'));
  const auxiliary=signed.inputs.slice(1).map(i=>history.get(i.prevTxId.toString('hex')));
  const current=new tbc.Transaction(signed.uncheckedSerialize());
  current.inputs.forEach((i,j)=>{i.output=signed.inputs[j].output;i.setScript(tbc.Script.empty());});
  const signature=controlled?Buffer.from(current.getSignature(0,controller),'hex'):undefined;
  const unlock=buildPoolUnlockScript({tx:current,preTx:parent,prePreTx:ancestor,inputTxs:auxiliary,option,
    ...(controlled?{signature,publicKey}:{})});
  assert.equal(unlock.toHex(),signed.inputs[0].script.toHex());
  const fields=unlock.chunks.map(c=>c.buf??(c.opcodenum===0?Buffer.alloc(0):c.opcodenum===0x4f?Buffer.from([0x81]):Buffer.from([c.opcodenum-0x50])));
  vectors.push({id,operation:option,currentRaw:current.uncheckedSerialize(),parentTxid:parent.id,ancestorTxid:ancestor.id,
    auxiliaryTxids:auxiliary.map(tx=>tx.id),poolHash:sha(parent.outputs[0].script.toBuffer()),
    ...(controlled?{publicKeyHex:publicKey.toString('hex'),signatureHex:signature.toString('hex'),
      digestHex:tbc.crypto.Hash.sha256sha256(Buffer.from(current.getPreimage(0,0x41),'hex')).toString('hex')} : {}),
    fieldHashes:fields.map(f=>sha(f)),unlockHash:sha(unlock.toBuffer()),signedTxid:signed.id});
}
for(const [controlled,timelocked] of [[false,false],[false,true],[true,false],[true,true]]){
  if(mode==='--emit-multi-controller'){
    controller=new tbc.PrivateKey(new tbc.crypto.BN(controlled&&timelocked?3:2));
    publicKey=controller.publicKey.toBuffer();
  }
  const label=(controlled?'controller':'public')+'-'+(timelocked?'locked':'plain');
  const funding=remember(new tbc.Transaction().from({txId:(controlled?(timelocked?'44':'45'):(timelocked?'34':'33')).repeat(32),outputIndex:0,script:p2pkh.toHex(),satoshis:3000000}).to(address,2999000).fee(1000).sign(key));
  const history=new Map([[funding.id,funding]]),chain=[];
  const keep=tx=>{verify(tx,history);remember(tx);history.set(tx.id,tx);chain.push(tx.id);return tx;};
  const token=new TBC20(timelocked?{tapeSize:66,extensionData:'000000000009'}:{});
  const ft=token.mint(key,address,1000000n,ref(funding,0));keep(ft.sourceTransaction);keep(ft.transaction);
  const pool=new PoolNFT3({ftGenesisTx:ft.transaction,lp:{kind:timelocked?'timelocked':'plain'},
    authorization:controlled?{kind:'controller',controllerPubKeyHashes:[tbc.crypto.Hash.sha256ripemd160(publicKey).toString('hex')]}:{kind:'public'}});
  const fund=(r)=>({parentTx:r.transaction,outputIndex:r.changeVout,signer});
  const asset=(r,role)=>({parentTx:r.transaction,outputIndex:r.layout.assetOutputs.find(a=>a.role===role).codeVout,signer,ancestors:history});
  const root={parentTx:ft.transaction,outputIndex:ft.transaction.outputs.length-1,signer};
  const minted=await pool.prepareMintPoolNFT({funding:root}).sign();keep(minted.transaction);
  const authorization=controlled?{controllerSigner:privateKeySigner(controller)}:{};
  const source=(r)=>({parentTx:r.transaction,ancestorTx:history.get(r.transaction.inputs[0].prevTxId.toString('hex'))});
  const added=await pool.prepareAddLP({pool:source(minted),poolFT:asset(minted,'pool-ft'),
    userFT:{parentTx:ft.transaction,outputIndex:0,signer,ancestors:history},funding:fund(minted),
    incrementSat:100000n,firstFtAmountRaw:200000n,lpReceiverAddress:address,...authorization,...(timelocked?{lpLockTime:829999}:{})}).sign();
  keep(added.transaction);capture(label+'-add',added,history,1,controlled);
  const bought=await pool.prepareSwapFT({pool:source(added),poolFT:asset(added,'pool-ft'),funding:fund(added),
    inputTbcSat:10000n,minFtOutRaw:1n,receiverAddress:address,...authorization}).sign();
  keep(bought.transaction);capture(label+'-buy',bought,history,3,controlled);
  const sold=await pool.prepareSwapTBC({pool:source(bought),poolFT:asset(bought,'pool-ft'),userFT:asset(bought,'user-ft'),
    funding:fund(bought),inputFtRaw:1000n,minTbcOutSat:1n,receiverAddress:address,...authorization}).sign();
  keep(sold.transaction);capture(label+'-sell',sold,history,4,controlled);
  const removed=await pool.prepareRemoveLP({pool:source(sold),poolFT:asset(sold,'pool-ft'),userLP:asset(added,'new-lp'),
    funding:fund(sold),burnAmountRaw:10000n,receiverAddress:address,...authorization}).sign();
  keep(removed.transaction);capture(label+'-remove',removed,history,2,controlled);
  sequences.push({label,fundingTxid:funding.id,transactions:chain});
}
const fixture={upstream:{commit,sources,publicScalars:mode==='--emit-multi-controller'?[1,2,3]:[1,2]},scope:'Offline synthetic funding; VM executed, no network or node proof',vmInputs,sequences,raws,vectors};
if(mode==='--emit-fixture'||mode==='--emit-multi-controller')process.stdout.write(JSON.stringify(fixture,null,2)+'\n');
else{assert.deepEqual(JSON.parse(readFileSync(new URL('../rust/fixtures/amm-pool-proof.json',import.meta.url))),fixture);
  console.log('AMM_POOL_PROOF_UPSTREAM_PASS '+vectors.length+' active-branch proofs, '+vmInputs+' independent VM inputs; no HTTP/broadcast');}
