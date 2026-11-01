// Read-only chain observation. No wallet, signer, private material or broadcast.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'../../..');
const {createTbcClient}=await import(pathToFileURL(join(root,'packages/kit/dist/esm/index.node.js')));
const {createWasmTbcKeylessEngine}=await import(pathToFileURL(join(root,'packages/kit/dist/esm/wallet.node.js')));
const materialEngine=await createWasmTbcKeylessEngine(await readFile(join(root,'packages/kit/artifacts/wasm/tbc_keyless_wasm.wasm')));
const reads=[];
const client=createTbcClient({network:'testnet',materialEngine,api:{baseUrl:'https://api.tbcdev.org',requestTimeoutMs:20000,async fetch(input,init){
 const url=new URL(String(input));
 if(url.origin!=='https://api.tbcdev.org'||/broadcast|pushtx|sendraw|submit/i.test(url.pathname))throw Error('Not a permitted read');
 const start=performance.now();const response=await fetch(input,init);reads.push({path:url.pathname,method:init?.method??'GET',status:response.status,ms:performance.now()-start});return response;
}}});
let result,error;
try{result=await client.tbc721.getMintStatus({collectionId:'e7f266c86c6b8981fcfdcd377c15d03f1218202dd7466600a42bed16fb9f86ad',address:'164nB7hUpDSx3neWu293wKqW1sRNBg1e3X'});}catch(e){error={message:e.message,code:e.code};}
const report={at:new Date().toISOString(),readOnly:true,realBroadcasts:0,result,error,reads};
const dest=join(root,'docs/acceptance/evidence/rc23-mint100-repro');await mkdir(dest,{recursive:true});await writeFile(join(dest,'chain-observation.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({status:result?.status,availableCount:result?.availableCount,spentCount:result?.spentCount,range200to232Available:result?.availableSlots?.filter(n=>n>=200&&n<=232),range233to299Available:result?.availableSlots?.filter(n=>n>=233&&n<=299).length,reads:reads.length,error}));
