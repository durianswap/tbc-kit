import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import {build} from 'esbuild';
import {materializeCheckpoints} from '../../../scripts/lib/lifecycle-conformance.mjs';

const root=new URL('../../../',import.meta.url).pathname;
const require=createRequire(import.meta.url);
async function compile(reference=false){
 let scans=0;
 const compiled=await build({entryPoints:[root+'packages/core/src/index.ts'],bundle:true,platform:'node',format:'cjs',write:false,
  plugins:[{name:'count-canonical-work',setup(builder){builder.onLoad({filter:/canonical-json\.ts$/},async({path})=>{
   let contents=await readFile(path,'utf8');
   assert(contents.includes('function assertUnicodeScalars(value: string): void {'),'scan probe must be installed');
   contents=contents.replace('function assertUnicodeScalars(value: string): void {','function assertUnicodeScalars(value: string): void { __countCanonicalScans();');
   if(reference){
    assert(contents.includes('const reusable = ownedJsonValues.has(value);'),'reference must actually disable reuse');
    contents=contents.replace('const reusable = ownedJsonValues.has(value);','const reusable = false;');
   }
   return {contents,loader:'ts'};
  });}}]});
 const module={exports:{}};
 vm.runInThisContext(`(function(require,module,exports,__countCanonicalScans){${compiled.outputFiles[0].text}\n})`)(require,module,module.exports,()=>scans++);
 return {api:module.exports,reset:()=>{scans=0},scans:()=>scans};
}
const vectors=JSON.parse(await readFile(root+'test-vectors/checkpoints.json','utf8'));
const planning=materializeCheckpoints(vectors).find(x=>x.id==='planning').checkpoint;

test('only Core-owned immutable JSON reuses canonical bytes; digest checks still execute',async()=>{
 const measured=await compile(),{api}=measured;
 const owned=api.createCheckpoint(planning.payload);
 assert.deepEqual(owned,planning);
 const first=api.canonicalize(owned.payload);measured.reset();
 assert.equal(api.canonicalize(owned.payload),first);
 assert.equal(api.hashCanonical(owned.payload),planning.checkpointHash);
 assert.equal(measured.scans(),0,'the same internal immutable tree must not repeat Unicode/string serialization work');
 let digestCalls=0;const {createHash}=await import('node:crypto');
 api.configureSha256Backend(bytes=>{digestCalls++;return new Uint8Array(createHash('sha256').update(bytes).digest())});digestCalls=0;
 api.hashCanonical(owned.payload);api.hashCanonical(owned.payload);assert.equal(digestCalls,2,'reuse canonical bytes, not a stale hash/authorization decision');
});

test('caller freeze, getters, mutable copies and proxies cannot forge cache ownership',async()=>{
 const {api,reset,scans}=await compile(),owned=api.createCheckpoint(planning.payload);
 for(const foreign of [structuredClone(owned.payload),Object.freeze(structuredClone(owned.payload)),new Proxy(owned.payload,{})]){
  api.canonicalize(foreign);reset();api.canonicalize(foreign);assert(scans()>0);
 }
 const child={amount:1},frozen=Object.freeze({child});
 const before=api.hashCanonical(frozen);child.amount=2;assert.notEqual(api.hashCanonical(frozen),before);
 let n=0;const getter=Object.freeze({get amount(){return ++n}});
 assert.notEqual(api.hashCanonical(getter),api.hashCanonical(getter));
 const wrapper={stable:owned.payload,recipient:'one'};const original=api.hashCanonical(wrapper);
 wrapper.recipient='two';assert.notEqual(api.hashCanonical(wrapper),original);
 const forged=structuredClone(owned);forged.payload.memory.chainSnapshot.payload.parents[0].rawTransaction='ab';
 assert.throws(()=>api.verifyCheckpoint(Object.freeze(forged),planning.payload.release),e=>e.code==='CHECKPOINT_HASH_MISMATCH');
});

test('cached subtrees preserve exact transition identities and rejection outcomes versus full traversal',async()=>{
 const optimized=(await compile()).api,reference=(await compile(true)).api;
 assert.deepEqual(Object.keys(optimized).sort(),Object.keys(reference).sort(),'no new public API');
 const payload=structuredClone(planning.payload);
 payload.memory.chainSnapshot.payload.parents[0].rawTransaction='ab'.repeat(53_255);
 payload.memory.chainSnapshot.snapshotHash=reference.hashCanonical(payload.memory.chainSnapshot.payload);
 let states=[optimized,reference].map(api=>api.createCheckpoint(payload));
 for(let i=0;i<12;i++){
  states=[optimized,reference].map((api,j)=>api.advanceCheckpoint(states[j],{
   ...states[j].payload,revision:String(BigInt(states[j].payload.revision)+1n),previousCheckpointHash:states[j].checkpointHash,
  },planning.payload.release));
  assert.deepEqual(states[0],states[1]);
  const identities=[optimized,reference].map((api,j)=>api.hashCanonical({domain:'tws-host-transition/1',transition:{kind:'continue',checkpoint:states[j]}}));
  assert.equal(identities[0],identities[1]);
 }
 for(const mutate of [p=>{p.contextHash='f'.repeat(64)},p=>{p.operationId='A'.repeat(43)},p=>{p.pendingCalls=[{callId:'B'.repeat(43)}]},p=>{p.memory.chainSnapshot.payload.parents[0].rawTransaction='\ud800'}]){
  const bad=structuredClone(planning.payload);mutate(bad);
  const result=[optimized,reference].map(api=>{try{api.createCheckpoint(bad);return 'accepted'}catch(e){return [e.name,e.code,e.message]}});
  assert.notEqual(result[0],'accepted');assert.deepEqual(result[0],result[1]);
 }
});

test('cache pressure only recomputes: large valid payloads remain accepted and hashes identical',async()=>{
 const {api}=await compile(),first=api.createCheckpoint(planning.payload),expected=first.checkpointHash;
 for(let i=0;i<24;i++){
  const payload=structuredClone(planning.payload);
  payload.memory.chainSnapshot.payload.parents[0].rawTransaction=(i%2?'ab':'cd').repeat(80_000+i);
  const owned=api.createCheckpoint(payload);assert.equal(api.hashCanonical(owned.payload),owned.checkpointHash);
 }
 assert.equal(api.hashCanonical(first.payload),expected);
});
