// Source-level independent SDK/VM oracle. Public fixture keys/preimages only;
// no HTTP, wallet state, custody, or broadcast. Not a device/chain acceptance.
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
function pinned(relative){const bytes=readFileSync(join(upstream,relative));
  assert.deepEqual(bytes,execFileSync('git',['-C',upstream,'show',`${commit}:${relative}`]));
  sources[relative]=createHash('sha256').update(bytes).digest('hex');return bytes.toString('utf8');}
const source=pinned('lib/contract/htlc.js'),util=pinned('lib/util/common/util.js');
function definition(source,name){const result=source.match(new RegExp(`^(?:export )?function ${name}\\([\\s\\S]*?^\\}`,'m'))?.[0];
  assert.ok(result,`Pinned function absent: ${name}`);return result.replace(/^export /,'');}
const tbc=deps('tbc-lib-js'),utilNames=['parseDecimalToBigInt','_isValidSHA256Hash','_isValidHexString'];
const helpers=runInThisContext(`(()=>{${utilNames.map(n=>definition(util,n)).join('\n')};return {${utilNames.join(',')}}})()`);
const names=['getCode','deployHTLC','withdraw','refund','fillSigDepoly','fillSigWithdraw','fillSigRefund','withdrawWithSign'];
// Load only pure native builders/fillers and exact Code; no coupled SDK wrappers.
const sdk=runInThisContext(`((tbc,util_1)=>{${names.map(n=>definition(source,n)).join('\n')};return {${names.join(',')}}})`)(tbc,helpers);
const output=execFileSync('cargo',['test','--locked','--offline','-p','tbc-engine-core','--test','htlc_transaction','--','--nocapture'],
  {cwd:resolve(import.meta.dirname,'../rust'),env:{...process.env,HTLC_TX_DUMP_WIRE:'1'},encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
assert.match(output,/test result: ok\. 4 passed; 0 failed;/);
const prefix='HTLC_TX_WIRE:',rows=output.split('\n').filter(l=>l.startsWith(prefix)).map(l=>JSON.parse(l.slice(prefix.length)));
assert.equal(rows.length,18);
const sender=new tbc.PrivateKey(new tbc.crypto.BN(1)),receiver=new tbc.PrivateKey(new tbc.crypto.BN(2));
const reports=[];let vmInputs=0,exactSdkTransactions=0,sdkNonminimalClaimFillers=0;
for(const row of rows){
  const tx=new tbc.Transaction(row.raw),key=row.operation==='claim'?receiver:sender;
  assert.equal(tx.version,10);assert.equal(tx.inputs.length,row.inputs.length);
  assert.equal(tx.outputs.at(-1).script.toHex(),tbc.Script.buildPublicKeyHashOut(key.toAddress()).toHex());
  for(const [i,input] of tx.inputs.entries()){
    const prior=row.inputs[i];assert.equal(input.prevTxId.toString('hex'),prior.txId);assert.equal(input.outputIndex,prior.outputIndex);
    input.output=new tbc.Transaction.Output({satoshis:prior.satoshis,script:tbc.Script.fromHex(prior.script)});
    const verified=tx.verifyScript(i);assert.equal(verified.success,true,`${row.operation}/${i}: ${verified.error}`);vmInputs++;
  }
  const size=Buffer.from(row.raw,'hex').length;assert.ok(size<=row.maximumSignedBytes);
  assert.ok(row.fee>=Math.max(80,Math.ceil(size*80/1000)));
  assert.equal(row.inputs.reduce((sum,u)=>sum+u.satoshis,0)-tx.outputs.reduce((sum,o)=>sum+o.satoshis,0),row.fee);
  // The fixed SDK exposes one-input native builders. Compare their complete
  // signed bytes when both use the ordinary 32-byte preimage and flat 80 fee.
  let exact=false;
  if(row.inputs.length===1&&row.secret.length===64){
    let raw;
    if(row.operation==='lock')raw=sdk.deployHTLC(sender.toAddress().toString(),receiver.toAddress().toString(),
      createHash('sha256').update(Buffer.from(row.secret,'hex')).digest('hex'),834801,'0.003',row.inputs[0]);
    else if(row.operation==='claim')raw=sdk.withdraw(receiver.toAddress().toString(),row.inputs[0]);
    else raw=sdk.refund(sender.toAddress().toString(),row.inputs[0],tx.nLockTime);
    const expected=new tbc.Transaction(raw);expected.inputs[0].output=tx.inputs[0].output;
    const signature=expected.getSignature(0,key),pub=key.publicKey.toBuffer().toString('hex');
    let signed=row.operation==='lock'?sdk.fillSigDepoly(raw,signature,pub):row.operation==='claim'?
      sdk.fillSigWithdraw(raw,row.secret,signature,pub):sdk.fillSigRefund(raw,signature,pub);
    if(row.operation==='claim'){
      // The fixed filler uses ASM "1" => non-minimal 0101, whereas its actual
      // with-sign path uses OP_TRUE. Assert that precise upstream difference;
      // compare the Engine's canonical result against the latter, not by
      // accepting arbitrary byte divergence. Only the public fixture key goes in.
      const filled=new tbc.Transaction(signed),script=filled.inputs[0].script.toHex();
      assert.ok(script.endsWith('0101'));
      assert.equal(tx.inputs[0].script.toHex(),script.slice(0,-4)+'51');
      sdkNonminimalClaimFillers++;
      signed=sdk.withdrawWithSign(key.toWIF(),receiver.toAddress().toString(),row.inputs[0],row.secret);
    }
    assert.equal(row.raw,signed,`SDK raw differs: ${row.operation}`);exact=true;exactSdkTransactions++;
  }
  reports.push({operation:row.operation,inputs:row.inputs.length,preimageBytes:row.operation==='claim'?row.secret.length/2:0,
    actualBytes:size,maxSignedBytes:row.maximumSignedBytes,fee:row.fee,exactSdkRaw:exact});
}
assert.equal(exactSdkTransactions,4);assert.equal(vmInputs,36);
const interpreter=readFileSync(deps.resolve('tbc-lib-js/lib/script/interpreter.js'));
console.log(JSON.stringify({status:'HTLC_TRANSACTION_SOURCE_PASS',commit,sources,interpreterVersion:deps('tbc-lib-js/package.json').version,
  interpreterSha256:createHash('sha256').update(interpreter).digest('hex'),vmInputs,exactSdkTransactions,sdkNonminimalClaimFillers,reports,
  externalRequests:0,broadcasts:0,publicEngineMethodsExercised:false,deviceAcceptance:false}));
