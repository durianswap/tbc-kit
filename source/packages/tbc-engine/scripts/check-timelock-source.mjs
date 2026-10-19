// Fixed upstream Script/VM oracle. Public scalar 1/2, synthetic inputs, no HTTP.
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
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986',relative='lib/contract/piggyBank.js';
const bytes=readFileSync(join(upstream,relative));
assert.deepEqual(bytes,execFileSync('git',['-C',upstream,'show',`${commit}:${relative}`]));
const module={exports:{}};
runInThisContext(`(function(module,exports,require){${bytes.toString('utf8')}\n})`)(module,module.exports,name=>{
  if(name==='tbc-lib-js')return deps(name);
  // getPiggyBankCode uses neither helper. Throw if future oracle code reaches
  // a decimal converter or network import instead of the intended pure method.
  assert.ok(['../util/common/util','../api/api'].includes(name));
  return new Proxy({},{get(){throw Error('No helper or network access in timelock oracle');}});
});
const sdk=module.exports,tbc=deps('tbc-lib-js'),key=new tbc.PrivateKey(new tbc.crypto.BN(1));
const other=new tbc.PrivateKey(new tbc.crypto.BN(2)),address=key.toAddress().toString();
const rust=resolve(import.meta.dirname,'../rust');
const output=execFileSync('cargo',['test','--locked','--offline','-p','tbc-engine-core','--test','timelock',
  'fixed_sdk_timelock_bytes_roundtrip_and_preserve_raw_lock_values','--','--exact','--nocapture'],
  {cwd:rust,env:{...process.env,TIMELOCK_DUMP_WIRE:'1'},encoding:'utf8',timeout:60000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
assert.match(output,/test result: ok\. 1 passed; 0 failed;/);
const wires=output.split('\n').filter(line=>line.startsWith('TIMELOCK_WIRE:')).map(line=>JSON.parse(line.slice(14)));
assert.equal(wires.length,8);
for(const wire of wires){assert.equal(wire.script,sdk.getPiggyBankCode(address,wire.lock).toHex());assert.equal(wire.heightSupported,wire.lock<500000000);}
const cases=[
  {name:'height-exact',lock:830000,tx:830000,sequence:0xfffffffe,accepted:true},
  {name:'height-too-early',lock:830000,tx:829999,sequence:0xfffffffe,accepted:false},
  {name:'final-sequence',lock:830000,tx:830000,sequence:0xffffffff,accepted:false},
  {name:'wrong-owner',lock:830000,tx:830000,sequence:0xfffffffe,foreign:true,accepted:false},
  // These characterize SDK Script, NOT allowed public height-profile requests.
  {name:'timestamp-script-only',lock:1700000000,tx:1700000000,sequence:0xfffffffe,accepted:true},
  {name:'no-script-domain-check',lock:830000,tx:1700000000,sequence:0xfffffffe,accepted:true},
  {name:'four-byte-negative-zero',lock:2147483648,tx:0,sequence:0xfffffffe,accepted:true},
  {name:'four-byte-negative-lock',lock:4294967295,tx:0,sequence:0xfffffffe,accepted:true},
];
for(const c of cases){
  const code=sdk.getPiggyBankCode(address,c.lock),signer=c.foreign?other:key;
  const tx=new tbc.Transaction().from({txId:'11'.repeat(32),outputIndex:0,script:code.toHex(),satoshis:10000}).to(address,9900).fee(100);
  tx.setInputSequence(0,c.sequence);tx.setLockTime(c.tx);
  const signature=tx.getSignature(0,signer);
  tx.inputs[0].setScript(tbc.Script.fromASM(`${signature} ${signer.publicKey.toBuffer().toString('hex')}`));
  const result=tx.verifyScript(0);assert.equal(result.success,c.accepted,`${c.name}: ${result.error}`);
}
console.log(JSON.stringify({status:'TIMELOCK_SOURCE_PASS',commit,sourceSha256:createHash('sha256').update(bytes).digest('hex'),
  codeVectors:wires.length,vmCases:cases.map(({name,accepted})=>({name,accepted})),
  scope:'Pinned SDK bytes and script semantics, not transaction finality or public intent support',
  externalRequests:0,broadcasts:0,deviceAcceptance:false}));
