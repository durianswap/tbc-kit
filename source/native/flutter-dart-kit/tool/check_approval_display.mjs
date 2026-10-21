// Focused source/candidate checks. Public fixtures only; no chain I/O or Vault.
import {readFile,readdir,mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {writeWorkflowFixture} from './approval_display_fixture.mjs';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..'),source=resolve(base,'../..'),repo=resolve(source,'..');
const out=process.argv[2]??await mkdtemp(join(tmpdir(),'tbc-approval-display-'));await mkdir(out,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const jsonHash=v=>hash(canonical(v));
const names=['NativePermissions','NativePrepared','NativeReviewed','NativeCustody','NativeWalletHost','NativeWorkflow','NativeCrypto','NativeNetworkSessions','NativeNetworkWalletRouter','NativeProtocolWalletRouter'];
const swift=names.map(n=>join(base,`platform/ios/Classes/${n}.swift`)),kotlin=names.map(n=>join(base,`platform/android/src/main/kotlin/io/tbc/kit/dart/${n}.kt`));
const opts={cwd:base,maxBuffer:4e6,timeout:180000};
const cache=join(homedir(),'.gradle/caches/modules-2/files-2.1');
async function jar(g,n,v){const root=join(cache,g,n,v),hits=[];for(const d of await readdir(root))for(const f of await readdir(join(root,d)))if(f===`${n}-${v}.jar`)hits.push(join(root,d,f));assert.equal(hits.length,1);return hits[0];}
const compiler=await Promise.all([['org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-stdlib','2.1.20'],['org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'],['org.jetbrains.kotlin','kotlin-daemon-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-reflect','1.6.10'],['org.jetbrains.intellij.deps','trove4j','1.0.20200330'],['org.jetbrains','annotations','13.0'],['org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.1']].map(v=>jar(...v)));
const java=(await run('/usr/libexec/java_home',[])).stdout.trim(),json=await jar('org.json','json','20240303');
const android=join(homedir(),'Library/Android/sdk/platforms/android-36/android.jar');
const protectedPaths=[join(homedir(),'Downloads/tbc-wallet-integration.zip'),...['tbc-kit.tgz','tbc-kit-flutter.tgz','native/ios-resources.tgz','native/android-resources.tgz'].map(p=>join(repo,'artifacts',p))];
const protectedBefore=Object.fromEntries(await Promise.all(protectedPaths.map(async p=>[p,hash(await readFile(p))])));
await writeFile(join(out,'protected-before.json'),JSON.stringify(protectedBefore,null,2));
const report={recordedAt:new Date().toISOString(),sourceHashes:{},results:[],broadcasts:0,chainReads:0,protectedBefore};
try{
 const {build}=await import(join(source,'node_modules/esbuild/lib/main.js'));
 await build({stdin:{contents:`export * from ${JSON.stringify(join(source,'packages/kit/src/approval-presentation.ts'))};export {ApprovalHostEvidenceConflictError} from ${JSON.stringify(join(source,'packages/kit/src/approval-host-evidence.ts'))};`,resolveDir:source},outfile:join(out,'presentation.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const testSource=await readFile(join(source,'packages/kit/test/approval-presentation.test.mjs'),'utf8');
 await writeFile(join(out,'presentation.test.mjs'),testSource.replace('"@tbc-wallet/core"',JSON.stringify(join(source,'packages/core/dist/esm/index.js'))).replace('"../dist/esm/wallet.js"','"./presentation.mjs"').replace('"../examples/approval-presentation/renderer.mjs"',JSON.stringify(join(source,'packages/kit/examples/approval-presentation/renderer.mjs'))));
 const js=await run(process.execPath,['--test',join(out,'presentation.test.mjs')],opts);await writeFile(join(out,'js-tests.log'),js.stdout+js.stderr);report.results.push({platform:'JS',output:js.stdout.slice(-800)});
 console.log('JS approval projection passed');
 await Promise.all([
  run('xcrun',['swiftc','-O','-swift-version','6','-parse-as-library',...swift,join(base,'test/native/CustodyCheck.swift'),'-o',join(out,'custody-check')],opts),
  run(join(java,'bin/java'),['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-language-version','1.8','-api-version','1.8','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],json,android].join(':'),'-d',join(out,'classes'),...kotlin,join(base,'test/native/CustodyCheck.kt')],opts)
 ]);
 console.log('Swift and Kotlin compiled');
 const fixtures=[['signing/replay.json',null],['typed-signing.json','typed'],['lp-staged-signing.json','staged'],['amm-alias-staged-signing.json','staged'],['staged-signing.json','staged'],['amm-dependent-signing.json','staged']];
 for(const [fixture,mode]of fixtures){
  const args=[join(base,'test/fixtures',fixture),...(mode?[mode]:[])];
  for(const [platform,cmd,argv] of [['swift',join(out,'custody-check'),args],['kotlin',join(java,'bin/java'),['-cp',[join(out,'classes'),compiler[1],json,android].join(':'),'io.tbc.kit.dart.CustodyCheckKt',...args]]]){
   const r=await run(cmd,argv,opts);report.results.push({platform,fixture,...JSON.parse(r.stdout)});console.log(`${platform} ${fixture} passed`);
  }
 }
 await Promise.all([
  run('xcrun',['swiftc','-O','-swift-version','6','-parse-as-library',...swift,join(base,'test/native/WorkflowConsentCheck.swift'),'-o',join(out,'workflow-check')],opts),
  run(join(java,'bin/java'),['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-language-version','1.8','-api-version','1.8','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],json,android].join(':'),'-d',join(out,'workflow-classes'),...kotlin,join(base,'test/native/WorkflowConsentCheck.kt')],opts)
 ]);
 const fixture=join(out,'workflow.json');await writeWorkflowFixture(fixture);
 for(const [platform,cmd,args] of [['swift',join(out,'workflow-check'),[fixture]],['kotlin',join(java,'bin/java'),['-cp',[join(out,'workflow-classes'),compiler[1],json,android].join(':'),'io.tbc.kit.dart.WorkflowConsentCheckKt',fixture]]]){
  const r=await run(cmd,args,opts);report.results.push({platform,fixture:'workflow.json',...JSON.parse(r.stdout)});console.log(`${platform} workflow display passed`);
 }
 for(const p of [...swift,...kotlin,join(source,'packages/kit/src/approval-presentation.ts')])report.sourceHashes[p]=hash(await readFile(p));
 for(const [p,h]of Object.entries(protectedBefore))assert.equal(hash(await readFile(p)),h,p);
 report.status='PASS_SOURCE_DIRECTED';report.protectedUnchanged=true;
 // Toolchain metadata is non-secret and lets the separate device harness reuse
 // these exact compiled sources without mutating either delivery package.
 await writeFile(join(out,'toolchain.json'),JSON.stringify({base,source,repo,java,compiler,json,android,names},null,2));
}catch(e){report.status='FAIL';report.error={message:e.message,stdout:e.stdout?.slice(-5000),stderr:e.stderr?.slice(-12000)};process.exitCode=1;}
await writeFile(join(out,`report-${Date.now()}.json`),JSON.stringify(report,null,2));
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report.status==='FAIL'?report.error:{status:report.status,cases:report.results.length,out}));
