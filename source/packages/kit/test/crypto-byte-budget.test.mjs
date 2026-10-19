import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
const moduleUrl=process.env.TBC_KIT_WALLET_TEST_MODULE
  ?pathToFileURL(process.env.TBC_KIT_WALLET_TEST_MODULE).href:new URL('../dist/esm/wallet.js',import.meta.url).href;
const {assertValidTws,assertTbcProviderRequest}=await import(moduleUrl);
const base={version:'1.0',chainId:'tbc:testnet',from:'1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH'};
const algorithm='tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1';
function verify(message,allowed){
 const single={...base,algorithm,message};
 const workflow={...base,steps:[{id:'encrypt',kind:'encrypt',dependsOn:[],algorithm,message}]};
 for(const[name,method,params]of [['encryptRequest','tbc_encrypt',single],['workflowRequest','tbc_signWorkflow',workflow],['workflowRequest','tbc_sendWorkflow',workflow],['preparedWorkflowRequest','tbc_signPreparedWorkflow',workflow],['preparedWorkflowRequest','tbc_sendPreparedWorkflow',workflow]]){
  for(const invoke of [()=>assertValidTws(name,params),()=>assertTbcProviderRequest({jsonrpc:'2.0',id:1,method,params})]){
   if(allowed)assert.doesNotThrow(invoke,method);else assert.throws(invoke,undefined,method);
  }
 }
}
test('new encryption has a 65536 decoded-byte budget at Core and Provider entrances',()=>{
 for(const text of ['', 'hello','中'.repeat(21845)+'a','😀'.repeat(16384)])verify({encoding:'utf8',data:text},true);
 for(const text of ['中'.repeat(21846),'中'.repeat(24000),'😀'.repeat(16385)])verify({encoding:'utf8',data:text},false);
 verify({encoding:'hex',data:'01'.repeat(65536)},true);
 verify({encoding:'base64',data:Buffer.alloc(65536,1).toString('base64')},true);
 for(const n of [65537,65538])verify({encoding:'base64',data:Buffer.alloc(n,1).toString('base64')},false);
});
test('historical UTF-8 decrypt results retain the existing wire union',()=>{
 const result={taskId:'old',algorithm,message:{encoding:'utf8',data:'中'.repeat(24000)}};
 assert.doesNotThrow(()=>assertValidTws('cryptoExecuteResult',result));
 assert.throws(()=>assertValidTws('cryptoExecuteResult',{...result,message:{encoding:'base64',data:Buffer.from(result.message.data).toString('base64')}}));
});
