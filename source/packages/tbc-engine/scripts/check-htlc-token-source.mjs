// Independent offline SDK/VM oracle. Only public synthetic scalar 1/2 and
// constant 0x33 preimage. No network, wallet custody, production raw or broadcast.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import {resolve,join,relative} from 'node:path';
import {build} from 'esbuild';
import {verifyTokenClaimScripts} from '../../../native/kit-runtime/closed-loop/htlc-token-live-checks.mjs';
const [upstreamArg,depsArg]=process.argv.slice(2);
assert.ok(upstreamArg&&depsArg&&process.argv.length===4);
const upstream=resolve(upstreamArg),deps=createRequire(join(resolve(depsArg),'package.json'));
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986';
const compiled=await build({stdin:{contents:`export const HTLC=require('./lib/contract/htlc.js');
  export {getFtBalanceFromTape} from './lib/util/common/util.js';
  export {ContractToken} from './lib/util/common/contractToken.js';`,resolveDir:upstream},
  bundle:true,write:false,metafile:true,platform:'node',format:'cjs',target:'node22',
  external:['tbc-lib-js','tbc-lib-js/*'],resolveExtensions:['.js','.json'],logLevel:'silent'});
let pinnedFiles=0;
for(const name of Object.keys(compiled.metafile.inputs)) {
  if(name==='<stdin>')continue;
  const path=resolve(name),rel=relative(upstream,path);assert.ok(!rel.startsWith('..'));
  assert.deepEqual(readFileSync(path),execFileSync('git',['-C',upstream,'show',`${commit}:${rel}`],{maxBuffer:8*1024*1024}));pinnedFiles++;
}
const module={exports:{}};
runInThisContext(`(function(module,exports,require){${compiled.outputFiles[0].text}\n})`)(module,module.exports,name=>{
  if(name==='tbc-lib-js'||name.startsWith('tbc-lib-js/')||name==='node:crypto')return deps(name);
  throw Error('Unexpected dependency '+name);
});
const {HTLC,getFtBalanceFromTape,ContractToken}=module.exports,tbc=deps('tbc-lib-js');
assert.equal(deps('tbc-lib-js/package.json').version,'1.0.31');
const stdout=execFileSync('cargo',['test','--locked','--offline','-p','tbc-engine-core','--test','htlc_token','--','--nocapture'],{
  cwd:resolve(import.meta.dirname,'../rust'),env:{...process.env,HTLC_TOKEN_DUMP_WIRE:'1'},encoding:'utf8',
  timeout:60000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});
