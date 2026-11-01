import{createServer}from'node:http';import{readFile,appendFile}from'node:fs/promises';import{resolve,join}from'node:path';
const root=resolve(import.meta.dirname,'../../../.verify/rc25-real');
createServer((q,r)=>{void(async()=>{
 if(q.method==='GET'&&(q.url==='/'||q.url==='/current.json')){r.setHeader('cache-control','no-store');r.setHeader('content-type',q.url==='/'?'text/html':'application/json');r.end(await readFile(join(root,q.url==='/'?'dapp.html':'private/current-request.json')));return;}
 if(q.method==='POST'&&q.url==='/result'){let data='';for await(const b of q){data+=b;if(data.length>4194304)throw Error('Size');}const v=JSON.parse(data);await appendFile(join(root,'private/page-results.jsonl'),JSON.stringify({at:new Date().toISOString(),...v})+'\n',{mode:0o600});console.log(JSON.stringify({method:v.method,ok:v.ok,code:v.code,status:v.result?.status,minted:v.result?.minted}));r.end('{}');return;}r.writeHead(404);r.end();
 })().catch(e=>{if(!r.headersSent)r.writeHead(500);r.end();console.error(e.message);});}).listen(4197,'127.0.0.1',()=>console.log('RC25 DAPP READY'));
