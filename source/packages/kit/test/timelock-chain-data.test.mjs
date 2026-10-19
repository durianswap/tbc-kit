import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const built=await build({stdin:{contents:`export * from './packages/kit/src/default-chain-data.ts';
 export {inspectTbcTransaction} from './packages/kit/src/testnet-validation.ts';
 export {chainDataRequirement} from './packages/core/src/index.ts';
 export {createTbcClient} from './packages/kit/src/client.ts';`,resolveDir:root,loader:'ts'},
 alias:{'@tbc-wallet/core':`${root}packages/core/src/index.ts`},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const kit=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const account={chainId:'tbc:testnet',address:'1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',accountId:'tbc:testnet:1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
 publicKey:'0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'};
function code(height,owner='751e76e8199196d454941c45d1b3a323f1433bd6'){
 const n=Buffer.alloc(4);n.writeUInt32LE(height);return `76a914${owner}88ad56ba01247f778104ffffffff819e518804${n.toString('hex')}8152ba81a15187`;
}
function fixture(height=829999,owner){
 const output=`102700000000000035${code(height,owner)}`;
 const raw=`0a00000001${'11'.repeat(32)}0000000000ffffffff02${output}${output}00000000`;
 const parsed=kit.inspectTbcTransaction(raw);return {id:parsed.txid,raw,parsed:parsed.transaction};
}
function setup(minimum='0'){
 let tx=fixture(),rows,reads=[],nativeReads=0;let reenter;
 const reset=()=>{rows=[0,1].map(index=>({txid:tx.id,index:String(index),value:'10000',height:'829999'}));};reset();
 const client={getUtxos:async()=>{nativeReads++;throw new Error('Unlock must not fetch native fee candidates');},
   api:{nodeInfo:async()=>{reads.push('tip');return {blocks:'830000',bestblockhash:'aa'.repeat(32)};},
     timelockUtxosByAddress:async()=>{reads.push('index');if(reenter)await reenter();return {utxos:rows};}},
   getRawTransactionBytes:async id=>{reads.push('raw');assert.equal(id,tx.id);return tx.raw;},
   getRawTransaction:async id=>{reads.push('decoded');assert.equal(id,tx.id);return {txid:id,rawTransaction:tx.raw,confirmations:'2',inputs:tx.parsed.inputs,
     outputs:tx.parsed.outputs.map((o,vout)=>({vout,satoshis:o.satoshis.toString(),scriptPubKey:Buffer.from(o.scriptPubKey).toString('hex')}))};}};
 const resolver=kit.createDefaultTbcChainDataResolver({accounts:{current:async()=>[account]},client,confirmationPolicy:{minConfirmations:minimum},
   now:()=>Date.parse('2026-09-29T12:00:00Z'),snapshotId:()=> 'timelock-test-snapshot'});
 return {resolver,reads,get rows(){return rows;},set rows(v){rows=v;},get nativeReads(){return nativeReads;},
   get point(){return {txid:tx.id,vout:0};},get allPoints(){return [0,1].map(vout=>({txid:tx.id,vout}));},
   changeScript(height,owner){tx=fixture(height,owner);reset();},delay(fn){reenter=fn;}};
}
function params(points){const request={intent:{type:'tbc-timelock-unlock',version:'1.0'},constraints:{inputOutpoints:points}};
 return {version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement:kit.chainDataRequirement(request)};}
test('timelock reuses one direct parent for sibling deposits and retains only immutable bytes',async()=>{
 const run=setup(),request=params(run.allPoints);
 const first=await run.resolver.resolve(request,account);assert.ok(first.snapshotHash,JSON.stringify(first));
 assert.equal(first.payload.utxos.length,2);assert.equal(first.payload.parents.length,1);
 assert.deepEqual(run.reads,['tip','index','raw']);run.reads.length=0;
 assert.ok((await run.resolver.resolve(request,account)).snapshotHash);
 assert.deepEqual(run.reads,['tip','index']);assert.equal(run.nativeReads,0);
});
test('timelock confirmation refresh is shared by siblings and cannot come from retained raw',async()=>{
 const run=setup('1');assert.ok((await run.resolver.resolve(params(run.allPoints),account)).snapshotHash);
 run.rows=run.rows.map(({height,...r})=>r);run.reads.length=0;
 assert.ok((await run.resolver.resolve(params(run.allPoints),account)).snapshotHash);
 assert.deepEqual(run.reads,['tip','index','decoded']);
});
test('timelock snapshots selected outpoints before asynchronous index reads',async()=>{
 const run=setup(),request=structuredClone(params([run.point]));
 run.delay(async()=>{request.requirement.inputOutpoints[0].vout=1;});
 const result=await run.resolver.resolve(request,account);
 assert.ok(result.snapshotHash,JSON.stringify(result));assert.equal(result.payload.utxos[0].vout,0);
 assert.deepEqual(run.reads,['tip','index','raw']);
});
test('timelock client helpers use the common send and sign methods with exact inputs',async()=>{
 const calls=[],provider={async request(call){calls.push(call);return call.method==='tbc_requestAccounts'?[account.address]:{};},
   on(){},removeListener(){},destroy(){}};
 const wallet=await kit.createTbcClient({network:'testnet',provider}).connect();
 const points=[{txid:'11'.repeat(32),vout:1}];
 await wallet.timelock.lock({amount:'10000',lockTime:'830001',constraints:{maxFee:'100'}});
 await wallet.timelock.unlock({inputOutpoints:points,constraints:{maxFee:'100'}});
 await wallet.walletBuild.sign({intent:{type:'tbc-timelock-unlock',version:'1.0'},constraints:{inputOutpoints:points}});
 assert.deepEqual(calls.slice(1).map(c=>c.method),['tbc_sendTransaction','tbc_sendTransaction','tbc_signTransaction']);
 assert.deepEqual(calls[1].params.intent,{type:'tbc-timelock-lock',version:'1.0',amount:'10000',lockTime:'830001'});
 assert.deepEqual(calls[2].params.intent,{type:'tbc-timelock-unlock',version:'1.0'});
 assert.deepEqual(calls[2].params.constraints,{maxFee:'100',inputOutpoints:points});
 assert.deepEqual(calls[3].params.constraints.inputOutpoints,points);
 assert.ok(calls.slice(1).every(c=>c.params.chainId==='tbc:testnet'));
});
test('timelock rejects unavailable or mismatched deposits and unsupported/immature locks',async()=>{
 for(const scenario of ['absent','value','duplicate','future','owner','timestamp','height']){
   const run=setup();
   if(scenario==='future')run.changeScript(830001);
   if(scenario==='timestamp')run.changeScript(1700000000);
   if(scenario==='owner')run.changeScript(829999,'00'.repeat(20));
   const request=params([run.point]);
   if(scenario==='absent')run.rows=[];
   if(scenario==='value')run.rows=[{...run.rows[0],value:'10001'}];
   if(scenario==='duplicate')run.rows=[run.rows[0],run.rows[0]];
   if(scenario==='height')run.rows=[{...run.rows[0],height:'830001'}];
   const result=await run.resolver.resolve(request,account);assert.ok(result.portError,scenario);
   assert.equal(run.nativeReads,0);
 }
 const run=setup();const request=structuredClone(params([run.point]));delete request.requirement.inputOutpoints;
 assert.ok((await run.resolver.resolve(request,account)).portError);assert.deepEqual(run.reads,[]);
});
