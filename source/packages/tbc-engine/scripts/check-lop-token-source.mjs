// Pinned pure SDK LOP constructors/fillers and independent VM. Synthetic only.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import {resolve,join,relative} from 'node:path';
import {build} from 'esbuild';
import {sourceKeylessFixtureRuntime} from './lib/source-keyless-fixture-runtime.mjs';
const [upstreamArg,depsArg,...flags]=process.argv.slice(2);assert.ok(upstreamArg&&depsArg&&flags.every(f=>['--reviewed','--native-parity'].includes(f)));
assert.ok(!flags.includes('--native-parity')||flags.includes('--reviewed'));
const root=resolve(import.meta.dirname,'../../..');
const runtime=flags.includes('--reviewed')?await sourceKeylessFixtureRuntime(root,{parity:flags.includes('--native-parity')}):undefined;
const upstream=resolve(upstreamArg),deps=createRequire(join(resolve(depsArg),'package.json'));
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986',sources={};
function pinned(path){const bytes=readFileSync(join(upstream,path));
  assert.deepEqual(bytes,execFileSync('git',['-C',upstream,'show',`${commit}:${path}`],{maxBuffer:8*1024*1024}));
  sources[path]=createHash('sha256').update(bytes).digest('hex');return bytes.toString();}
const source=pinned('lib/contract/orderBook.ts');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
const constants=section('const token_order_prefix_length','// Match transactions');
const fields=section('class OrderBook {','\n  buildSellOrderTX(');
const native=section('\n  buildBuyOrderTX(','\n  matchOrder(');
const tokens=section('\n  private getTokenPartialHash(','\n  private buildMatchTokenOrderTransaction(');
const codec=section('\n  getSellOrderCode(','\n  static placeHolderP2PKHOutput(');
const numeric=section('\nfunction _isPositiveBigInt(','\nmodule.exports =');
const compiled=await build({stdin:{contents:`import * as tbc from 'tbc-lib-js';
import {ContractToken as FT,tokenKind,isTokenProof,getFTPartialOffset,getFTVersion,isCoinCodeScript,modernCodeOffsets} from './lib/util/common/contractToken.js';
import {CoinTBC20} from './lib/util/coin/coinTbc20Code.js';
import {_isValidHexString,_isValidSHA256Hash,getFtBalanceFromTape} from './lib/util/common/util.js';
const BN=tbc.crypto.BN,partial_sha256=require('tbc-lib-js/lib/util/partial-sha256');
const stableCoin={getLockTimeFromTape(){throw Error('Legacy Coin outside oracle scope');}};
${constants}\n${numeric}\n${fields}\n${native}\n${tokens}\n${codec}\n}\nexport {OrderBook,getFtBalanceFromTape};`,loader:'ts',resolveDir:upstream},
  bundle:true,write:false,metafile:true,platform:'node',format:'cjs',target:'node22',
  external:['tbc-lib-js','tbc-lib-js/*'],resolveExtensions:['.js','.json'],logLevel:'silent'});
for(const path of Object.keys(compiled.metafile.inputs)){if(path==='<stdin>')continue;
  const rel=relative(upstream,resolve(path));assert.ok(!rel.startsWith('..'));pinned(rel);}
