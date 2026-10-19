// Reproducible, redacted source-stage evidence. Not a candidate/package gate.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url)),sdk=process.argv[2];assert.ok(sdk&&process.argv.length===3);
const checks=[
 ['holder',['packages/tbc-engine/scripts/check-coin-reviewed-source.mjs','--sdk',resolve(sdk)]],
 ['lop',['packages/tbc-engine/scripts/check-lop-reviewed-source.mjs','--detached-signatures','--associated-templates']],
 ['htlc',['packages/tbc-engine/scripts/check-htlc-reviewed-token-source.mjs','--sdk',resolve(sdk),'--associated-witness']],
 ['focused',['--test','packages/kit/test/reviewed-token.test.mjs','packages/kit/test/reviewed-lop.test.mjs','packages/kit/test/reviewed-issuance-policy.test.mjs']],
 ['types',['node_modules/typescript/bin/tsc','-p','packages/kit/tsconfig.json','--noEmit','--incremental','false']],
];
const sha=b=>createHash('sha256').update(b).digest('hex'),results=[];
for(const [name,args]of checks){
 const start=Date.now();
 const output=execFileSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
 const line=output.trim().split('\n').find(l=>l.startsWith('{'));
 results.push({name,args,exitCode:0,elapsedMs:Date.now()-start,outputSha256:sha(output),...(line?{report:JSON.parse(line)}:{})});
}
execFileSync('git',['diff','--check'],{cwd:root,stdio:'pipe'});
const sourceFiles=['packages/kit/src/reviewed-token-holder-flows.ts','packages/kit/src/reviewed-lop-flows.ts',
 'packages/kit/src/reviewed-transaction-reviewer.ts','packages/kit/src/reviewed-token.ts','packages/kit/src/reviewed-token-assets.ts',
 'packages/kit/src/standard-workflow-capabilities.ts','packages/kit/src/reviewed-issuance-policy.ts',
 'packages/tbc-engine/scripts/check-coin-reviewed-source.mjs','packages/tbc-engine/scripts/lib/check-raw-holder-host.mjs',
 'packages/tbc-engine/scripts/lib/token-unlock-sdk-oracle.mjs','packages/tbc-engine/scripts/check-lop-reviewed-source.mjs',
 'packages/tbc-engine/scripts/check-htlc-reviewed-token-source.mjs','packages/tbc-engine/scripts/lib/check-associated-htlc-host.mjs',
 'packages/tbc-engine/scripts/check-current-holder-source-delivery.mjs',
 'packages/tbc-engine/rust/fixtures/coin-proof.json','packages/tbc-engine/rust/fixtures/tbc20-standard-transfer.json',
 'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm'];
const report={status:'PASS_SOURCE_HOLDER_REVIEW_NOT_DELIVERED',at:new Date().toISOString(),results,
 sourceFiles:Object.fromEntries(sourceFiles.map(p=>[p,sha(readFileSync(join(root,p)))])),goalComplete:false,
 limits:['No new frozen package or device acceptance','No real HTTP, custody or broadcast','Holder raw detached signatures only; admin/associated coverage is not expanded','No end-to-end speed claim']};
const dir=mkdtempSync(join(tmpdir(),'tbc-holder4il-source-')),path=join(dir,'report.json'),body=JSON.stringify(report,null,2)+'\n';
writeFileSync(path,body,{flag:'wx'});console.log(JSON.stringify({status:report.status,path,sha256:sha(body),checks:results.map(r=>({name:r.name,exitCode:r.exitCode,elapsedMs:r.elapsedMs}))}));
