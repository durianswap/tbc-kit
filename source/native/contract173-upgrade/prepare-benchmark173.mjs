// New independent consumer only. No frozen source, key or release is modified.
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink,readdir,mkdir,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {sha256} from '../flutter/scripts/candidate-inputs.mjs';
const root=resolve(import.meta.dirname,'../..'),base=join(root,'native/flutter-dart-kit');
const [sdkArg,outArg,platform,candidateArg]=process.argv.slice(2),sdk=resolve(sdkArg),out=resolve(outArg),candidate=resolve(candidateArg);
assert(['ios','android'].includes(platform));assert.match(out,new RegExp(`^/private/tmp/tbc-dart-kit-f3-contract173-${platform}-bench-[a-z]+$`));
execFileSync(process.execPath,[join(base,'tool/prepare_consumer.mjs'),sdk,out,platform,'contract173',candidate],{cwd:root,stdio:'inherit'});
for(const file of await readdir(join(out,'assets')))if(!['native-hashes.json','dapp.html'].includes(file))await unlink(join(out,'assets',file));
const fixture=join(root,'native/flutter-dart-live-token-exploration/matched/dart/fixture.json');
const readFixture=join(root,'native/flutter-dart-live-token-exploration/matched/dart/mobile/benchmark_fixture.dart');
await copyFile(fixture,join(out,'assets/pilot.json'));await copyFile(readFixture,join(out,'lib/benchmark_fixture.dart'));
await copyFile(join(import.meta.dirname,'benchmark/main.dart'),join(out,'lib/main.dart'));
await mkdir(join(out,'assets/fixture-tls'));
execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','7','-config',join(root,'native/flutter-dart-token-exploration/js-reference/baseline/fixture-tls.conf'),
 '-keyout',join(out,'assets/fixture-tls/key.pem'),'-out',join(out,'assets/fixture-tls/cert.pem')],{stdio:'pipe'});
const pub=join(out,'pubspec.yaml');await writeFile(pub,(await readFile(pub,'utf8')).replace('    - assets/','    - assets/\n    - assets/fixture-tls/'));
const approvalFile=platform==='android'?'android/app/src/main/kotlin/io/tbc/dartkitf1/FixtureWallet.kt':'ios/Runner/FixtureWallet.swift';
const old=platform==='android'?',250)':'.now()+0.25',next=platform==='android'?',200)':'.now()+0.2';
const source=await readFile(join(out,approvalFile),'utf8');assert.equal(source.split(old).length,2);
await writeFile(join(out,approvalFile),source.replace(old,next));
const p=JSON.parse(await readFile(join(out,'consumer-provenance.json')));
p.candidate['FixtureWallet.'+(platform==='android'?'kt':'swift')]=sha256(await readFile(join(out,approvalFile)));
p.benchmark={mainSha256:sha256(await readFile(join(out,'lib/main.dart'))),fixtureSha256:sha256(await readFile(fixture)),
 transportSha256:sha256(await readFile(readFixture)),consentDelayMs:200,readDelayMs:5,scope:'Frozen P5 synthetic TBC20 exact bytes/fees, current full production Dart/native host. Pinned loopback TLS only; no broadcast. Binary messenger timing wrapper records metadata only.'};
await writeFile(join(out,'consumer-provenance.json'),JSON.stringify(p,null,2)+'\n');
console.log(JSON.stringify({status:'MATCHED_BENCHMARK_PREPARED',out,platform,benchmark:p.benchmark}));
