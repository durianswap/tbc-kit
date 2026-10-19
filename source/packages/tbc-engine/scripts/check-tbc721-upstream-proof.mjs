#!/usr/bin/env node
// Offline fixed-source oracle. Public scalar 1 + fictitious funding only.
// No network, wallet custody, artifact rebuild or private-key-bearing Engine.
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const [upstreamArg, dependenciesArg, mode] = process.argv.slice(2);
assert.ok(upstreamArg && dependenciesArg && [undefined, '--emit-fixture'].includes(mode),
  'Usage: FIXED_UPSTREAM DEPENDENCY_DIRECTORY [--emit-fixture]');
const upstream = resolve(upstreamArg), dependencies = createRequire(join(resolve(dependenciesArg), 'package.json'));
const commit = 'af77616121db340e15bb8b73c197bc2f8d1ee986';
assert.equal(execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), commit);
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceName = 'lib/util/tbc721/tbc721unlock.ts', artifactName = 'lib/util/tbc721/artifacts/tbc721.json';
const source = readFileSync(join(upstream, sourceName), 'utf8'), artifactBytes = readFileSync(join(upstream, artifactName));
assert.equal(sha(source), '739afdd53a3cd971e42d764408143071a0b1165d1966d40958ddc19148c58e1d');
assert.equal(sha(artifactBytes), 'f71e7708143942e4badb265576e5f72d0713de701a2d4a31d5730b7031338ecd');
const libRoot = dirname(dependencies.resolve('tbc-lib-js/package.json'));
assert.equal(JSON.parse(readFileSync(join(libRoot,'package.json'))).version, '1.0.31');
function tree(dir, prefix='') {
  const out=[];
  for(const entry of readdirSync(join(dir,prefix),{withFileTypes:true})) {
    if(['node_modules','.git'].includes(entry.name)) continue;
    const p=join(prefix,entry.name);
    if(entry.isDirectory())out.push(...tree(dir,p));
    else {assert.ok(entry.isFile());out.push(p);}
  }
  return out.sort();
}
assert.equal(sha(tree(libRoot).map(p=>p+'\0'+sha(readFileSync(join(libRoot,p)))+'\n').join('')),
  'b73c8b5996276584981fe5b14f04db3e4cce02c94e7a19cb2b0f64e37206c7e9');
const ts=dependencies('typescript'),tbc=dependencies('tbc-lib-js');assert.equal(ts.version,'5.9.2');
const artifact=JSON.parse(artifactBytes), exports={};
runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
  {exports,Buffer,require(name){
    if(name==='tbc-lib-js')return tbc;
    if(name==='./artifacts/tbc721.json')return artifact;
    throw new Error('Unexpected upstream import: '+name);
  }},{filename:sourceName});
const {buildTBC721Code,parseTBC721Code,buildTBC721UnlockScript}=exports;
const templatePath=fileURLToPath(new URL('../rust/crates/tbc-engine-core/src/protocols/tbc721-lock-template.hex',import.meta.url));
assert.equal(readFileSync(templatePath,'utf8').trim(),artifact.lock.hex);
const codeVectors=[['0123456789abcdef'.repeat(4),3],['ab'.repeat(32),0],['cd'.repeat(32),0xffffffff]].map(([txid,vout])=>{
  const code=buildTBC721Code(txid,vout),parsed=parseTBC721Code(code);
  assert.equal(parsed.txid,txid);assert.equal(parsed.outputIndex,vout);
  return {txid,vout,codeHex:code.toHex(),originalOutpointHex:parsed.originalUTXO.toString('hex')};
});
const key=new tbc.PrivateKey(new tbc.crypto.BN(1)),pub=key.toPublicKey().toBuffer();
const p2pkh=tbc.Script.buildPublicKeyHashOut(key.toAddress());
const mintScript=tbc.Script.fromHex(p2pkh.toHex()).add(tbc.Opcode.OP_RETURN).add(Buffer.from('V0 Mint NHold'));
const holdScript=tbc.Script.fromHex(p2pkh.toHex()).add(tbc.Opcode.OP_RETURN).add(Buffer.from('V0 Curr NHold'));
const output=(script,satoshis)=>new tbc.Transaction.Output({script,satoshis});
const tape=data=>new tbc.Script().add(0).add(tbc.Opcode.OP_RETURN).add(Buffer.from(JSON.stringify(data))).add(Buffer.from('NTape'));
function make(inputs,outputs){
  const tx=new tbc.Transaction();tx.version=10;
  for(const i of inputs)tx.uncheckedAddInput(new tbc.Transaction.Input({prevTxId:i.txid,outputIndex:i.vout,
    sequenceNumber:0xffffffff,script:tbc.Script.empty(),output:i.output}));
  for(const o of outputs)tx.addOutput(o);return tx;
}
const ref=(tx,vout)=>({txid:tx.id,vout,output:tx.outputs[vout]});
const signature=(tx,vin)=>Buffer.from(tx.getSignature(vin,key),'hex');
function signP2pkh(tx,vin){tx.inputs[vin].setScript(new tbc.Script().add(signature(tx,vin)).add(pub));}
const collection=make([{txid:'11'.repeat(32),vout:0,output:output(p2pkh,100000)}],[
  output(tape({collectionName:'TBC721 Vector',description:'public synthetic',supply:3,file:'{}'}),0),
  output(mintScript,100),output(mintScript,100),output(mintScript,100),output(p2pkh,99000)]);
