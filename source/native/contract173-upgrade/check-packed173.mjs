import assert from 'node:assert/strict';
import {readFile,writeFile,cp,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {sha256,verifiedKitCandidate} from '../flutter/scripts/candidate-inputs.mjs';
const run=promisify(execFile),root=resolve(import.meta.dirname,'../..'),candidate=resolve(process.argv[2]);
const report=JSON.parse(await readFile(join(candidate,'candidate.json'))),tar=join(candidate,report.tarball);
assert.equal(sha256(await readFile(tar)),report.sha256);
const out=await mkdtemp('/private/tmp/tbc-contract173-consumer-');
await writeFile(join(out,'package.json'),JSON.stringify({name:'tbc-contract173-clean-consumer',private:true,type:'module',version:'0.0.0'}));
await cp(join(import.meta.dirname,'packed-consumer173.mjs'),join(out,'check.mjs'));
const install=await run('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund','--save-exact',tar],{cwd:out,maxBuffer:2**20,timeout:120000});
await writeFile(join(out,'install.log'),install.stdout+install.stderr);
assert.deepEqual(await verifiedKitCandidate(join(out,'node_modules/@tbc/kit')),report.identity);
// Browser/RN barrels are unbundled modules, unlike the passing Node entries.
// Resolve every public browser entry to catch missing newly exported files.
const browserBuild=await build({stdin:{contents:["@tbc/kit","@tbc/kit/wallet","@tbc/kit/engine","@tbc/kit/api","@tbc/kit/rpc","@tbc/kit/sqlite","@tbc/kit/testing"].map((p,i)=>`import * as m${i} from ${JSON.stringify(p)}; console.log(m${i});`).join('\n'),resolveDir:out},bundle:true,write:false,format:'esm',platform:'browser',target:'es2020',logLevel:'silent',external:['node:*']});
assert(browserBuild.outputFiles.length>0);
const result=await run(process.execPath,['check.mjs',join(import.meta.dirname,'high-level173.json'),join(import.meta.dirname,'high-level173-extra.json')],{cwd:out,maxBuffer:2**20,timeout:120000});
const evidence=JSON.parse(result.stdout);assert.equal(evidence.status,'INSTALLED_PACKAGE173_OFFLINE_PASS');
// Public declarations must stand alone, including wallet/raw-review types.
await writeFile(join(out,'types.ts'),`import {normalizeAmmFeePolicy,prepareTbcTransaction} from '@tbc/kit';
import {createDefaultTbcNetwork,TWS_RELEASE_FINGERPRINT} from '@tbc/kit/wallet';
import {createTbcEngine} from '@tbc/kit/engine';
import * as api from '@tbc/kit/api';import * as rpc from '@tbc/kit/rpc';
const fee = normalizeAmmFeePolicy({lpFeeRate:20,taxFeeRate:0,serviceProviderFeeRate:10,protocolFeeRate:0,feeAddress:'1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH'});
void [fee,prepareTbcTransaction,createDefaultTbcNetwork,TWS_RELEASE_FINGERPRINT,createTbcEngine,api,rpc];\n`);
await run(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','--lib','ES2022,DOM','types.ts'],{cwd:out,maxBuffer:2**20,timeout:120000});
const complete={...evidence,cleanConsumer:out,identity:report.identity,tarballSha256:report.sha256,standaloneTypes:'PASS',browserPublicEntries:7,installScripts:false};
await writeFile(join(candidate,'installed-offline.json'),JSON.stringify(complete,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({...complete,evidence:undefined}));
