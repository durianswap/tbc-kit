#!/usr/bin/env node
// Independent pinned SDK oracle: local Code/Tape/lock computations only.
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
const built=await build({stdin:{contents:`export * from './lib/util/poolnft3/artifacts.ts';export * from './lib/util/poolnft3/authorization.ts';export * from './lib/contract/ftlpTbc20.ts';`,resolveDir:upstream,loader:'ts'},
  bundle:true,write:false,metafile:true,platform:'node',format:'cjs',target:'node22',external:['tbc-lib-js'],logLevel:'silent'});
const sources={};
for(const name of Object.keys(built.metafile.inputs)){
  if(name==='<stdin>')continue;const p=resolve(name),rel=relative(upstream,p);assert.ok(!rel.startsWith('..'));
  const bytes=readFileSync(p);assert.deepEqual(bytes,execFileSync('git',['-C',upstream,'show',`${commit}:${rel}`],{maxBuffer:4*1024*1024}));sources[rel]=sha(bytes);
}
const module={exports:{}};
runInThisContext(`(function(module,exports,require){${built.outputFiles[0].text}\n})`)(module,module.exports,name=>{
  assert.ok(['tbc-lib-js','tbc-lib-js/lib/util/partial-sha256','crypto','node:crypto'].includes(name),`unexpected oracle dependency: ${name}`);return deps(name);
});
const sdk=module.exports,tbc=deps('tbc-lib-js'),lp=sdk.FTLPTBC20;
for(const name of ['pool','pool_hash_lock','ftlp_tbc20','ftlp_tbc20_locktime']){
  const artifact=sdk.getPool3Artifact(name),manifest=sdk.POOL3_ARTIFACT_MANIFEST.artifacts[name];
  assert.equal(sha(artifact.lock.hex),manifest.templateSha256);
  assert.equal(readFileSync(new URL(`../rust/crates/tbc-engine-core/src/protocols/amm-${name}-template.hex`,import.meta.url),'utf8').trim(),artifact.lock.hex);
}
const cases=[];
function add(op,input,call){let expected;try{expected={ok:true,value:call()};}catch{expected={ok:false};}cases.push({op,input,expected});}
const hex=(n,v)=>Buffer.alloc(n,v).toString('hex'),b=h=>Buffer.from(h,'hex');
const pk='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const member=tbc.crypto.Hash.sha256ripemd160(b(pk)).toString('hex');
const lists=[null,[hex(20,1)],[hex(20,3),hex(20,1),hex(20,2)],[1,2,3,4,5].map(v=>hex(20,v)),[],[hex(20,1),hex(20,1)],Array.from({length:6},(_,i)=>hex(20,i))];
for(const controllers of lists)for(const size of [61,66,127]){
  const input={original:hex(36,0x12),fee:hex(32,0x34),size,controllers};
  add('pool',input,()=>{
    const raw=sdk.instantiatePoolCode({originalUTXO:b(input.original),tbcFeeScriptHash:b(input.fee),ftTapeSize:size,
      authorization:controllers===null?{kind:'public'}:{kind:'controller',controllerPubKeyHashes:controllers}}).toBuffer();
    const parsed=sdk.parsePoolCode(raw);assert.equal(parsed.poolCodeHash.toString('hex'),sha(raw));
    return{hash:sha(raw),size:raw.length,controllers:parsed.authorization.kind==='public'?null:parsed.authorization.controllerPubKeyHashes};
  });
}
for(const timelocked of [false,true])for(const size of [60,61,65,66,127,128])for(const tag of [0,1,2]){
  const input={poolHash:hex(32,0x56),controller:hex(20,0x78)+tag.toString(16).padStart(2,'0'),size,timelocked};
  add('lp',input,()=>{
    const raw=lp.instantiateCode({poolCodeHash:b(input.poolHash),controller:b(input.controller),tapeSize:size,timelocked}).toBuffer();
    const parsed=lp.parseCode(raw),replacement=lp.replaceController(raw,b(hex(20,0x99)+'01')).toBuffer();
    assert.deepEqual(lp.getCodeIdentity(replacement),parsed.identity);
    return{hash:sha(raw),size:raw.length,identity:parsed.identity.toString('hex'),replacementHash:sha(replacement)};
  });
}
for(const timelocked of [false,true])for(const size of [61,66,127])for(const lockTime of [0,829999,500000000,4294967295]){
  const input={timelocked,size,lockTime,amounts:['0','1','9223372036854775807','3','4','5']};
  add('tape',input,()=>{
    const raw=lp.buildTape({timelocked,tapeSize:size,lockTime,amounts:input.amounts.map(BigInt)}).toBuffer();
    const parsed=lp.parseTape(raw,{timelocked,tapeSize:size});
    return{hex:raw.toString('hex'),balance:parsed.balance.toString()};
  });
}
for(const locks of [[],[0],[0,123,124],[0,500000000,4294967295],[123,500000000]])
  add('requiredLock',{locks},()=>lp.getRequiredLockTime(locks));
for(const [timelocked,lockTime,txLock,sequence] of [[false,0,0,4294967295],[true,0,0,4294967295],[true,0,0,4294967294],
  [true,829999,829999,4294967294],[true,829999,829998,4294967294],[true,829999,500000000,4294967294],
  [true,500000000,500000000,4294967294],[true,500000000,499999999,4294967294],[true,4294967295,4294967295,0]]){
  add('inputLock',{timelocked,lockTime,txLock,sequence},()=>{
    const tape=lp.buildTape({amounts:[0n,0n,0n,0n,0n,0n],tapeSize:66,timelocked,lockTime});
    const tx=new tbc.Transaction();tx.nLockTime=txLock;tx.inputs.push({sequenceNumber:sequence});
    lp.verifyInputLock(tx,0,tape,{timelocked,tapeSize:66});return true;
  });
}
for(const [controllers,key] of [[[member],pk],[[member,hex(20,1)],pk],[[hex(20,1)],pk],[null,pk],[[member],'02'+hex(32,255)]])
  add('controller',{controllers,key},()=>{sdk.assertPoolControllerPublicKey(controllers===null?{kind:'public'}:{kind:'controller',controllerPubKeyHashes:controllers},b(key));return true;});
const fixture={upstream:{commit,sources,manifest:sdk.POOL3_ARTIFACT_MANIFEST},cases};
if(mode==='--emit-fixture')process.stdout.write(JSON.stringify(fixture,null,2)+'\n');
else{assert.deepEqual(JSON.parse(readFileSync(new URL('../rust/fixtures/amm-code.json',import.meta.url))),fixture);
  console.log(`AMM_CODE_UPSTREAM_PASS ${cases.length} codec/identity/lock/controller cases; no HTTP/signing/broadcast`);}
