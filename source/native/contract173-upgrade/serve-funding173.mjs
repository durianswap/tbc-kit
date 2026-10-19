// Funding only: the existing accepted Testnet wallet owns custody and sending.
// This does not constitute new-candidate acceptance. Never replay a started id.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..'),out=join(root,'release/contract173-live-20261014-a/funding');
await mkdir(out,{recursive:true});
const account=JSON.parse(await readFile(join(root,'native/flutter-dart-live-token-exploration/evidence/private-accounts-20261012-a/accounts.json'))).accounts.ios;
const source='1G7dCALWf4fdM8ZwEvwXyXE8KcbLz5G1bm',chainId='tbc:testnet';
const steps=[
 {id:'ios-native173-a',intent:{version:'1.0',type:'tbc.transfer',to:account.address,amount:'1000000'}},
 {id:'ios-token173-a',intent:{version:'1.0',type:'tbc20-standard-transfer',contractId:'90ce67feb65b6727b79a95d67df4a042a7f89ac4102a2d671f02f7b727a78d31',to:account.address,amount:'100000000'}},
];
const page=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px system-ui;padding:20px}button{width:100%;padding:14px;margin:8px 0}pre{white-space:pre-wrap}</style>
<h2>Contract 1.7.3 funding</h2><p>Testnet only: 1 TBC and 100 tokens to the private iOS acceptance account. Fee limit 0.005 TBC per request.</p>
<button id="start">Start bounded funding</button><pre id="status">Discovering</pre><script>
const source=${JSON.stringify(source)},chainId=${JSON.stringify(chainId)},steps=${JSON.stringify(steps)};
let wallet,busy=false;const status=document.querySelector('#status');
const api={register(w){if(w.features['tbc:provider']){wallet=w;status.textContent='Wallet discovered';}return()=>{};}};
window.addEventListener('wallet-standard:register-wallet',e=>e.detail(api));window.dispatchEvent(new CustomEvent('wallet-standard:app-ready',{detail:api}));
const request=(method,params)=>wallet.features['tbc:provider'].provider.request({method,...(params===undefined?{}:{params})});
document.querySelector('#start').onclick=async()=>{if(busy)return;busy=true;
try{await request('wallet_requestPermissions',[{tbc_accounts:{chains:[chainId],maxAccounts:1},tbc_sendTransaction:{chains:[chainId]}}]);
if(!JSON.stringify(await request('tbc_accounts')).includes(source))throw Error('Wrong funding account');
for(const step of steps){
 const guard=await fetch('/start/'+step.id,{method:'POST'});if(guard.status!==201)throw Error('Already admitted: reconcile only');
 status.textContent='Approve '+step.id+' to '+step.intent.to+' amount '+step.intent.amount;
 try{const r=await request('tbc_sendTransaction',{version:'1.0',chainId,from:source,intent:step.intent,constraints:{maxFee:'5000'}});
 const transactions=r.transactions.map(x=>({txid:x.txid,status:x.status,role:x.role}));
 await fetch('/result/'+step.id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:'returned',totalFee:r.totalFee,transactions})});
 if(transactions.some(x=>x.status!=='submitted'))throw Error('Unknown submit status');
 }catch(e){await fetch('/error/'+step.id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:'stopped-reconcile',code:e.code??null})});throw e;}
}
status.textContent='FUNDING173_RETURNED — node verification required';
}catch(e){status.textContent='STOP: reconcile before continuing';}};
</script>`;
createServer(async(req,res)=>{try{
 if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(page);return;}
 assert.equal(req.method,'POST');assert.equal(req.headers.origin,'http://127.0.0.1:42016');
 const m=/^\/(start|result|error)\/(ios-(?:native|token)173-a)$/.exec(req.url);assert(m);
 const step=steps.find(s=>s.id===m[2]);assert(step);
 if(m[1]==='start'){await writeFile(join(out,step.id+'.started.json'),JSON.stringify({startedAt:new Date().toISOString(),source,chainId,...step}),{flag:'wx'});res.writeHead(201);res.end('started');return;}
 let body='';for await(const c of req){body+=c;assert(body.length<8192);}
 const data=JSON.parse(body);assert(['returned','stopped-reconcile'].includes(data.status));
 await readFile(join(out,step.id+'.started.json'));
 await writeFile(join(out,step.id+'.'+m[1]+'.json'),JSON.stringify({recordedAt:new Date().toISOString(),...data},null,2)+'\n',{flag:'wx'});
 res.writeHead(200);res.end('recorded');console.log(JSON.stringify({id:step.id,status:data.status,txids:data.transactions?.map(t=>t.txid)}));
}catch(e){res.writeHead(e.code==='EEXIST'?409:400);res.end('Stopped; reconcile');}}).listen(42016,'127.0.0.1',()=>console.log('BOUNDED_FUNDING173_READY'));