signP2pkh(collection,0);assert.equal(collection.verifyScript(0).success,true);
const code=buildTBC721Code(collection.id,3);
const metadata=tape({nftName:'NFT',symbol:'N',description:'vector',attributes:'{}',file:collection.id+'03000000'});
const mint=make([ref(collection,3),ref(collection,4)],[output(code,200),output(holdScript,100),output(metadata,0),output(p2pkh,98720)]);
for(let i=0;i<mint.inputs.length;i++){signP2pkh(mint,i);assert.equal(mint.verifyScript(i).success,true);}
function leaf(chunk){
  if(chunk.buf)return chunk.buf.toString('hex');
  if(chunk.opcodenum===0)return '';
  if(chunk.opcodenum===79)return '81';
  if(chunk.opcodenum>=81&&chunk.opcodenum<=96)return (chunk.opcodenum-80).toString(16).padStart(2,'0');
  throw new Error('Non-push ABI field');
}
const vectors=[];
function transfer(id,parent,grandparent){
  const tx=make([ref(parent,0),ref(parent,1),ref(parent,3)],[output(code,200),output(holdScript,100),output(metadata,0),output(p2pkh,parent.outputs[3].satoshis-200)]);
  const unsignedRaw=tx.uncheckedSerialize(),sig=signature(tx,0);
  const unlock=buildTBC721UnlockScript(sig,pub,tx,parent,grandparent);
  assert.equal(unlock.chunks.length,20);
  tx.inputs[0].setScript(unlock);signP2pkh(tx,1);signP2pkh(tx,2);
  const vm=tx.inputs.map((_,i)=>{const result=tx.verifyScript(i);assert.equal(result.success,true,id+' input '+i+': '+result.error);return true;});
  const digest=tbc.Transaction.Sighash.sighash(tx,0x41,0,parent.outputs[0].script,parent.outputs[0].satoshisBN);
  vectors.push({id,currentRaw:unsignedRaw,parentRaw:parent.uncheckedSerialize(),grandparentRaw:grandparent.uncheckedSerialize(),
    publicKeyHex:pub.toString('hex'),signatureHex:sig.toString('hex'),digestBytesHex:Buffer.from(digest).reverse().toString('hex'),
    fields:unlock.chunks.map(leaf),unlockHex:unlock.toHex(),signedRaw:tx.uncheckedSerialize(),txid:tx.id,localVmInputs:vm});
  return tx;
}
const first=transfer('genesis-slot-three',mint,collection);
transfer('continued-code-output-zero',first,mint);
const fixture={standardId:'tbc721-standard',upstreamCommit:commit,artifactSha256:sha(artifactBytes),sourceSha256:sha(source),
  publicTestScalar:'1',syntheticFunding:true,network:false,leafCount:20,codeVectors,vectors};
const path=fileURLToPath(new URL('../rust/fixtures/tbc721-standard-proof.json',import.meta.url));
if(mode==='--emit-fixture')console.log(JSON.stringify(fixture,null,2));
else {assert.deepEqual(JSON.parse(readFileSync(path)),fixture);console.log('TBC721_UPSTREAM_PROOF_PASS codec=3 proof=2 vmInputs=6 network=0');}
