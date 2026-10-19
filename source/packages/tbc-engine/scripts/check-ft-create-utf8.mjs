import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [candidatePath,vectorsPath,reportPath]=process.argv.slice(2);
assert(candidatePath&&vectorsPath&&reportPath,'CANDIDATE_ROOT VECTORS REPORT required');
globalThis.fetch=async()=>{throw new Error('Network disabled for controlled regression');};
const root=resolve(candidatePath), engineRoot=join(root,'packages/tbc-engine');
const load=p=>import(pathToFileURL(join(root,p)).href);
const core=await load('packages/core/dist/esm/index.js');
const provider=await load('packages/provider/dist/esm/index.js');
const {createTbcEngine}=await load('packages/tbc-engine/dist/esm/index.js');
const {createWasmTbcEngineBackend}=await load('packages/tbc-engine/dist/esm/wasm.js');
const nativePath=join(engineRoot,'artifacts/native/aarch64-apple-darwin/libtbc_engine_native.dylib');
const wasmPath=join(engineRoot,'artifacts/wasm/tbc_engine_wasm.wasm');
const backend=await createWasmTbcEngineBackend(readFileSync(wasmPath));
const facade=createTbcEngine({backend});
const vectors=JSON.parse(readFileSync(vectorsPath,'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const cases=[],checks=[];
const add=(id,method,input,expected,accepted=true)=>cases.push({id,method,input:core.canonicalize(input),params:input,expected,accepted});
for(const sample of vectors.accepted){
 for(const kind of ['create','sameMetadataTransfer']){
  const v=sample[kind], p=v.planInput;
  assert(core.isValidTws('transactionRequest',p.request));
  assert.deepEqual(provider.assertTbcProviderMethodParams('tbc_signTransaction',p.request),p.request);
  checks.push({id:sample.id+'/'+kind,kind:'core-provider-schema',accepted:true});
  if(kind==='create'){assert.equal(p.request.intent.name,sample.name);assert.equal(p.request.intent.symbol,sample.symbol);}
  const id=sample.id+'/'+kind;
  add(id+'/normalize','normalizeRequest',{version:'1.0',request:p.request},{request:p.request,requestHash:p.requestHash});
  add(id+'/plan','plan',p,v.planned);
  add(id+'/validate-plan','validate',{...p,phase:'plan',plan:v.planned.plan},{valid:true,violations:[]});
  const pre={...v.finalizeStages[0].input,phase:'pre-sign'};delete pre.signatures;
  add(id+'/validate-pre-sign','validate',pre,{valid:true,violations:[]});
  for(const [i,stage] of v.finalizeStages.entries()){
   add(id+'/finalize-'+i,'finalize',stage.input,stage.expected);
   const validation={...stage.input,phase:'finalized',...(stage.expected.bundle?{bundle:stage.expected.bundle}:{pending:stage.expected})};
   add(id+'/validate-finalized-'+i,'validate',validation,{valid:true,violations:[]});
  }
 }
}
for(const sample of vectors.rejected){
 assert.equal(core.isValidTws('transactionRequest',sample.params.request),sample.schemaAccepted,sample.id);
 if(sample.schemaAccepted)assert.deepEqual(provider.assertTbcProviderMethodParams('tbc_signTransaction',sample.params.request),sample.params.request);
 else assert.throws(()=>provider.assertTbcProviderMethodParams('tbc_signTransaction',sample.params.request));
 checks.push({id:sample.id,kind:'core-provider-schema',accepted:sample.schemaAccepted});
 add(sample.id,'normalizeRequest',sample.params,sample.expectedError,false);
}
const python=`import ctypes,json,sys
class Buffer(ctypes.Structure):
 _fields_=[('ptr',ctypes.POINTER(ctypes.c_ubyte)),('len',ctypes.c_size_t),('cap',ctypes.c_size_t)]
lib=ctypes.CDLL(sys.argv[1]);lib.tbc_engine_call.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_void_p,ctypes.c_size_t];lib.tbc_engine_call.restype=Buffer
lib.tbc_engine_free.argtypes=[Buffer];lib.tbc_engine_free.restype=None
results=[]
for c in json.load(sys.stdin):
 m=c['method'].encode();d=c['input'].encode();mb=ctypes.create_string_buffer(m);db=ctypes.create_string_buffer(d)
 r=lib.tbc_engine_call(mb,len(m),db,len(d))
 try: results.append(json.loads(ctypes.string_at(r.ptr,r.len).decode()))
 finally: lib.tbc_engine_free(r)
json.dump(results,sys.stdout,separators=(',',':'))
`;
const native=JSON.parse(execFileSync('python3',['-c',python,nativePath],{input:JSON.stringify(cases.map(({method,input})=>({method,input}))),encoding:'utf8',maxBuffer:64*1024*1024}));
for(const [i,c] of cases.entries()){
 const wasm=JSON.parse(await backend.call(c.method,c.input));
 assert.deepEqual(native[i],wasm,c.id+' native/WASM');assert.equal(wasm.ok,c.accepted,c.id);
 if(c.accepted){
  assert.deepEqual(wasm.result,c.expected,c.id+' source fixture');
  try { assert.deepEqual(await facade[c.method](c.params),c.expected,c.id+' exact WASM facade'); }
  catch(error) { throw new Error(c.id+' exact WASM facade failed',{cause:error}); }
 }else{
  assert.deepEqual(wasm.error,c.expected,c.id+' rejection');
  const schemaAccepted=core.isValidTws('normalizeRequestParams',c.params);
  await assert.rejects(async()=>facade[c.method](c.params),e=>e.code==='INVALID_REQUEST'&&e.rustCode===(schemaAccepted?'INVALID_INPUT':undefined),c.id+' facade rejection');
 }
 checks.push({id:c.id,kind:'native-wasm-and-facade',accepted:c.accepted,resultSha256:sha(core.canonicalize(wasm))});
}
for(const value of [{a:1}, {text:'\u5e01-tws'}, {a:[1,true,null]}, {nested:{a:'x',b:'y'}}]){
 const digest=sha(core.canonicalize(value));assert.equal(core.hashCanonical(value),digest);assert.equal(core.hashCanonical(structuredClone(value)),digest);
}
assert.throws(()=>core.hashCanonical({value:NaN}));assert.throws(()=>core.hashCanonical({value:undefined}));assert.throws(()=>core.utf8('\ud800'));
const bad=structuredClone(vectors.accepted[0].create.planInput.request);bad.intent.symbol='\ud800';assert.throws(()=>provider.assertTbcProviderMethodParams('tbc_signTransaction',bad));
const versions=Object.fromEntries(['core','provider','tbc-engine'].map(n=>[n,JSON.parse(readFileSync(join(root,'packages',n,'package.json'),'utf8')).version]));
const report={versions,release:core.TWS_RELEASE,releaseFingerprint:core.TWS_RELEASE_FINGERPRINT,positiveMetadataCases:vectors.accepted.length,negativeMetadataCases:vectors.rejected.length,checks,checksPassed:checks.length,nativeSha256:sha(readFileSync(nativePath)),wasmSha256:sha(readFileSync(wasmPath)),publicVectorsSha256:sha(readFileSync(vectorsPath)),hashAndEncodingChecksPassed:12,boundary:vectors.boundary,realKeys:false,realWalletSigner:false,realSignatures:false,transactionPost:false,broadcast:false,deviceAcceptance:false};
writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({versions,checksPassed:checks.length,positiveMetadataCases:report.positiveMetadataCases,negativeMetadataCases:report.negativeMetadataCases,releaseFingerprint:report.releaseFingerprint}));
