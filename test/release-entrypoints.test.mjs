import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root));
const json=p=>JSON.parse(read(p));
const current=json('release/current.json');
const frozen=json('release/candidates/lean-distribution-rc20/delivery-lock.json');

test('default downloads use the frozen RC20 JS and unchanged paired Native bytes',()=>{
 for(const [id,expected]of [['kit',frozen.kit],['sdk-ios',frozen.sdk['ios-sdk.tgz']],['sdk-android',frozen.sdk['android-sdk.tgz']]]){
  const artifact=current.artifacts.find(a=>a.id===id);
  assert.equal(artifact.sha256,expected.sha256);
  assert.equal(artifact.bytes,expected.bytes);
  assert.equal(createHash('sha256').update(read(artifact.path)).digest('hex'),expected.sha256);
 }
 assert.equal(json('packages/kit/package.json').version,frozen.kitVersion);
 assert.equal(json('package-lock.json').packages['packages/kit'].version,frozen.kitVersion);
 assert.equal(current.pairing.kitVersion,frozen.kitVersion);
 assert.equal(current.pairing.sdkVersion,frozen.sdkVersion);
 assert.equal(current.pairing.nativeBuildInputKitVersion,'0.1.0-rc.19');
 assert.equal(current.pairing.protocolFingerprint,frozen.protocolFingerprint);
});

test('Flutter remains independently paired and unchanged',()=>{
 assert.equal(current.pairing.flutterIsIndependentPairedDistribution,true);
 assert.equal(current.artifacts.find(a=>a.id==='flutter').sha256,'f782b21ff2aa5d069669ae080615bde083e45006e5536a98b11233025d322b7f');
 assert(!current.artifacts.some(a=>a.id.startsWith('resources-')),'Optional raw libraries must not enter the default install');
});

test('landing and install guide identify the selected pair',()=>{
 for(const p of ['README.md','docs/installation.md','docs/native.md']){
  const text=read(p).toString();
  assert(text.includes(frozen.kitVersion));
  assert(text.includes(frozen.sdkVersion));
 }
 assert(read('docs/coin-multiround.md').toString().includes('constraints.inputOutpoints'));
 const guide=read('docs/legacy-ft.md').toString();
 for(const field of ['preview.assetFlows','contractId','constraints.inputOutpoints','outputReview'])assert(guide.includes(field));
});
