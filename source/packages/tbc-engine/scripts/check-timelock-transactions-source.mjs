// Independent pinned SDK construction and VM checking for public synthetic Rust
// lock/unlock output. API.fetchBlockHeaders is replaced with a fixed test height;
// no endpoint, installed wallet key or broadcasting is available to this script.
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
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986';
const sources={};
function pinned(relative){const bytes=readFileSync(join(upstream,relative));
  assert.deepEqual(bytes,execFileSync('git',['-C',upstream,'show',`${commit}:${relative}`]));
  sources[relative]=createHash('sha256').update(bytes).digest('hex');return bytes.toString('utf8');}
const source=pinned('lib/contract/piggyBank.js');
const util=pinned('lib/util/common/util.js');
const decimalSource=util.match(/^export function parseDecimalToBigInt\(amount, decimal\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(decimalSource);
const parseDecimalToBigInt=runInThisContext(`(${decimalSource.replace(/^export /,'')})`);
let mockReads=0;const module={exports:{}};
runInThisContext(`(function(module,exports,require){${source}\n})`)(module,module.exports,name=>{
  if(name==='tbc-lib-js')return deps(name);
  if(name==='../util/common/util')return {parseDecimalToBigInt};
  assert.equal(name,'../api/api');return {fetchBlockHeaders:async()=>{mockReads++;return [{height:830000}]}};
});
const sdk=module.exports,tbc=deps('tbc-lib-js'),key=new tbc.PrivateKey(new tbc.crypto.BN(1)),address=key.toAddress().toString();
const output=execFileSync('cargo',['test','--locked','--offline','-p','tbc-engine-core','--test','timelock_transaction',
  'timelock_builders_share_external_signatures_and_bound_real_signed_size','--','--exact','--nocapture'],
  {cwd:resolve(import.meta.dirname,'../rust'),env:{...process.env,TIMELOCK_TX_DUMP_WIRE:'1'},encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});
assert.match(output,/test result: ok\. 1 passed; 0 failed;/);
const prefix='TIMELOCK_TX_WIRE:';
const rows=output.split('\n').filter(line=>line.startsWith(prefix)).map(line=>JSON.parse(line.slice(prefix.length)));
assert.equal(rows.length,5);const reports=[];let vmInputs=0;
for(const row of rows){
  const unsigned=row.operation==='lock'?sdk.freezeTBC(address,row.amount/1e6,row.height,row.inputs):await sdk.unfreezeTBC(address,row.inputs,'testnet');
  const expected=new tbc.Transaction(unsigned),actual=new tbc.Transaction(row.raw);
  const sum=row.inputs.reduce((s,u)=>s+u.satoshis,0);
  const sdkFee=sum-expected.outputs.reduce((s,o)=>s+o.satoshis,0);
  assert.equal(actual.version,expected.version);assert.equal(actual.nLockTime,expected.nLockTime);
  assert.equal(actual.inputs.length,expected.inputs.length);assert.equal(actual.outputs.length,expected.outputs.length);
  for(const [i,input]of actual.inputs.entries()){
    const prior=row.inputs[i];assert.equal(input.prevTxId.toString('hex'),prior.txId);
    assert.equal(input.outputIndex,prior.outputIndex);assert.equal(input.sequenceNumber,expected.inputs[i].sequenceNumber);
    const spent=new tbc.Transaction.Output({satoshis:prior.satoshis,script:tbc.Script.fromHex(prior.script)});
    input.output=spent;expected.inputs[i].output=spent;
    const sig=expected.getSignature(i,key);expected.inputs[i].setScript(tbc.Script.fromASM(`${sig} ${key.publicKey.toBuffer().toString('hex')}`));
    const verified=actual.verifyScript(i);assert.equal(verified.success,true,`${row.operation}/${i}: ${verified.error}`);vmInputs++;
  }
  for(const [i,out]of actual.outputs.entries()){
    assert.equal(out.script.toHex(),expected.outputs[i].script.toHex());
    const feeBearing=i===actual.outputs.length-1;
    assert.equal(out.satoshis,expected.outputs[i].satoshis-(feeBearing?row.fee-sdkFee:0));
  }
  const actualBytes=Buffer.from(row.raw,'hex').length;
  assert.ok(actualBytes<=row.maximumSignedBytes);
  assert.ok(row.fee>=Math.max(80,Math.ceil(actualBytes*80/1000)));
  if(row.inputs.length===1)assert.equal(row.raw,expected.uncheckedSerialize(),'Single-input path differs from SDK');
  reports.push({operation:row.operation,inputs:row.inputs.length,sdkFee,engineFee:row.fee,actualBytes,
    maxSignedBytes:row.maximumSignedBytes,exactSdkRaw:row.raw===expected.uncheckedSerialize()});
}
assert.equal(mockReads,2);
console.log(JSON.stringify({status:'TIMELOCK_TRANSACTION_SOURCE_PASS',commit,sources,vmInputs,reports,
  externalRequests:0,stubbedSdkHeightReads:mockReads,broadcasts:0,publicEngineMethodsExercised:false,deviceAcceptance:false}));
