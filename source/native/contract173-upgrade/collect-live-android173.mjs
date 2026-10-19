// Read-only exact installed APK/report collection; no transaction replay.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {sha256} from '../flutter/scripts/candidate-inputs.mjs';
const consumer=resolve(process.argv[2]),out=resolve(process.argv[3]);
const adb='/Users/alex/Library/Android/sdk/platform-tools/adb',device='emulator-5554',bundle='io.tbc.dartkit.contract173';
const run=args=>execFileSync(adb,['-s',device,...args],{maxBuffer:64*1024*1024});
const provenance=JSON.parse(await readFile(join(consumer,'consumer-provenance.json')));
assert.equal(provenance.bundleId,bundle);assert.equal(provenance.privateTestnetOnly,true);
const path=run(['shell','pm','path',bundle]).toString().trim();assert.match(path,/^package:\/data\/app\/[^\n]+\/base.apk$/);
const installed=run(['exec-out','cat',path.slice(8)]),local=await readFile(join(consumer,'build/app/outputs/flutter-apk/app-release.apk'));
assert.equal(sha256(installed),sha256(local),'Installed APK differs');
const apk=join(consumer,'build/app/outputs/flutter-apk/app-release.apk');
const entries=execFileSync('unzip',['-Z1',apk],{encoding:'utf8'}).trim().split('\n');
assert(!entries.some(p=>p.includes('testnet-private.json')||p.includes('libtbc_f1_signer.so')||p.endsWith('/contract173.json')),'Fixture/private assets must not be bundled');
const packaged={};
for(const [entry,source]of [
 ['lib/arm64-v8a/libtbc_compute_native.so','android/app/src/main/jniLibs/arm64-v8a/libtbc_compute_native.so'],
 ['lib/arm64-v8a/libtbc_signer_kernel.so','android/app/src/main/jniLibs/arm64-v8a/libtbc_signer_kernel.so'],
 ['lib/arm64-v8a/libtbc_contract173_signer.so','android/app/src/main/jniLibs/arm64-v8a/libtbc_contract173_signer.so'],
 ['assets/tbc-kit/tbc-webview-page.js','android/app/src/main/assets/tbc-kit/tbc-webview-page.js']
]){
 packaged[entry]=sha256(execFileSync('unzip',['-p',apk,entry],{maxBuffer:32*1024*1024}));
 const original=sha256(await readFile(join(consumer,source)));
 if(entry.endsWith('/libtbc_contract173_signer.so') && packaged[entry]!==original){
  // AGP strips the test-only JNI helper. Reproduce only that packaging step
  // on an independent copy and require exact bytes; no runtime hash bypass.
  const temporary=await mkdtemp('/private/tmp/tbc-contract173-elf-proof-'),normalized=join(temporary,'signer.so');
  await copyFile(join(consumer,source),normalized);
  execFileSync('/Users/alex/Library/Android/sdk/ndk/27.1.12297006/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-strip',['--strip-unneeded',normalized]);
  assert.equal(packaged[entry],sha256(await readFile(normalized)),entry);
 }else assert.equal(packaged[entry],original,entry);
}
const report=JSON.parse(run(['exec-out','cat',`/data/user/0/${bundle}/files/live-report.json`]));
assert.equal(report.runId,provenance.liveHarness.runId);
const planBytes=await readFile(join(consumer,'assets/live-plan.json'));
assert.equal(sha256(planBytes),provenance.liveHarness.planSha256);assert.deepEqual(report.plan,JSON.parse(planBytes));
let journal;
await mkdir(out,{recursive:true});
if(report.status==='RETURNED_RECONCILIATION_REQUIRED'){
 const db=`/data/user/0/${bundle}/files/contract173-private-testnet/tbc-kit-broadcast.sqlite`;
 const snapshot=join(out,report.runId+'-journal.sqlite');
 // Production Android store uses journal_mode=DELETE. The one-shot driver is
 // terminal here; copy the same bytes twice to reject an in-flight mutation.
 const bytes=run(['exec-out','cat',db]);assert.equal(sha256(bytes),sha256(run(['exec-out','cat',db])));
 await writeFile(snapshot,bytes,{flag:'wx'});
 journal=JSON.parse(execFileSync('sqlite3',['-readonly','-json',snapshot,'SELECT txid,state,result_status FROM broadcast_intents;'],{encoding:'utf8'}));
 for(const t of report.result.value.transactions){const row=journal.find(j=>j.txid===t.txid);assert(row);assert.equal(row.state,'completed');assert.equal(row.result_status,'accepted');}
 assert(!journal.some(j=>j.state==='prepared'||j.state==='uncertain'));
}
const evidence={collectedAt:new Date().toISOString(),device,provenance,report,artifacts:{apkSha256:sha256(installed),apkBytes:installed.length,packaged},
 journal,
 scope:'Private Testnet current Dart WebView/worker and Kotlin custody/HTTPS broadcast. Release arm64 simulator App. Returned success still requires read-only chain/journal reconciliation; not physical-device/minimumOS proof.'};
await writeFile(join(out,report.runId+'.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,runId:report.runId,result:report.result,approvalDelta:report.approvalDelta,signatureDelta:report.signatureDelta}));
