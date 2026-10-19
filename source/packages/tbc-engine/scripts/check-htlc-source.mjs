// Fixed SDK Code/VM oracle. Only public scalar 1/2 and synthetic UTXOs.
// Script success is not a claim of chain finality, public API or installed support.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import {resolve,join} from 'node:path';
const [upstreamArg,dependenciesArg]=process.argv.slice(2);
assert.ok(upstreamArg&&dependenciesArg&&process.argv.length===4);
const upstream=resolve(upstreamArg),deps=createRequire(join(resolve(dependenciesArg),'package.json'));
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986',sources={};
for(const relative of ['lib/contract/htlc.js','lib/contract/htlc.ts']){
  const bytes=readFileSync(join(upstream,relative));
  assert.deepEqual(bytes,execFileSync('git',['-C',upstream,'show',`${commit}:${relative}`]));
  sources[relative]=createHash('sha256').update(bytes).digest('hex');
}
const source=readFileSync(join(upstream,'lib/contract/htlc.js'),'utf8');
const definition=source.match(/^function getCode\([\s\S]*?^\}/m)?.[0];assert.ok(definition);
const tbc=deps('tbc-lib-js');
// Evaluate only the pinned pure Code factory. Token/HTTP/keyful wrappers are
// intentionally not loaded. Nothing in this function receives external keys.
const getCode=runInThisContext(`(tbc=>${definition})`)(tbc);
const output=execFileSync('cargo',['test','--locked','--offline','-p','tbc-engine-core','--test','htlc',
  'fixed_sdk_htlc_code_roundtrip_and_token_controller','--','--exact','--nocapture'],
  {cwd:resolve(import.meta.dirname,'../rust'),env:{...process.env,HTLC_DUMP_WIRE:'1'},
    encoding:'utf8',timeout:60000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
assert.match(output,/test result: ok\. 1 passed; 0 failed;/);
const prefix='HTLC_WIRE:',wires=output.split('\n').filter(l=>l.startsWith(prefix)).map(l=>JSON.parse(l.slice(prefix.length)));
assert.equal(wires.length,9);
for(const w of wires){
  const code=getCode(w.sender,w.receiver,w.hashlock,w.lock);
  assert.equal(code.toHex(),w.script);
  assert.equal(tbc.crypto.Hash.sha256ripemd160(tbc.crypto.Hash.sha256(code.toBuffer())).toString('hex'),w.tokenController);
  assert.equal(w.supported,w.lock>0&&w.lock<=0x7fffffff);
}
const sender=new tbc.PrivateKey(new tbc.crypto.BN(1)),receiver=new tbc.PrivateKey(new tbc.crypto.BN(2));
const secret=Buffer.alloc(32,0x33),hashlock=createHash('sha256').update(secret).digest('hex');
const cases=[
  {name:'claim-before-expiry',claim:true,lock:834801,tx:0,sequence:0xffffffff,accepted:true},
  {name:'claim-after-expiry',claim:true,lock:834801,tx:834900,sequence:0xfffffffe,accepted:true},
  {name:'claim-wrong-secret',claim:true,lock:834801,tx:0,sequence:0xffffffff,badSecret:true,accepted:false},
  {name:'claim-sender-not-receiver',claim:true,lock:834801,tx:0,sequence:0xffffffff,wrongRole:true,accepted:false},
  {name:'refund-height-exact',lock:834801,tx:834801,sequence:0xfffffffe,accepted:true},
  {name:'refund-height-early',lock:834801,tx:834800,sequence:0xfffffffe,accepted:false},
  {name:'refund-final-sequence',lock:834801,tx:834801,sequence:0xffffffff,accepted:false},
  {name:'refund-receiver-not-sender',lock:834801,tx:834801,sequence:0xfffffffe,wrongRole:true,accepted:false},
  {name:'refund-height-to-timestamp',lock:834801,tx:1774427165,sequence:0xfffffffe,accepted:false},
  {name:'refund-timestamp-exact-script-only',lock:1774427165,tx:1774427165,sequence:0xfffffffe,accepted:true},
  {name:'refund-timestamp-early',lock:1774427165,tx:1774427164,sequence:0xfffffffe,accepted:false},
  {name:'refund-timestamp-to-height',lock:1774427165,tx:834801,sequence:0xfffffffe,accepted:false},
  // Wire characterization only; safe public construction must reject these.
  {name:'unsafe-four-byte-negative-zero',lock:2147483648,tx:0,sequence:0xfffffffe,accepted:true},
  {name:'unsafe-four-byte-negative-value',lock:4294967295,tx:0,sequence:0xfffffffe,accepted:true},
];
for(const c of cases){
  const code=getCode(sender.toAddress().hashBuffer.toString('hex'),receiver.toAddress().hashBuffer.toString('hex'),hashlock,c.lock);
  const owner=c.claim?receiver:sender,signer=c.wrongRole?(c.claim?sender:receiver):owner;
  const tx=new tbc.Transaction().from({txId:'11'.repeat(32),outputIndex:0,script:code.toHex(),satoshis:10000})
    .to(owner.toAddress().toString(),9900).fee(100);
  tx.setLockTime(c.tx);tx.setInputSequence(0,c.sequence);
  const signature=tx.getSignature(0,signer),publicKey=signer.publicKey.toBuffer().toString('hex');
  tx.inputs[0].setScript(tbc.Script.fromASM(c.claim?
    `${signature} ${publicKey} ${Buffer.alloc(32,c.badSecret?0x34:0x33).toString('hex')} OP_TRUE`:
    `${signature} ${publicKey} OP_FALSE`));
  const result=tx.verifyScript(0);assert.equal(result.success,c.accepted,`${c.name}: ${result.error}`);
}
console.log(JSON.stringify({status:'HTLC_CODE_SOURCE_PASS',commit,sources,
  interpreterVersion:deps('tbc-lib-js/package.json').version,codeVectors:wires.length,
  vmCases:cases.map(({name,accepted})=>({name,accepted})),externalRequests:0,broadcasts:0,
  scope:'Pinned template and script branches only; no node finality, builders, public methods or device acceptance'}));
