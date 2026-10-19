// Preserve the already-frozen local5 archives, never rebuild or relabel them.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,copyFile,constants} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {schnorr} from '@noble/curves/secp256k1.js';
const [sourceArg,destinationArg]=process.argv.slice(2);
assert.ok(sourceArg&&destinationArg&&process.argv.length===4);
const source=resolve(sourceArg),out=resolve(destinationArg),sha=b=>createHash('sha256').update(b).digest('hex');
const bytes=await readFile(join(source,'delivery.json'));
assert.equal(sha(bytes),'55477509d6c1db9b9959cb40573cceb7e28628851b42ab42bc0560fc28c4897f');
const delivery=JSON.parse(bytes);
assert.equal(delivery.sdkVersion,'0.1.0-local.5');assert.equal(delivery.status,'LOCAL_CANDIDATE_NOT_PUBLISHED');
assert.equal(delivery.artifactSetId,'b1e6fa0d78a85b4702eabea52aa16cfae74fbfee82c90edb37142218c9fd0bfd');
assert.deepEqual(Object.keys(delivery.assets).sort(),['android-signer.tgz','apple-signer.tgz','signer-source.tgz','wasm-signer.tgz']);
const extracted=await mkdtemp(join(tmpdir(),'tbc-signer-local5-archive-'));
const roots={};let identityHash;
for(const [name,asset] of Object.entries(delivery.assets)){
 const file=join(source,name),content=await readFile(file);assert.equal(content.length,asset.bytes);assert.equal(sha(content),asset.sha256);
 const entries=execFileSync('tar',['-tzf',file],{encoding:'utf8'}).trim().split('\n');
 for(const p of entries){assert.ok(!p.startsWith('/')&&!p.split('/').includes('..'));}
 const listing=execFileSync('tar',['-tvzf',file],{encoding:'utf8'}).trim().split('\n');
 assert.ok(listing.every(line=>['-','d'].includes(line[0])),'No archive links or special files');
 const dir=join(extracted,name.slice(0,-4));await mkdir(dir);execFileSync('tar',['-xzf',file,'-C',dir]);roots[name]=dir;
 const idBytes=await readFile(join(dir,'identity.json')),id=JSON.parse(idBytes);
 identityHash??=sha(idBytes);assert.equal(sha(idBytes),identityHash);
 assert.equal(id.sdkVersion,delivery.sdkVersion);assert.equal(id.artifactSetId,delivery.artifactSetId);
}
const identity=JSON.parse(await readFile(join(roots['wasm-signer.tgz'],'identity.json')));
let sourceChecks=0;
for(const [file,hash] of Object.entries(identity.sourceHashes)){
 const relative=/^(apple|android)\//.test(file)?file:`kernel/${file}`;
 assert.equal(sha(await readFile(join(roots['signer-source.tgz'],'source',relative))),hash,relative);sourceChecks++;
}
const wasmDir=join(roots['wasm-signer.tgz'],'wasm'),wasm=await readFile(join(wasmDir,'tbc_signer_kernel.wasm'));
assert.equal(sha(wasm),delivery.common.artifacts.wasm.sha256);
const aar=join(roots['android-signer.tgz'],'maven-repository/io/tbc/local/signer',delivery.sdkVersion,`signer-${delivery.sdkVersion}.aar`);
assert.equal(sha(await readFile(aar)),delivery.consumer.aarSha256);
const {createWasmDigestSigner}=await import(pathToFileURL(join(wasmDir,'adapter.mjs')));
const signer=await createWasmDigestSigner(wasm);
const vectorBytes=await readFile(join(roots['signer-source.tgz'],'source/kernel/fixtures/common-vectors.json'));
assert.equal(sha(vectorBytes),delivery.common.artifacts.vectors.sha256);
let signatureChecks=0;
for(const v of JSON.parse(vectorBytes).vectors){
 const scalar=Uint8Array.from(Buffer.from(v.scalar,'hex'));
 try{
  assert.equal(await signer.signDigest(v.digest,scalar,'compact64'),v.compact64);signatureChecks++;
  assert.equal(await signer.signDigest(v.digest,scalar,'compact65-recoverable'),v.compact65);signatureChecks++;
 }finally{scalar.fill(0);}
}
// Public scalar 1, zero digest: independent BIP340 verification of the actual
// extracted WASM, not a production account or wallet-approved transaction.
const scalar=new Uint8Array(32);scalar[31]=1;
try{const sig=await signer.signDigest('00'.repeat(32),scalar,'schnorr64');
 assert.equal(schnorr.verify(sig,'00'.repeat(32),schnorr.getPublicKey(scalar)),true);signatureChecks++;
}finally{scalar.fill(0);}
await assert.rejects(()=>signer.signDigest('00'.repeat(32),new Uint8Array(32),'compact64'));
await assert.rejects(()=>signer.signDigest('00',new Uint8Array(32),'compact64'));
await assert.rejects(()=>signer.signDigest('00'.repeat(32),new Uint8Array(32),'unknown'));
await mkdir(out); // Fails if present; frozen delivery must never be overwritten.
for(const name of ['delivery.json',...Object.keys(delivery.assets)]){
 await copyFile(join(source,name),join(out,name),constants.COPYFILE_EXCL);
 assert.equal(sha(await readFile(join(out,name))),sha(await readFile(join(source,name))));
}
const report={status:'PASS_PRESERVED_LOCAL5',deliverySha256:sha(bytes),identitySha256:identityHash,artifactSetId:delivery.artifactSetId,
 sourceChecks,signatureChecks,negativeChecks:3,wasmSha256:sha(wasm),aarSha256:delivery.consumer.aarSha256,
 acceptanceScriptSha256:sha(await readFile(new URL(import.meta.url))),
 limits:['Original device reports retained, not rerun','Public fixed scalar signatures only; no custody or chain acceptance','No artifact rebuild, release, deployment or source/license certification'],
 broadcasts:0,realKeys:false};
const reportBytes=JSON.stringify(report,null,2)+'\n';await writeFile(join(out,'preservation-report.json'),reportBytes,{flag:'wx'});
console.log(JSON.stringify({out,extracted,...report,reportSha256:sha(reportBytes)}));
