#!/usr/bin/env node
// Fixed upstream complete mint wrapper; synthetic public scalar 1 only. No I/O
// to chain services. Store compact hashes/signatures rather than duplicate raws.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import {resolve,join,relative} from 'node:path';
import {build} from 'esbuild';
const [upstreamArg,depsArg,mode]=process.argv.slice(2);
assert.ok(upstreamArg&&depsArg&&[undefined,'--emit-fixture'].includes(mode)&&process.argv.length<=5);
const upstream=resolve(upstreamArg),depsPath=resolve(depsArg),deps=createRequire(join(depsPath,'package.json'));
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986',sha=b=>createHash('sha256').update(b).digest('hex');
execFileSync(process.execPath,[new URL('./check-amm-code-source.mjs',import.meta.url).pathname,upstream,depsPath],{stdio:'pipe',timeout:30000});
const built=await build({stdin:{contents:`export const PoolNFT3 = require('./lib/contract/poolNFT3.0.js').PoolNFT3;
export const privateKeySigner = require('./lib/util/poolnft3/transaction.js').privateKeySigner;`,resolveDir:upstream},
  bundle:true,write:false,metafile:true,platform:'node',format:'cjs',target:'node22',external:['tbc-lib-js'],resolveExtensions:['.js','.json'],logLevel:'silent'});
const sources={};
for(const name of Object.keys(built.metafile.inputs)){
  if(name==='<stdin>')continue;const path=resolve(name),rel=relative(upstream,path);assert.ok(!rel.startsWith('..'));
  const bytes=readFileSync(path);assert.deepEqual(bytes,execFileSync('git',['-C',upstream,'show',`${commit}:${rel}`],{maxBuffer:8*1024*1024}));sources[rel]=sha(bytes);
}
const module={exports:{}};
runInThisContext(`(function(module,exports,require){${built.outputFiles[0].text}\n})`)(module,module.exports,name=>{
  assert.ok(name==='tbc-lib-js'||name.startsWith('tbc-lib-js/')||name==='node:crypto');return deps(name);
});
const {PoolNFT3,privateKeySigner}=module.exports,tbc=deps('tbc-lib-js');
const key=new tbc.PrivateKey(new tbc.crypto.BN(1)),controller=new tbc.PrivateKey(new tbc.crypto.BN(2));
const sourceFixture=readFileSync(new URL('../rust/fixtures/amm-pool-proof.json',import.meta.url));
const previous=JSON.parse(sourceFixture),cases=[];let vmInputs=0;
for(const label of ['public-plain','public-locked','controller-plain','controller-locked']){
  const before=previous.vectors.find(v=>v.id===label+'-add');
  const oldPool=new tbc.Transaction(previous.raws[before.parentTxid]);
  const ftGenesisId=oldPool.inputs[0].prevTxId.toString('hex'),ftGenesis=new tbc.Transaction(previous.raws[ftGenesisId]);
  const timelocked=label.endsWith('locked'),controlled=label.startsWith('controller');
  const pool=new PoolNFT3({ftGenesisTx:ftGenesis,lp:{kind:timelocked?'timelocked':'plain'},
    authorization:controlled?{kind:'controller',controllerPubKeyHashes:[tbc.crypto.Hash.sha256ripemd160(controller.publicKey.toBuffer()).toString('hex')]}:{kind:'public'}});
  const vout=oldPool.inputs[0].outputIndex;
  const result=await pool.mintPoolNFT({funding:{parentTx:ftGenesis,outputIndex:vout,signer:privateKeySigner(key)}});
  assert.equal(result.transactions.length,2);
  const [source,genesis]=result.transactions;
  for(const [tx,parent,index]of [[source,ftGenesis,vout],[genesis,source,0]]){
    assert.equal(tx.inputs.length,1);tx.inputs[0].output=parent.outputs[index];
    const verdict=tx.verifyScript(0);assert.equal(verdict.success,true,verdict.error);vmInputs++;
  }
  const history=new Map(Object.entries(previous.raws).map(([id,raw])=>[id,new tbc.Transaction(raw)]));
  history.set(source.id,source);history.set(genesis.id,genesis);
  const added=await pool.prepareAddLP({pool:{parentTx:genesis,ancestorTx:source},
    poolFT:{parentTx:genesis,outputIndex:2,signer:privateKeySigner(key),ancestors:history},
    userFT:{parentTx:ftGenesis,outputIndex:0,signer:privateKeySigner(key),ancestors:history},
    funding:{parentTx:genesis,outputIndex:result.changeVout,signer:privateKeySigner(key)},
    incrementSat:100000n,firstFtAmountRaw:200000n,lpReceiverAddress:key.toAddress().toString(),
    ...(controlled?{controllerSigner:privateKeySigner(controller)}:{}),...(timelocked?{lpLockTime:829999}:{})}).sign();
  for(const [vin,input]of added.transaction.inputs.entries()){
    input.output=history.get(input.prevTxId.toString('hex')).outputs[input.outputIndex];
    const verdict=added.transaction.verifyScript(vin);assert.equal(verdict.success,true,verdict.error);vmInputs++;
  }
  const firstAddSignatures=added.transaction.inputs.flatMap((input,vin)=>{
    if(vin===0&&!controlled)return[];const chunks=input.script.chunks;
    return[{vin,signature:chunks[chunks.length===123?98:0].buf.toString('hex')}];
  });
  cases.push({label,ftGenesisId,fundingVout:vout,sourceRaw:source.uncheckedSerialize(),
    sourceFee:ftGenesis.outputs[vout].satoshis-source.outputs.reduce((n,o)=>n+o.satoshis,0),
    genesisFee:source.outputs[0].satoshis-genesis.outputs.reduce((n,o)=>n+o.satoshis,0),
    genesisRawHash:sha(Buffer.from(genesis.uncheckedSerialize(),'hex')),genesisTxid:genesis.id,
    genesisSignature:genesis.inputs[0].script.chunks[0].buf.toString('hex'),
    firstAddRawHash:sha(Buffer.from(added.transaction.uncheckedSerialize(),'hex')),firstAddTxid:added.transaction.id,firstAddSignatures});
}
const fixture={upstream:{commit,sources,publicScalars:[1,2],poolFixtureSha256:sha(sourceFixture)},scope:'Offline synthetic complete mint; no HTTP or broadcast',vmInputs,cases};
if(mode==='--emit-fixture')process.stdout.write(JSON.stringify(fixture,null,2)+'\n');
else{assert.deepEqual(JSON.parse(readFileSync(new URL('../rust/fixtures/amm-mint.json',import.meta.url))),fixture);
  console.log('AMM_MINT_UPSTREAM_PASS '+cases.length+' source/genesis pairs, '+vmInputs+' independent VM inputs; no HTTP/broadcast');}
