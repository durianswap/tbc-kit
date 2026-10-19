// Seal installed send evidence without replaying a transaction or rebuilding.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const base=resolve(import.meta.dirname,'..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const run=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8'}).trim();
const reports={},platforms={},methods=new Set();
const adb='/Users/alex/Library/Android/sdk/platform-tools/adb';
for(const platform of ['ios','android']){
 const file=`evidence/f3-send-device-${platform}-a.json`,bytes=await readFile(join(base,file)),r=JSON.parse(bytes);
 assert.equal(r.status,'F3_SEND_DEVICE_PUBLIC_FIXTURE_PASS');
 reports[file]=sha(bytes);
 for(const [file,h]of Object.entries(r.source)){
  if(file==='acceptance-profile.json')continue;
  assert.equal(sha(await readFile(join(base,file))),h,`Current ${file}`);
 }
 let installed;
 if(platform==='ios'){
  const app=run('xcrun',['simctl','get_app_container',r.device,r.bundleId,'app']);
  installed={path:app+'/Runner.debug.dylib',sha256:sha(await readFile(app+'/Runner.debug.dylib'))};
 }else{
  const location=run(adb,['-s',r.device,'shell','pm','path',r.bundleId]);
  assert(/^package:\/data\/app\/[^\s]+\/base\.apk$/.test(location));
  const path=location.slice('package:'.length);
  installed={path,sha256:run(adb,['-s',r.device,'shell','sha256sum',path]).split(/\s/)[0]};
 }
 assert.equal(installed.sha256,r.artifact.sha256,'Installed artifact equals collected build');
 const cases=r.deviceReport.cases.filter(c=>c.name?.startsWith('send-'));
 assert.equal(cases.length,5);assert.equal(r.deviceReport.broadcasts,0);
 assert.deepEqual(r.deviceReport.loopbackFailures,[]);
 for(const c of cases){methods.add(c.method);assert.equal(c.approvalDelta,1);assert.equal(c.signedTransactionsExact,true);assert.equal(c.matchedExceptFreshApprovalId,true);}
 platforms[platform]={device:r.device,pid:r.deviceReport.pid,artifact:r.artifact,installed,
  cases:cases.map(c=>({name:c.name,method:c.method,approvals:c.approvalDelta,signatures:c.signatureDelta,
   approvalToLastSignatureMs:c.approvalToLastSignatureUs/1000,pageMs:c.pageMs,materialReads:c.reads,
   statusReads:c.readOnlyStatusPosts,loopbackPosts:c.loopbackPosts})),loopbackPosts:r.deviceReport.loopbackHTTP.length};
}
assert.deepEqual([...methods].sort(),['tbc_sendPreparedTransaction','tbc_sendPreparedWorkflow','tbc_sendTransaction','tbc_sendWorkflow']);
const protectedState=JSON.parse(run(process.execPath,[join(base,'tool/check_protected.mjs')]));
const report={status:'F3_SEND_PAIRED_DEVICE_PASS',recordedAt:new Date().toISOString(),reports,platforms,
 implementation:'Four public sends reuse the existing Dart worker, bounded approval, material preparation, frozen Rust signer/Engine, native authorization, system SQLite dispatch journal and exact result emission. No runtime or Rust source changed in this checkpoint.',
 testBoundary:'Acceptance-only generated host redirects the final native HTTP destination to localhost. All source/path/body/authority/journal/result validation before that seam is unchanged. Only public scalar-one fixtures are signed; zero public-node requests and zero real-chain broadcasts.',
 checked:['All four public sends; five distinct selections including three-stage AMM, two-stage Prepared FT and dependency-bound typed receipts',
  'Five transaction approvals per platform, one per selection, no second broadcast approval',
  'Eight real loopback POSTs per platform, exact frozen signed bytes and order, no duplicate POST or status GET',
  'Material reads unique within each request and inside the previously frozen cold/warm trace bounds',
  'Separate send grant, rejection and pending-approval navigation produce zero signatures/POSTs as applicable',
  'Installed binaries match the collected build hashes; runtime source and protected frozen artifacts reverified'],
 provider:{required:22,source:21,accumulatedInstalled:21,remaining:'tbc_switchChain'},
 timingLimit:'One public-fixture sample per selection, including a 250ms automated consent delay, synthetic 5ms reads and local HTTP. iOS simulator Debug and Android emulator Release must not be compared as a platform speed claim. No matched historical regression or real-node timing claim.',
 sizeLimit:'Android test APK total and iOS simulator debug host binary are recorded, not incremental partner App size or final release handoff size.',
 protectedState,next:['Implement tbc_switchChain and thin Legacy on the same authoritative lifecycle, without wallet/Legacy execution bypasses.',
  'Authorized private Testnet and required confirmation/recovery; matched segmented timings and Release App increment.',
  'Clean-project production-safe Vault/approval templates, paired local candidate, short documentation and final full-scope matrix.'],
 acceptedDeliveryChanged:false,frozenRustModified:false,published:false,goalComplete:false};
await writeFile(join(base,'evidence/f3-send-paired-device-design.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,methods:[...methods],platforms,protectedFiles:protectedState.protectedFiles}));
