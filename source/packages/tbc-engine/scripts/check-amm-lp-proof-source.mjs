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
assert.ok(upstreamArg&&depsArg&&[undefined,'--emit-fixture'].includes(mode)&&process.argv.length<=5);
const upstream=resolve(upstreamArg),depsPath=resolve(depsArg),deps=createRequire(join(depsPath,'package.json'));
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986',sha=b=>createHash('sha256').update(b).digest('hex');
execFileSync(process.execPath,[new URL('./check-amm-code-source.mjs',import.meta.url).pathname,upstream,depsPath],{stdio:'pipe',timeout:30000});
// Upstream TBC20 mixes TS exports and module.exports. Consume its committed CJS
// artifact so bundling cannot hoist that assignment into our oracle's exports.
const built=await build({stdin:{contents:`export const PoolNFT3 = require('./lib/contract/poolNFT3.0.js').PoolNFT3;
export const TBC20 = require('./lib/contract/tbc20.js');
export const FTLPTBC20 = require('./lib/contract/ftlpTbc20.js').FTLPTBC20;
export const privateKeySigner = require('./lib/util/poolnft3/transaction.js').privateKeySigner;
export const buildFTLPUnlockScriptWithSignature = require('./lib/util/poolnft3/ftlpTbc20unlock.js').buildFTLPUnlockScriptWithSignature;`,resolveDir:upstream},
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
const {PoolNFT3,TBC20,FTLPTBC20,privateKeySigner,buildFTLPUnlockScriptWithSignature}=module.exports;
assert.equal(typeof privateKeySigner,'function',`SDK exports: ${Object.keys(module.exports)}`);
const tbc=deps('tbc-lib-js'),key=new tbc.PrivateKey(new tbc.crypto.BN(1)),controller=new tbc.PrivateKey(new tbc.crypto.BN(2));
const address=key.toAddress().toString(),signer=privateKeySigner(key),publicKey=key.publicKey.toBuffer();
const p2pkh=tbc.Script.buildPublicKeyHashOut(address),vectors=[],raws={},sequences=[];
let vmInputs=0;
function remember(tx){const raw=tx.uncheckedSerialize();if(raws[tx.id])assert.equal(raws[tx.id],raw);raws[tx.id]=raw;return tx;}
const ref=(tx,vout)=>({txId:tx.id,outputIndex:vout,script:tx.outputs[vout].script.toHex(),satoshis:tx.outputs[vout].satoshis});
function verify(tx,history){for(const [vin,input]of tx.inputs.entries()){
  const parent=history.get(input.prevTxId.toString('hex'));assert.ok(parent,'parent for VM');input.output=parent.outputs[input.outputIndex];
  const verdict=tx.verifyScript(vin);assert.equal(verdict.success,true,`${tx.id}:${vin}: ${verdict.error}`);vmInputs++;
}}
function groups(result){const paired=new Set(result.layout.assetOutputs.map(a=>a.codeVout));const groups=[];
  for(let i=0;i<result.transaction.outputs.length;i++){if(paired.has(i)){groups.push({codeVout:i,tapeVout:i+1});i++;}else groups.push({codeVout:i});}return groups;}
function capture(id,result,history,contractController){
  const signed=result.transaction,outputGroups=groups(result);
  for(let vin=0;vin<signed.inputs.length-1;vin++){
    const input=signed.inputs[vin],parent=history.get(input.prevTxId.toString('hex'));
    const descriptor=FTLPTBC20.parseCode(parent.outputs[input.outputIndex].script);
    const tape=FTLPTBC20.parseTape(parent.outputs[input.outputIndex+1].script,descriptor);
    const ancestors=new Map();for(let slot=0;slot<6;slot++)if(tape.amounts[slot]!==0n){const id=parent.inputs[slot].prevTxId.toString('hex');ancestors.set(id,history.get(id));}
    const current=new tbc.Transaction(signed.uncheckedSerialize());current.inputs.forEach((i,j)=>{i.output=signed.inputs[j].output;i.setScript(tbc.Script.empty());});
    const signature=Buffer.from(current.getSignature(vin,key),'hex');
    const unlock=buildFTLPUnlockScriptWithSignature({currentTx:current,inputIndex:vin,preTx:parent,preTxVout:input.outputIndex,
      ancestorTransactions:ancestors,outputGroups,signature,publicKey,contractController});
    assert.equal(unlock.toHex(),signed.inputs[vin].script.toHex());
    const fields=unlock.chunks.map(c=>c.buf??(c.opcodenum===0?Buffer.alloc(0):c.opcodenum===0x4f?Buffer.from([0x81]):Buffer.from([c.opcodenum-0x50])));
    assert.equal(fields.length,123);
    vectors.push({id:`${id}-${vin}`,currentRaw:current.uncheckedSerialize(),parentTxid:parent.id,parentCodeVout:input.outputIndex,
      inputIndex:vin,ancestors:[...ancestors.keys()],outputGroups,publicKeyHex:publicKey.toString('hex'),
      digestHex:tbc.crypto.Hash.sha256sha256(Buffer.from(current.getPreimage(vin,0x41),'hex')).toString('hex'),signatureHex:signature.toString('hex'),
      fieldHashes:fields.map(f=>sha(f)),unlockHash:sha(unlock.toBuffer()),signedTxid:signed.id,identityHex:descriptor.identity.toString('hex'),
      ...(contractController?{contractController:{txid:contractController.transaction.id,currentInputIndex:contractController.currentInputIndex}}:{})});
  }
}
for(const timelocked of [false,true]){
  const label=timelocked?'controller-locked':'public-plain';
  const funding=remember(new tbc.Transaction().from({txId:(timelocked?'22':'11').repeat(32),outputIndex:0,script:p2pkh.toHex(),satoshis:3000000}).to(address,2999000).fee(1000).sign(key));
  const history=new Map([[funding.id,funding]]),chain=[];
  const keep=tx=>{verify(tx,history);remember(tx);history.set(tx.id,tx);chain.push(tx.id);return tx;};
  const token=new TBC20(timelocked?{tapeSize:66,extensionData:'000000000009'}:{});
  const ft=token.mint(key,address,1000000n,ref(funding,0));keep(ft.sourceTransaction);keep(ft.transaction);
  const pool=new PoolNFT3({ftGenesisTx:ft.transaction,lp:{kind:timelocked?'timelocked':'plain'},
    authorization:timelocked?{kind:'controller',controllerPubKeyHashes:[tbc.crypto.Hash.sha256ripemd160(controller.publicKey.toBuffer()).toString('hex')]}:{kind:'public'}});
  const fund=(tx,index=tx.outputs.length-1)=>({parentTx:tx,outputIndex:index,signer});
  const root=fund(ft.transaction);
  const minted=await pool.prepareMintPoolNFT({funding:root}).sign();keep(minted.transaction);
  const asset=(r,role)=>({parentTx:r.transaction,outputIndex:r.layout.assetOutputs.find(a=>a.role===role).codeVout,signer,ancestors:history});
  const added=await pool.prepareAddLP({pool:{parentTx:minted.transaction,ancestorTx:ft.transaction},poolFT:asset(minted,'pool-ft'),
    userFT:{parentTx:ft.transaction,outputIndex:0,signer,ancestors:history},funding:fund(minted.transaction,minted.changeVout),
    incrementSat:100000n,firstFtAmountRaw:200000n,lpReceiverAddress:address,
    ...(timelocked?{lpLockTime:829999,controllerSigner:privateKeySigner(controller)}:{})}).sign();keep(added.transaction);
  const transferred=await pool.prepareTransferLP({inputs:[asset(added,'new-lp')],funding:fund(added.transaction,added.changeVout),receiverAddress:address,amountRaw:40000n}).sign();
  keep(transferred.transaction);capture(`${label}-transfer`,transferred,history);
  const merged=await pool.prepareTransferLP({inputs:[asset(transferred,'lp-transfer'),asset(transferred,'lp-change')],funding:fund(transferred.transaction,transferred.changeVout),receiverAddress:address,amountRaw:100000n}).sign();
  keep(merged.transaction);capture(`${label}-merge`,merged,history);
  const again=timelocked?await pool.prepareUnlockLP({inputs:[asset(merged,'lp-transfer')],funding:fund(merged.transaction,merged.changeVout),receiverAddress:address}).sign():
    await pool.prepareTransferLP({inputs:[asset(merged,'lp-transfer')],funding:fund(merged.transaction,merged.changeVout),receiverAddress:address,amountRaw:100000n}).sign();
  keep(again.transaction);capture(`${label}-${timelocked?'unlock':'again'}`,again,history);
  if(!timelocked){
    // Exercise SDK's low-level contract-controller profile with a genuinely
    // VM-checked transfer into it, then release by consuming the controlling
    // P2PKH output. No edited/invalid historical parent is treated as valid.
    const move=(previous,nextController,witness)=>{
      const parent=previous.transaction,lpVout=previous.layout.assetOutputs[0].codeVout;
      const descriptor=FTLPTBC20.parseCode(parent.outputs[lpVout].script);
      const tape=FTLPTBC20.parseTape(parent.outputs[lpVout+1].script,descriptor);
      const current=new tbc.Transaction().from(ref(parent,lpVout)).from(ref(parent,previous.changeVout));
      current.addOutput(new tbc.Transaction.Output({satoshis:500,script:FTLPTBC20.replaceController(parent.outputs[lpVout].script,nextController)}));
      current.addOutput(new tbc.Transaction.Output({satoshis:0,script:FTLPTBC20.buildTape({amounts:[tape.balance,0n,0n,0n,0n,0n],tapeSize:descriptor.tapeSize,timelocked:false})}));
      current.addOutput(new tbc.Transaction.Output({satoshis:parent.outputs[previous.changeVout].satoshis-10000,script:p2pkh}));
      const outputGroups=[{codeVout:0,tapeVout:1},{codeVout:2}];
      current.inputs[0].setScript(buildFTLPUnlockScriptWithSignature({currentTx:current,inputIndex:0,preTx:parent,preTxVout:lpVout,
        ancestorTransactions:history,outputGroups,signature:Buffer.from(current.getSignature(0,key),'hex'),publicKey,contractController:witness}));
      current.inputs[1].setScript(new tbc.Script().add(Buffer.from(current.getSignature(1,key),'hex')).add(publicKey));
      return{transaction:current,changeVout:2,layout:{assetOutputs:[{codeVout:0,role:'lp-transfer'}]}};
    };
    const controlled=move(again,Buffer.concat([tbc.crypto.Hash.sha256ripemd160(tbc.crypto.Hash.sha256(p2pkh.toBuffer())),Buffer.from([1])]));
    keep(controlled.transaction);capture(`${label}-to-contract`,controlled,history);
    const witness={transaction:controlled.transaction,currentInputIndex:1};
    const released=move(controlled,Buffer.concat([tbc.crypto.Hash.sha256ripemd160(publicKey),Buffer.from([0])]),witness);
    keep(released.transaction);capture(`${label}-contract-release`,released,history,witness);
  }
  sequences.push({label,fundingTxid:funding.id,transactions:chain});
}
const fixture={upstream:{commit,sources,publicScalars:[1,2]},scope:'Offline synthetic funding; VM executed, no network or node proof',vmInputs,sequences,raws,vectors};
if(mode==='--emit-fixture')process.stdout.write(JSON.stringify(fixture,null,2)+'\n');
else{assert.deepEqual(JSON.parse(readFileSync(new URL('../rust/fixtures/amm-lp-proof.json',import.meta.url))),fixture);
  console.log(`AMM_LP_PROOF_UPSTREAM_PASS ${vectors.length} 123-field LP proofs, ${vmInputs} independent VM inputs; no HTTP/broadcast`);}
