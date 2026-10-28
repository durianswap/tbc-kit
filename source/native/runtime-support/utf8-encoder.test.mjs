import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const code=await readFile(new URL('./utf8-encoder.js',import.meta.url),'utf8');
test('private ASCII path has exact bytes, no native bridge, and no cached mutable result',()=>{
  let calls=0;const context={__encode:s=>{calls++;return new TextEncoder().encode(s)}};
  runInNewContext(code,context);const encoder=new context.TextEncoder();
  for(const s of ['',Array.from({length:128},(_,i)=>String.fromCharCode(i)).join(''),'a'.repeat(1048576)])
    assert.deepEqual([...encoder.encode(s)],[...new TextEncoder().encode(s)]);
  assert.equal(calls,0);
  const a=encoder.encode('abc');a[0]=0;assert.equal(encoder.encode('abc')[0],97);
});
test('Unicode is sent unchanged to existing platform fallback',()=>{
  const seen=[];const context={__encode:s=>{seen.push(s);return new TextEncoder().encode(s)}};
  runInNewContext(code,context);const encoder=new context.TextEncoder();
  for(const s of ['中文','é','\u{1f642}','\ud800','a\udc00b']) {
    assert.deepEqual([...encoder.encode(s)],[...new TextEncoder().encode(s)]);assert.equal(seen.at(-1),s);
  }
});
test('optional private ASCII primitive is exact and leaves Unicode on the existing codec',()=>{
  let nativeCalls=0,fallbackCalls=0;
  const context={Uint8Array,__encode:s=>{fallbackCalls++;return new TextEncoder().encode(s)},
    __tbcNativeEncodeAscii:s=>{nativeCalls++;return /[^\x00-\x7f]/.test(s)?undefined:new TextEncoder().encode(s)}};
  runInNewContext(code,context);const encoder=new context.TextEncoder();
  for(const s of ['', 'abc\0xyz',Array.from({length:128},(_,i)=>String.fromCharCode(i)).join(''),'a'.repeat(1048576)])
    assert.deepEqual(encoder.encode(s),new TextEncoder().encode(s));
  assert.equal(nativeCalls,4);assert.equal(fallbackCalls,0);
  for(const s of ['中文','é','\u{1f642}','\ud800','a\udc00b'])
    assert.deepEqual(encoder.encode(s),new TextEncoder().encode(s));
  assert.equal(fallbackCalls,5);
  const previous=encoder.encode('abc');previous[0]=0;assert.equal(encoder.encode('abc')[0],97);
});
test('malformed native byte containers and errors fail closed',()=>{
  for(const primitive of [()=>[],()=>new Uint8Array(1),()=>{throw Error('codec failed')}]){
    const context={Uint8Array,__tbcNativeEncodeAscii:primitive,__encode:()=>{throw Error('unexpected fallback')}};
    runInNewContext(code,context);assert.throws(()=>new context.TextEncoder().encode('abc'));
  }
});
