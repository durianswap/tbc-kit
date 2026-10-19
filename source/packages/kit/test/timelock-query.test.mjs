import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const bundle=await build({stdin:{contents:`export * from './packages/kit/src/api.ts';
  export {createTbcClient} from './packages/kit/src/client.ts';`,resolveDir:root,loader:'ts'},
  alias:{'@tbc-wallet/core':`${root}packages/core/src/index.ts`},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const kit=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
function fixture(owner='751e76e8199196d454941c45d1b3a323f1433bd6',locks=[830010,829990]){
 const outputs=locks.map(height=>{const n=Buffer.alloc(4);n.writeUInt32LE(height);
   return `10270000000000003576a914${owner}88ad56ba01247f778104ffffffff819e518804${n.toString('hex')}8152ba81a15187`;});
 const raw=`0a00000001${'11'.repeat(32)}0000000000ffffffff02${outputs.join('')}00000000`;
 return {raw,id:kit.inspectTbcTransaction(raw).txid};
}
function setup(network='testnet',tx=fixture()){
 const reads=[];let rows=[0,1].map(index=>({txid:tx.id,index,value:10000,height:index===0?-1:829999})),tip=830000;
 let mutate;let raw=tx.raw;
 const fetch=async input=>{
   const u=new URL(String(input));assert.equal(u.origin,network==='testnet'?'https://api.tbcdev.org':'https://api.turingbitchain.io');
   reads.push(u.pathname);if(mutate)mutate();
   const data=u.pathname.endsWith('/nodeinfo')?{blocks:tip,bestblockhash:'aa'.repeat(32)}:
     u.pathname.includes('/frozenUtxo/')?{utxos:rows}:u.pathname.endsWith(tx.id)?{txraw:raw}:assert.fail('Unexpected endpoint');
   return new Response(JSON.stringify({code:200,data}));
 };
 const api=kit.createTbcOfficialApi({network,fetch});
 return {tx,api,fetch,reads,get rows(){return rows;},set rows(v){rows=v;},set tip(v){tip=v;},set raw(v){raw=v;},set mutate(v){mutate=v;}};
}
test('queries show immature and mature deposits, exact atomic units, one parent and fresh mutable state',async()=>{
 const run=setup(),reader=kit.createTimelockReader({api:run.api});assert.equal(run.reads.length,0);
 const first=await reader.listDeposits({address});
 assert.deepEqual(first.deposits.map(d=>[d.vout,d.amountAtomic,d.lockHeight,d.maturity,d.confirmations]),
   [[0,'10000','830010','locked','0'],[1,'10000','829990','mature','2']]);
 assert.equal(first.availability,'indexed-unspent');assert.equal(first.selection,'all-indexed');assert.equal(run.reads.length,3);
 assert.ok(Object.isFrozen(first.deposits[0]));
 run.reads.length=0;run.tip=830020;run.rows=run.rows.slice(0,1);
 const next=await reader.listDeposits({address});
 assert.equal(next.deposits.length,1);assert.equal(next.deposits[0].maturity,'mature');assert.equal(run.reads.length,2);
 assert.ok(run.reads.every(p=>!p.includes('/txraw/')));
 run.rows=[];run.reads.length=0;
 assert.deepEqual((await reader.listDeposits({address})).deposits,[]);assert.equal(run.reads.length,2);
});
test('bounded exact selection is copied before await; missing input does not silently fall back',async()=>{
 const run=setup(),reader=kit.createTimelockReader({api:run.api,maxDeposits:1});
 await assert.rejects(reader.listDeposits({address}),/bounded selection/);assert.equal(run.reads.length,2);
 run.reads.length=0;const input={address,inputOutpoints:[{txid:run.tx.id,vout:1}]};
 run.mutate=()=>{input.inputOutpoints[0].vout=0;};
 const observed=await reader.listDeposits(input);assert.equal(observed.deposits[0].vout,1);assert.equal(run.reads.length,3);
 run.mutate=undefined;
 await assert.rejects(reader.listDeposits({address,inputOutpoints:[{txid:run.tx.id,vout:2}]}),/unavailable/);
 const count=run.reads.length;
 await assert.rejects(reader.listDeposits({address,inputOutpoints:[]}),/selection/);
 assert.equal(run.reads.length,count);
});
test('forged parent/value/owner, duplicates, bad index heights and unsupported lock domains fail closed',async()=>{
 for(const issue of ['hash','value','owner','duplicate','height','domain']){
   const run=setup('testnet',issue==='owner'?fixture('00'.repeat(20)):issue==='domain'?fixture(undefined,[1700000000,829990]):fixture());
   if(issue==='hash')run.raw=run.tx.raw.slice(0,-8)+'01000000';
   if(issue==='value')run.rows=[{...run.rows[0],value:10001}];
   if(issue==='duplicate')run.rows=[run.rows[0],run.rows[0]];
   if(issue==='height')run.rows=[{...run.rows[0],height:830001}];
   await assert.rejects(kit.createTimelockReader({api:run.api}).listDeposits({address}),undefined,issue);
 }
});
test('missing confirmation metadata remains unknown without adding decode queries',async()=>{
 const run=setup();run.rows=run.rows.map(({height,...r})=>r);
 const result=await kit.createTimelockReader({api:run.api}).listDeposits({address});
 assert.ok(result.deposits.every(d=>d.confirmations===undefined));assert.equal(run.reads.length,3);
});
test('public client queries need no connection and inherit the selected network without eager reads',async()=>{
 for(const network of ['mainnet','testnet']){
   const run=setup(network);let connected=0;
   const client=kit.createTbcClient({network,api:{fetch:run.fetch},provider:{request(){connected++;throw new Error('No wallet request expected');},on(){},removeListener(){}}});
   assert.equal(run.reads.length,0);
   assert.equal((await client.timelock.listDeposits({address})).deposits.length,2);
   assert.equal(run.reads.length,3);assert.equal(connected,0);
 }
});
test('concurrent queries share immutable parent work without making failed raw or custom cache authoritative',async()=>{
 const run=setup(),reader=kit.createTimelockReader({api:run.api});
 const results=await Promise.all([reader.listDeposits({address}),reader.listDeposits({address})]);
 assert.equal(results.length,2);assert.equal(run.reads.filter(p=>p.includes('/txraw/')).length,1);
 const poisoned=kit.createTimelockReader({api:run.api,cache:{get(){return {txid:run.tx.id,rawTransaction:run.tx.raw.slice(0,-8)+'01000000'};},
   remember(){assert.fail('Wrong bytes must not be remembered');},size(){return {entries:1,hexCharacters:run.tx.raw.length};}}});
 await assert.rejects(poisoned.listDeposits({address}),/hash mismatch/);
 const retry=setup(),fresh=kit.createTimelockReader({api:retry.api});retry.raw=retry.tx.raw.slice(0,-8)+'01000000';
 await assert.rejects(fresh.listDeposits({address}),/hash mismatch/);
 retry.raw=retry.tx.raw;
 assert.equal((await fresh.listDeposits({address})).deposits.length,2);
});
