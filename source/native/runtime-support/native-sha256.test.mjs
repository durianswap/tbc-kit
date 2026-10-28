import test from 'node:test';import assert from 'node:assert/strict';import{createHash}from'node:crypto';
import{createNativeSha256Backend}from'./native-sha256.mjs';
test('native SHA adapter preserves byte view offset and exact digest; never mutates source',()=>{
 const calls=[];const backend=createNativeSha256Backend((buffer,offset,length)=>{calls.push({buffer,offset,length});return new Uint8Array(createHash('sha256').update(new Uint8Array(buffer,offset,length)).digest());});
 for(const size of [0,3,63,64,65,4096,65536,1048576]){
  const padded=Uint8Array.from({length:size+13},(_,i)=>i%251),before=padded.slice(),view=padded.subarray(7,7+size);
  assert.deepEqual(backend(view),new Uint8Array(createHash('sha256').update(view).digest()));assert.deepEqual(padded,before);assert.equal(calls.at(-1).offset,7);assert.equal(calls.at(-1).length,size);assert.equal(calls.at(-1).buffer,padded.buffer);
 }
});
test('native backend failures do not silently fall back or accept wrong output',()=>{
 assert.throws(()=>createNativeSha256Backend(null));assert.throws(()=>createNativeSha256Backend(()=>new Uint8Array(31))(new Uint8Array()));
 assert.throws(()=>createNativeSha256Backend(()=>Array(32).fill(0))(new Uint8Array()));
 assert.throws(()=>createNativeSha256Backend(()=>{throw Error('native-failure')})(new Uint8Array()),/native-failure/);
 assert.throws(()=>createNativeSha256Backend(()=>new Uint8Array(32))([1,2]));
});