assert.match(stdout,/test result: ok\. 4 passed; 0 failed;/);
const prefix='HTLC_TOKEN_WIRE:',rows=stdout.split('\n').filter(l=>l.startsWith(prefix)).map(l=>JSON.parse(l.slice(prefix.length)));
assert.equal(rows.length,21);
const sender=new tbc.PrivateKey(new tbc.crypto.BN(1)),receiver=new tbc.PrivateKey(new tbc.crypto.BN(2));
const secret='33'.repeat(32),hashlock=createHash('sha256').update(Buffer.from(secret,'hex')).digest('hex');
let vmInputs=0,exactSdkTransactions=0,exactSdkWitnesses=0,claimObserverInputs=0,claimObserverRejections=0;
const reports=[];
for(const row of rows) {
  const tx=new tbc.Transaction(row.raw),parent=new tbc.Transaction(row.parentRaw);
  if(row.operation==='claim'){
    const inputs=row.inputs.map(p=>({txid:p.txId,vout:p.outputIndex,satoshis:String(p.satoshis),scriptPubKey:p.script}));
    const evidence={rawTransaction:row.raw,txid:tx.id,inputs,escrow:{txid:parent.id},tbc};
    claimObserverInputs+=verifyTokenClaimScripts(evidence).verifiedInputs;
    for(let index=0;index<tx.inputs.length;index++){
      const changed=new tbc.Transaction(row.raw),script=changed.inputs[index].script.toBuffer();script[10]^=1;
      changed.inputs[index].setScript(tbc.Script.fromBuffer(script));
      assert.throws(()=>verifyTokenClaimScripts({...evidence,rawTransaction:changed.uncheckedSerialize(),txid:changed.id}),
        e=>e.message==='Token claim independent script verification failed'&&!e.stack.includes('33'.repeat(32)));
      claimObserverRejections++;
    }
  }
  const ancestors=new Map(row.ancestorsRaw.map(raw=>{const tx=new tbc.Transaction(raw);return [tx.id,tx];}));
  const resolver=txid=>{const tx=ancestors.get(txid);assert.ok(tx,'Missing exact ancestor');return tx;};
  for(const [i,input] of tx.inputs.entries()) {
    const prior=row.inputs[i];assert.equal(input.prevTxId.toString('hex'),prior.txId);assert.equal(input.outputIndex,prior.outputIndex);
    input.output=new tbc.Transaction.Output({satoshis:prior.satoshis,script:tbc.Script.fromHex(prior.script)});
    const result=tx.verifyScript(i);assert.equal(result.success,true,`${row.profile}/${row.operation}/${i}: ${result.error}`);vmInputs++;
  }
  const size=Buffer.byteLength(row.raw,'hex');assert.ok(size<=row.maximumSignedBytes);
  assert.ok(row.fee>=Math.max(80,Math.ceil(size*80/1000)));
  assert.equal(row.inputs.reduce((s,i)=>s+i.satoshis,0)-tx.outputs.reduce((s,o)=>s+o.satoshis,0),row.fee);
  const token=i=>({...row.inputs[i],ftBalance:getFtBalanceFromTape(parent.outputs[row.inputs[i].outputIndex+1].script.toHex()).toString()});
  let sdkRaw;
  const log=console.log;console.log=()=>{}; // SDK's diagnostic only, not production interception.
  try {
    if(row.operation==='lock') {
      const script=tx.outputs[0].script.toBuffer(),lock=script.readUInt32LE(61);
      sdkRaw=HTLC.deployHTLCTokenWithSign(sender.toAddress().toString(),receiver.toAddress().toString(),hashlock,lock,
        `${getFtBalanceFromTape(tx.outputs[2].script.toHex())/1000000n}.${(getFtBalanceFromTape(tx.outputs[2].script.toHex())%1000000n).toString().padStart(6,'0')}`,
        row.inputs.slice(0,-1).map((_,i)=>token(i)),row.inputs.at(-1),row.inputs.slice(0,-1).map(()=>parent),row.inputs.slice(0,-1).map(()=>resolver),sender.toWIF());
    } else if(row.operation==='claim') {
      sdkRaw=HTLC.withdrawHTLCTokenWithSign(receiver.toWIF(),receiver.toAddress().toString(),row.inputs[0],token(1),parent,resolver,row.inputs[2],secret);
    } else {
      sdkRaw=HTLC.refundHTLCTokenWithSign(sender.toWIF(),sender.toAddress().toString(),row.inputs[0],token(1),parent,resolver,row.inputs[2],
        parent.outputs[0].script.toBuffer().readUInt32LE(61));
    }
  } finally {console.log=log;}
  const sdkTx=new tbc.Transaction(sdkRaw),sdkFee=row.inputs.reduce((s,i)=>s+i.satoshis,0)-sdkTx.outputs.reduce((s,o)=>s+o.satoshis,0);
  assert.equal(tx.version,sdkTx.version);assert.equal(tx.nLockTime,sdkTx.nLockTime);
  assert.equal(tx.inputs.length,sdkTx.inputs.length);assert.equal(tx.outputs.length,sdkTx.outputs.length);
  tx.inputs.forEach((input,i)=>{assert.ok(input.prevTxId.equals(sdkTx.inputs[i].prevTxId));
    assert.equal(input.outputIndex,sdkTx.inputs[i].outputIndex);assert.equal(input.sequenceNumber,sdkTx.inputs[i].sequenceNumber);});
  tx.outputs.forEach((output,i)=>{assert.ok(output.script.toBuffer().equals(sdkTx.outputs[i].script.toBuffer()));
    if(i!==tx.outputs.length-1)assert.equal(output.satoshis,sdkTx.outputs[i].satoshis);});
  // tbc-lib's legacy P2PKH size estimator reserves a 65-byte key (140-byte
  // script), while Engine binds compressed keys and reserves 107. The pinned
  // wrapper therefore differs only in fee/change. Bound this known difference;
  // do not silently accept any other transaction-semantic drift.
  assert.equal(tbc.Transaction.Input.PublicKeyHash.SCRIPT_MAX_SIZE,140);
  assert.ok(sdkFee>=row.fee&&sdkFee-row.fee<=4,'Unexpected SDK fee-policy difference');
  if(row.raw===sdkRaw)exactSdkTransactions++;
  // Recompute every witness independently at the Engine's approved outputs.
  // No copying Rust signatures or proof fields into the SDK.
  const key=row.operation==='claim'?receiver:sender,pub=key.publicKey.toString();
  for(let i=0;i<tx.inputs.length;i++) {
    const sig=tx.getSignature(i,key);let expected;
    if(i===tx.inputs.length-1)expected=tbc.Script.fromASM(`${sig} ${pub}`);
    else if(row.operation==='lock')expected=ContractToken.getFTunlock(sig,pub,tx,parent,resolver,i,row.inputs[i].outputIndex,row.profile==='Coin');
    else if(i===0)expected=tbc.Script.fromASM(`${sig} ${pub} ${row.operation==='claim'?`${secret} OP_TRUE`:'OP_FALSE'}`);
    else expected=ContractToken.getFTunlockSwap(sig,pub,tx,parent,resolver,parent,i,row.inputs[i].outputIndex,4,row.profile==='Coin');
    assert.ok(tx.inputs[i].script.toBuffer().equals(expected.toBuffer()),`${row.profile}/${row.operation}/${i}: SDK witness differs`);exactSdkWitnesses++;
  }
  reports.push({profile:row.profile,operation:row.operation,bytes:size,fee:row.fee,sdkWrapperFee:sdkFee,lockTime:tx.nLockTime});
}
assert.equal(vmInputs,58);assert.equal(exactSdkWitnesses,58);
assert.equal(claimObserverInputs,21);assert.equal(claimObserverRejections,21);
console.log(JSON.stringify({status:'HTLC_TOKEN_SOURCE_PASS',commit,pinnedFiles,transactions:rows.length,vmInputs,exactSdkTransactions,exactSdkWitnesses,claimObserverInputs,claimObserverRejections,reports,
  interpreterVersion:deps('tbc-lib-js/package.json').version,
  interpreterSha256:createHash('sha256').update(readFileSync(deps.resolve('tbc-lib-js/lib/script/interpreter.js'))).digest('hex'),
  externalRequests:0,broadcasts:0,publicEngineMethodsExercised:false,deviceAcceptance:false}));
