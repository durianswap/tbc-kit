// Isolated simulator acceptance only. Pins the code-signed binary after proving
// it is the verified candidate with Apple signature metadata changed, not a new
// implementation. No runtime hash check is bypassed; no frozen files are edited.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,copyFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {sha256} from '../flutter/scripts/candidate-inputs.mjs';
import {verifiedDartNativeCandidate} from './dart-native-candidate.mjs';
const [consumerArg,candidateArg]=process.argv.slice(2);
assert(consumerArg&&candidateArg,'CONSUMER PAIRED_NATIVE_CANDIDATE');
const consumer=resolve(consumerArg),candidate=resolve(candidateArg);
assert.match(consumer,/^\/private\/tmp\/tbc-dart-kit-f3-(?:contract173-ios-(?:(?:live|bench|network)-)?[a-z]+|legacy-ios-\d{8}-[a-z]+)$/);
const sealPath=join(consumer,'ios-signed-consumer.json');
try{await access(sealPath);throw Error('Already sealed');}catch(e){if(e.code!=='ENOENT')throw e;}
const m=await verifiedDartNativeCandidate(candidate),p=JSON.parse(await readFile(join(consumer,'consumer-provenance.json')));
assert.equal(p.frozen,candidate);assert.equal(p.platform,'ios');
assert(p.publicFixtureOnly===true || (p.privateTestnetOnly===true && p.bundleId==='io.tbc.dartkit.contract173'));
assert.deepEqual(p.kitIdentity,m.kitIdentity);
const app=join(consumer,'build/ios/iphonesimulator/Runner.app');
assert.equal(execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',join(app,'Info.plist')],{encoding:'utf8'}).trim(),p.bundleId);
const rel='ios/Frameworks/TbcFlutterEngine.xcframework/ios-arm64-simulator/TbcFlutterEngine.framework/TbcFlutterEngine';
const before=join(candidate,rel),after=join(app,'Frameworks/TbcFlutterEngine.framework/TbcFlutterEngine');
const beforeHash=sha256(await readFile(before)),afterHash=sha256(await readFile(after));
assert.equal(beforeHash,m.artifacts[rel]);
execFileSync('codesign',['--verify','--strict',join(app,'Frameworks/TbcFlutterEngine.framework')]);
// Re-sign temporary standalone copies identically, so CodeResources and linker
// signature allocation do not affect comparison. Every other byte must match.
const temp=await mkdtemp('/private/tmp/tbc-contract173-ios-code-compare-'),normalized=[];
for(const [name,source]of [['source',before],['installed',after]]){
 const dest=join(temp,name);await copyFile(source,dest);
 execFileSync('codesign',['--remove-signature',dest]);
 execFileSync('codesign',['--force','--sign','-','--identifier','io.tbc.flutter.engine','--timestamp=none',dest]);
 normalized.push(sha256(await readFile(dest)));
}
assert.equal(normalized[0],normalized[1],'Signed App compute differs from verified source beyond Apple signing metadata');
const asset=join(app,'Frameworks/App.framework/flutter_assets/assets/native-hashes.json');
const hashes=JSON.parse(await readFile(asset));assert(hashes.engine.includes(beforeHash));
hashes.engine=[afterHash];await writeFile(asset,JSON.stringify(hashes));
for(const path of [join(app,'Frameworks/App.framework'),app])execFileSync('codesign',['--force','--sign','-','--timestamp=none',path]);
execFileSync('codesign',['--verify','--deep','--strict',app]);
assert.equal(sha256(await readFile(after)),afterHash,'Sealing changed engine bytes');
const report={status:'SIGNED_CONSUMER_PINNED_NOT_DEVICE_ACCEPTED',kitIdentity:m.kitIdentity,artifactId:m.artifactId,
 sourceSha256:beforeHash,installedSha256:afterHash,normalizedSha256:normalized[0],comparisonCopies:temp,
 runtimePinPreserved:true,publicFixtureOnly:p.publicFixtureOnly,privateTestnetOnly:p.privateTestnetOnly??false,broadcasts:0};
await writeFile(sealPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report));
