// Generates a new private runtime resource and provenance, not a released app.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {buildFlutterRuntime} from './runtime-build.mjs';
import {configuredFlutterPeerModules} from './build-tools.mjs';
const args=process.argv.slice(2);assert.equal(args.length,4,'EXTRACTED_KIT HERMESC PEER_MODULES NEW_OUTPUT');
const [kit,compiler,peerModules,out]=args.map((p,i)=>i===2&&p==='-'?configuredFlutterPeerModules():resolve(p));
await mkdir(out);
const built=await buildFlutterRuntime({kit,peerModules});
await writeFile(join(out,'private-kit.js'),built.source);
// Keep the source/provenance outside the app; runtime debug tables are not used
// by the bridge. Preserve function names and all optimized executable code.
const compilerFlags=['-O','-emit-binary','-g0'];
// Hermes records its source filename in bytecode. Pass a stable relative name
// from the isolated output directory, never the maintainer's absolute path.
const compile=spawnSync(compiler,[...compilerFlags,'-out','private-kit.hbc','private-kit.js'],
  {cwd:out,encoding:'utf8',maxBuffer:64*1024*1024});
await writeFile(join(out,'compiler.log'),String(compile.stdout??'')+String(compile.stderr??''));
assert.equal(compile.status,0,'Hermes compile failed; inspect compiler.log');
const sha=b=>createHash('sha256').update(b).digest('hex');
const bytecode=await readFile(join(out,'private-kit.hbc'));
assert.equal(bytecode.readBigUInt64LE(0),0x1f1903c103bc1fc6n);
for (const localPath of [kit,out,resolve(import.meta.dirname,'../../..')]) {
  assert.ok(!built.source.includes(localPath), 'Private runtime source embeds a build-machine path');
  assert.ok(!bytecode.includes(Buffer.from(localPath)), 'Hermes bytecode embeds a build-machine path');
}
const executionPayload={kind:'hermes-bytecode',file:'private-kit.hbc',sha256:sha(bytecode),bytes:bytecode.length,
  sourceSha256:built.sha256,bytecodeVersion:bytecode.readUInt32LE(8),compilerSha256:sha(await readFile(compiler)),compilerFlags};
await writeFile(join(out,'runtime-provenance.json'),JSON.stringify({status:'BUILT_NOT_DEVICE_ACCEPTED',kit:built.kitIdentity.version,kitIdentity:built.kitIdentity,
  sourceSha256:built.sha256,bytecodeSha256:executionPayload.sha256,executionPayload,
  compilerSha256:sha(await readFile(compiler)),dependencyLockSha256:sha(await readFile(resolve(import.meta.dirname,'../runtime/package-lock.json'))),
  buildScriptSha256:sha(await readFile(join(import.meta.dirname,'runtime-build.mjs'))),
  transforms:['React Native hermes-stable Babel preset', 'WHATWG URL 14.2.0 async iterator fallback intrinsic for transformed generators; parser unchanged', 'UTF-8 only without legacy encoding index tables', 'brorand Node randomBytes uses platform CSPRNG; Buffer 6.0.3 pinned locally with BigInt uint64 support'],
  inputs:built.sources,deviceAcceptance:false,realChainAcceptance:false,
  limitations:['Platform scheduling/ownership and plugin binding remain to be integrated and validated.',
    'UTF-8 only; encoding index tables deliberately omitted. Pinned polyfills require dependency/license review before release.',
    'No private key, permission grant, API response, fixed account or fixture clock is bundled.']},null,2)+'\n');
console.log(JSON.stringify({out,status:'BUILT_NOT_DEVICE_ACCEPTED',sourceBytes:Buffer.byteLength(built.source),sha256:built.sha256}));
