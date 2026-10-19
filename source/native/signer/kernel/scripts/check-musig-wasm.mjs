// Real WASM execution with public test keys; no wallet keys or network.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createWasmMuSigSigner} from '../wasm/musig-adapter.mjs';
const path=resolve(process.argv[2]??new URL('../target/wasm32-unknown-unknown/release/tbc_signer_kernel.wasm',import.meta.url).pathname);
const wasm=await readFile(path),require=createRequire(import.meta.url),tbc=require('tbc-lib-js');
assert.equal(require('tbc-lib-js/package.json').version,'1.0.31');
const scalar=n=>{const k=new Uint8Array(32);k[31]=n;return k;};
const publicKeys=[1,2].map(n=>tbc.crypto.MuSig2.pubkeyFromSk(Buffer.from(scalar(n))).toString('hex'));
const aggregateKey=tbc.crypto.MuSig2.getAggPubkey(tbc.crypto.MuSig2.keyAgg(publicKeys.map(k=>Buffer.from(k,'hex')))).toString('hex');
let clock=100;const signer=await createWasmMuSigSigner(wasm,{clock:()=>clock});
assert.equal(signer.aggregateKey(publicKeys),aggregateKey);
for(const count of [3,32]){
  const keys=Array.from({length:count},(_,i)=>tbc.crypto.MuSig2.pubkeyFromSk(Buffer.from(scalar(i+1))).toString('hex')).sort();
  const expected=tbc.crypto.MuSig2.getAggPubkey(tbc.crypto.MuSig2.keyAgg(keys.map(k=>Buffer.from(k,'hex')))).toString('hex');
  assert.equal(signer.aggregateKey(keys),expected);
}
for(const keys of [[],[publicKeys[0]],[...publicKeys].reverse(),[publicKeys[0],publicKeys[0]],['00'.repeat(33),'01'.repeat(33)],Array(33).fill(publicKeys[0])])assert.throws(()=>signer.aggregateKey(keys));
const common={publicKeys,aggregateKey,digest:'37'.repeat(32),binding:'20'.repeat(32),expiresAt:200};
function begin(n){return signer.begin({...common,scalar:scalar(n)});}
function sign(session,n,publicNonces,extra={}){return signer.sign({...common,handle:session.handle,scalar:scalar(n),publicNonces,...extra});}
const a=begin(1),b=begin(2),publicNonces=[a.publicNonce,b.publicNonce];
const partialSignatures=[sign(a,1,publicNonces),sign(b,2,publicNonces)];
const signature=signer.combine({...common,publicNonces,partialSignatures});
assert.equal(tbc.crypto.Schnorr.verify(Buffer.from(common.digest,'hex'),Buffer.from(signature,'hex'),Buffer.from(aggregateKey,'hex')),true);
const session=tbc.crypto.MuSig2.buildSession(tbc.crypto.MuSig2.keyAgg(publicKeys.map(k=>Buffer.from(k,'hex'))),tbc.crypto.MuSig2.nonceAgg(publicNonces.map(n=>Buffer.from(n,'hex'))),Buffer.from(common.digest,'hex'));
for(let i=0;i<2;i++)assert.equal(tbc.crypto.MuSig2.partialVerify(Buffer.from(partialSignatures[i],'hex'),Buffer.from(publicNonces[i],'hex'),Buffer.from(publicKeys[i],'hex'),session),true);
assert.throws(()=>sign(a,1,publicNonces),/106/);
assert.throws(()=>signer.combine({...common,publicNonces,partialSignatures:[partialSignatures[1],partialSignatures[0]]}),/105/);
const wrong=begin(1);assert.throws(()=>sign(wrong,1,[wrong.publicNonce,b.publicNonce],{binding:'21'.repeat(32)}),/102/);assert.throws(()=>sign(wrong,1,publicNonces),/106/);
const invalid=begin(1);assert.throws(()=>sign(invalid,1,['bad']));assert.throws(()=>sign(invalid,1,publicNonces),/106/);
const expired=begin(1);clock=200;assert.throws(()=>sign(expired,1,publicNonces),/108/);clock=100;assert.throws(()=>sign(expired,1,publicNonces),/106/);
const cancelled=begin(1);signer.cancel(cancelled.handle);assert.throws(()=>sign(cancelled,1,publicNonces),/106/);
const all=begin(1);signer.cancelAll();assert.throws(()=>sign(all,1,publicNonces),/106/);
const beforeRestart=begin(1),restarted=await createWasmMuSigSigner(wasm,{clock:()=>100});
assert.throws(()=>restarted.sign({...common,handle:beforeRestart.handle,scalar:scalar(1),publicNonces}),/106/);signer.cancelAll();
// Direct private ABI safety checks: malformed input clears outputs/entropy.
// Adapter scratch cleanup is in its finally block. Never inspect/export nonce.
const {instance}=await WebAssembly.instantiate(wasm,{}),api=instance.exports,base=api.tbc_signer_musig_buffer_new();
new Uint8Array(api.memory.buffer,base,32).fill(0x55);
assert.equal(api.tbc_signer_musig_aggregate_key(0,2,base),100);
assert.ok(new Uint8Array(api.memory.buffer,base,32).every(b=>b===0));
assert.equal(api.tbc_signer_musig_aggregate_key(base,2,0),100);
new Uint8Array(api.memory.buffer,base,8192).fill(0x55);
assert.equal(api.tbc_signer_musig_begin(0,2,0,0,0,0,base,100n,200n,base+32,base+64),100);
assert.ok(new Uint8Array(api.memory.buffer,base,130).every(b=>b===0));
api.tbc_signer_musig_buffer_free(base);
console.log(JSON.stringify({status:'PASS',actualWasm:true,sdkPartialAndFinalVerification:true,reuseExpiryCancelRestartRejected:true,malformedInputCleared:true,networkRequests:0,realKeys:false}));
