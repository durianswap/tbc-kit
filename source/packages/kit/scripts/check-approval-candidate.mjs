import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const run=promisify(execFile),repo=resolve(import.meta.dirname,'../../../..'),source=join(repo,'source'),out=resolve(process.argv[2]);
const prior=resolve(process.argv[3]),sha=b=>createHash('sha256').update(b).digest('hex');
const opts={timeout:180000,maxBuffer:4e6},report={results:[],scope:'Offline packed imports, types, approval binding and native adapters; no real signing or broadcast'};
const unpack=join(out,'unpacked'),consumer=join(out,'consumer');await mkdir(unpack,{recursive:true});await mkdir(consumer,{recursive:true});
const log=async(name,cmd,args,cwd=repo,env={})=>{
 const r=await run(cmd,args,{...opts,cwd,env:{...process.env,...env}});
 await writeFile(join(out,name+'.log'),r.stdout+r.stderr);report.results.push({name,status:'PASS'});return r.stdout;
};
try {
 const candidate=JSON.parse(await readFile(join(out,'candidate.json')));
 for(const a of candidate.artifacts){
  assert.equal(sha(await readFile(join(out,a.name))),a.sha256);
  const listing=(await run('tar',['-tzf',join(out,a.name)],opts)).stdout.trim().split('\n');
  assert(listing.every(p=>!p.startsWith('/')&&!p.split('/').includes('..')));
  await run('tar',['-xzf',join(out,a.name),'-C',unpack],opts);
 }
 const flutter=join(unpack,'tbc_kit_flutter_dart');
 for(const [base,manifest,skip]of [[join(unpack,'package'),'artifacts/distribution.json','artifacts/distribution.json'],[flutter,'package-files.json','package-files.json']]){
  const m=JSON.parse(await readFile(join(base,manifest)));
  for(const[p,h]of Object.entries(m.files))assert.equal(sha(await readFile(join(base,p))),h,p);
  async function files(dir,pre=''){return(await Promise.all((await readdir(join(dir,pre),{withFileTypes:true})).map(e=>e.isDirectory()?files(dir,join(pre,e.name)):join(pre,e.name)))).flat();}
  assert.deepEqual((await files(base)).filter(p=>p!==skip).sort(),Object.keys(m.files).sort());
 }
 report.results.push({name:'tarball-and-complete-inventories',status:'PASS'});
 await log('install','npm',['install','--prefix',consumer,'--ignore-scripts','--no-audit','--no-fund',join(out,'tbc-kit.tgz')]);
 const installed=join(consumer,'node_modules/@tbc/kit'),entries=['','/wallet','/engine','/api','/rpc','/sqlite','/testing','/multisig'];
 await log('esm-imports',process.execPath,['--input-type=module','-e',`for(const e of ${JSON.stringify(entries)}){if(!Object.keys(await import('@tbc/kit'+e)).length)throw Error(e)}console.log('8 ESM imports PASS')`],consumer);
 await log('cjs-imports',process.execPath,['-e',`for(const e of ${JSON.stringify(entries)}){if(!Object.keys(require('@tbc/kit'+e)).length)throw Error(e)}console.log('8 CJS imports PASS')`],consumer);
 const cjsPath=join(installed,'dist/cjs/wallet.cjs'),cjsAdapter=join(out,'cjs-wallet-test.mjs');
 const cjsNames=Object.keys(createRequire(import.meta.url)(cjsPath));
 await writeFile(cjsAdapter,`import {createRequire} from 'node:module';const value=createRequire(import.meta.url)(${JSON.stringify(cjsPath)});\n`+
  cjsNames.map(k=>`export const ${k}=value.${k};`).join('\n'));
 for(const format of ['esm','cjs']){
  const walletModule=format==='esm'?join(installed,'dist/esm/wallet.js'):cjsAdapter;
  const tests=['approval-presentation','approval-host-evidence','crypto-byte-budget'];
  const paths=[];
  for(const name of tests){
   let code=await readFile(join(source,'packages/kit/test',name+'.test.mjs'),'utf8');
   code=code.replaceAll('"@tbc-wallet/core"',JSON.stringify(join(source,'packages/core/dist/esm/index.js')))
    .replaceAll('"../dist/esm/wallet.js"',JSON.stringify(walletModule))
    .replaceAll('"../examples/approval-presentation/renderer.mjs"',JSON.stringify(join(installed,'examples/approval-presentation/renderer.mjs')));
   const path=join(out,format+'-'+name+'.test.mjs');await writeFile(path,code);paths.push(path);
  }
  await log(format+'-approval-tests',process.execPath,['--test',...paths],consumer,
   {TBC_KIT_WALLET_TEST_MODULE:walletModule});
 }
 // The private parser must resolve in an installation without tbc-tx-parser as
 // a public dependency, and keep its real callable export in both closures.
 await log('private-parser',process.execPath,['--input-type=module','-e',`for(const f of ['esm','cjs']){const m=await import('./node_modules/@tbc/kit/dist/'+f+'/vendor/tbc-tx-parser/index.js');if(typeof m.decodeTxRaw!=='function')throw Error(f)}console.log('PRIVATE_PARSER_PASS')`],consumer);
 await writeFile(join(consumer,'consumer.mts'),`import {projectTbcApprovalPresentation,type TbcApprovalPresentationStep} from '@tbc/kit/wallet';
import * as api from '@tbc/kit/api'; import * as engine from '@tbc/kit/engine';
const warnings = (step:TbcApprovalPresentationStep):readonly string[] => step.warnings;
void [warnings,projectTbcApprovalPresentation,api,engine];\n`);
 await log('public-types',process.execPath,[join(source,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','consumer.mts'],consumer);
 for(const name of ['backend-node','multi-wallet','approval-presentation'])await log('example-'+name,process.execPath,[join(installed,'examples',name,'run.mjs')],consumer);
 const t=JSON.parse(await readFile(join(prior,'toolchain.json'))),native=join(source,'native/flutter-dart-kit');
 await cp(join(prior,'toolchain.json'),join(out,'toolchain.json'));
 const swift=t.names.map(n=>join(flutter,'ios/Classes',n+'.swift')),kotlin=t.names.map(n=>join(flutter,'android/src/main/kotlin/io/tbc/kit/dart',n+'.kt'));
 await log('swift-example-build','xcrun',['swiftc','-O','-swift-version','6','-parse-as-library',...swift,join(flutter,'example/ios/PartnerApprovalPresenter.swift'),join(native,'test/native/PartnerApprovalPresenterCheck.swift'),'-o',join(out,'swift-example')]);
 await log('swift-example',join(out,'swift-example'),[]);
 await log('kotlin-example-build',join(t.java,'bin/java'),['-cp',t.compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-language-version','1.8','-api-version','1.8','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[t.compiler[1],t.compiler[6],t.json,t.android].join(':'),'-d',join(out,'kotlin-example'),...kotlin,join(flutter,'example/android/PartnerApprovalPresenter.kt'),join(native,'test/native/PartnerApprovalPresenterCheck.kt')]);
 await log('kotlin-example',join(t.java,'bin/java'),['-cp',[join(out,'kotlin-example'),t.compiler[1],t.json,t.android].join(':'),'io.tbc.kit.dart.PartnerApprovalPresenterCheckKt']);
 report.status='PASS_PACKAGED_DIRECTED';
}catch(e){report.status='FAIL';report.error={message:e.message,stdout:e.stdout?.slice(-5000),stderr:e.stderr?.slice(-8000)};process.exitCode=1;}
const protectedBefore=JSON.parse(await readFile(join(out,'protected-before.json')));
for(const[p,h]of Object.entries(protectedBefore))assert.equal(sha(await readFile(p)),h,p);
report.protectedUnchanged=true;await writeFile(join(out,'checks.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
