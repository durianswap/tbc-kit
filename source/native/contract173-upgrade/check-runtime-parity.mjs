// Compare the freshly built source C ABI and WASM with the tested Rust wire.
// Public synthetic fixtures only. No wallet, network, transport or broadcast.
import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../..'),rust=join(root,'packages/tbc-engine/rust');
const sha=b=>createHash('sha256').update(b).digest('hex');
const filters=['eight_explicit_public_amm_creates_bind_funded_continuation_and_match_sdk',
  ...(process.argv.includes('--full')?['explicit173_public_business_lifecycle_matches_sdk_and_binding']:[])];
const wire=[];
for(const filter of filters){
const run=spawnSync('cargo',['test','--offline','--locked','-p','tbc-engine-core','--test','amm_public',filter,'--','--nocapture'],
  {cwd:rust,env:{...process.env,AMM_DUMP_WIRE:'1'},encoding:'utf8',maxBuffer:128*1024*1024});
assert.equal(run.status,0,'public Engine fixture failed');
wire.push(...run.stdout.split('\n').filter(s=>s.startsWith('AMM_WIRE:')).map(s=>JSON.parse(s.slice(9))));
}
assert(wire.length>0&&wire.length%2===0);
const methods={normalizeRequestParams:'normalizeRequest',planParams:'plan',validateParams:'validate',finalizeParams:'finalize'};
const cases=[];
for(let i=0;i<wire.length;i+=2){
  const method=methods[wire[i].definition];assert(method);
  cases.push({lane:'engine',name:`${wire[i].value.request?.intent?.type??'engine'}-${i/2}`,method,input:wire[i].value,expected:{ok:true,result:wire[i+1].value}});
}
const fixtures=JSON.parse(await readFile(join(rust,'fixtures/amm-explicit173-lifecycle.json')));
const raw=id=>({txid:id,rawTransaction:fixtures.raws[id]});
for(const row of fixtures.cases){
  for(const [kind,action,point]of [
    ['genesis',null,row.genesisId],
    ['add',{kind:'addTbc',amount:'100000',initialFtAmount:'200000'},row.genesisId],
    ['buy',{kind:'buy',amount:'10000'},row.actions[0].txid],
    ['sell',{kind:'sell',amount:'1000'},row.actions[1].txid],
    ['remove',{kind:'remove',amount:'10000'},row.actions[2].txid],
  ]){
    const input={phase:'describe',poolGenesis:raw(row.genesisId),ftGenesis:raw(row.ftGenesisId),currentPool:raw(point),
      publicKey:'0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      ...(row.controlled?{controllerPublicKey:'02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'}:{}),
      ...(action?{action}:{})};
    cases.push({lane:'keyless',method:'inspectAmmMaterial',name:row.label+'-'+kind,input,feePolicy:{...row.rates,feeAddress:row.feeAddress}});
  }
}
const instances={};
for(const lane of ['engine','keyless']){
  const module=await WebAssembly.compile(await readFile(join(rust,`target/wasm32-unknown-unknown/release/tbc_${lane}_wasm.wasm`)));
  assert.equal(WebAssembly.Module.imports(module).length,0);
  instances[lane]=(await WebAssembly.instantiate(module,{})).exports;
}
function wasm(lane,method,input){
  const e=instances[lane],prefix=`tbc_${lane}_wasm_`,m=Buffer.from(method),data=Buffer.from(JSON.stringify(input));
  const mp=e[prefix+'alloc'](m.length),ip=e[prefix+'alloc'](data.length);
  try{
    new Uint8Array(e.memory.buffer,mp,m.length).set(m);new Uint8Array(e.memory.buffer,ip,data.length).set(data);
    const r=e[prefix+'call'](mp,m.length,ip,data.length);
    try{return JSON.parse(Buffer.from(e.memory.buffer,e[prefix+'result_ptr'](r),e[prefix+'result_len'](r)).toString());}
    finally{e[prefix+'free_result'](r);}
  }finally{e[prefix+'free_input'](mp,m.length);e[prefix+'free_input'](ip,data.length);}
}
const ffi=`import ctypes,json,sys
class Buffer(ctypes.Structure):
 _fields_=[('ptr',ctypes.POINTER(ctypes.c_ubyte)),('len',ctypes.c_size_t),('cap',ctypes.c_size_t)]
libs={}
for lane in ['engine','keyless']:
 lib=ctypes.CDLL(sys.argv[1]+'/libtbc_'+lane+'_native.dylib'); fn=getattr(lib,'tbc_'+lane+'_call'); free=getattr(lib,'tbc_'+lane+'_free')
 fn.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_void_p,ctypes.c_size_t];fn.restype=Buffer;free.argtypes=[Buffer];free.restype=None;libs[lane]=(fn,free)
results=[]
for item in json.load(sys.stdin):
 fn,free=libs[item['lane']]; m=item['method'].encode(); data=json.dumps(item['input'],separators=(',',':')).encode();r=fn(m,len(m),data,len(data))
 try:results.append(json.loads(ctypes.string_at(r.ptr,r.len)))
 finally:free(r)
json.dump(results,sys.stdout,separators=(',',':'))
`;
const native=JSON.parse(execFileSync('python3',['-c',ffi,join(rust,'target/release')],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:128*1024*1024}));
const summary=[];const descriptors=[];
for(const [i,c]of cases.entries()){
  const result=wasm(c.lane,c.method,c.input);
  assert.deepEqual(result,native[i],c.name+' Native/WASM');
  if(c.expected) {
    assert.equal(result.ok,true);assert.deepEqual(result.result,c.expected.result,c.name+' tested source');
  } else {
    assert.equal(result.error,undefined,c.name);assert.deepEqual(result.feePolicy,c.feePolicy,c.name);
    assert.equal(result.lpPlan,undefined);assert.equal(result.serviceFeeRate,undefined);
    descriptors.push({name:c.name,input:c.input,result});
  }
  summary.push({name:c.name,lane:c.lane,method:c.method,resultSha256:sha(JSON.stringify(result))});
}
const artifacts={};
for(const lane of ['engine','keyless'])for(const path of [`target/release/libtbc_${lane}_native.dylib`,`target/wasm32-unknown-unknown/release/tbc_${lane}_wasm.wasm`]){
  const bytes=await readFile(join(rust,path));artifacts[path]={sha256:sha(bytes),bytes:bytes.length};
}
const suffix=process.argv.includes('--full')?'-full':'';
await writeFile(join(import.meta.dirname,`runtime-parity${suffix}.json`),JSON.stringify({status:'SOURCE_RUNTIME_PARITY_PASS',scope:'Desktop source C ABI/WASM; not mobile installed or chain acceptance',artifacts,cases:summary,http:0,broadcasts:0},null,2)+'\n',{flag:'wx'});
await writeFile(join(import.meta.dirname,`explicit173-descriptors${suffix}.json`),JSON.stringify({status:'PAIRED_NATIVE_WASM',artifacts,cases:descriptors},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'SOURCE_RUNTIME_PARITY_PASS',checks:summary.length,keylessDescriptors:descriptors.length,artifacts}));
