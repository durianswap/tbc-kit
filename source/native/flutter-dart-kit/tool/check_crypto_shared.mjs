// BIE1 shared-Dart checkpoint with independently generated frozen Core vectors
// and the existing Rust ABI. Does not imply native custody/Provider/device proof.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);
assert(dart&&output);
const sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>readFile(join(base,p));
const oraclePath='test/fixtures/crypto-signing.json',oracleBytes=await read(oraclePath),oracle=JSON.parse(oracleBytes);
assert.equal(sha(oracleBytes),'9373286892cfd6c82a93d7f5c8637f12015172b261e3463613058cb63a818bc3');
assert.equal(oracle.archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
assert.equal(oracle.cases.length,12);assert.equal(oracle.invalid.length,14);assert.equal(oracle.nativeReject.length,4);
const parentPath='evidence/f3-workflow-public-device-design.json',parentBytes=await read(parentPath);
const sources=['lib/src/internal/crypto_action.dart','lib/src/internal/signing_executor.dart','lib/src/signing_backend.dart',
 'test/crypto_action_test.dart','test/crypto_rust_test.dart','tool/crypto_oracle.mjs','tool/check_crypto_shared.mjs'];
const sourceHashes={};for(const p of sources)sourceHashes[p]=sha(await read(p));
const analysis=execFileSync(dart,['analyze','--fatal-infos',...sources.filter(p=>p.endsWith('.dart'))],{cwd:base,encoding:'utf8',maxBuffer:1024*1024});
const files=['crypto_action','crypto_rust','signing_executor','typed_signing','prepared_signing','reviewed_signing','workflow_execution'];
const events=execFileSync(dart,['test',...files.map(f=>'test/'+f+'_test.dart'),'--reporter=json'],{cwd:base,encoding:'utf8',maxBuffer:8*1024*1024}).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const successes=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success');
const testNames=Object.fromEntries(events.filter(e=>e.type==='testStart').map(e=>[e.test.id,e.test.name]));
const passedNames=successes.map(e=>testNames[e.testID]);
assert.equal(passedNames.filter(n=>n?.startsWith('actual frozen Rust ')).length,12);
assert.equal(passedNames.filter(n=>n?.startsWith('actual Rust rejects ')).length,5);
const protection=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],{cwd:base,encoding:'utf8'}));
const library='../flutter-compat/crypto-custody-source-evidence-2026-10-07-a/native-signer/target/release/libtbc_signer_kernel.dylib';
assert.equal(sha(await read(library)),'9b6bddd40a80d25dd5a2bb9888eaa99a148141274acd36856ac149f4e7e9af0f');
const primitiveSources={};for(const p of ['src/crypto.rs','src/lib.rs','include/tbc_signer_kernel.h'])primitiveSources[p]=sha(await read('../signer/kernel/'+p));
const routing={};for(const p of ['lib/src/internal/provider_session.dart','lib/src/internal/signing_worker.dart','lib/src/internal/native_wallet_binding.dart',
 'platform/ios/Classes/NativeCustody.swift','platform/android/src/main/kotlin/io/tbc/kit/dart/NativeCustody.kt'])routing[p]=sha(await read(p));
const report={status:'F3_BIE1_SHARED_DART_AND_HOST_RUST_PASS',recordedAt:new Date().toISOString(),
 parent:{path:parentPath,sha256:sha(parentBytes)},oracle:{path:oraclePath,sha256:sha(oracleBytes)},sourceHashes,
 tests:successes.length,testFiles:files,analysis:analysis.trim(),protection,
 primitive:{library,sha256:sha(await read(library)),sourceHashes:primitiveSources,recompiled:false},
 proof:{frozenCoreCases:12,invalidSchemaCases:14,actualRustCases:12,actualRustNegativeCases:5,
   sharedSingleApproval:true,cryptoNeverDigestSigns:true,authorityBeforeAndAfter:true,
   chainReads:0,signingJournalWrites:0,publicExecutableMethods:15,requiredMethods:22},
 routingUnchanged:routing,
 repair:'The first focused run found missing Dart isUnlocked fences in the new crypto branch. Shared freshness checks now fence both pre-key and post-key boundaries; native independent checks are still required. No original signature/transaction validation was removed.',
 limits:['Public scalar1/2 and replay approval only. Actual cryptography uses the pinned existing macOS Rust library, not paired mobile Vault integration.',
 'Native crypto custody, private MethodChannel/worker, Provider capabilities, workflow crypto and exact delivery binding remain to be integrated. Public executable methods remain15 of22.',
 'BIE1 is the existing deterministic compatibility format, not a new general-purpose encryption protocol. Plaintext must never enter telemetry.',
 'No new iOS/Android, private Testnet, matched timing or size proof. The full final goal remains active.'],
 chainHttp:0,broadcasts:0,acceptedDeliveryChanged:false,frozenRustModified:false,published:false,goalComplete:false};
const bytes=JSON.stringify(report,null,2)+'\n';await writeFile(resolve(base,output),bytes,{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests:report.tests,actualRustCases:12,protectedFiles:protection.protectedFiles,sha256:sha(bytes),output}));
