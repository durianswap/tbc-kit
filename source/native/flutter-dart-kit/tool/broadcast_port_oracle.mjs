// Frozen Kit port behavior; public synthetic transactions and in-memory TEST
// journal only. No live node, real POST, new Dart output or production storage.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {base,frozenOracle,canonical,sha} from './frozen_oracle.mjs';
const o=await frozenOracle(),source=await readFile(join(base,'test/fixtures/staged-signing.json'));
const txs=JSON.parse(source).cases.find(s=>s.name==='current-ft-staged-transfer').result.transactions.slice(0,2);
assert.equal(txs.length,2);assert.deepEqual(txs[1].dependsOn,[txs[0].id]);
const copy=v=>JSON.parse(JSON.stringify(v));
const identity=r=>Object.fromEntries(['idempotencyKey','rawHash','txid','submitContextHash','accountScopeHash'].map(k=>[k,r[k]]));
class Journal {
 rows=new Map();
 async beginSubmitBatch(ids){
  const old=ids.map(id=>this.rows.get(id.idempotencyKey)??null);
  old.forEach((r,i)=>{if(r)assert.deepEqual(identity(r),ids[i]);});
  if(old.some(Boolean))return {created:false,records:copy(old)};
  for(const id of ids)for(const r of this.rows.values())if(r.txid===id.txid||r.rawHash===id.rawHash)assert.equal(r.state,'not-submitted');
  for(const id of ids)this.rows.set(id.idempotencyKey,{...copy(id),state:'prepared',createdAt:'2026-10-13T08:00:00.000Z'});
  return {created:true,records:copy(ids.map(i=>this.rows.get(i.idempotencyKey)))};
 }
 async beginSubmit(id){const p=await this.beginSubmitBatch([id]);return {created:p.created,record:p.records[0]};}
 async read(k){return copy(this.rows.get(k)??null);}
 async readByTxids(ids){return copy([...this.rows.values()].filter(r=>ids.includes(r.txid)));}
 async markUncertain(id){const r=this.rows.get(id.idempotencyKey);assert.deepEqual(identity(r),id);if(r.state==='prepared')r.state='uncertain';return copy(r);}
 async complete(id,result){const r=this.rows.get(id.idempotencyKey);assert.deepEqual(identity(r),identity(id));assert.equal(result.txid,r.txid);if(r.state==='completed')assert.deepEqual(r.result,result);else{assert.notEqual(r.state,'not-submitted');r.state='completed';r.result=copy(result);}return copy(r);}
 async abortPreNetwork(id,evidence){assert.equal(evidence.kind,'local-preflight');const r=this.rows.get(id.idempotencyKey);assert.equal(r.state,'prepared');r.state='not-submitted';r.result={txid:id.txid,status:'rejected',reason:'TBC Testnet transaction was not submitted'};return copy(r);}
 async listIncomplete(){return copy([...this.rows.values()].filter(r=>r.state==='prepared'||r.state==='uncertain'));}
}
const cases=[];
async function make(name,{batch=false,networkName='testnet',custom=false,mode='accepted',preflight=null,status='unknown',steps=['submit']}={}){
 const options={network:networkName,...custom?{endpoint:{kind:'trusted-custom',apiOrigin:'https://node.example',rpcOrigin:'https://rpc.example',trustId:'partner-local'}}:{}};
 const network=o.kit.createTbcNetworkContext(options),journal=new Journal(),trace=[];let account='1'.repeat(64);
 const err=code=>Object.assign(Error('public fixture only'),{name:'TestnetNodeError',code});
 const client={
  async preflightBroadcast(raw){trace.push({kind:'preflight',rawHash:sha(Buffer.from(raw,'hex'))});if(preflight)throw err(preflight);},
  async broadcast(raw){trace.push({kind:'single-post',rawHash:sha(Buffer.from(raw,'hex'))});if(mode==='timeout')throw Error('public timeout');return {txid:mode==='wrong-id'?'f'.repeat(64):txs.find(t=>t.rawTransaction===raw).txid};},
  async broadcastBatch(raws){trace.push({kind:'batch-post',rawHashes:raws.map(raw=>sha(Buffer.from(raw,'hex')))});if(mode==='timeout')throw Error('public timeout');return raws.map((raw,i)=>({txid:mode==='wrong-id'?'f'.repeat(64):txs.find(t=>t.rawTransaction===raw).txid,status:mode==='parent-rejected'&&i===0?'rejected':mode==='parent-unknown'&&i===0?'unknown':'accepted',...(mode==='parent-rejected'&&i===0?{reason:'public fixture rejection'}:{})}));},
  async getTransactionStatus(txid){trace.push({kind:'status',txid});if(status==='timeout')throw err('NODE_REQUEST_FAILED');return {txid:status==='wrong-id'?'f'.repeat(64):txid,status:status==='wrong-id'?'confirmed':status==='contradiction'?'mempool':status,...['confirmed','mempool','contradiction'].includes(status)?{confirmations:status==='mempool'?'0':'2'}:{}};},
 };
 const port=o.kit.createDefaultTbcBroadcast({network,journal,client,accountScopeHash:async()=>account}),actions=[],results=[];
 const operation=batch?'broadcast.submitBatch':'broadcast.submit';
 let params={version:'1.0',chainId:network.chainId,...batch?{transactions:copy(txs)}:{transaction:copy(txs[0])},idempotencyKey:'send-'+name};
 const call=p=>({callId:'call-'+name,operation,params:copy(p),execution:{type:'session-only'}});
 for(const step of steps){
  if(typeof step==='object'){
   actions.push(step);
   if(step.mode!==undefined)mode=step.mode;
   if(step.preflight!==undefined)preflight=step.preflight;
   if(step.status!==undefined)status=step.status;
   if(step.account!==undefined)account=step.account;
   if(step.key!==undefined)params={...params,idempotencyKey:step.key};
   continue;
  }
  let action,result;
  if(step==='recover'||step==='missing-recover'){
   const ids=step==='missing-recover'?['e'.repeat(64)]:batch?txs.map(t=>t.txid):[txs[0].txid];
   action={kind:'recover',txids:ids};result=await port.recover(ids);
  }else if(step==='reconcile'){
   const p={version:'1.0',chainId:network.chainId,txids:batch?txs.map(t=>t.txid):[txs[0].txid]},c={callId:'reconcile-'+name,operation:'broadcast.reconcile',params:p,execution:{type:'session-only'}};
   action={kind:'reconcile',params:p,call:c};result=await port.reconcile(p,c);
  }else{
   const p=copy(params),c=call(p);
   if(step==='wrong-chain')p.chainId=networkName==='testnet'?'tbc:mainnet':'tbc:testnet';
   if(step==='wrong-txid')(batch?p.transactions[0]:p.transaction).txid='f'.repeat(64);
   if(step==='unknown-field')p.unexpected=true;
   if(step==='duplicate-batch')p.transactions=[...p.transactions,p.transactions[0]];
   c.params=copy(p);
   if(step==='mismatched-call')c.params.idempotencyKey='tampered';
   if(step==='missing-call')action={kind:batch?'batch':'single',params:p,call:null};else action={kind:batch?'batch':'single',params:p,call:c};
   result=batch?await port.submitBatch(p,action.call):await port.submit(p,action.call);
  }
  actions.push(action);results.push(copy(result));
 }
 cases.push({name,options,sourceIdentity:network.sourceIdentity,initial:{mode:arguments[1]?.mode??'accepted',preflight:arguments[1]?.preflight??null,status:arguments[1]?.status??'unknown',account:'1'.repeat(64)},actions,results,trace,records:copy([...journal.rows.values()])});
}
await make('single-accepted-replay',{steps:['submit','submit']});
await make('single-unknown-replay',{mode:'timeout',steps:['submit','submit','recover']});
await make('single-unknown-confirmed',{mode:'timeout',status:'confirmed',steps:['submit','recover']});
await make('single-unknown-mempool',{mode:'timeout',status:'mempool',steps:['submit','recover']});
await make('single-wrong-id',{mode:'wrong-id'});
await make('single-preflight-abort',{preflight:'INVALID_INPUT',steps:['submit','submit']});
await make('single-preflight-new-key',{preflight:'NODE_RESPONSE_INVALID',steps:['submit',{preflight:null,key:'fresh-authorized-request'},'submit']});
await make('single-preflight-unavailable',{preflight:'NODE_REQUEST_FAILED',steps:['submit','submit']});
await make('single-account-isolation',{mode:'timeout',steps:['submit',{account:'2'.repeat(64)},'recover']});
await make('single-status-contradiction',{mode:'timeout',status:'contradiction',steps:['submit','recover']});
await make('single-status-wrong-id',{mode:'timeout',status:'wrong-id',steps:['submit','recover']});
await make('single-status-timeout',{mode:'timeout',status:'timeout',steps:['submit','recover']});
await make('single-recover-unrecorded',{steps:['missing-recover']});
await make('single-accepted-reconcile',{status:'confirmed',steps:['submit','reconcile']});
await make('single-accepted-rejected',{status:'rejected',steps:['submit','reconcile']});
for(const step of ['missing-call','mismatched-call','wrong-chain','wrong-txid','unknown-field'])await make(step,{steps:[step]});
await make('batch-accepted-replay',{batch:true,steps:['submit','submit']});
await make('batch-unknown-confirmed',{batch:true,mode:'timeout',status:'confirmed',steps:['submit','submit','recover']});
await make('batch-parent-rejected',{batch:true,mode:'parent-rejected'});
await make('batch-parent-unknown',{batch:true,mode:'parent-unknown'});
await make('batch-wrong-id',{batch:true,mode:'wrong-id'});
await make('batch-preflight-failed',{batch:true,preflight:'INVALID_INPUT'});
await make('batch-duplicate',{batch:true,steps:['duplicate-batch']});
await make('mainnet-local-only',{networkName:'mainnet'});
await make('custom-source-local-only',{custom:true});
const report={status:'FROZEN_BROADCAST_PORT_REFERENCE',archiveSha256:o.archiveSha256,sourceFixtureSha256:sha(source),cases,liveHttp:0,broadcasts:0,proof:'Frozen Kit default broadcast state/response/identity behavior with a TEST journal and synthetic node responses; not durable native, Provider, device or chain acceptance.'};
const bytes=JSON.stringify(report,null,2)+'\n';await writeFile(join(base,'test/fixtures/broadcast-port.json'),bytes,{flag:'wx'});
console.log(JSON.stringify({status:report.status,cases:cases.length,sha256:sha(bytes),scratch:o.work}));
