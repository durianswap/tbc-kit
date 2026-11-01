import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync as exec} from 'node:child_process';
import {createServer} from 'node:http';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.verify/rc26-ui'),prior=join(root,'.verify/rc25-real'),[action,platform]=process.argv.slice(2);
const config=JSON.parse(await readFile(join(out,'build.json'))),adb='/Users/alex/Library/Android/sdk/platform-tools/adb';
const ar=(args,input)=>exec(adb,['-s',config.androidSerial,...args],{encoding:'utf8',input,maxBuffer:8e6});
if(action==='serve'){
 createServer((q,r)=>{void(async()=>{if(q.method==='GET'&&(q.url==='/'||q.url==='/current.json')){r.setHeader('cache-control','no-store');r.setHeader('content-type',q.url==='/'?'text/html':'application/json');r.end(await readFile(join(out,q.url==='/'?'dapp.html':'private/current-request.json')));return;}if(q.method==='POST'&&q.url==='/result'){let body='';for await(const b of q){body+=b;if(body.length>1e6)throw Error('oversize')}const v=JSON.parse(body);console.log(JSON.stringify({ok:v.ok,code:v.code,status:v.result?.status,reason:v.result?.reason,minted:v.result?.minted}));r.end('{}');return;}r.writeHead(404);r.end()})().catch(()=>{r.writeHead(500);r.end()})}).listen(4197,'127.0.0.1',()=>console.log('RC26 expiry-only DApp ready'));
}else{
 assert(['ios','android'].includes(platform));
 const container=platform==='ios'?exec('xcrun',['simctl','get_app_container',config.iosUDID,config.iosBundle,'data'],{encoding:'utf8'}).trim():null;
 const report=async()=>JSON.parse(platform==='ios'?await readFile(join(container,'Documents/report.json'),'utf8'):ar(['exec-out','run-as',config.androidBundle,'cat','files/report.json']));
 const putRequest=async req=>{if(platform==='ios')await writeFile(join(out,'private/current-request.json'),JSON.stringify(req),{mode:0o600});else ar(['shell','run-as',config.androidBundle,'sh','-c',"'cat > files/current-request.json'"],JSON.stringify(req))};
 if(action==='accounts'){await putRequest({method:'tbc_accounts'});console.log('accounts only')}
 else if(action==='stage'){
  const before=await report();assert.equal(before.results.at(-1)?.method,'tbc_accounts','Read current account before staging');
  assert.equal(before.counts['signer.sign']??0,0);assert.equal(before.counts['broadcast.POST']??0,0);
  const a=JSON.parse(await readFile(join(prior,platform+'-account.json'))).account;
  const r=JSON.parse(await readFile(join(prior,'private/dispatch-'+platform+'-'+(platform==='ios'?'expiry-during-approval':'expiry-during-approval-ready')+'.json'))).request;
  assert.equal(r.params.from,a.address);assert.equal(r.params.items.length,1);assert.equal(r.params.items[0].slot,22);
  const expiresAt=new Date(Date.now()+30000).toISOString();r.params.limits.expiresAt=expiresAt;
  await writeFile(join(out,'private',platform+'-dispatch.json'),JSON.stringify({at:new Date().toISOString(),beforeCounts:before.counts,request:r},null,2),{flag:'wx',mode:0o600});
  await putRequest(r);console.log(JSON.stringify({platform,staged:true,expiresAt,rule:'Click Execute now; approve only after expiresAt',slot:22}));
 }else if(action==='capture'){
  const dispatch=JSON.parse(await readFile(join(out,'private',platform+'-dispatch.json'))),r=await report(),last=r.results.at(-1);
  assert(last?.time>=dispatch.at);assert.equal(last.method,'tbc_runNftMintJob');
  assert.equal(last.publicResult?.status,'stopped');assert.equal(last.publicResult?.reason,'expired');assert.equal(last.publicResult?.minted,0);assert.deepEqual(last.publicResult?.batches,[]);
  const deltas=Object.fromEntries(['approvalUI','job.approve','approved','job.authorize','signer.sign','broadcast.POST','http.GET'].map(k=>[k,(r.counts[k]??0)-(dispatch.beforeCounts[k]??0)]));
  assert.equal(deltas.approvalUI,1);assert.equal(deltas['job.approve'],1);assert.equal(deltas['signer.sign'],0);assert.equal(deltas['broadcast.POST'],0);
  const evidence={status:'PASS',platform,loadedKit:config.kit,jsSha256:platform==='ios'?config.iosJS:config.androidJS,nativeSdk:config.nativeSdk,harnessReportingVersion:config.harnessReportingVersion,expiresAt:dispatch.request.params.limits.expiresAt,last,deltas,metrics:r.metrics,scope:'real DApp bridge and native approval; expiry-only, zero signing and broadcast'};
  await writeFile(join(root,'docs/acceptance/evidence/rc26-devices',platform+'-ui-expiry.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({status:evidence.status,platform,result:last.publicResult,deltas}));
 }else throw Error('Unknown action');
}
