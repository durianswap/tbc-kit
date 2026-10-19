// Deterministic scheduler/state oracle from the actual frozen package. No
// transaction/key/HTTP adapter; exact Engine bytes are a later composition gate.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {verifiedKitCandidate} from '../../flutter/scripts/candidate-inputs.mjs';
const [kitArg,out]=process.argv.slice(2);assert(kitArg&&out);
const kit=resolve(kitArg),identity=await verifiedKitCandidate(kit);
const {createTbcMultiRoundMergeOrchestrator,hashTbcMultiRoundMergeState}=await import(pathToFileURL(join(kit,'dist/esm/wallet.node.js')));
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const sha=b=>createHash('sha256').update(b).digest('hex'),hash=v=>sha(canonical(v));
const time='2026-10-14T00:00:00Z',start=Date.parse(time),expiry='2026-10-14T00:05:00Z';
const specs=[
 {name:'tbc-three-rounds'}, {name:'mainnet',network:'mainnet'},
 ...['ft','stablecoin','pool-ft','ftlp'].map(kind=>({name:kind,kind,initial:12})),
 {name:'empty',initial:0},{name:'already-one',initial:1},{name:'target-seven',target:7},
 {name:'transactions-exhausted',maxTransactions:1},{name:'fee-exhausted',maxFee:'5'},
 {name:'cumulative-fee',maxFee:'20'},{name:'maximum-fee',feeKind:'maximum',fee:'30',executionFee:'10'},
 {name:'reject-consent',reject:true},{name:'prepare-failed',prepareFail:2},
 {name:'execute-unknown',executeThrow:1},{name:'known-failed',status:'failed'},
 {name:'known-rejected',status:'rejected'},{name:'host-pending',status:'pending'},
 {name:'already-known',status:'known'},{name:'reconcile-known',status:'uncertain',reconcile:'known'},
 {name:'reconcile-unknown',status:'uncertain',reconcile:'unknown'},
 {name:'reconcile-rejected',status:'uncertain',reconcile:'rejected'},
 {name:'reconcile-throws',status:'uncertain',reconcileThrow:true},
 {name:'index-stalled',stall:true},{name:'index-read-failed',readFail:true},
 {name:'foreign-approval',wrongApproval:true},{name:'foreign-dependency',badDependency:true},
 {name:'foreign-state',badState:true},{name:'expired-step',stepExpired:true},
 {name:'expired-after-prepare',advancePrepare:300000},{name:'revoked-before-execute',authorityLost:true},
 {name:'count-only-progress',unrelatedIndex:true}, {name:'changed-index-reduction',wrongReduction:true},
 {name:'pool-owner-changed',kind:'pool-ft',initial:8,changePool:true},
 {name:'ftlp-pool-moved',kind:'ftlp',initial:8,moveLpPool:true},
 // Explicit safety deltas: frozen outputs retained, never rewritten to green.
 {name:'throw-after-cancel',executeThrow:1,cancelExecute:true,safetyDelta:'retain-post-dispatch-uncertainty'},
 {name:'throw-after-expiry',executeThrow:1,advanceExecute:300000,safetyDelta:'retain-post-dispatch-uncertainty'},
 {name:'expired-index-wait',stall:true,advanceWait:300000,safetyDelta:'stop-index-refresh-at-deadline'},
];
const cases=[];
for(const config of specs){
 const chainId='tbc:'+(config.network??'testnet'),address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
 const authority={chainId,accountId:chainId+':'+address,origin:'https://merge.example',sessionId:'merge-session'};
 const kind=config.kind??'tbc',asset=kind==='tbc'?{kind}:['ft','stablecoin'].includes(kind)?{kind,contractId:'a'.repeat(64)}:{kind,poolContractId:'b'.repeat(64)};
 const limits={targetUtxoCount:config.target??1,maxTransactions:config.maxTransactions??8,
  maxTotalFee:config.maxFee??'1000',expiresAt:expiry,maxIndexRefreshes:2,indexRefreshDelayMs:0};
 const calls=[],scopes=[],prepared=[],controller=new AbortController();let clock=start,executions=0,reads=0;
 const pool={poolContractId:'b'.repeat(64),ftContractId:'a'.repeat(64),currentPoolTxid:'c'.repeat(64)};
 function state(count,ids=[]){const p={version:'1.0',authority,asset,observedAt:time,revision:'r-'+count+'-'+ids.join('-'),
  utxoCount:count,observedTransactionIds:ids,...(['pool-ft','ftlp'].includes(kind)?{poolIdentity:{...pool}}:{})};return {...p,stateHash:hashTbcMultiRoundMergeState(p)};}
 const initialState=state(config.initial??205);let current=initialState;
 function advance(step,txid){
  if(kind==='pool-ft'||config.moveLpPool)pool.currentPoolTxid=txid;
  if(config.changePool)pool.ftContractId='d'.repeat(64);
  current=state(current.utxoCount-step.inputCount+1-(config.wrongReduction?1:0),config.unrelatedIndex?[]:[txid]);
 }
 const adapter={
  async readState(){calls.push('read');reads++;if(config.readFail&&executions)throw Error('index');
   if(config.badState)return {...current,stateHash:'f'.repeat(64)};return current;},
  async approve(input){calls.push('approve');scopes.push(input);return config.reject?{status:'rejected',scopeHash:input.scopeHash}:
   {status:'approved',scopeHash:config.wrongApproval?'f'.repeat(64):input.scopeHash,approvalId:'consent',approvedAt:time,expiresAt:expiry};},
  async prepareStep(input){calls.push('prepare:'+input.stepIndex);if(input.stepIndex===config.prepareFail)throw Error('prepare');
   const inputCount=Math.min(input.scope.impact.maxAssetInputsPerTransaction,input.state.utxoCount-limits.targetUtxoCount+1);
   const step={version:'1.0',stepId:'merge-'+input.stepIndex,stepIndex:input.stepIndex,authority,asset,
    stateHash:input.state.stateHash,materialHash:hash({step:input.stepIndex,state:input.state.stateHash}),
    inputCount,outputCount:1,fee:config.fee??'10',...(config.feeKind?{feeKind:config.feeKind}:{}),
    expiresAt:config.stepExpired?'2026-10-13T23:59:59Z':expiry,
    dependsOn:config.badDependency?['e'.repeat(64)]:input.acceptedTxids.slice(-1),prepared:{fixture:true}};
   prepared.push(step);clock+=config.advancePrepare??0;return step;},
  async assertAuthority(){calls.push('authority');if(config.authorityLost)throw Error('authority');},
  async executePreparedStep({step}){calls.push('execute:'+step.stepIndex);executions++;
   if(config.cancelExecute)controller.abort();clock+=config.advanceExecute??0;
   if(executions===config.executeThrow){const e=Error('execution');e.recoveryId='native-'+executions;throw e;}
   const status=config.status??'accepted',txid=hash({tx:executions,materialHash:step.materialHash});
   if(['failed','rejected','pending'].includes(status))return {status,stepId:step.stepId,materialHash:step.materialHash,
    error:'controlled failure',...(status==='pending'?{recoveryId:'native-'+executions}:{})};
   if(!config.stall&&status!=='uncertain')advance(step,txid);
   return {status,stepId:step.stepId,materialHash:step.materialHash,txid,fee:config.executionFee??step.fee,inputsConsumed:step.inputCount,outputsCreated:1};},
  async reconcile({txid,step}){calls.push('reconcile');if(config.reconcileThrow)throw Error('reconcile');
   const status=config.reconcile??'known';if(status==='known'&&!config.stall)advance(step,txid);return {txid,status};},
  async waitForIndex(){calls.push('wait');clock+=config.advanceWait??0;},
 };
 let outcome;
 try{outcome={result:await createTbcMultiRoundMergeOrchestrator(adapter,{now:()=>clock}).run({authority,asset,limits,signal:controller.signal})};}
 catch(e){outcome={error:e.name};}
 cases.push({config,authority,asset,limits,initialState,...outcome,calls,scopes,prepared});
}
const report={status:'FROZEN_MULTI_ROUND_COORDINATOR_ORACLE',identity,cases,externalHttp:0,broadcasts:0,
 generatorSha256:sha(await readFile(new URL(import.meta.url)))};
await writeFile(resolve(out),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,cases:cases.length,out}));
