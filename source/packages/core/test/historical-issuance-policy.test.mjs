import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// The delivery runner verifies every installed byte before setting this path.
// Installed mode exercises the shipped Core, never a bundled source substitute.
const installedWallet = process.env.TBC_POLICY_INSTALLED_WALLET;
const bundle = installedWallet ? null : await build({entryPoints:[fileURLToPath(new URL('../src/index.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node'});
const url = new URL('../src/.issuance-policy-test.mjs',import.meta.url).href;
const hooks = installedWallet ? null : registerHooks({resolve(s,c,next){return s===url?{url,shortCircuit:true}:next(s,c);},load(u,c,next){return u===url?{source:bundle.outputFiles[0].text,format:'module',shortCircuit:true}:next(u,c);}});
const tws = await import(installedWallet ? pathToFileURL(installedWallet).href : url); hooks?.deregister();
const read = async name => JSON.parse(await readFile(new URL(`../../../test-vectors/${name}.json`,import.meta.url)));
const integration = await read('integration'), provider = await read('provider');
const context = provider.trustedContexts[0].context, session = provider.providerSessions.sessionA;
const canonical = integration.canonicalTransfer.request, id = '11'.repeat(32);
const disabled = [
  {type:'tbc.ft.create',version:'1.0',name:'Old',symbol:'OLD',decimals:0,initialSupply:'100'},
  {type:'tbc.nft.mint',version:'1.0',collectionId:id,name:'Old',symbol:'OLD',description:'',attributes:[]},
  {type:'tbc.pool.create',version:'1.0',stage:'mint',ftContractId:id,lpPlan:1},
];
async function initial(method,params){
  const core=tws.createTwsCore();
  let step=await core.start({version:'1.0',release:tws.TWS_RELEASE,request:{jsonrpc:'2.0',id:'issuance-check',method,params},currentContext:context,currentSession:session});
  const call=step.checkpoint.payload.pendingCalls[0];
  step=await core.resume({version:'1.0',checkpoint:step.checkpoint,response:{version:'1.0',callId:call.callId,result:{now:'2026-08-31T12:00:00Z'}},currentContext:context,currentSession:session});
  return core.resume({version:'1.0',checkpoint:step.checkpoint,currentContext:context,currentSession:session});
}
function proposal(intent){
  const transfer=integration.canonicalTransfer;
  const payload={version:'1.0',engineProfile:'tbc-engine-plan-v1',
    createdAt:transfer.snapshot.payload.capturedAt,expiresAt:transfer.plan.payload.expiresAt,
    intentHash:tws.hashCanonical(intent),transactions:transfer.plan.payload.transactions.map(tx=>({
      id:tx.id,role:tx.role,dependsOn:tx.dependsOn,kind:'fixed',unsignedTransaction:tx.unsignedTransaction,fee:tx.fee,
    })),evidence:{observedAt:transfer.snapshot.payload.capturedAt,parentTransactions:transfer.snapshot.payload.parents,contracts:[]},estimatedTotalFee:transfer.plan.payload.preview.totalFee};
  // Structurally valid but untrusted DApp bytes. The early intent restriction
  // must reject before either evaluating or fetching these proposed materials.
  return {payload,proposalHash:tws.hashCanonical(payload)};
}
test('historical issuance rejects before permission, account, material, approval or signer ports',async()=>{
  for(const intent of disabled){
    const params={...canonical,intent};
    tws.assertValidTws('transactionRequest',params);
    for(const method of ['tbc_signTransaction','tbc_sendTransaction']){
      const result=await initial(method,params);
      assert.equal(result.completion?.response?.error?.code,4200,intent.type);
      assert.match(result.completion.response.error.message,/Historical asset issuance is disabled/);
      assert.deepEqual(result.checkpoint.payload.pendingCalls,[]);
    }
  }
});
test('entire mixed workflow rejects before executing any allowed predecessor',async()=>{
  for(const intent of disabled)for(const method of ['tbc_signWorkflow','tbc_sendWorkflow']){
    const request={version:'1.0',chainId:canonical.chainId,from:canonical.from,steps:[
      {id:'allowed',kind:'transaction',dependsOn:[],intent:canonical.intent},
      {id:'disabled',kind:'transaction',dependsOn:['allowed'],intent},
    ]};
    tws.assertValidTws('workflowRequest',request);
    const result=await initial(method,request);
    assert.equal(result.completion?.response?.error?.code,4200,intent.type);
    assert.deepEqual(result.checkpoint.payload.pendingCalls,[]);
  }
});
test('Prepared transaction/workflow and repeated NFT mint cannot bypass the same entry policy',async()=>{
  for(const intent of disabled){
    const params={...canonical,intent,proposal:proposal(intent)};
    tws.assertValidTws('preparedTransactionRequest',params);
    for(const method of ['tbc_signPreparedTransaction','tbc_sendPreparedTransaction']){
      const result=await initial(method,params);
      assert.equal(result.completion?.response?.error?.code,4200);
      assert.deepEqual(result.checkpoint.payload.pendingCalls,[]);
    }
    for(const failureMode of ['atomic','continue-independent'])for(const method of ['tbc_signPreparedWorkflow','tbc_sendPreparedWorkflow']){
      const request={version:'1.0',chainId:canonical.chainId,from:canonical.from,failureMode,steps:[
        {id:'allowed',kind:'preparedTransaction',dependsOn:[],intent:canonical.intent,proposal:proposal(canonical.intent)},
        {id:'disabled',kind:'preparedTransaction',dependsOn:[],intent,proposal:proposal(intent)},
      ]};
      tws.assertValidTws('preparedWorkflowRequest',request);
      const result=await initial(method,request);
      assert.equal(result.completion?.response?.error?.code,4200);
      assert.deepEqual(result.checkpoint.payload.pendingCalls,[]);
    }
  }
  const request={version:'1.0',chainId:canonical.chainId,from:canonical.from,steps:[0,1].map(i=>({id:`mint-${i}`,kind:'transaction',dependsOn:[],intent:disabled.find(i=>i.type==='tbc.nft.mint')}))};
  assert.equal((await initial('tbc_signWorkflow',request)).completion.response.error.code,4200);
});
test('historical holder and pool liquidity operations are not classified as issuance',async()=>{
  const intents=[canonical.intent,
    {type:'tbc.ft.transfer',version:'1.0',contractId:id,to:canonical.from,amount:'1'},
    {type:'tbc.ft.merge',version:'1.0',contractId:id},
    {type:'tbc.stablecoin.transfer',version:'1.0',contractId:id,to:canonical.from,amount:'1'},
    {type:'tbc.nft.transfer',version:'1.0',contractId:id,to:canonical.from},
    {type:'tbc.pool.liquidity.add',version:'1.0',poolContractId:id,receiver:canonical.from,tbcAmount:'1000',minimumLpAmount:'1'},
    {type:'tbc.pool.liquidity.remove',version:'1.0',poolContractId:id,receiver:canonical.from,lpAmount:'10',minimumTbcAmount:'1',minimumFtAmount:'1'},
    {type:'tbc.pool.swap.exactTbcForToken',version:'1.0',poolContractId:id,receiver:canonical.from,tbcAmount:'1000',minimumFtAmount:'1'},
    {type:'tbc.pool.swap.exactTokenForTbc',version:'1.0',poolContractId:id,receiver:canonical.from,ftAmount:'1000',minimumTbcAmount:'1'},
    ...['tbc.pool.ft.merge','tbc.pool.ftlp.merge','tbc.pool.ftlp.burn'].map(type=>({type,version:'1.0',poolContractId:id})),
    {type:'tbc20-standard-create',version:'1.0',name:'New',symbol:'NEW',decimals:0,initialSupply:'100'},
  ];
  for(const intent of intents){
    const params={...canonical,intent};tws.assertValidTws('transactionRequest',params);
    const result=await initial('tbc_signTransaction',params);
    assert.equal(result.completion,undefined,intent.type);
    assert.deepEqual(result.checkpoint.payload.pendingCalls.map(c=>c.operation),['permissionStore.load']);
  }
});

test('shared collection format is allowed through ordinary, Prepared and workflow policy',async()=>{
  const intent={type:'tbc.collection.create',version:'1.0',name:'Shared',description:'',supply:'2',media:{kind:'uri',uri:'https://example.test/image.png'}};
  for(const method of ['tbc_signTransaction','tbc_sendTransaction','tbc_signPreparedTransaction','tbc_sendPreparedTransaction',
    'tbc_signWorkflow','tbc_sendWorkflow','tbc_signPreparedWorkflow','tbc_sendPreparedWorkflow']){
    const prepared=method.includes('Prepared'),workflow=method.includes('Workflow');
    const params=workflow?{version:'1.0',chainId:canonical.chainId,from:canonical.from,steps:[{
      id:'collection',kind:prepared?'preparedTransaction':'transaction',dependsOn:[],intent,...(prepared?{proposal:proposal(intent)}:{}),
    }]}:{...canonical,intent,...(prepared?{proposal:proposal(intent)}:{})};
    const result=await initial(method,params);
    assert.equal(result.completion,undefined,method);
    assert.deepEqual(result.checkpoint.payload.pendingCalls.map(c=>c.operation),['permissionStore.load']);
  }
});
