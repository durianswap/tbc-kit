// Build-time verification only. Page resources remain separate from the private
// VM. Nothing here authorizes a document, selects an account or loads page code.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {verifiedKitCandidate} from './candidate-inputs.mjs';
import {sourcePath} from './webview-source-identity.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const privileged=/(?:\/host\/|\/engine\/|\/wallet\.js$|native-driver|wallet-runtime|private-host|sqlite|custody)/;
export async function verifiedWebViewPage(arg,runtime,kitArg){
  if(!arg)return null;
  assert.ok(kitArg,'Pinned Kit directory required for page source verification');
  const kit=resolve(kitArg),root=resolve(import.meta.dirname,'../../..');
  const directory=resolve(arg),manifestBytes=await readFile(join(directory,'page-provenance.json'));
  const manifest=JSON.parse(manifestBytes),bytes=await readFile(join(directory,'tbc-webview-page.js'));
  assert.equal(manifest.schema,2,'Portable page source identity required');
  assert.ok(runtime.kitIdentity,'Private Kit identity required');
  assert.deepEqual(await verifiedKitCandidate(kit),runtime.kitIdentity,'Pinned Kit source differs from private VM');
  assert.equal(runtime.kit,runtime.kitIdentity.version);
  for(const key of ['artifactId','protocolFingerprint','rustSourceSha256','manifestSha256']){
    assert.match(runtime.kitIdentity[key]??'',/^[a-f0-9]{64}$/,`Private Kit ${key}`);
  }
  assert.deepEqual(manifest.kitIdentity,runtime.kitIdentity,'Page/private Kit build identity mismatch');
  assert.equal(manifest.kit,runtime.kit,'Page/private Kit version mismatch');
  assert.equal(manifest.privilegedRuntime,false);assert.equal(manifest.signer,false);
  assert.ok(bytes.length>0&&bytes.length<=2*1024*1024,'Bounded page resource');
  assert.equal(bytes.length,manifest.bytes);assert.equal(sha(bytes),manifest.sha256,'Page resource digest');
  assert.equal(manifest.generatorSha256,sha(await readFile(new URL('./prepare-webview-page.mjs',import.meta.url))),'Page generator changed');
  assert.equal(manifest.bootstrapExtractorSha256,sha(await readFile(new URL('./legacy-page-bootstrap.mjs',import.meta.url))),'Page bootstrap extractor changed');
  assert.equal(manifest.sourceIdentitySha256,sha(await readFile(new URL('./webview-source-identity.mjs',import.meta.url))),'Page source identity changed');
  assert.ok(manifest.sources&&Object.keys(manifest.sources).length>0,'Page source provenance required');
  for(const [id,hash] of Object.entries(manifest.sources)){
    assert.equal(sha(await readFile(sourcePath(root,kit,id))),hash,'Page input changed');
  }
  assert.ok(Array.isArray(manifest.retainedSources)&&manifest.retainedSources.length>0);
  for(const id of manifest.retainedSources){
    assert.equal(typeof id,'string');
    assert.ok(!privileged.test(id),'Privileged module retained in page');
    assert.ok(Object.hasOwn(manifest.sources,id),'Retained input lacks source digest');
  }
  return {bytes,manifestBytes,identity:{file:'tbc-webview-page.js',kit:manifest.kit,kitIdentity:manifest.kitIdentity,
    sha256:manifest.sha256,bytes:bytes.length,provenanceSha256:sha(manifestBytes)}};
}
