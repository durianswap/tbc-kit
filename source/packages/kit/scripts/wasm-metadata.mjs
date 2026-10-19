import assert from 'node:assert/strict';

// Only remove the optional debugging name section. Retain every other section
// byte-for-byte, including executable code, data, producers and target features.
export function stripWasmNameSection(input) {
  const bytes=Buffer.from(input);
  const before=new WebAssembly.Module(bytes);
  const kept=[bytes.subarray(0,8)];
  let pos=8;
  const uint=()=>{
    let value=0;
    for(let shift=0;shift<35;shift+=7){
      assert.ok(pos<bytes.length,'Truncated WASM length');
      const b=bytes[pos++];value+=(b&127)*2**shift;
      if(!(b&128)){assert.ok(value<=0xffffffff);return value;}
    }
    throw Error('Invalid WASM length');
  };
  while(pos<bytes.length){
    const start=pos,id=bytes[pos++],length=uint(),end=pos+length;
    assert.ok(end<=bytes.length,'Truncated WASM section');
    let name;
    if(id===0){const size=uint();assert.ok(pos+size<=end);name=bytes.subarray(pos,pos+size).toString('utf8');}
    if(name!=='name')kept.push(bytes.subarray(start,end));
    pos=end;
  }
  const output=Buffer.concat(kept),after=new WebAssembly.Module(output);
  assert.deepEqual(WebAssembly.Module.imports(after),WebAssembly.Module.imports(before));
  assert.deepEqual(WebAssembly.Module.exports(after),WebAssembly.Module.exports(before));
  return output;
}
