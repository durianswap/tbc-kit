// Wire-level behavior of the pinned Kit client. Fetch is entirely synthetic.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {base,frozenOracle,sha} from './frozen_oracle.mjs';
const o=await frozenOracle(),input=await readFile(join(base,'test/fixtures/staged-signing.json'));
const txs=JSON.parse(input).cases.find(s=>s.name==='current-ft-staged-transfer').result.transactions.slice(0,2);
const ids=txs.map(t=>t.txid),raws=txs.map(t=>t.rawTransaction),cases=[];
async function run(name,kind,data,{code=200,http=200,message='',rawBody,network='testnet',custom=false,inputOverride}={}){
 const options={network,...custom?{endpoint:{kind:'trusted-custom',apiOrigin:'https://node.example',trustId:'partner-local'}}:{}};
 const context=o.kit.createTbcNetworkContext(options),trace=[];
 const body=rawBody??JSON.stringify({code,message,data});
 const fetch=async(url,init)=>{trace.push({url:String(url),method:init.method,redirect:init.redirect,body:init.body?JSON.parse(init.body):null});return new Response(body,{status:http});};
 const client=o.api.createTbcChainClient({baseUrl:context.endpoint.apiOrigin,allowedOrigins:[context.endpoint.apiOrigin],fetch});
 const supplied=inputOverride??(kind==='batch'?raws:kind==='status'?ids[0]:raws[0]);
 let result;try{result={ok:true,value:await (kind==='batch'?client.broadcastBatch(supplied):kind==='status'?client.getTransactionStatus(supplied):kind==='preflight'?client.preflightBroadcast(supplied):client.broadcast(supplied))??null};}
 catch(e){result={ok:false,code:e.code??'UNCLASSIFIED'};}
 cases.push({name,kind,options,input:supplied,response:{http,body},result,trace});
}
await run('single-success','single',{txid:ids[0]});
await run('single-wrong-id','single',{txid:ids[1]});
await run('single-uppercase-id','single',{txid:ids[0].toUpperCase()});
await run('single-missing-id','single',{});
await run('single-null-data','single',null);
await run('single-api-rejection','single',null,{code:400,message:'invalid transaction'});
await run('single-http-redirect','single',null,{http:302});
await run('single-invalid-json','single',null,{rawBody:'{"code":200'});
await run('single-mainnet-config-only','single',{txid:ids[0]},{network:'mainnet'});
await run('single-custom-config-only','single',{txid:ids[0]},{custom:true});
await run('preflight-no-http','preflight',null);
await run('preflight-invalid-hex','preflight',null,{inputOverride:'xyz'});
await run('batch-accepted-strings','batch',{success:2,failed:0,results:ids});
await run('batch-accepted-objects','batch',{success:'2',failed:'0',results:ids.map(txid=>({txid}))});
await run('batch-partial-envelope','batch',{success:1,failed:1,results:[ids[0],{error:'rejected synthetic input'}]},{code:400,message:'Partial Failure'});
await run('batch-missing-items','batch',{success:2,failed:0});
await run('batch-one-item','batch',{success:1,failed:0,results:[ids[0]]});
await run('batch-reordered-items','batch',{success:2,failed:0,results:[ids[1],ids[0]]});
await run('batch-wrong-object-id','batch',{success:1,failed:0,results:[{txid:ids[1]},null]});
await run('batch-empty-string-rejection','batch',{success:0,failed:2,results:['','failure']});
await run('batch-error-wins','batch',{success:0,failed:1,results:[{txid:ids[0],error:'no'}]});
await run('batch-null-error-unknown','batch',{success:0,failed:0,results:[{txid:ids[0],error:null}]});
await run('batch-truncate-reason','batch',{success:0,failed:1,results:['x'.repeat(600)]});
for(const [name,patch] of [
 ['negative-count',{success:-1}],['fraction-count',{success:0.5}],['leading-zero-count',{success:'01'}],
 ['sum-too-large',{success:2,failed:1}],['missing-count',{failed:undefined}],
 ['too-many-items',{results:[...ids,ids[0]]}],['invalid-items',{results:{}}],
 ['unsafe-count',{success:'9007199254740992'}],
])await run('batch-'+name,'batch',{success:1,failed:0,results:ids,...patch});
await run('batch-duplicate-input','batch',null,{inputOverride:[raws[0],raws[0]]});
await run('batch-empty-input','batch',null,{inputOverride:[]});
await run('status-confirmed','status',{txid:ids[0],confirmations:2});
await run('status-mempool','status',{txid:ids[0],confirmations:'0'});
await run('status-http-404','status',null,{http:404});
await run('status-api-404','status',null,{code:404});
await run('status-missing-confirmations','status',{txid:ids[0]});
await run('status-negative-confirmations','status',{txid:ids[0],confirmations:-1});
await run('status-fraction-confirmations','status',{txid:ids[0],confirmations:1.5});
await run('status-wrong-id','status',{txid:ids[1],confirmations:1});
await run('status-invalid-input','status',null,{inputOverride:'not-a-txid'});
await run('status-large-integer-lossless','status',{txid:ids[0]},{rawBody:JSON.stringify({code:200,data:{txid:ids[0]}}).replace('"txid":','"confirmations":9007199254740993,"txid":')});
const report={status:'FROZEN_BROADCAST_CLIENT_REFERENCE',archiveSha256:o.archiveSha256,sourceFixtureSha256:sha(input),cases,liveHttp:0,broadcasts:0,
 proof:'Pinned Kit HTTP/REST response behavior through a synthetic fetch; no native dispatch, SQLite, device or chain proof.'};
const bytes=JSON.stringify(report,null,2)+'\n';await writeFile(join(base,'test/fixtures/broadcast-client.json'),bytes,{flag:'wx'});
console.log(JSON.stringify({status:report.status,cases:cases.length,sha256:sha(bytes),scratch:o.work}));
