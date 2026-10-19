import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
// Export the actual private source helper for this test only. No package API.
const source=await readFile(new URL('../src/wallet-runtime.ts',import.meta.url),'utf8');
const output=await build({stdin:{contents:source+'\nexport { approvalPreparationWarningScope };',loader:'ts',
 resolveDir:fileURLToPath(new URL('../src/',import.meta.url))},bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const {approvalPreparationWarningScope}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
test('wallet-built funding prerequisite is disclosed before consent, never inferred from later warnings',()=>{
 const intent={type:'tbc.pool.liquidity.add'};
 for(const method of ['tbc_signTransaction','tbc_sendTransaction']){
  assert.deepEqual(approvalPreparationWarningScope({method,params:{intent}}),['MULTI_TRANSACTION','MAINTENANCE_TRANSACTION']);
 }
 for(const method of ['tbc_signWorkflow','tbc_sendWorkflow','tbc_signPreparedWorkflow','tbc_sendPreparedWorkflow']){
  assert.deepEqual(approvalPreparationWarningScope({method,params:{steps:[{kind:'transaction',intent}]}}),['MULTI_TRANSACTION','MAINTENANCE_TRANSACTION']);
  assert.deepEqual(approvalPreparationWarningScope({method,params:{steps:[{kind:'preparedTransaction',intent}]}}),[]);
 }
 for(const method of ['tbc_signPreparedTransaction','tbc_signReviewedTransaction','tbc_signMessage']){
  assert.deepEqual(approvalPreparationWarningScope({method,params:{intent}}),[]);
 }
 const mint=approvalPreparationWarningScope({method:'tbc_signTransaction',params:{intent:{type:'tbc.ft.create'}}});
 assert.deepEqual(mint,['FT_MINT_V4','MULTI_TRANSACTION','MAINTENANCE_TRANSACTION']);
 assert.ok(!mint.includes('UNKNOWN_RISK'));
});
for(const method of ['tbc_signWorkflow','tbc_sendWorkflow','tbc_signPreparedWorkflow','tbc_sendPreparedWorkflow']){
 test(method+' discloses dynamic txid binding in early consent',()=>{
  const params={steps:[{id:'trade',kind:method.includes('Prepared')?'preparedTransaction':'transaction',dependsOn:[]},
   {id:'message',kind:'typedData',dependsOn:['trade'],bindings:[{target:'/message/txids',source:{stepId:'trade',output:'transactionIds'}}]}]};
  assert.deepEqual(approvalPreparationWarningScope({id:'public-scope',method,params}),['DYNAMIC_BINDING']);
  const noBinding=structuredClone(params);delete noBinding.steps[1].bindings;
  assert.deepEqual(approvalPreparationWarningScope({id:'public-scope',method,params:noBinding}),[]);
 });
}
test('unknown and unrelated methods do not gain a workflow warning scope',()=>{
 for(const method of ['tbc_signMessage','unknown'])assert.deepEqual(approvalPreparationWarningScope({method,params:{steps:[{bindings:[{}]}]}}),[]);
});
for(const method of ['tbc_signWorkflow','tbc_sendWorkflow'])test(method+' discloses nested Reviewed transaction count before consent',()=>{
 const step=(format,count)=>({id:'reviewed',kind:'reviewedTransaction',dependsOn:[],request:{payload:format==='raw'
  ?{format,transactions:Array.from({length:count},()=>({}))}:{format,children:Array.from({length:count-1},()=>({}))}}});
 const message={id:'message',kind:'message',dependsOn:['reviewed'],bindings:[{target:'txids',source:{stepId:'reviewed',output:'transactionIds'}}]};
 for(const format of ['raw','associated']){
  assert.deepEqual(approvalPreparationWarningScope({method,params:{steps:[step(format,2),message]}}),['MULTI_TRANSACTION','DYNAMIC_BINDING']);
  assert.deepEqual(approvalPreparationWarningScope({method,params:{steps:[step(format,1),message]}}),['DYNAMIC_BINDING']);
  assert.deepEqual(approvalPreparationWarningScope({method,params:{steps:[step(format,2)]}}),['MULTI_TRANSACTION']);
 }
 assert.deepEqual(approvalPreparationWarningScope({method,params:{steps:[{kind:'transaction',request:step('raw',2).request}]}}),[]);
 assert.deepEqual(approvalPreparationWarningScope({method,params:{steps:[{kind:'reviewedTransaction',request:{payload:{format:'unknown',children:[{}]}}}]}}),[]);
});
