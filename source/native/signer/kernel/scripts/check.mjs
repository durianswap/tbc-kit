import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWasmDigestSigner} from '../wasm/adapter.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const reportPath=process.argv[2]??join(root,'artifacts/common-vector-evidence.json');
const vectors=JSON.parse(readFileSync(join(root,'fixtures/common-vectors.json'),'utf8')).vectors;
const wasmPath=process.argv[3]??join(root,'artifacts/wasm/tbc_signer_kernel.wasm');
const nativePath=process.argv[4]??join(root,`artifacts/native/${process.arch==='arm64'?'aarch64':'x86_64'}-apple-darwin/libtbc_signer_kernel.dylib`);
const schnorr=JSON.parse(readFileSync(join(root,'fixtures/schnorr-vector.json'),'utf8'));
const module=await WebAssembly.compile(readFileSync(wasmPath));
assert.deepEqual(WebAssembly.Module.imports(module),[],'kernel must not import a network, wallet or host key API');
const signer=await createWasmDigestSigner(module);
let wasmChecks=0;
const schnorrKey=Uint8Array.from(Buffer.from(schnorr.scalar,'hex'));
assert.equal(await signer.signDigest(schnorr.digest,schnorrKey,'schnorr64'),schnorr.signature);
assert.equal(Buffer.from(schnorrKey).toString('hex'),schnorr.scalar);wasmChecks++;
schnorrKey.fill(0);
await assert.rejects(signer.signDigest(schnorr.digest,schnorrKey,'schnorr64'));wasmChecks++;
for(const vector of vectors){
 const scalar=Uint8Array.from(Buffer.from(vector.scalar,'hex'));
 for(const [encoding,key] of [['compact64','compact64'],['compact65-recoverable','compact65']]){
  assert.equal(await signer.signDigest(vector.digest,scalar,encoding),vector[key],vector.name);
  assert.equal(Buffer.from(scalar).toString('hex'),vector.scalar,'custody input ownership');
  wasmChecks++;
 }
 scalar.fill(0);
}
for(const scalar of [new Uint8Array(32),new Uint8Array(32).fill(255),new Uint8Array(31)]){
 await assert.rejects(signer.signDigest('11'.repeat(32),scalar,'compact64'));wasmChecks++;
}
await assert.rejects(signer.signDigest('bad',new Uint8Array(32).fill(3),'compact64'));wasmChecks++;
await assert.rejects(signer.signDigest('11'.repeat(32),new Uint8Array(32).fill(3),'der'));wasmChecks++;
const python=String.raw`
import ctypes,json,sys
lib=ctypes.CDLL(sys.argv[1]);lib.tbc_signer_kernel_version.restype=ctypes.c_uint32
assert lib.tbc_signer_kernel_version()==1
fn=lib.tbc_signer_sign_digest
fn.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_size_t]
fn.restype=ctypes.c_int32
count=0
fixture=json.load(sys.stdin)
v=fixture['schnorr'];out=(ctypes.c_ubyte*64)()
assert fn(bytes.fromhex(v['digest']),32,bytes.fromhex(v['scalar']),32,164,out,64)==0
assert bytes(out).hex()==v['signature'];count+=1
assert fn(bytes.fromhex(v['digest']),32,b'\x00'*32,32,164,out,64)==2
assert bytes(out)==b'\x00'*64;count+=1
for v in fixture['vectors']:
    key=bytearray.fromhex(v['scalar']);digest=bytes.fromhex(v['digest'])
    secret=(ctypes.c_ubyte*32).from_buffer(key)
    for size in [64,65]:
        out=(ctypes.c_ubyte*size)()
        assert fn(digest,32,secret,32,size,out,size)==0
        assert bytes(out).hex()==v['compact'+str(size)]
        assert key.hex()==v['scalar']
        count+=1
    key[:]=b'\x00'*32
for key in [b'\x00'*32,b'\xff'*32]:
    out=(ctypes.c_ubyte*64)(*([255]*64))
    assert fn(b'\x11'*32,32,key,32,64,out,64)==2
    assert bytes(out)==b'\x00'*64
    count+=1
out=(ctypes.c_ubyte*64)()
assert fn(b'\x11'*32,31,b'\x03'*32,32,64,out,64)==1
count+=1
print(json.dumps({'checks':count}))
`;
const native=JSON.parse(execFileSync('python3',['-c',python,nativePath],{input:JSON.stringify({vectors,schnorr}),encoding:'utf8',maxBuffer:2*1024*1024}));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const report={scope:'Public fixed scalars only; no live wallet, approval, signer account, transaction POST or broadcast',vectorPairs:vectors.length,wasmChecks,nativeChecks:native.checks,totalChecks:wasmChecks+native.checks,wasmImports:[],artifacts:{wasm:{path:wasmPath,sha256:hash(wasmPath)},native:{path:nativePath,sha256:hash(nativePath)},vectors:{path:join(root,'fixtures/common-vectors.json'),sha256:hash(join(root,'fixtures/common-vectors.json'))}},productionActivated:false,pluginActivated:false};
mkdirSync(dirname(reportPath),{recursive:true});writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({totalChecks:report.totalChecks,wasmChecks,nativeChecks:native.checks,reportPath}));
