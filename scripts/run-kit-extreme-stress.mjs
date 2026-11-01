import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const repo=resolve(import.meta.dirname,'..'),root=process.env.TBC_STRESS_SOURCE_ROOT??join(repo,'source');
const [installedArg,outArg,mode='all']=process.argv.slice(2),installed=resolve(installedArg),out=resolve(outArg);
await mkdir(out,{recursive:true});assert.equal(JSON.parse(await readFile(join(installed,'package.json'))).name,'@tbc/kit');
const env={...process.env,TBC_TEST_INSTALLED_KIT:installed,TBC_KIT_TEST_ROOT:installed,TBC_KIT_WALLET_TEST_MODULE:join(installed,'dist/esm/wallet.node.js'),TBC_TEST_WASM_DIR:join(installed,'artifacts/wasm'),TBC_FT_PACKED_ROOT:installed,TBC_FT_BASELINE_WASM:join(repo,'packages/kit/artifacts/wasm/tbc_engine_wasm.wasm')};
const kitNames=`approved-host-task backend-service capability-descriptor chain-data-read-scope chain-data-tools coin-chain-data contract-identification core-host-runtime cross-chain-accounts current-associated-material default-broadcast-wallet-lifecycle default-broadcast default-chain-data engine-network-profile ft-fragmented-reader ft-standard-fallback-gate fungible-business-route host-port-business-errors htlc-material htlc-review-status-batching legacy-batch-consent legacy-batch legacy-bitcoin-message legacy-dependent-batch legacy-ft-transfer-intent legacy-generic-batch legacy-mapping legacy-metadata legacy-migration-contract legacy-nft-intent legacy-pool-intent legacy-raw-transaction-reviewer legacy-routing-boundaries legacy-standard-workflow legacy-webview-composition lop-material lp-receipt multi-round-merge-real-engine multi-round-merge multi-round-pool network-context nft-material-batching nft-query nft-three-step optimized-chain-data pool-empty-lp-index pool-policy prepared-approval-warning-scope prepared-template-parsing provider-transport read-retry receipt-verification recoverable-signature-identity request-preparation reviewed-issuance-policy reviewed-lop reviewed-token session-execution sign-in sqlite-recovery stablecoin-approval-evidence standard-workflow-capabilities tbc20-chain-data tbc20-network-profile tbc20-receivers tbc20-standard-client-prepared timelock-chain-data timelock-query unified-fungible-requirements unified-issuance-client unified-tbc-client wallet-discovery-authority wallet-environment wallet-standard-closure wallet-vertical wallet-webview-native webview-cross-artifact webview-page-provider workflow-budget`.split(' ');
const coreNames=(await readdir(join(root,'packages/core/test'))).filter(n=>n.endsWith('.test.mjs')&&!/package-boundary|portability|public-types/.test(n)).map(n=>n.slice(0,-9));
const hostNames=`crash-matrix driver-lifecycle indexeddb-restart lease-heartbeat port-dispatch real-transfer session-commit sqlite-codec sqlite-contention sqlite-restart sqlite-schema store-contract-indexeddb store-contract-memory store-contract-sqlite`.split(' ');
const providerNames=`in-memory provider-events provider-lifecycle provider-request validation webview-codec webview-native webview-navigation webview-outbox webview-page`.split(' ');
const groups=mode==='extreme'?[['extreme','kit',['kit-extreme-lifecycle']]]:mode==='wide'?[
 ['kit','kit',kitNames],['core','core',coreNames],['host','host',hostNames],['provider','provider',providerNames]]:[['extreme','kit',['kit-extreme-lifecycle']],['kit','kit',kitNames],['core','core',coreNames],['host','host',hostNames],['provider','provider',providerNames]];
const results=[];
for(const [name,pkg,names]of groups){
 const args=[...(name==='extreme'?['--expose-gc']:[]),'--import',join(repo,'scripts/kit-stress-offline-guard.mjs')];
 if(name!=='extreme'&&!process.env.TBC_STRESS_SOURCE_ROOT)args.push('--import',join(repo,'scripts/rejection-core-test-loader.mjs'));
 if(pkg==='kit'&&name!=='extreme')args.push('--import',join(repo,'scripts/nft-job-installed-test-loader.mjs'));
 args.push('--test','--test-timeout=180000','--test-concurrency=2',...names.map(n=>`packages/${pkg}/test/${n}.test.mjs`));
 const start=performance.now();let stdout='',stderr='';
 const code=await new Promise((done,fail)=>{const p=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',fail);p.on('close',done)});
 const log=stdout+stderr;await writeFile(join(out,name+'.log'),log);
 const row={name,files:names.length,code,ms:performance.now()-start,tests:Number(stdout.match(/# tests (\d+)/)?.[1]??0),passed:Number(stdout.match(/# pass (\d+)/)?.[1]??0),failed:Number(stdout.match(/# fail (\d+)/)?.[1]??0),skipped:Number(stdout.match(/# skipped (\d+)/)?.[1]??0),cancelled:Number(stdout.match(/# cancelled (\d+)/)?.[1]??0),logSha256:createHash('sha256').update(log).digest('hex')};results.push(row);console.log(JSON.stringify(row));
 await writeFile(join(out,'results.json'),JSON.stringify({installed,version:JSON.parse(await readFile(join(installed,'package.json'))).version,status:results.every(r=>r.code===0)?'PASS':'FAIL',results,realBroadcasts:0,devices:false},null,2)+'\n');
}
process.exitCode=results.every(r=>r.code===0)?0:1;
