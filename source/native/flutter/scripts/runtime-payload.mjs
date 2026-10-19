// Source identity and executable identity are separate. No runtime fallback.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function verifiedRuntimePayload(resource,provenance){
 const source=await readFile(join(resource,'private-kit.js'));
 assert.ok(source.length>0&&source.length<=32*1024*1024);
 assert.equal(sha(source),provenance.sourceSha256,'Runtime source digest');
 if(provenance.executionPayload===undefined)return {
  kind:'javascript-source',file:'private-kit.js',sha256:provenance.sourceSha256,
  bytes:source.length,sourceSha256:provenance.sourceSha256,bytecodeVersion:0,
 };
 const p=provenance.executionPayload;
 assert.equal(p.kind,'hermes-bytecode');assert.equal(p.file,'private-kit.hbc');
 assert.equal(p.sourceSha256,provenance.sourceSha256);
 assert.match(p.compilerSha256,/^[a-f0-9]{64}$/);assert.equal(p.compilerSha256,provenance.compilerSha256);
 // Two explicit build profiles, so frozen baseline candidates remain verifiable.
 assert.ok([['-O','-emit-binary'],['-O','-emit-binary','-g0']]
  .some(flags=>JSON.stringify(flags)===JSON.stringify(p.compilerFlags)),
  'Unsupported Hermes compiler profile');
 assert.ok(Number.isSafeInteger(p.bytecodeVersion)&&p.bytecodeVersion>0&&p.bytecodeVersion<=0xffffffff);
 const bytes=await readFile(join(resource,p.file));
 assert.ok(bytes.length>=12&&bytes.length<=32*1024*1024);assert.equal(bytes.length,p.bytes);
 assert.equal(bytes.readBigUInt64LE(0),0x1f1903c103bc1fc6n,'Executable Hermes magic');
 assert.equal(bytes.readUInt32LE(8),p.bytecodeVersion,'Declared bytecode version');
 assert.equal(sha(bytes),p.sha256);assert.equal(p.sha256,provenance.bytecodeSha256);
 return {...p};
}
export async function hermesDebuggerFlags(buildDirectory){
 const cache=await readFile(join(buildDirectory,'CMakeCache.txt'),'utf8');
 const value=cache.match(/^HERMES_ENABLE_DEBUGGER:BOOL=(ON|OFF)$/m)?.[1];
 assert.ok(value,'Hermes header ABI must match the fixed library');
 return value==='ON'?['-DHERMES_ENABLE_DEBUGGER']:[];
}
export function runtimePayloadDefines(payload){
 return [`-DTBC_FLUTTER_RUNTIME_PAYLOAD_FILE="${payload.file}"`,
  `-DTBC_FLUTTER_RUNTIME_PAYLOAD_SHA256="${payload.sha256}"`,
  `-DTBC_FLUTTER_HBC_VERSION=${payload.bytecodeVersion}`];
}
