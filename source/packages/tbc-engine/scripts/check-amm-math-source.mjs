#!/usr/bin/env node
// Fixed upstream read-only oracle. Pure tape/quote calculations only; no key,
// HTTP, transaction construction or signing. Fixture emission is explicit.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import {resolve,join,relative,dirname} from 'node:path';
import {build} from 'esbuild';
const [upstreamArg,depsArg,mode]=process.argv.slice(2);
assert.ok(upstreamArg&&depsArg&&[undefined,'--emit-fixture'].includes(mode)&&process.argv.length<=5);
const upstream=resolve(upstreamArg),deps=createRequire(join(resolve(depsArg),'package.json'));
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986';
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(execFileSync('git',['-C',upstream,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),commit);
const libRoot=dirname(deps.resolve('tbc-lib-js/package.json'));
function tree(prefix=''){return readdirSync(join(libRoot,prefix),{withFileTypes:true}).flatMap(entry=>{
  if(['node_modules','.git'].includes(entry.name))return[];const p=join(prefix,entry.name);
  if(entry.isDirectory())return tree(p);assert.ok(entry.isFile());return[p];
}).sort();}
assert.equal(sha(tree().map(p=>p+'\0'+sha(readFileSync(join(libRoot,p)))+'\n').join('')),'b73c8b5996276584981fe5b14f04db3e4cce02c94e7a19cb2b0f64e37206c7e9');
const built=await build({stdin:{contents:`export * from './lib/util/poolnft3/tape.ts';export * from './lib/util/poolnft3/math.ts';export * from './lib/util/poolnft3/fees.ts';`,resolveDir:upstream,loader:'ts'},
  bundle:true,write:false,metafile:true,platform:'node',format:'cjs',target:'node22',external:['tbc-lib-js'],logLevel:'silent'});
const sources={};
for(const name of Object.keys(built.metafile.inputs)){
  if(name==='<stdin>')continue;
  const p=resolve(name),rel=relative(upstream,p);assert.ok(!rel.startsWith('..'));
  const bytes=readFileSync(p);assert.deepEqual(bytes,execFileSync('git',['-C',upstream,'show',`${commit}:${rel}`],{maxBuffer:4*1024*1024}));sources[rel]=sha(bytes);
}
const module={exports:{}};
runInThisContext(`(function(module,exports,require){${built.outputFiles[0].text}\n})`)(module,module.exports,name=>{
  assert.equal(name,'tbc-lib-js');return deps(name);
});
const sdk=module.exports;
const plain=x=>JSON.parse(JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v));
const M=(1n<<63n)-1n;
const empty={ftLpAmount:0n,ftAAmount:0n,tbcAmount:0n,poolValue:1500n};
const active={ftLpAmount:1000000n,ftAAmount:3000000n,tbcAmount:1000000n,poolValue:1002500n};
const skew={ftLpAmount:13n,ftAAmount:17n,tbcAmount:23n,poolValue:1531n};
const wide={ftLpAmount:M/4n,ftAAmount:M/4n,tbcAmount:M/4n,poolValue:M/4n+1500n};
const cases=[];
function add(op,input,call){let expected;try{expected={ok:true,value:plain(call())};}catch{expected={ok:false};}cases.push({op,input:plain(input),expected});}
for(let plan=1;plan<=6;plan++)for(const amount of [1n,285n,286n,999n,10000n,M])
  add('fees',{amount,plan},()=>sdk.calculateSwapFees(amount,sdk.resolveSwapFeePolicy(plan)));
for(const [state,budget] of [[empty,{incrementSat:100000n,firstFtAmountRaw:300000n}],[empty,{incrementFtRaw:10n}],
  [empty,{incrementSat:1n}],[active,{incrementSat:111n}],[active,{incrementFtRaw:333n}],
  [active,{incrementSat:1n}],[active,{incrementSat:100n,firstFtAmountRaw:30n}],
  [skew,{incrementSat:7n}],[skew,{incrementFtRaw:7n}],[wide,{incrementSat:123456789n}],
  [{...active,poolValue:1501n},{incrementSat:100n}],[{...wide,poolValue:M},{incrementSat:M}]])
  add('add',{state,budget},()=>sdk.quoteAddLP(state,budget));
for(const [state,amount] of [[active,1n],[active,1000n],[active,1000000n],[active,1000001n],[empty,1n],[skew,6n],[wide,123456n]])
  add('remove',{state,amount},()=>sdk.quoteRemoveLP(state,amount));
for(const op of ['buy','sell'])for(const [state,amount,plan,minimum] of [[active,10000n,1,0n],[active,10000n,6,0n],
  [active,1n,1,0n],[active,10000n,1,M],[active,3000000n,1,0n],[wide,123456789n,3,0n],[empty,10000n,1,0n]])
  add(op,{state,amount,plan,minimum},()=>op==='buy'?sdk.quoteSwapFT(state,amount,sdk.resolveSwapFeePolicy(plan),minimum):sdk.quoteSwapTBC(state,amount,sdk.resolveSwapFeePolicy(plan),minimum));
for(const plan of [0,7])add('fees',{amount:1000n,plan},()=>sdk.calculateSwapFees(1000n,sdk.resolveSwapFeePolicy(plan)));
add('fees',{amount:1000n,plan:1,rate:36},()=>sdk.calculateSwapFees(1000n,sdk.resolveSwapFeePolicy(1,36)));
add('fees',{amount:M+1n,plan:1},()=>sdk.calculateSwapFees(M+1n,sdk.resolveSwapFeePolicy(1)));
const tapes=[];
for(const locked of [false,true])for(const controlled of [false,true]){
  const fields={ftLpPartialHash:Buffer.alloc(32,0x11),ftLpCodeSize:128,ftAPartialHash:Buffer.alloc(32,0x22),ftACodeSize:32767,
    ftLpAmount:M,ftAAmount:1234567n,tbcAmount:7654321n,ftAContractId:Array.from({length:32},(_,i)=>i.toString(16).padStart(2,'0')).join(''),
    serviceFeeRate:35,lpPlan:1,withSwapHashLock:controlled,withLpLocktime:locked,withLpHashLock:controlled};
  const raw=sdk.encodePoolTape(fields);const decoded=sdk.decodePoolTape(raw);
  const changed=sdk.replacePoolTapeAmounts(raw,{ftLpAmount:1n,ftAAmount:2n,tbcAmount:3n});
  sdk.assertPoolTapeConfigurationUnchanged(raw,changed);
  tapes.push({hex:raw.toString('hex'),changedHex:changed.toString('hex'),variant:decoded.variant});
}
const policies=Array.from({length:6},(_,i)=>plain(sdk.resolveSwapFeePolicy(i+1)));
const fixture={upstream:{commit,sources},cases,tapes,policies};
if(mode==='--emit-fixture')process.stdout.write(JSON.stringify(fixture,null,2)+'\n');
else{assert.deepEqual(JSON.parse(readFileSync(new URL('../rust/fixtures/amm-math.json',import.meta.url))),fixture);
  console.log(`AMM_UPSTREAM_PASS ${cases.length} quote/fee cases, ${tapes.length} exact tapes; no HTTP/signature/broadcast`);}