const module={exports:{}};
runInThisContext(`(function(module,exports,require){${compiled.outputFiles[0].text}\n})`)(module,module.exports,name=>{
  if(name==='tbc-lib-js'||name.startsWith('tbc-lib-js/')||name==='node:crypto')return deps(name);
  throw Error('Unexpected dependency '+name);
});
const {OrderBook,getFtBalanceFromTape}=module.exports,tbc=deps('tbc-lib-js');
assert.equal(deps('tbc-lib-js/package.json').version,'1.0.31');
const run=spawnSync('cargo',['test','--offline','--locked','-p','tbc-engine-core','--test','lop_token',
  'token_lop_make_cancel_roundtrip_and_locks','--','--exact','--nocapture'],{
  cwd:resolve(import.meta.dirname,'../rust'),env:{...process.env,LOP_TOKEN_DUMP_WIRE:'1'},encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
assert.equal(run.status,0,'LOP Rust transaction check failed; fixture raw withheld');
const prefix='LOP_TOKEN_WIRE:',rows=run.stdout.split('\n').filter(l=>l.startsWith(prefix)).map(l=>JSON.parse(l.slice(prefix.length)));
assert.equal(rows.length,36);
const key=new tbc.PrivateKey(new tbc.crypto.BN(1)),owner=key.toAddress().toString(),pub=key.publicKey.toString();
const tax=new tbc.PrivateKey(new tbc.crypto.BN(2)).toAddress().toString();
let vmInputs=0,exactSdkRaw=0;const reports=[];
const parentsForChildren=new Map();let reviewedSources=0,reviewedChildren=0,reviewedVmInputs=0,childNegatives=0;
const call=async(op,input)=>JSON.parse(await runtime.engine.execute(op,JSON.stringify(input)));
for(const row of rows){
  const tx=new tbc.Transaction(row.raw),parent=new tbc.Transaction(row.parentRaw),sdk=new OrderBook();
  const ancestors=new Map(row.ancestorsRaw.map(raw=>{const t=new tbc.Transaction(raw);return[t.id,t];}));
  const resolver=id=>{assert.ok(ancestors.has(id));return ancestors.get(id);};
  for(const[i,input]of tx.inputs.entries()){
    const prior=row.inputs[i];assert.equal(input.prevTxId.toString('hex'),prior.txId);assert.equal(input.outputIndex,prior.outputIndex);
    input.output=new tbc.Transaction.Output({satoshis:prior.satoshis,script:tbc.Script.fromHex(prior.script)});
    const result=tx.verifyScript(i);assert.equal(result.success,true,`${row.profile}/${row.market}/${row.side}/${row.operation}/${i}: ${result.error}`);vmInputs++;
  }
  const token=i=>({...row.inputs[i],ftBalance:getFtBalanceFromTape(parent.outputs[row.inputs[i].outputIndex+1].script.toHex()).toString()});
  let sdkRaw;
  if(row.operation==='make'){
    const ftInputs=row.inputs.slice(0,-1).map((_,i)=>token(i)),parents=ftInputs.map(()=>parent),funding=[row.inputs.at(-1)];
    sdkRaw=row.market==='native'?sdk.buildBuyOrderTX(owner,tax,100n,1100000n,100n,'44'.repeat(32),funding,ftInputs,parents):
      sdk[row.side==='sell'?'buildTokenSellOrderTX':'buildTokenBuyOrderTX'](owner,tax,100n,1100000n,100n,'44'.repeat(32),'55'.repeat(32),row.assetA,row.assetB,funding,ftInputs,parents);
  }else{
    sdkRaw=sdk[row.market==='native'?'buildCancelBuyOrderTX':row.side==='sell'?'buildCancelTokenSellOrderTX':'buildCancelTokenBuyOrderTX'](
      row.inputs[0],token(1),parent,row.inputs.slice(2));
  }
  const expected=new tbc.Transaction(sdkRaw);
  assert.equal(expected.version,tx.version);assert.equal(expected.nLockTime,tx.nLockTime);
  assert.equal(expected.inputs.length,tx.inputs.length);assert.equal(expected.outputs.length,tx.outputs.length);
  expected.inputs.forEach((input,i)=>{assert.equal(input.prevTxId.toString('hex'),row.inputs[i].txId);assert.equal(input.outputIndex,row.inputs[i].outputIndex);
    assert.equal(input.sequenceNumber,tx.inputs[i].sequenceNumber);input.output=tx.inputs[i].output;});
  expected.outputs.forEach((output,i)=>{assert.equal(output.script.toHex(),tx.outputs[i].script.toHex());
    if(i<expected.outputs.length-1)assert.equal(output.satoshis,tx.outputs[i].satoshis);});
  const sdkFee=row.inputs.reduce((s,i)=>s+i.satoshis,0)-expected.outputs.reduce((s,o)=>s+o.satoshis,0);
  // SDK reserves a rough 12000 bytes/token; Engine sizes actual proof structure.
  // Only fee/change may differ. Compare independent SDK signatures and complete
  // proof witnesses on precisely the Engine transaction outputs below.
  const unsigned=new tbc.Transaction(row.raw);unsigned.inputs.forEach((input,i)=>{input.setScript(tbc.Script.empty());input.output=tx.inputs[i].output;});
  const sigs=unsigned.inputs.map((_,i)=>unsigned.getSignature(i,key));let reference;
  if(row.operation==='make'){
    const count=unsigned.inputs.length-1;
    reference=sdk[row.market==='native'?'fillSigsMakeBuyOrder':row.side==='sell'?'fillSigsMakeTokenSellOrder':'fillSigsMakeTokenBuyOrder'](
      unsigned.uncheckedSerialize(),sigs,pub,Array(count).fill(parent),Array(count).fill(resolver));
  }else{
    reference=sdk[row.market==='native'?'fillSigsCancelBuyOrder':row.side==='sell'?'fillSigsCancelTokenSellOrder':'fillSigsCancelTokenBuyOrder'](
      unsigned.uncheckedSerialize(),sigs,pub,parent,parent,resolver);
  }
  assert.equal(reference,row.raw);
  if(runtime){
    const sourceUtxos=row.inputs.map((input,i)=>{
      const base={txId:input.txId,outputIndex:input.outputIndex,satoshis:input.satoshis,script:input.script};
      if(i===row.inputs.length-1)return {...base,scriptSigType:'p2pkh'};
      if(row.operation==='cancel'&&i===0)return {...base,scriptSigType:'other',unfinishedScriptSig:tbc.Script.fromASM(`7369676e6174757265 ${pub} OP_2`).toHex()};
      return {...base,scriptSigType:row.profile==='Coin'?'tbc20-stablecoin':'tbc20-standard',preTx:row.parentRaw,ancestorTransactions:row.ancestorsRaw};
    });
    const resolvedOutputs=[parent,...ancestors.values()].flatMap(tx=>tx.outputs.map((o,vout)=>({txid:tx.id,vout,satoshis:String(o.satoshis),scriptPubKey:o.script.toHex()})));
    const prepare={format:'associated',publicKey:pub,resolvedOutputs,request:{sourceTxraw:unsigned.uncheckedSerialize(),sourceUtxos,inputs:[],outputs:[]}};
    const stage=await call('prepareReviewedStage',prepare),finish={stage,signatures:sigs};
    const result=await call('finalizeReviewedStage',finish);assert.equal(result.txraw,reference);reviewedSources++;
    if(row.operation==='make')parentsForChildren.set(result.txid,{prepare,sigs});
    else{
      const first=parentsForChildren.get(parent.id);assert.ok(first,'Missing matching synthetic make stage');
      const chain=structuredClone(first.prepare);
      chain.request.inputs=[sourceUtxos.map(item=>{const copy={...item};
        assert.equal(item.txId,parent.id,'All dependent inputs must consume the finalized make transaction');
        for(const name of ['txId','script','satoshis','preTx','ancestorTransactions'])delete copy[name];return copy;})];
      chain.request.outputs=[tx.outputs.map(o=>({satoshis:o.satoshis,script:o.script.toHex()}))];
      const sourceStage=await call('prepareReviewedStage',chain);
      const finalized=await call('finalizeReviewedStage',{stage:sourceStage,signatures:first.sigs});
      assert.notEqual(finalized.txid,new tbc.Transaction(chain.request.sourceTxraw).id,'Signed parent must change the provisional ID');
      const second={...chain,transactionIndex:1,previousTransactions:[finalized.txraw]};
      const childStage=await call('prepareReviewedStage',second);
      const child=await call('finalizeReviewedStage',{stage:childStage,signatures:sigs});
      assert.equal(child.txraw,reference,'Dependent controller proof must use the signed parent');
      const checked=new tbc.Transaction(child.txraw),signedParent=new tbc.Transaction(finalized.txraw);
      checked.inputs.forEach((input,i)=>{assert.equal(input.prevTxId.toString('hex'),signedParent.id);
        input.output=signedParent.outputs[input.outputIndex];assert.equal(checked.verifyScript(i).success,true);reviewedVmInputs++;});reviewedChildren++;
      for(const mutate of [p=>{p.outputs[0].satoshis++;},p=>{p.outputs[0].setScript(tbc.Script.fromASM('OP_TRUE'));}]){
        const badParent=new tbc.Transaction(finalized.txraw);mutate(badParent);
        await assert.rejects(()=>call('prepareReviewedStage',{...second,previousTransactions:[badParent.uncheckedSerialize()]}));childNegatives++;
      }
    }
  }
  if(sdkFee===row.fee)exactSdkRaw++;
  const actualBytes=Buffer.from(row.raw,'hex').length;
  assert.ok(actualBytes<=row.maximumSignedBytes);assert.ok(row.fee>=Math.max(80,Math.ceil(actualBytes*80/1000)));
  assert.equal(row.inputs.reduce((s,i)=>s+i.satoshis,0)-tx.outputs.reduce((s,o)=>s+o.satoshis,0),row.fee);
  reports.push({profile:row.profile,market:row.market,side:row.side,operation:row.operation,lock:tx.nLockTime,actualBytes,
    maximumSignedBytes:row.maximumSignedBytes,fee:row.fee,sdkFee});
}
assert.equal(vmInputs,96);
if(runtime){assert.equal(reviewedSources,36);assert.equal(reviewedChildren,18);assert.equal(reviewedVmInputs,54);assert.equal(childNegatives,36);}
const report={status:'LOP_TOKEN_SOURCE_PASS',commit,pinnedFiles:Object.keys(sources).length,
  transactions:rows.length,vmInputs,exactSdkRaw,reports,externalRequests:0,broadcasts:0,
  reviewedSources,reviewedChildren,reviewedVmInputs,childNegatives,...(runtime?{runtime:runtime.evidence}:{}),
  publicEngineMethodsExercised:false,deviceAcceptance:false};
const reportPath=runtime?join(runtime.directory,'lop-token-reviewed-report.json'):undefined;
if(reportPath)writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({...report,reportPath}));
