import assert from 'node:assert/strict';
import{readFile,writeFile,mkdir}from'node:fs/promises';import{resolve,join}from'node:path';import{execFileSync as exec}from'node:child_process';import{createRequire}from'node:module';
import{publicAccountFromProof}from'/Users/alex/Documents/Codex/2026-09-02/tws-standard-mobile-p0/native/kit-runtime/closed-loop/testnet-public-identity.mjs';
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.verify/rc25-real'),json=async p=>JSON.parse(await readFile(p));
const c=await json(join(out,'candidate.json')), [action,platform,kind]=process.argv.slice(2);assert(['ios','android'].includes(platform));
const adb='/Users/alex/Library/Android/sdk/platform-tools/adb';const ar=(args,input)=>exec(adb,['-s',c.androidSerial,...args],{encoding:'utf8',input});
const container=platform==='ios'?exec('xcrun',['simctl','get_app_container',c.iosUDID,c.iosBundle,'data'],{encoding:'utf8'}).trim():null;
const read=async f=>platform==='ios'?readFile(join(container,'Documents',f),'utf8'):ar(['exec-out','run-as',c.androidBundle,'cat','files/'+f]);
const save=(f,v,exclusive=false)=>writeFile(join(out,f),JSON.stringify(v,null,2),{mode:0o600,...(exclusive?{flag:'wx'}:{})});
const writeApp=async(f,value)=>{const bytes=JSON.stringify(value);if(platform==='ios')await writeFile(join(container,'Documents',f),bytes,{mode:0o600,flag:'wx'});else ar(['shell','run-as',c.androidBundle,'sh','-c',"'test ! -e files/"+f+" && cat > files/"+f+"'"],bytes);};
if(action==='bind'){
 const proof=JSON.parse(await read('testnet-identity-proof.json'));
 const {secp256k1}=createRequire(join(c.consumer,'package.json'))('@noble/curves/secp256k1');
 const account=publicAccountFromProof(proof,secp256k1);await save(platform+'-account.json',{proof,account},true);await writeApp('real-account.json',{proof,account});console.log(JSON.stringify({platform,address:account.address,keyExported:false}));
}else if(action==='stage'){
 const a=(await json(join(out,platform+'-account.json'))).account;let request;
 if(kind==='collection'){
  const profile=await json(join(out,'collection-profile.json'));request={method:'tbc_sendTransaction',params:{version:'1.0',chainId:'tbc:testnet',from:a.address,clientRequestId:'rc25-'+platform+'-collection',intent:profile.intent,constraints:{maxFee:profile.maxFee}}};
 }else if(['mint11','mint11-envelope','partial-budget','partial-budget-after-expiry','partial-budget-new-process','expired-unused-slot','expiry-during-approval','expiry-during-approval-ready'].includes(kind)){
  if(kind==='expiry-during-approval-ready'){
   const live=JSON.parse(await read('report.json'));assert(live.results.every(r=>r.method==='tbc_accounts'),'Prior staged mint request must never have entered wallet');
   for(const key of ['job.approve','signer.sign','broadcast.POST'])assert.equal(live.counts[key]??0,0);
   await save('private/'+platform+'-unexecuted-expiry-stage-proof.json',{at:new Date().toISOString(),counts:live.counts,processID:live.processID},true);
  }
  if(kind==='partial-budget-new-process'){
   const failed=await json(join(out,'private',platform+(platform==='ios'?'-partial-budget-after-expiry':'-partial-budget')+'-report.json'));
   const base=await json(join(out,'private',platform+(platform==='ios'?'-mint11-envelope':'-mint11')+'-report.json'));
   assert.equal(failed.results.at(-1).code,'-32603');
   for(const key of ['broadcast.POST','signer.sign','approved'])assert.equal(failed.counts[key],base.counts[key],'Prior harness rejection must have no signing/submission effects');
  }
  if(kind==='partial-budget-after-expiry'){
   const expired=await json(join(out,'private',platform+'-expired-before-dispatch-report.json'));
   const base=await json(join(out,'private',platform+'-mint11-envelope-report.json'));
   assert.equal(expired.results.at(-1).publicResult.reason,'expired');assert.equal(expired.results.at(-1).publicResult.minted,0);
   for(const key of ['broadcast.POST','signer.sign','approved','http.GET'])assert.equal(expired.counts[key],base.counts[key],'Expired request must have no effects');
  }
  if(kind.startsWith('partial-budget')){
   const completed=await json(join(out,'private',platform+(platform==='ios'?'-mint11-envelope':'-mint11')+'-report.json'));
   assert.equal(completed.results.at(-1).publicResult.status,'complete');
   assert.equal(completed.results.at(-1).publicResult.minted,11);
  }
  if(kind==='mint11-envelope'){
   const failed=await json(join(out,'private',platform+'-mint11-report.json'));
   assert.equal(failed.results.at(-1).code,'-32602');
   const base=await json(join(out,'private',platform+'-collection-report.json'));
   for(const key of ['broadcast.POST','signer.sign','approved'])assert.equal(failed.counts[key],base.counts[key],'No effects before correcting the test request');
  }
  const previous=await json(join(out,'private',platform+'-collection-report.json'));
  const result=previous.results.at(-1).publicResult,txs=result.transactions??result.bundle?.transactions;assert.equal(txs.length,1);assert(['submitted','accepted','known'].includes(txs[0].status));
  request={method:'tbc_runNftMintJob',params:{version:'1.0',chainId:'tbc:testnet',from:a.address,collectionId:txs[0].txid,items:Array.from({length:11},(_,i)=>({slot:i+1,name:'RC25 '+platform+' '+(i+1),symbol:'R25',description:'Testnet targeted batch',attributes:[],media:{kind:'uri',uri:'https://example.com/rc25/'+platform+'/'+(i+1)}})),limits:{maxTotalFee:'10000',expiresAt:new Date(Date.now()+120000).toISOString()}}};
  if(kind.startsWith('partial-budget')){
   request.params.items=request.params.items.map(i=>({...i,slot:i.slot+11,name:'RC25 '+platform+' '+(i.slot+11),media:{kind:'uri',uri:'https://example.com/rc25/'+platform+'/'+(i.slot+11)}}));
   request.params.limits.maxTotalFee='850';
  }
  if(kind==='expired-unused-slot'||kind.startsWith('expiry-during-approval')){
   const partial=await json(join(out,'private',platform+'-partial-budget-new-process-report.json'));
   assert.equal(partial.results.at(-1).publicResult.minted,10);assert.equal(partial.results.at(-1).publicResult.reason,'fee-budget');
   request.params.items=[{...request.params.items[0],slot:22,name:'Expired request must not mint slot 22'}];
   request.params.limits.expiresAt=new Date(Date.now()+(kind.startsWith('expiry-during-approval')?20000:-1000)).toISOString();
  }
 }else throw Error('Unknown case');
 await save('private/dispatch-'+platform+'-'+kind+'.json',{at:new Date().toISOString(),request},true);
 if(platform==='ios')await save('private/current-request.json',request);
 else ar(['shell','run-as',c.androidBundle,'sh','-c',"'cat > files/current-request.json'"],JSON.stringify(request));
 console.log('STAGED_ONLY '+platform+' '+kind);
}else if(action==='capture'){
 const r=JSON.parse(await read('report.json'));assert.equal(r.candidate,'0.1.0-rc.25');await save('private/'+platform+'-'+kind+'-report.json',r);
 const last=r.results?.at(-1),all=r.metrics??[],returns=all.map((v,i)=>v.phase==='wallet-return'?i:-1).filter(i=>i>=0);
 const dispatched=await json(join(out,'private','dispatch-'+platform+'-'+kind+'.json')).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
 if(dispatched)assert(Date.parse(last.time)>=Date.parse(dispatched.at),'Capture only a completed current request, never an in-flight stale result');
 const m=all.slice((returns.at(-2)??-1)+1,returns.at(-1)+1),approval=m.filter(x=>x.phase==='approved').at(-1),signs=m.filter(x=>x.phase==='signature'),ret=m.filter(x=>x.phase==='wallet-return').at(-1);
 const evidence={platform,kind,candidate:r.candidate,account:r.account?.address,last:last?{method:last.method,outcome:last.outcome,code:last.code,publicResult:last.publicResult}:null,counts:r.counts,approvalToSignMs:signs.length?signs.at(-1).monoMs-approval.monoMs:null,approvalToReturnMs:ret&&approval?ret.monoMs-approval.monoMs:null,nativeSignMs:signs.reduce((s,x)=>s+x.nativeMs,0),signatureCount:signs.length,metrics:m};
 await mkdir(join(root,'docs/acceptance/evidence/rc25-devices'),{recursive:true});
 await writeFile(join(root,'docs/acceptance/evidence/rc25-devices',platform+'-'+kind+'.json'),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({...evidence,metrics:undefined,last:last?{method:last.method,outcome:last.outcome,code:last.code,keys:Object.keys(last.publicResult??{}),status:last.publicResult?.status,reason:last.publicResult?.reason,minted:last.publicResult?.minted}:null}));
}else throw Error('action');
