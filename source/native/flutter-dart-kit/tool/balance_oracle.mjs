// Frozen package oracle only; transport never reaches the public network.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {verifiedKitCandidate} from '../../flutter/scripts/candidate-inputs.mjs';
const [kitArg,output]=process.argv.slice(2);assert(kitArg&&output);
const kit=resolve(kitArg),identity=await verifiedKitCandidate(kit);
const {createLegacyTbcBalanceReader,createTbcNetworkContext}=await import(pathToFileURL(join(kit,'dist/esm/wallet.node.js')));
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',cases=[];
const responses=[...['0','1','1000000','1000001','9007199254740991'].map(balance=>({balance})),
 ...[0,1,1000001,9007199254740991].map(balance=>({address,balance})),
 {balance:-1},{balance:1.5},{balance:'01'},{balance:'1e6'},{balance:'9007199254740992'},
 {balance:true},{},{balance:0,address:null},{balance:0,address:'wrong'}];
for(const networkName of ['mainnet','testnet'])for(const response of responses){
 const network=createTbcNetworkContext({network:networkName}),calls=[];
 const reader=createLegacyTbcBalanceReader({network,fetch:async(url,init)=>{
  assert.equal(String(url),network.endpoint.apiOrigin+'/api/tbc/balance/address/'+address);
  assert.equal(init.method,'GET');calls.push(String(url));
  return new Response(JSON.stringify({code:200,data:response}),{status:200,headers:{'content-type':'application/json'}});
 }});
 let expected;try{expected={result:await reader.read(address)};}catch{expected={rejected:true};}
 assert.equal(calls.length,1);cases.push({network:networkName,address,response,...expected,calls});
}
const source=await readFile(new URL(import.meta.url));
const report={status:'FROZEN_KIT_BALANCE_ORACLE',identity,cases,externalHttp:0,broadcasts:0,
 generatorSha256:createHash('sha256').update(source).digest('hex')};
await writeFile(resolve(output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,cases:cases.length,output}));
