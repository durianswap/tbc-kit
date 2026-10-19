// Pinned SDK / Rust keyless match, continuation and external-signing oracle. Synthetic only.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import {resolve,join,relative} from 'node:path';
import {build} from 'esbuild';
const [upstreamArg,depsArg]=process.argv.slice(2);assert.ok(upstreamArg&&depsArg&&process.argv.length===4);
const roundingOnly=process.env.LOP_MATCH_ROUNDING_ONLY==='1';
const feeOnly=process.env.LOP_MATCH_FEE_ONLY==='1';
const upstream=resolve(upstreamArg),deps=createRequire(join(resolve(depsArg),'package.json'));
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986',sources={};
function pinned(path){const bytes=readFileSync(join(upstream,path));
  assert.deepEqual(bytes,execFileSync('git',['-C',upstream,'show',`${commit}:${path}`],{maxBuffer:8*1024*1024}));
  sources[path]=createHash('sha256').update(bytes).digest('hex');return bytes.toString();}
const source=pinned('lib/contract/orderBook.ts');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
const constants=section('const token_order_prefix_length','class OrderBook {');
const fields=section('class OrderBook {','\n  buildSellOrderTX(');
const native=section('\n  buildSellOrderTX(','\n  async makeSellOrder_privateKeyOnline(');
const tokens=section('\n  private getTokenPartialHash(','\n  async makeTokenSellOrder_privateKeyOnline(');
const codec=section('\n  getOrderUnlock(','\n  static placeHolderP2PKHOutput(');
const placeholder=section('\n  static placeHolderP2PKHOutput(','\n  // makeSellOrder_privateKey(');
const numeric=section('\nfunction _isPositiveBigInt(','\nmodule.exports =');
const compiled=await build({stdin:{contents:`import * as tbc from 'tbc-lib-js';
import {ContractToken as FT,tokenKind,isTokenProof,getFTPartialOffset,getFTVersion,isCoinCodeScript,modernCodeOffsets} from './lib/util/common/contractToken.js';
import {getPreTxdata,getCurrentTxOutputsData} from './lib/util/orderbook/orderbookunlock.js';
import {CoinTBC20} from './lib/util/coin/coinTbc20Code.js';
import {_isValidHexString,_isValidSHA256Hash,getFtBalanceFromTape} from './lib/util/common/util.js';
const BN=tbc.crypto.BN,partial_sha256=require('tbc-lib-js/lib/util/partial-sha256');
const stableCoin={getLockTimeFromTape(){throw Error('Legacy Coin outside oracle scope');}};
${constants}\n${numeric}\n${fields}\n${native}\n${tokens}\n${codec}\n${placeholder}\n}\nexport {OrderBook,getFtBalanceFromTape,FT};`,loader:'ts',resolveDir:upstream},
  bundle:true,write:false,metafile:true,platform:'node',format:'cjs',target:'node22',
  external:['tbc-lib-js','tbc-lib-js/*'],resolveExtensions:['.js','.json'],logLevel:'silent'});
for(const path of Object.keys(compiled.metafile.inputs)){if(path==='<stdin>')continue;
  const rel=relative(upstream,resolve(path));assert.ok(!rel.startsWith('..'));pinned(rel);}
const module={exports:{}};
runInThisContext(`(function(module,exports,require){${compiled.outputFiles[0].text}\n})`)(module,module.exports,name=>{
  if(name==='tbc-lib-js'||name.startsWith('tbc-lib-js/')||name==='node:crypto')return deps(name);
  throw Error('Unexpected dependency '+name);
});
const {OrderBook,getFtBalanceFromTape,FT}=module.exports,tbc=deps('tbc-lib-js');
assert.equal(deps('tbc-lib-js/package.json').version,'1.0.31');

