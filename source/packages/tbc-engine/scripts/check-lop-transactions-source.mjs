// Pinned pure SDK make/cancel + independent VM oracle; public scalar 1/2 only.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import {resolve,join} from 'node:path';
import {transform} from 'esbuild';
const [upstreamArg,depsArg]=process.argv.slice(2);assert.ok(upstreamArg&&depsArg&&process.argv.length===4);
const upstream=resolve(upstreamArg),deps=createRequire(join(resolve(depsArg),'package.json'));
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986',sources={};
function pinned(path){const bytes=readFileSync(join(upstream,path));
  assert.deepEqual(bytes,execFileSync('git',['-C',upstream,'show',`${commit}:${path}`],{maxBuffer:1024*1024}));
  sources[path]=createHash('sha256').update(bytes).digest('hex');return bytes.toString();}
const source=pinned('lib/contract/orderBook.ts'),util=pinned('lib/util/common/util.ts');
const tokenSource=pinned('lib/util/common/contractToken.ts');
assert.match(tokenSource,/modernCodeOffsets\.get\(code.length \/ 2\)/);
const functions=['_isValidSHA256Hash','_isValidHexString'].map(name=>{
  const match=util.match(new RegExp(`export function ${name}\\([\\s\\S]*?^\\}`,'m'));assert.ok(match);return match[0].replace('export ','');});
const make=source.slice(source.indexOf('\n  buildSellOrderTX('),source.indexOf('\n  buildBuyOrderTX('));
const codec=source.slice(source.indexOf('\n  getSellOrderCode('),source.indexOf('\n  static placeHolderP2PKHOutput('));
const positive=source.slice(source.indexOf('\nfunction _isPositiveBigInt('),source.indexOf('\nmodule.exports ='));
const count=source.slice(source.indexOf('const validateSellOrderInputCount'),source.indexOf('const validateBuyOrderInputCount'));
const size=source.slice(source.indexOf('const getFTCodeSizeHex'),source.indexOf('// Match transactions'));
const compiled=await transform(`${functions.join('\n')}\n${positive}\nconst MAX_ORDER_INPUTS=10;${count}\n${size}\nclass OrderBook {${make}\n${codec}\n}`,{loader:'ts',target:'node22'});
const tbc=deps('tbc-lib-js'),partial=deps('tbc-lib-js/lib/util/partial-sha256');
const modernCodeOffsets=new Map([[2981,2944]]);
const Oracle=runInThisContext(`(function(tbc,BN,partial_sha256,modernCodeOffsets,isCoinCodeScript,getFTPartialOffset,token_order_size_hex){${compiled.code}\nreturn OrderBook;})`)(
  tbc,tbc.crypto.BN,partial,modernCodeOffsets,
  code=>Buffer.from(code,'hex').subarray(-14).equals(Buffer.from('COINTBC20CODE2')),
  code=>Math.floor(code.length/2/64)*64,'023405');
const run=spawnSync('cargo',['test','--offline','--locked','-p','tbc-engine-core','--test','lop_transaction',
  'native_lop_make_cancel_share_external_signing_and_fee_envelope','--','--exact','--nocapture'],{
  cwd:resolve(import.meta.dirname,'../rust'),env:{...process.env,LOP_TX_DUMP_WIRE:'1'},encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
assert.equal(run.status,0,'LOP Rust transaction check failed; raw output withheld');
const rows=run.stdout.split('\n').filter(l=>l.startsWith('LOP_TX_WIRE:')).map(l=>JSON.parse(l.slice(12)));assert.equal(rows.length,8);
const key=new tbc.PrivateKey(new tbc.crypto.BN(1)),tax=new tbc.PrivateKey(new tbc.crypto.BN(2)).toAddress().toString();
let vmInputs=0,exactSdkRaw=0;const fees=[];
for(const row of rows){
  const tx=new tbc.Transaction(row.raw),sdk=new Oracle();modernCodeOffsets.set(row.quoteCode.length/2,Math.floor(row.quoteCode.length/2/64)*64);
  for(const [i,input] of tx.inputs.entries()){
    const prior=row.inputs[i];assert.equal(input.prevTxId.toString('hex'),prior.txId);assert.equal(input.outputIndex,prior.outputIndex);
    input.output=new tbc.Transaction.Output({satoshis:prior.satoshis,script:tbc.Script.fromHex(prior.script)});
    assert.equal(tx.verifyScript(i).success,true,`LOP ${row.operation} input ${i}`);vmInputs++;
  }
  const sdkRaw=row.operation==='make'?sdk.buildSellOrderTX(key.toAddress().toString(),tax,3000n,1100000n,100n,'44'.repeat(32),row.quoteCode,row.inputs):
    sdk.buildCancelSellOrderTX(row.inputs[0],row.inputs.slice(1));
  const expected=new tbc.Transaction(sdkRaw);
  assert.equal(expected.version,tx.version);assert.equal(expected.nLockTime,tx.nLockTime);
  assert.equal(expected.inputs.length,tx.inputs.length);assert.equal(expected.outputs.length,tx.outputs.length);
  expected.inputs.forEach((input,i)=>{assert.equal(input.prevTxId.toString('hex'),row.inputs[i].txId);assert.equal(input.outputIndex,row.inputs[i].outputIndex);
    assert.equal(input.sequenceNumber,tx.inputs[i].sequenceNumber);input.output=tx.inputs[i].output;});
  expected.outputs.forEach((output,i)=>{assert.equal(output.script.toHex(),tx.outputs[i].script.toHex());
    if(i<expected.outputs.length-1)assert.equal(output.satoshis,tx.outputs[i].satoshis);});
  const sdkFee=row.inputs.reduce((sum,u)=>sum+u.satoshis,0)-expected.outputs.reduce((sum,o)=>sum+o.satoshis,0);
  const signedSdk=sdk.fillSigsSellOrder(sdkRaw,expected.inputs.map((_,i)=>expected.getSignature(i,key)),key.publicKey.toString(),row.operation);
  if(sdkFee===row.fee){assert.equal(row.raw,signedSdk);exactSdkRaw++;}
  // Compare full SDK witnesses on the exact Engine outputs, independently
  // recomputing all signature digests. Any difference must be solely fee/change.
  const unsigned=new tbc.Transaction(row.raw);unsigned.inputs.forEach((input,i)=>{input.setScript(tbc.Script.empty());input.output=tx.inputs[i].output;});
  const reference=sdk.fillSigsSellOrder(unsigned.uncheckedSerialize(),unsigned.inputs.map((_,i)=>unsigned.getSignature(i,key)),key.publicKey.toString(),row.operation);
  assert.equal(reference,row.raw);
  const actualBytes=Buffer.from(row.raw,'hex').length;
  assert.ok(actualBytes<=row.maximumSignedBytes);assert.ok(row.fee>=Math.max(80,Math.ceil(actualBytes*80/1000)));
  assert.equal(row.inputs.reduce((sum,u)=>sum+u.satoshis,0)-tx.outputs.reduce((sum,o)=>sum+o.satoshis,0),row.fee);
  fees.push({operation:row.operation,inputs:row.inputs.length,actualBytes,maximumSignedBytes:row.maximumSignedBytes,fee:row.fee,sdkFee});
}
assert.equal(vmInputs,48);
console.log(JSON.stringify({status:'LOP_TRANSACTION_SOURCE_PASS',commit,sources,transactions:rows.length,vmInputs,exactSdkRaw,fees,
  externalRequests:0,broadcasts:0,publicEngineMethodsExercised:false,deviceAcceptance:false}));
