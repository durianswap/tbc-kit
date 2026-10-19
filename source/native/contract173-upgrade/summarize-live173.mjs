// Assemble current installed private-Testnet evidence, then refresh only GET
// confirmations/index metadata. Does not submit or replay any accepted action.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../..'),dir=join(root,'release/contract173-live-20261014-a');
const kit=join(root,'release/kit-contract173-20261014-c/package'),require=createRequire(import.meta.url);
const {createTbcChainClient,createTbcOfficialApi}=require(join(kit,'dist/cjs/api.cjs'));
const opts={network:'testnet',baseUrl:'https://devapi.tbcdev.org',allowedOrigins:['https://devapi.tbcdev.org'],fetch:(u,o)=>{
 assert.equal(o?.method??'GET','GET');return fetch(u,{...o,redirect:'error',signal:AbortSignal.timeout(20000)});
}};
const client=createTbcChainClient(opts),api=createTbcOfficialApi(opts),steps=[];
let poolId,identity;
for(const [index,kind]of ['create','add','buy','sell','remove'].entries()){
 const runId=`contract173-ios-${kind}-20261014-a`;
 const suffix=['add','buy'].includes(kind)?'-quoted-receipt.json':'-receipt.json';
 const evidence=JSON.parse(await readFile(join(dir,runId+'.json'))),receipt=JSON.parse(await readFile(join(dir,runId+suffix)));
 assert.equal(receipt.status,'LIVE_AMM_CONFIG_AND_FEE_VERIFIED');assert.equal(receipt.approvalCount,1);
 if(index===0){poolId=receipt.poolContractId;identity=receipt.kitIdentity;}else{
  assert.equal(receipt.poolContractId,poolId);assert.deepEqual(receipt.kitIdentity,identity);
  assert(receipt.quote,'Post-create lifecycle requires checked quote/next-state parity');
 }
 const transactions=await Promise.all(receipt.rows.map(async row=>({id:row.id,txid:row.txid,feeAtomic:row.feeAtomic,status:await client.getTransactionStatus(row.txid)})));
 steps.push({kind,runId,evidence:runId+'.json',receipt:runId+suffix,transactions,
  approvalCount:receipt.approvalCount,signatureCount:receipt.signatureCount,totalFeeAtomic:receipt.totalFeeAtomic,
  timing:receipt.timing,state:receipt.pool.state,installedArtifacts:evidence.artifacts,
  timingLimitations:['iOS26.5 simulator Debug','One functional sample, includes250ms automatic test consent and live API latency',
   ...(kind==='buy'?['Background compilation overlapped this functional sample; exclude from strict benchmark']:[])]});
}
const device='C2C010B8-4071-4888-9E25-D91BF88EB461';
const data=execFileSync('xcrun',['simctl','get_app_container',device,'io.tbc.dartkit.contract173','data'],{encoding:'utf8'}).trim();
const journal=JSON.parse(execFileSync('sqlite3',['-readonly','-json',join(data,'Library/Application Support/contract173-private-testnet/tbc-kit-broadcast.sqlite'),
 'SELECT txid,state,result_status FROM broadcast_intents;'],{encoding:'utf8'}));
for(const step of steps)for(const tx of step.transactions){const row=journal.find(j=>j.txid===tx.txid);assert(row);assert.equal(row.state,'completed');assert.equal(row.result_status,'accepted');}
assert.equal(journal.filter(j=>j.state==='uncertain'||j.state==='prepared').length,0);
const info=await api.poolInfo({pool_id:poolId});
const last=steps.at(-1),primary=last.transactions.at(-1);assert.equal(info.txid,primary.txid);
assert.equal(info.token_balance,last.state.ftAmount);assert.equal(info.lp_balance,last.state.lpAmount);assert.equal(info.tbc_balance,last.state.tbcAmount);assert.equal(info.value,last.state.poolValue);
const report={checkedAt:new Date().toISOString(),status:'IOS_PRIVATE_TESTNET_AMM_LIFECYCLE_ACCEPTED',device,kitIdentity:identity,poolContractId:poolId,steps,
 allConfirmed:steps.every(s=>s.transactions.every(t=>t.status.status==='confirmed'&&BigInt(t.status.confirmations)>0n)),
 journal:{rows:journal.length,unknown:0,allLifecycleSubmissionsAccepted:true},
 apiSummary:{serviceFeeRate:info.service_fee_rate,serviceProvider:info.service_provider,version:info.version,
  authoritativeFees:{lpFeeRate:25,taxFeeRate:100,serviceProviderFeeRate:10,protocolFeeRate:5,feeAddress:'1BascLLVsqhS8Bta8aaSfyNUxWW4E4Q5fH'},
  note:'Shared API still returns legacy fee/tag summary0/empty for this explicit profile. Kit derives verified fees/tag from Code/Tape/genesis with the existing raw reads; it does not trust that summary. Reserve/index identity matches. API summary exposure remains an external integration caveat, not a reason to change contract math.'},
 scope:'New four-rate AMM public/plain lifecycle in actual current Dart WebView/native production host. No controlled network or public fixture key. Real broadcast acceptance is distinct from confirmation. Not Android real-chain, controlled/pool-timelock real-chain, matched performance, Release size, minimum OS, or full final partner delivery.',
 frozenDeliveryModified:false,published:false,goalComplete:false};
await writeFile(resolve(process.argv[2]),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,allConfirmed:report.allConfirmed,poolId,journal:report.journal,steps:steps.map(s=>({kind:s.kind,approvals:s.approvalCount,...s.timing,txids:s.transactions.map(t=>t.txid)}))}));
