import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const built=await build({stdin:{contents:`
export {createTbcClient} from './packages/kit/src/client.ts';
export {chainDataRequirement,workflowChainDataRequirement} from './packages/core/src/reducers/chain-data-requirements.ts';
export {hashCanonical,assertValidTws} from './packages/core/src/index.ts';
export {preparedChainDataRequirement} from './packages/kit/src/prepared-chain-data.ts';
export {projectTbcApprovalPreparation} from './packages/kit/src/approval-presentation.ts';
export {createDefaultTbcNetwork} from './packages/kit/src/default-network.ts';
export {createTbcNetworkContext} from './packages/kit/src/network-context.ts';`,resolveDir:root,loader:'ts'},
alias:{'@tbc-wallet/core':`${root}packages/core/src/index.ts`},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const {createTbcClient,chainDataRequirement,workflowChainDataRequirement,hashCanonical,assertValidTws,preparedChainDataRequirement,
  projectTbcApprovalPreparation,createDefaultTbcNetwork,createTbcNetworkContext}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',a={standard:'tbc20-standard',contractId:'11'.repeat(32)},b={standard:'tbc20-stablecoin',contractId:'22'.repeat(32)};
const points=[{txid:'33'.repeat(32),vout:2},{txid:'44'.repeat(32),vout:0}];
const create=(market='native-token',side='sell',first=a,second=b)=>({type:'tbc-lop-create',version:'1.0',order:{
  market,side,assetA:first,...(market==='token-token'?{assetB:second}:{}),saleVolume:'101',unitPrice:'1500000',feeRate:'100000',feeRecipient:address}});
const wrap=(intent,chainId='tbc:testnet')=>({version:'1.0',chainId,from:address,intent});
test('LOP ordinary and Prepared share exact identity-versus-escrow material projection',()=>{
  for(const market of ['native-token','token-token'])for(const side of ['buy','sell'])for(const [first,second]of [[a,b],[b,a]]){
    const request=wrap(create(market,side,first,second));request.constraints={inputOutpoints:points,maxFee:'10000'};
    const material=chainDataRequirement(request);assert.deepEqual(preparedChainDataRequirement(request),material);
    assertValidTws('transactionRequest',request);
    assertValidTws('chainDataResolveParams',{version:'1.0',chainId:request.chainId,accountId:`${request.chainId}:${address}`,requirement:material});
    const native=market==='native-token'&&side==='sell';
    assert.equal(material.assets.length,native?1:2);assert.equal(material.nativeAmount,native?'101':undefined);
    assert.equal(material.lopAssets.filter(v=>v.purpose==='escrow').length,native?0:1);
    if(!native){const selected=side==='buy'&&market==='token-token'?second:first;
      assert.deepEqual(material.assets[1],{kind:selected.standard==='tbc20-standard'?'ft':'stablecoin',contractId:selected.contractId,minimumAmount:side==='buy'?'151':'101'});
    }
    assert.equal(Object.hasOwn(material,'feeRecipient'),false);assert.equal(Object.hasOwn(material,'order'),false);
    assert.ok(Object.isFrozen(material.lopAssets));assert.ok(material.lopAssets.every(Object.isFrozen));
    assert.deepEqual(material.inputOutpoints,points);assert.notEqual(material.inputOutpoints,points);
  }
});
test('LOP exact targets preserve order and reject silent aggregate loss',()=>{
  for(const type of ['tbc-lop-cancel','tbc-lop-match']){
    const request=wrap({type,version:'1.0',targetOutpoints:type.endsWith('cancel')?[points[0]]:points});
    const requirement=chainDataRequirement(request);assert.deepEqual(requirement.assets,[{kind:'native'},{kind:'lop'}]);
    assert.deepEqual(requirement.targetOutpoints,request.intent.targetOutpoints);assert.deepEqual(preparedChainDataRequirement(request),requirement);
    assert.deepEqual(workflowChainDataRequirement([request]),requirement);
    assert.throws(()=>workflowChainDataRequirement([request,request]),/per-step/);
    assert.throws(()=>chainDataRequirement(wrap({...request.intent,targetOutpoints:[]})),/exact ordered/);
  }
  assert.throws(()=>chainDataRequirement(wrap({type:'tbc-lop-match',version:'1.0',targetOutpoints:[points[0],points[0]]})),/exact ordered/);
});
test('LOP strict schemas reject caller script authority and malformed integer terms',()=>{
  const valid=create();
  for(const order of [{...valid.order,ownerHash:'aa'.repeat(20)},{...valid.order,assetA:{...a,partialHash:'aa'.repeat(32)}},
    {...valid.order,feeRate:0},{...valid.order,saleVolume:'0'},{...valid.order,unitPrice:'1.2'},
    {...valid.order,market:'token-token'},{...valid.order,assetB:b}]){
    assert.throws(()=>assertValidTws('transactionRequest',wrap({...valid,order})));
  }
  const mutable=wrap(create());const material=chainDataRequirement(mutable);mutable.intent.order.assetA={...a,contractId:'ff'.repeat(32)};
  assert.equal(material.lopAssets[0].contractId,a.contractId);
  assert.throws(()=>chainDataRequirement(wrap({...create('native-token','buy'),order:{...create('native-token','buy').order,unitPrice:'1'}})),/spendable/);
});
test('LOP client uses standard send/sign methods on both configured networks',async()=>{
  for(const network of ['mainnet','testnet']){
    const calls=[],provider={async request(call){calls.push(call);return call.method==='tbc_requestAccounts'?[address]:{}},on(){},removeListener(){},destroy(){}};
    const wallet=await createTbcClient({network,provider}).connect();const intent=create();
    await wallet.lop.create({order:intent.order,constraints:{maxFee:'10000'}});
    await wallet.lop.cancel({targetOutpoints:[points[0]]});await wallet.lop.match({targetOutpoints:points});
    await wallet.walletBuild.sign({intent});
    assert.deepEqual(calls.slice(1).map(v=>v.method),['tbc_sendTransaction','tbc_sendTransaction','tbc_sendTransaction','tbc_signTransaction']);
    assert.deepEqual(calls[1].params.intent,intent);assert.deepEqual(calls[3].params.intent.targetOutpoints,points);
    assert.ok(calls.slice(1).every(v=>v.params.chainId===`tbc:${network}`));
  }
});
test('LOP local policy and preparation display bind full terms without any HTTP',async()=>{
  for(const networkName of ['mainnet','testnet']){
    let reads=0;const network=createTbcNetworkContext({network:networkName});
    const defaults=createDefaultTbcNetwork({network,accounts:{async current(){return[]}},fetch:async()=>{reads++;throw new Error('unexpected HTTP')},now:()=>Date.parse('2030-01-01T00:00:00Z')});
    for(const intent of [create(),{type:'tbc-lop-cancel',version:'1.0',targetOutpoints:[points[0]]},{type:'tbc-lop-match',version:'1.0',targetOutpoints:points}]){
      const request=wrap(intent,network.chainId),requestHash=hashCanonical(request);
      const result=await defaults.resolvePolicy({version:'1.0',request,requestHash,snapshotHash:'55'.repeat(32)});
      assert.ok(result.payload,JSON.stringify(result));assert.equal(result.payload.dustThreshold,'42');assert.equal(result.payload.feeRateSatPerKb,'80');
      assert.deepEqual(result.payload.contractPolicies.map(v=>v.family),['ft','stablecoin']);assert.equal(result.payload.chainId,network.chainId);
      const model=projectTbcApprovalPreparation({method:'tbc_signTransaction',operationKind:'transaction',requestHash,request,expiresAt:Date.parse('2030-01-01T00:05:00Z'),warningScope:[]});
      assert.deepEqual(model.businessTerms.value,intent);assert.equal(model.businessTerms.source,'preparation-scope');assert.equal(model.trust,'intent-bounded');
      assert.equal(model.binding.status,'not-created');
      // A missing account fails before HTTP, even with the LOP loader present.
      const unavailable=await defaults.resolveChainData({version:'1.0',chainId:request.chainId,accountId:`${request.chainId}:${address}`,requirement:chainDataRequirement(request)});
      assert.equal(unavailable.portError.name,'UNAUTHORIZED');
    }
    assert.equal(reads,0);
  }
});
