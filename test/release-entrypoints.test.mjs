import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root));
const json=p=>JSON.parse(read(p));
const current=json('release/current.json');
const frozen=json('release/candidates/coin-local-reuse/delivery/delivery-lock.json');

test('default JS and Native downloads use the accepted RC18 bytes',()=>{
 for(const [id,file]of [['kit','tbc-kit-0.1.0-rc.18.tgz'],['sdk-ios','ios-sdk-0.1.0-rc.18.native.2.tgz'],['sdk-android','android-sdk-0.1.0-rc.18.native.2.tgz']]){
  const artifact=current.artifacts.find(a=>a.id===id),expected=frozen.artifacts[file];
  assert.equal(artifact.sha256,expected.sha256);
  assert.equal(artifact.bytes,expected.bytes);
  assert.equal(createHash('sha256').update(read(artifact.path)).digest('hex'),expected.sha256);
 }
 assert.equal(json('packages/kit/package.json').version,frozen.kitVersion);
 assert.equal(current.pairing.kitVersion,frozen.kitVersion);
 assert.equal(current.pairing.sdkVersion,frozen.nativeSdkVersion);
 assert.equal(current.pairing.protocolFingerprint,frozen.protocolFingerprint);
});

test('Flutter remains independently paired and unchanged',()=>{
 assert.equal(current.pairing.flutterIsIndependentPairedDistribution,true);
 assert.equal(current.artifacts.find(a=>a.id==='flutter').sha256,'f782b21ff2aa5d069669ae080615bde083e45006e5536a98b11233025d322b7f');
 assert(!current.artifacts.some(a=>a.id.startsWith('resources-')),'Unpaired old raw-library alias');
});

test('landing and install guide identify the selected pair',()=>{
 for(const p of ['README.md','docs/installation.md','docs/native.md']){
  const text=read(p).toString();
  assert(text.includes(frozen.kitVersion));
  assert(text.includes(frozen.nativeSdkVersion));
 }
 assert(read('docs/coin-multiround.md').toString().includes('constraints.inputOutpoints'));
});
