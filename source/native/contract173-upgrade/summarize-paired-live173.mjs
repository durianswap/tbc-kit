// GET-only summary. Accepted one-shot operations must never be replayed.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../..'),dir=join(root,'release/contract173-live-20261014-a');
const read=async file=>JSON.parse(await readFile(join(dir,file)));
const previous=await read('ios-amm-confirmation-refresh-20261014-b.json');
assert.equal(previous.allConfirmed,true);
const {createTbcChainClient,createTbcOfficialApi}=createRequire(import.meta.url)(join(root,'release/kit-contract173-20261014-c/package/dist/cjs/api.cjs'));
const options={network:'testnet',baseUrl:'https://devapi.tbcdev.org',allowedOrigins:['https://devapi.tbcdev.org'],fetch:(u,o)=>{
 assert.equal(o?.method??'GET','GET');return fetch(u,{...o,redirect:'error',signal:AbortSignal.timeout(20000)});
}};
const client=createTbcChainClient(options),api=createTbcOfficialApi(options),steps=previous.steps.map(s=>({...s,platform:'ios'}));
for(const [kind,id]of [['buy','contract173-android-buy-20261014-b'],['sell','contract173-android-sell-20261014-a']]){
 const evidence=await read(id+'.json'),receipt=await read(id+'-receipt.json');
 assert.equal(receipt.status,'LIVE_AMM_CONFIG_AND_FEE_VERIFIED');assert.deepEqual(receipt.kitIdentity,previous.kitIdentity);
 assert.equal(receipt.poolContractId,previous.poolContractId);assert.equal(receipt.approvalCount,1);assert(receipt.quote);
 assert(evidence.journal.every(j=>j.state==='completed'&&j.result_status==='accepted'));
 steps.push({platform:'android',kind,runId:id,evidence:id+'.json',receipt:id+'-receipt.json',transactions:receipt.rows.map(r=>({id:r.id,txid:r.txid,feeAtomic:r.feeAtomic,status:r.status})),
  approvalCount:receipt.approvalCount,signatureCount:receipt.signatureCount,totalFeeAtomic:receipt.totalFeeAtomic,timing:receipt.timing,state:receipt.pool.state,installedArtifacts:evidence.artifacts,
  timingLimitations:['API36 arm64 emulator Release','Single functional sample with live API and250ms automatic consent','Not comparable directly with iOS Debug or matched old/new performance']});
}
for(const step of steps)for(const t of step.transactions)t.status=await client.getTransactionStatus(t.txid);
const self=await read('contract173-ios-self-20261014-b.json');
const selfTransactions=await Promise.all(self.report.result.value.transactions.map(async t=>({txid:t.txid,status:await client.getTransactionStatus(t.txid)})));
const latest=steps.at(-1),info=await api.poolInfo({pool_id:previous.poolContractId});
assert.equal(info.txid,latest.transactions.at(-1).txid);
assert.equal(info.token_balance,latest.state.ftAmount);assert.equal(info.lp_balance,latest.state.lpAmount);assert.equal(info.tbc_balance,latest.state.tbcAmount);assert.equal(info.value,latest.state.poolValue);
const allConfirmed=[...steps.flatMap(s=>s.transactions),...selfTransactions].every(t=>t.status.status==='confirmed'&&BigInt(t.status.confirmations)>0n);
const report={checkedAt:new Date().toISOString(),status:'PAIRED_PRIVATE_TESTNET_NEW_AMM_ACCEPTED',kitIdentity:previous.kitIdentity,poolContractId:previous.poolContractId,
 allConfirmed,selfTransactions,steps,counts:{candidateBroadcasts:9,separateFundingBroadcasts:2,ammTransactions:8,ammOperations:7,unknown:0},
 latestIndex:{txid:info.txid,state:latest.state},apiCaveat:previous.apiSummary,
 failedAttempt:{evidence:'contract173-android-buy-20261014-a.json',boundary:'Test App omitted Android platformViewId; no run admitted, no approval/signature/broadcast/journal. Fixed only driver attach argument, current production host unchanged.'},
 pending:['Matched same-device/input performance and Release incremental size','Clean partner handoff','Deferred switchChain/Legacy and broader Dart final scope'],
 proofLimits:'iOS current new-AMM public/plain full lifecycle plus Android representative buy/sell. Controlled devices cover additional variants but are not real-chain proof. No physical-device/minimum-OS or full final delivery claim.',
 frozenDeliveryModified:false,published:false,goalComplete:false};
await writeFile(resolve(process.argv[2]),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,allConfirmed,counts:report.counts,steps:steps.map(s=>({platform:s.platform,kind:s.kind,approval:s.approvalCount,timing:s.timing,transactions:s.transactions}))}));