const run=spawnSync('cargo',['test','--offline','--locked','-p','tbc-engine-core','--test','lop_token',
  'token_lop_make_cancel_roundtrip_and_locks','--','--exact','--nocapture'],{
  cwd:resolve(import.meta.dirname,'../rust'),env:{...process.env,LOP_TOKEN_DUMP_WIRE:'1'},encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
assert.equal(run.status,0,'Rust fixture source failed; raw withheld');
const rows=run.stdout.split('\n').filter(l=>l.startsWith('LOP_TOKEN_WIRE:')).map(l=>JSON.parse(l.slice(15)));
const key=new tbc.PrivateKey(new tbc.crypto.BN(1)),owner=key.toAddress().toString(),pub=key.publicKey.toString();
const buyerKey=new tbc.PrivateKey(new tbc.crypto.BN(2));
const matcherKey=new tbc.PrivateKey(new tbc.crypto.BN(4));
const tax=new tbc.PrivateKey(new tbc.crypto.BN(3)).toAddress().toString();
const stock=(profile,lock=0)=>{
  const row=rows.find(r=>r.profile===profile&&r.market==='native'&&r.operation==='make'&&r.inputs.length===2&&new tbc.Transaction(r.raw).nLockTime===lock);
  assert.ok(row);const parent=new tbc.Transaction(row.parentRaw);
  const ancestors=new Map(row.ancestorsRaw.map(raw=>{const tx=new tbc.Transaction(raw);return[tx.id,tx];}));
  return{parent,lock,input:{...row.inputs[0],ftBalance:getFtBalanceFromTape(parent.outputs[row.inputs[0].outputIndex+1].script.toHex())},
    resolve:id=>{assert.ok(ancestors.has(id));return ancestors.get(id);}};
};
let serial=80;
const fee=(recipient=owner)=>({txId:(serial++).toString(16).padStart(64,'0'),outputIndex:0,satoshis:100000,script:tbc.Script.buildPublicKeyHashOut(recipient).toHex()});
function stockForBuyer(original){
  const target=buyerKey.toAddress().toString(),funding=fee(),tx=new tbc.Transaction().from(original.input).from(funding);
  const amounts=FT.buildTapeAmount(original.input.ftBalance,[original.input.ftBalance]).amountHex;
  tx.addOutput(new tbc.Transaction.Output({satoshis:500,script:FT.buildFTtransferCode(original.input.script,target)}));
  tx.addOutput(new tbc.Transaction.Output({satoshis:0,script:FT.buildFTtransferTape(original.parent.outputs[original.input.outputIndex+1].script.toHex(),amounts)}));
  tx.change(owner).fee(10000);
  const coin=original.input.script.endsWith(Buffer.from('COINTBC20CODE2').toString('hex'));if(coin){tx.setInputSequence(0,4294967294);tx.nLockTime=original.lock;}
  tx.inputs[0].setScript(FT.getFTunlock(tx.getSignature(0,key),pub,tx,original.parent,original.resolve,0,original.input.outputIndex,coin));
  tx.inputs[1].setScript(tbc.Script.fromASM(`${tx.getSignature(1,key)} ${pub}`));
  tx.inputs.forEach((_,i)=>assert.equal(tx.verifyScript(i).success,true,'Synthetic holder handoff must verify'));
  return{parent:tx,input:{txId:tx.id,outputIndex:0,satoshis:500,script:tx.outputs[0].script.toHex(),ftBalance:original.input.ftBalance},
    resolve:id=>{assert.equal(id,original.parent.id);return original.parent;}};
}
function create(native,side,volume,a,b,zeroTax=false,unitPrice=1100000n,sameOwner=false,feeRecipient=tax){
  const signingKey=side==='buy'&&!sameOwner?buyerKey:key,owner=signingKey.toAddress().toString(),pub=signingKey.publicKey.toString();
  const sdk=new OrderBook(),funding=fee(owner),selected=side==='buy'?(sameOwner?b:stockForBuyer(b)):native?b:a;
  let raw;
  const acode=a.input.script,bcode=b.input.script,rate=zeroTax?0n:100000n;
  if(native&&side==='sell')raw=sdk.buildSellOrderTX(owner,feeRecipient,BigInt(volume),unitPrice,rate,'44'.repeat(32),bcode,[funding]);
  else if(native)raw=sdk.buildBuyOrderTX(owner,feeRecipient,BigInt(volume),unitPrice,rate,'44'.repeat(32),[funding],[selected.input],[selected.parent]);
  else raw=sdk[side==='buy'?'buildTokenBuyOrderTX':'buildTokenSellOrderTX'](owner,feeRecipient,BigInt(volume),unitPrice,rate,'44'.repeat(32),'55'.repeat(32),
    acode,bcode,[funding],[selected.input],[selected.parent]);
  const tx=new tbc.Transaction(raw),prior=native&&side==='sell'?[funding]:[selected.input,funding];
  tx.inputs.forEach((i,n)=>i.output=new tbc.Transaction.Output({script:tbc.Script.fromHex(prior[n].script),satoshis:prior[n].satoshis}));
  const sigs=tx.inputs.map((_,i)=>tx.getSignature(i,signingKey));
  const signed=native&&side==='sell'?sdk.fillSigsSellOrder(raw,sigs,pub,'make'):
    sdk[native?'fillSigsMakeBuyOrder':side==='buy'?'fillSigsMakeTokenBuyOrder':'fillSigsMakeTokenSellOrder'](raw,sigs,pub,[selected.parent],[selected.resolve]);
  const parent=new tbc.Transaction(signed);
  return{parent,order:{txId:parent.id,outputIndex:0,satoshis:parent.outputs[0].satoshis,script:parent.outputs[0].script.toHex()},
    token:native&&side==='sell'?null:{txId:parent.id,outputIndex:1,satoshis:500,script:parent.outputs[1].script.toHex(),ftBalance:getFtBalanceFromTape(parent.outputs[2].script.toHex())},
    resolve:id=>{assert.equal(id,selected.parent.id);return selected.parent;}};
}
const packets=[],expected=[],contexts=[],vmFailures=[],nonConservingSdkCases=[],selfMatchCases=[],feeRecipientCases=[];let vmInputs=0,roleRejections=0;
function traceFailure(tx,index){
  const Interpreter=tbc.Script.Interpreter,step=Interpreter.prototype.step;let failed;
  try{Interpreter.prototype.step=function(type){const pc=this.pc,op=this.script.chunks[pc]?.opcodenum;
    const operands=op===0x88?this.stack.slice(-2).map(v=>v.toString('hex')):[];
    const result=step.call(this,type);if(!result)failed={pc,type,op,operands,window:this.script.chunks.slice(pc-8,pc+1).map(c=>c.buf?c.buf.toString('hex'):tbc.Opcode(c.opcodenum).toString())};return result;};tx.verifyScript(index);
  }finally{Interpreter.prototype.step=step;}return failed;
}
function directAncestors(order){
  if(!order.token)return[];
  const tape=order.parent.outputs[order.token.outputIndex+1].script.toBuffer(),ids=new Set();
  for(let n=0;n<6;n++)if(tape.readBigUInt64LE(3+n*8)>0n)ids.add(order.parent.inputs[n].prevTxId.toString('hex'));
  return[...ids].map(id=>order.resolve(id).uncheckedSerialize());
}
function queueMatch(native,profile,buy,sell,buyVolume,sellVolume,zeroTax,round=0,rejectionReason=null){
  const expectReject=rejectionReason!==null;
  const funding=fee(matcherKey.toAddress().toString()),sdk=new OrderBook();
  let raw,sdkRejectedAllocation=false;const log=console.log;console.log=()=>{};
  try{
    raw=native?sdk.matchOrder(matcherKey,buy.order,buy.parent,buy.token,buy.parent,buy.resolve,sell.order,sell.parent,[funding],tax,tax):
      sdk.matchTokenOrder(matcherKey,buy.order,buy.parent,buy.token,buy.parent,buy.resolve,sell.order,sell.parent,sell.token,sell.parent,sell.resolve,[funding],tax,tax);
  }catch(error){
    if(rejectionReason!=='unallocated-escrow'||!String(error.message).includes("output amounts do not conserve this input's absolute vin slot"))throw error;
    sdkRejectedAllocation=true;
  }finally{console.log=log;}
  if(sdkRejectedAllocation){
    nonConservingSdkCases.push({market:native?'native':'token',reason:rejectionReason,constructionRejected:'input-allocation'});
    packets.push({current:buy.parent.uncheckedSerialize(),buy:buy.parent.uncheckedSerialize(),sell:sell.parent.uncheckedSerialize(),
      escrowA:native?sellVolume:Number(sell.token.ftBalance),escrowB:Number(buy.token.ftBalance),funding,
      buyVout:buy.order.outputIndex,sellVout:sell.order.outputIndex,buyAncestors:directAncestors(buy),sellAncestors:directAncestors(sell),expectReject,rejectionReason});
    contexts.push({native,profile,buy,sell,round,zeroTax,buyVolume,sellVolume,expectReject,rejectionReason});expected.push(null);return;
  }
  const tx=new tbc.Transaction(raw),prior=native?[buy.order,buy.token,sell.order,funding]:[buy.order,buy.token,sell.order,sell.token,funding];
  const failures=[];
  tx.inputs.forEach((input,i)=>{input.output=new tbc.Transaction.Output({script:tbc.Script.fromHex(prior[i].script),satoshis:prior[i].satoshis});
    const result=tx.verifyScript(i);if(result.success){if(!expectReject)vmInputs++;}else failures.push({market:native?'native':'token',profile,buyVolume,sellVolume,input:i,error:result.error,
      ...(process.env.LOP_MATCH_TRACE==='1'?{trace:traceFailure(tx,i)}:{})});});
  if(expectReject){const released=getFtBalanceFromTape(tx.outputs[1].script.toHex())+getFtBalanceFromTape(tx.outputs[3].script.toHex());
    if(rejectionReason==='unallocated-escrow')assert.equal(buy.token.ftBalance-released,1n);
    else{assert.equal(rejectionReason,'native-continuation-escrow');assert.equal(buy.token.ftBalance-released,152n);assert.deepEqual(failures.map(f=>f.input),[0]);}
    nonConservingSdkCases.push({market:native?'native':'token',reason:rejectionReason,vmRejectedInputs:failures.map(f=>f.input)});
  }else vmFailures.push(...failures);
  if(round===0&&!zeroTax&&profile==='Tbc20'&&buyVolume===200&&sellVolume===200){
    for(const[collidingKey,orderVin]of[[key,2],[buyerKey,0]]){
      const collision=fee(collidingKey.toAddress().toString());let badRaw;
      const log=console.log;console.log=()=>{};
      try{badRaw=native?sdk.matchOrder(collidingKey,buy.order,buy.parent,buy.token,buy.parent,buy.resolve,sell.order,sell.parent,[collision],tax,tax):
        sdk.matchTokenOrder(collidingKey,buy.order,buy.parent,buy.token,buy.parent,buy.resolve,sell.order,sell.parent,sell.token,sell.parent,sell.resolve,[collision],tax,tax);
      }finally{console.log=log;}
      const bad=new tbc.Transaction(badRaw),old=orderVin===0?buy.order:sell.order;
      bad.inputs[orderVin].output=new tbc.Transaction.Output({satoshis:old.satoshis,script:tbc.Script.fromHex(old.script)});
      const result=bad.verifyScript(orderVin);assert.equal(result.success,false);assert.equal(result.error,'SCRIPT_ERR_EQUALVERIFY');roleRejections++;
    }
  }
  packets.push({current:raw,buy:buy.parent.uncheckedSerialize(),sell:sell.parent.uncheckedSerialize(),
    escrowA:native?sellVolume:Number(sell.token.ftBalance),escrowB:Number(buy.token.ftBalance),funding,
    buyVout:buy.order.outputIndex,sellVout:sell.order.outputIndex,buyAncestors:directAncestors(buy),sellAncestors:directAncestors(sell),expectReject,rejectionReason});
  contexts.push({native,profile,buy,sell,prior,tx,sdk,round,zeroTax,buyVolume,sellVolume,expectReject,rejectionReason});
  const matched=Math.min(buyVolume,sellVolume),paid=Number(BigInt(matched)*OrderBook[native?'getOrderData':'getTokenOrderData'](sell.order.script).unitPrice/1000000n);
  expected.push({proofs:[tx.inputs[0].script.toHex(),tx.inputs[2].script.toHex()],
    quote:{matchedA:matched,aToBuyer:zeroTax?matched:matched*9/10,aTax:zeroTax?0:matched/10,paidB:paid,bToSeller:zeroTax?paid:paid*9/10,bTax:zeroTax?0:paid/10,
      sellRemaining:sellVolume-matched,buyRemaining:buyVolume-matched,aEscrowChange:sellVolume-matched,
      bEscrowChange:Number(buy.token.ftBalance)-paid,nativeZeroTaxPlaceholder:native&&zeroTax},
    continuation:buyVolume===sellVolume?null:tx.outputs[native?7:9].script.toHex()});
}
if(!roundingOnly&&!feeOnly)for(const native of[true,false]){
  const a=stock('Tbc20'),b=stock('Coin'),buy=create(native,'buy',200,a,b,false,1100000n,true),sell=create(native,'sell',200,a,b),sdk=new OrderBook();
  let raw;const log=console.log;console.log=()=>{};
  try{raw=native?sdk.matchOrder(matcherKey,buy.order,buy.parent,buy.token,buy.parent,buy.resolve,sell.order,sell.parent,[fee(matcherKey.toAddress().toString())],tax,tax):
    sdk.matchTokenOrder(matcherKey,buy.order,buy.parent,buy.token,buy.parent,buy.resolve,sell.order,sell.parent,sell.token,sell.parent,sell.resolve,[fee(matcherKey.toAddress().toString())],tax,tax);
  }finally{console.log=log;}
  const tx=new tbc.Transaction(raw),failed=[];
  for(const [vin,order]of[[0,buy.order],[2,sell.order]]){tx.inputs[vin].output=new tbc.Transaction.Output({satoshis:order.satoshis,script:tbc.Script.fromHex(order.script)});
    const result=tx.verifyScript(vin);if(!result.success)failed.push({input:vin,error:result.error});}
  assert.deepEqual(failed,[{input:0,error:'SCRIPT_ERR_EQUALVERIFY'},{input:2,error:'SCRIPT_ERR_EQUALVERIFY'}],
    'Both pinned order covenants must reject same-owner settlement');
  selfMatchCases.push({market:native?'native':'token',failed});
}
// Different addresses in the two committed order Codes are not compatible,
// even when the caller routes each asset fee to its own order's address.
if(!roundingOnly)for(const native of[true,false])for(const zeroTax of[false,true])for(const recipientMode of ['different','buyer','seller']){
  const a=stock('Tbc20'),b=stock('Coin'),otherTax=new tbc.PrivateKey(new tbc.crypto.BN(5)).toAddress().toString();
  const buyTax=recipientMode==='different'?tax:recipientMode==='buyer'?buyerKey.toAddress().toString():owner;
  const sellTax=recipientMode==='different'?otherTax:buyTax;
  const buy=create(native,'buy',400,a,b,zeroTax,1100000n,false,buyTax),sell=create(native,'sell',200,a,b,zeroTax,1100000n,false,sellTax),sdk=new OrderBook();
  let raw;const log=console.log;console.log=()=>{};
  try{raw=native?sdk.matchOrder(matcherKey,buy.order,buy.parent,buy.token,buy.parent,buy.resolve,sell.order,sell.parent,[fee(matcherKey.toAddress().toString())],sellTax,buyTax):
    sdk.matchTokenOrder(matcherKey,buy.order,buy.parent,buy.token,buy.parent,buy.resolve,sell.order,sell.parent,sell.token,sell.parent,sell.resolve,[fee(matcherKey.toAddress().toString())],sellTax,buyTax);
  }finally{console.log=log;}
  const tx=new tbc.Transaction(raw),failed=[];
  for(const [vin,order]of[[0,buy.order],[2,sell.order]]){
    tx.inputs[vin].output=new tbc.Transaction.Output({satoshis:order.satoshis,script:tbc.Script.fromHex(order.script)});
    const result=tx.verifyScript(vin);if(!result.success)failed.push({input:vin,error:result.error});
  }
  if(recipientMode==='different')assert.ok(failed.length>0,'Pinned covenant unexpectedly permits different committed fee recipients');
  else assert.deepEqual(failed,[],'Shared fee recipient may equal one owner; do not add unsupported restrictions');
  feeRecipientCases.push({market:native?'native':'token',zeroTax,recipientMode,failed});
}
if(feeOnly){console.log(JSON.stringify({status:'LOP_FEE_RECIPIENT_SOURCE_PASS',commit,pinnedFiles:Object.keys(sources).length,feeRecipientCases,network:0,broadcasts:0}));process.exit(0);}
if(!roundingOnly)for(const native of[true,false])for(const profile of['Tbc20','Coin'])for(const[buyVolume,sellVolume,zeroTax]of[[200,200,false],[400,200,false],[200,400,false],[200,200,true]]){
  const a=stock(profile),b=stock(profile==='Coin'?'Tbc20':'Coin');
  queueMatch(native,profile,create(native,'buy',buyVolume,a,b,zeroTax),create(native,'sell',sellVolume,a,b,zeroTax),buyVolume,sellVolume,zeroTax);
}
if(!roundingOnly)for(const native of[true,false])for(const lock of[829999,1774427000]){
  const a=stock('Tbc20'),b=stock('Coin',lock);
  queueMatch(native,'Tbc20',create(native,'buy',200,a,b),create(native,'sell',200,a,b),200,200,false,20);
}
function runRust(rows){const checked=spawnSync('cargo',['run','--offline','--locked','-q','-p','tbc-engine-core','--example','lop_match_oracle'],{
  cwd:resolve(import.meta.dirname,'../rust'),input:JSON.stringify(rows),encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
  assert.equal(checked.status,0,'Rust LOP proof adapter failed: '+checked.stderr.slice(-1500));return JSON.parse(checked.stdout);}
const actual=runRust(packets);assert.equal(actual.length,expected.length);
let engineVmInputs=0,exactEngineWitnesses=0,continuationCancellations=0,cancelVmInputs=0,verifiedMatches=0;
function verifyRows(start,end){for(let i=start;i<end;i++){assert.deepEqual(actual[i].quote,expected[i].quote);assert.equal(actual[i].continuation,expected[i].continuation);
  verifiedMatches++;
  assert.equal(actual[i].proofs.length,2);actual[i].proofs.forEach((proof,j)=>assert.equal(proof,expected[i].proofs[j],`LOP match witness differs row ${i}/role ${j}`));
  const{native,buy,sell,prior,tx:sdkTx,sdk}=contexts[i],result=actual[i].engine,tx=new tbc.Transaction(result.raw);
  assert.deepEqual(result.signingInputs,native?[1,3]:[1,3,4]);
  assert.equal(tx.outputs.length,sdkTx.outputs.length);assert.equal(tx.nLockTime,sdkTx.nLockTime);
  tx.outputs.forEach((output,n)=>{assert.equal(output.script.toHex(),sdkTx.outputs[n].script.toHex());if(n!==(native?6:8))assert.equal(output.satoshis,sdkTx.outputs[n].satoshis);});
  tx.inputs.forEach((input,n)=>{assert.equal(input.prevTxId.toString('hex'),prior[n].txId);assert.equal(input.outputIndex,prior[n].outputIndex);
    input.output=new tbc.Transaction.Output({script:tbc.Script.fromHex(prior[n].script),satoshis:prior[n].satoshis});
    const r=tx.verifyScript(n);
    if(!r.success&&process.env.LOP_MATCH_TRACE==='1')console.error(JSON.stringify({kind:'engine-input',row:i,input:n,native,round:contexts[i].round,
      quote:actual[i].quote,sdkFailures:vmFailures,trace:traceFailure(tx,n)}));
    assert.equal(r.success,true,`Engine ${i}/${n}: ${r.error}`);engineVmInputs++;});
  for(let n=0;n<tx.inputs.length;n++){
    let witness;
    if(n===0||n===2){const order=n===0?buy:sell;witness=sdk[native?'getOrderUnlock':'getTokenOrderUnlock'](tx,order.parent,order.order.outputIndex);}
    else if(n===tx.inputs.length-1)witness=tbc.Script.fromASM(`${tx.getSignature(n,matcherKey)} ${matcherKey.publicKey}`);
    else{const order=n===1?buy:sell,coin=order.token.script.endsWith(Buffer.from('COINTBC20CODE2').toString('hex'));
      witness=FT.getFTunlockSwap(tx.getSignature(n,matcherKey),matcherKey.publicKey.toString(),tx,order.parent,order.resolve,order.parent,n,order.token.outputIndex,4,coin,!native);}
    assert.equal(tx.inputs[n].script.toHex(),witness.toHex());exactEngineWitnesses++;
  }
  assert.ok(Buffer.from(result.raw,'hex').length<=result.maximumSignedBytes);
  assert.equal(prior.reduce((s,p)=>s+p.satoshis,0)-tx.outputs.reduce((s,o)=>s+o.satoshis,0),result.fee);
  assert.ok(result.fee>=Math.max(80,Math.ceil(Buffer.from(result.raw,'hex').length*80/1000)));
  assert.equal(result.cancel!==null,expected[i].continuation!==null);
  if(result.cancel){const c=result.cancel,cancel=new tbc.Transaction(c.raw),vout=native?7:9;
    assert.equal(cancel.inputs[0].prevTxId.toString('hex'),tx.id);assert.equal(cancel.inputs[0].outputIndex,vout);
    const refundAddress=new tbc.PublicKey(c.ownerPublicKey).toAddress();
    assert.equal(cancel.outputs[0].script.toHex(),cancel.inputs.length===2?tbc.Script.buildPublicKeyHashOut(refundAddress).toHex():FT.buildFTtransferCode(tx.outputs[vout+1].script.toHex(),refundAddress.toString()).toHex());
    if(cancel.inputs.length===2)assert.equal(cancel.outputs[0].satoshis,tx.outputs[vout].satoshis);
    else{assert.equal(getFtBalanceFromTape(cancel.outputs[1].script.toHex()),getFtBalanceFromTape(tx.outputs[vout+2].script.toHex()));}
    cancel.inputs.forEach((input,n)=>{const p=c.inputs[n];assert.equal(input.prevTxId.toString('hex'),p.txId);assert.equal(input.outputIndex,p.outputIndex);
      if(n<c.inputs.length-1){assert.equal(p.txId,tx.id);assert.equal(p.script,tx.outputs[p.outputIndex].script.toHex());assert.equal(p.satoshis,tx.outputs[p.outputIndex].satoshis);}
      input.output=new tbc.Transaction.Output({script:tbc.Script.fromHex(p.script),satoshis:p.satoshis});
      const r=cancel.verifyScript(n);assert.equal(r.success,true,`Continuation cancel ${i}/${n}: ${r.error}`);cancelVmInputs++;});
    assert.equal(c.inputs.reduce((sum,p)=>sum+p.satoshis,0)-cancel.outputs.reduce((sum,o)=>sum+o.satoshis,0),c.fee);
    assert.ok(Buffer.from(c.raw,'hex').length<=c.maximumSignedBytes);continuationCancellations++;
  }
}}
verifyRows(0,actual.length);
function continuedOrder(index){
  const c=contexts[index],parent=new tbc.Transaction(actual[index].engine.raw),vout=c.native?7:9,isBuy=c.buyVolume>c.sellVolume;
  return{parent,order:{txId:parent.id,outputIndex:vout,satoshis:parent.outputs[vout].satoshis,script:parent.outputs[vout].script.toHex()},
    token:!isBuy&&c.native?null:{txId:parent.id,outputIndex:vout+1,satoshis:500,script:parent.outputs[vout+1].script.toHex(),ftBalance:getFtBalanceFromTape(parent.outputs[vout+2].script.toHex())},
    resolve:id=>{const source=isBuy?c.buy.parent:c.sell.parent;assert.equal(id,source.id);return source;}};
}
// Spend the Rust-built continuation, not an SDK-only stand-in. Two follow-up
// fills exercise repeated nonzero order vouts and final exhaustion.
if(!roundingOnly)for(let round=1;round<=2;round++){
  const start=actual.length;
  for(let i=0;i<start;i++){
    const c=contexts[i];if(c.round!==round-1||!actual[i].continuation)continue;
    const isBuy=c.buyVolume>c.sellVolume;
    const volume=Math.abs(c.buyVolume-c.sellVolume),a=stock(c.profile),b=stock(c.profile==='Coin'?'Tbc20':'Coin');
    const order=continuedOrder(i);
    const other=create(c.native,isBuy?'sell':'buy',100,a,b,c.zeroTax);
    queueMatch(c.native,c.profile,isBuy?order:other,isBuy?other:order,isBuy?volume:100,isBuy?100:volume,c.zeroTax,round);
  }
  assert.equal(packets.length-start,8,'Both continuation sides in both markets and profiles');
  actual.push(...runRust(packets.slice(start)));verifyRows(start,actual.length);
}
// Rounding is not distributive: floor(303*1.5)=454, but three 101-unit
// fills pay 151 each. Preserve the last unit: fail before signing, allowing
// the owner's previously verified full-balance cancellation instead.
let roundingPrior=[];
for(let round=0;round<3;round++){
  const start=actual.length;
  for(const [n,native]of[true,false].entries()){
    if(native&&round===2)continue;
    const a=stock('Tbc20'),b=stock('Coin'),buy=round?continuedOrder(roundingPrior[n]):create(native,'buy',303,a,b,true,1500000n);
    const sell=create(native,'sell',101,a,b,true,1500000n);
    queueMatch(native,'Tbc20',buy,sell,303-round*101,101,true,10+round,native&&round===1?'native-continuation-escrow':round===2?'unallocated-escrow':null);
  }
  const result=runRust(packets.slice(start));actual.push(...result);
  for(let i=start;i<actual.length;i++){
    const c=contexts[i];if(c.expectReject)assert.deepEqual(actual[i],{rejected:true,reason:c.rejectionReason});
    else{verifyRows(i,i+1);roundingPrior[c.native?0:1]=i;}
  }
}
// Optional acceptance-observer cross-check: consume actual Rust signed vectors
// with the frozen delivery decoder, never hand-authored order/asset snapshots.
let acceptanceObserver;
if(process.env.LOP_MATCH_ACCEPTANCE_CONSUMER){
  const {pathToFileURL}=await import('node:url');
  const installed=join(resolve(process.env.LOP_MATCH_ACCEPTANCE_CONSUMER),'node_modules/@tbc/kit');
  const {createWasmTbcKeylessEngine}=await import(pathToFileURL(join(installed,'dist/esm/wallet.js')));
  const {inspectTbcTransaction}=await import(pathToFileURL(join(installed,'dist/esm/api.js')));
  const keyless=await createWasmTbcKeylessEngine(readFileSync(join(installed,'artifacts/wasm/tbc_keyless_wasm.wasm')));
  const {verifyLopMatchOutcome,verifyLopMatchScripts}=await import('../../../native/kit-runtime/closed-loop/lop-match-live-checks.mjs');
  const decode=async(phase,raw,vout)=>JSON.parse(await keyless.execute('inspectLopMaterial',JSON.stringify({phase,parent:{txid:new tbc.Transaction(raw).id,rawTransaction:raw},vout})));
  let matches=0,negativeCases=0,scriptInputs=0;
  for(let i=0;i<actual.length;i++){
    if(contexts[i].expectReject)continue;
    const c=contexts[i],raw=actual[i].engine.raw,parsed=inspectTbcTransaction(raw),assets=[];
    for(let vout=0;vout<parsed.transaction.outputs.length;vout++){
      try{assets.push(await decode('inspectAsset',raw,vout));}catch{/* Strict observer checks every non-asset output. */}
    }
    const buy=await decode('inspectOrder',c.buy.parent.uncheckedSerialize(),c.buy.order.outputIndex);
    const sell=await decode('inspectOrder',c.sell.parent.uncheckedSerialize(),c.sell.order.outputIndex);
    const continuationOrders=actual[i].continuation?[await decode('inspectOrder',raw,c.native?7:9)]:[];
    const args={parsed,buy,sell,assets,continuationOrders,matcherScript:tbc.Script.buildPublicKeyHashOut(matcherKey.toAddress()).toHex(),
      inputs:c.prior.map(p=>({txid:p.txId,vout:p.outputIndex,satoshis:String(p.satoshis),scriptPubKey:p.script})),maxFee:'10000',rawBytes:raw.length/2};
    const checked=verifyLopMatchOutcome(args);assert.equal(checked.fee,String(actual[i].engine.fee));matches++;
    scriptInputs+=verifyLopMatchScripts({rawTransaction:raw,txid:parsed.txid,inputs:args.inputs,tbc}).verifiedInputs;
    for(const mutate of[
      a=>{a.sell.ownerHash=a.buy.ownerHash;},
      a=>{a.matcherScript=tbc.Script.buildPublicKeyHashOut(buyerKey.toAddress()).toHex();},
      a=>{a.assets[0].balance=String(BigInt(a.assets[0].balance)+1n);},
      a=>{a.assets[0].partialHash='00'.repeat(32);},
      a=>{a.assets[0].controller='00'.repeat(20)+'00';},
      a=>{a.inputs[0].txid='00'.repeat(32);},
      a=>{a.maxFee='0';},
      ...(continuationOrders.length?[a=>{a.continuationOrders[0].feeRecipientHash='00'.repeat(20);}]:[])
    ]){const bad=structuredClone(args);mutate(bad);assert.throws(()=>verifyLopMatchOutcome(bad));negativeCases++;}
  }
  acceptanceObserver={matches,negativeCases,scriptInputs,candidate:JSON.parse(readFileSync(join(installed,'package.json'))).version,realChain:false};
}
console.log(JSON.stringify({status:vmFailures.length?'LOP_MATCH_SOURCE_VM_FAILURE':'LOP_MATCH_SOURCE_PASS',commit,pinnedFiles:Object.keys(sources).length,acceptanceObserver,
  cases:packets.length,transactions:verifiedMatches,rejectedCases:contexts.filter(c=>c.expectReject).length,vmInputs,vmFailures,
  exactRustProofs:verifiedMatches*2,settlementQuotes:verifiedMatches,externalRequests:0,broadcasts:0,nonConservingSdkCases,
  roleRejections,selfMatchCases,feeRecipientCases,engineVmInputs,exactEngineWitnesses,continuationCancellations,cancelVmInputs,continuationMatches:contexts.filter(c=>c.round>0&&c.round<10).length,
  engineMatchBuilder:true,sharedSigningIntegration:true,deviceAcceptance:false}));
if(vmFailures.length)process.exitCode=1;
