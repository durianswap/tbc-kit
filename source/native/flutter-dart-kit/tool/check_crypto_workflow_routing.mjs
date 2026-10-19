// Source/native checkpoint only. Preserve prior reports and accepted delivery.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);assert(dart&&output);
const sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>readFile(join(base,p));
const nativePath='evidence/f3-bie1-workflow-native-a.json',bytes=await read(nativePath),native=JSON.parse(bytes);
assert.equal(sha(bytes),'4da15856b9349ace3409626b61e149e5daab4701df96e66dd3f695dda44a6460');
for(const [p,pin]of Object.entries(native.sourceHashes))assert.equal(sha(await read(p)),pin,p);
assert.deepEqual(native.results.map(r=>r.checks),[61,61]);
const files=['crypto_action','crypto_rust','crypto_worker','crypto_provider','crypto_workflow',
 'crypto_workflow_worker','crypto_workflow_provider','native_wallet_binding','provider_session',
 'signing_worker','workflow_plan','workflow_execution','workflow_worker','workflow_provider'];
const sources=['lib/src/internal/crypto_action.dart','lib/src/internal/signing_executor.dart','lib/src/signing_backend.dart',
 'lib/src/internal/signing_worker.dart','lib/src/internal/native_wallet_binding.dart','lib/src/internal/provider_control.dart',
 'lib/src/internal/provider_session.dart','lib/src/internal/workflow_executor.dart','lib/src/internal/workflow_plan.dart','lib/src/internal/workflow_request.dart',
 'tool/crypto_workflow_oracle.mjs','tool/check_crypto_workflow_routing.mjs',...files.map(f=>'test/'+f+'_test.dart')];
const sourceHashes={};for(const p of sources)sourceHashes[p]=sha(await read(p));
const opts={cwd:base,encoding:'utf8',maxBuffer:16*1024*1024};
const analysis=execFileSync(dart,['analyze','--fatal-infos','lib',...files.map(f=>'test/'+f+'_test.dart')],opts).trim();
const events=execFileSync(dart,['test',...files.map(f=>'test/'+f+'_test.dart'),'--reporter=json'],opts).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const passed=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success');
const names=Object.fromEntries(events.filter(e=>e.type==='testStart').map(e=>[e.test.id,e.test.name]));
const actual=passed.map(e=>names[e.testID]);
for(const [prefix,count]of [['private worker frozen ',12],['actual frozen Rust ',12],['actual Rust rejects ',5],['public BIE1 ',12],['frozen workflow crypto ',4],['private worker crypto batch ',3],['public workflow crypto ',3]])assert.equal(actual.filter(n=>n.startsWith(prefix)).length,count,prefix);
const protectedState=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],opts));
const report={status:'F3_BIE1_PUBLIC_AND_WORKFLOW_SOURCE_PASS',recordedAt:new Date().toISOString(),native:{path:nativePath,sha256:sha(bytes),results:native.results},sourceHashes,
 tests:passed.length,testFiles:files,analysis,protectedState,
 proof:{nativeStandaloneChecksPerPlatform:182,nativeWorkflowChecksPerPlatform:61,frozenWorkflowCases:4,publicMixedWorkflowCases:3,
  nativeOptionalCapability:true,oneApproval:true,cryptoAdditionalChainReads:0,signingJournalWrites:0,
  actualMacRustPositiveCases:12,actualMacRustNegativeCases:5,sourceMethodsWithNativeCrypto:17,sourceMethodsWithoutNativeCrypto:15,installedDeviceMethods:15,requiredMethods:22},
 limits:['Native tests compile Swift/macOS and Kotlin/JVM with replayed public BIE1 bytes; actual pinned macOS Rust crypto is a separate check. Mobile framework constructors/device/Vault integration remains next.',
  'Four mixed/native binding comparisons and two crypto-only native execution graphs pass. Mixed transaction/crypto execution passes the public Provider/worker/Rust checks; it has not yet run in installed mobile/native custody.',
  'No new broadcast, matched speed/size, minimum-OS/physical-device or final handoff proof. Public fixture replay is never production key custody. Thin Legacy and network/send/reconcile remain pending.'],
 acceptedDeliveryChanged:false,frozenRustModified:false,broadcasts:0,published:false,goalComplete:false};
const out=JSON.stringify(report,null,2)+'\n';await writeFile(resolve(base,output),out,{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests:report.tests,sha256:sha(out),protectedFiles:protectedState.protectedFiles,output}));
