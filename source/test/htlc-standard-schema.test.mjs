import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
const directory=new URL('../schemas/',import.meta.url);
const schemas=readdirSync(directory).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(readFileSync(new URL(n,directory),'utf8')));
const ajv=new Ajv2020({strict:true,allErrors:true});
ajv.addFormat('uri',/^[A-Za-z][A-Za-z0-9+.-]*:/u);
ajv.addFormat('date-time',/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u);
schemas.forEach(s=>ajv.addSchema(s));
const validator=(file,name)=>ajv.getSchema(`${schemas.find(s=>s.$id.endsWith(`/${file}.schema.json`)).$id}#/$defs/${name}`);
const request=validator('transaction-request','transactionRequest'),address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const point={txid:'11'.repeat(32),vout:0};
const wrap=intent=>({version:'1.0',chainId:'tbc:testnet',from:address,intent});
test('HTLC native requests bind exact fields and explicit claim/refund deposits',()=>{
  const lock={type:'tbc-htlc-lock',version:'1.0',amount:'1000',to:address,hashlock:'ab'.repeat(32),lockTime:'830000'};
  const claim={type:'tbc-htlc-claim',version:'1.0',preimage:'33'.repeat(32)},refund={type:'tbc-htlc-refund',version:'1.0'};
  for(const chainId of ['tbc:mainnet','tbc:testnet']){
    for(const lockTime of ['830000','1774427165'])assert.equal(request({...wrap({...lock,lockTime}),chainId}),true,JSON.stringify(request.errors));
    for(const intent of [claim,{...claim,preimage:''},refund])assert.equal(request({...wrap(intent),chainId,constraints:{inputOutpoints:[point]}}),true,JSON.stringify(request.errors));
  }
  for(const patch of [{lockTime:'0'},{lockTime:'01'},{lockTime:830000},{amount:'0'},{amount:'1.0'},
    {hashlock:'AB'.repeat(32)},{hashlock:'ab'},{contractId:point.txid},{preimage:'11'}])assert.equal(request(wrap({...lock,...patch})),false);
  for(const intent of [claim,refund]){
    assert.equal(request(wrap(intent)),false);
    assert.equal(request({...wrap(intent),constraints:{inputOutpoints:[]}}),false);
    assert.equal(request({...wrap({...intent,to:address}),constraints:{inputOutpoints:[point]}}),false);
  }
  for(const preimage of ['a','AA','😀','33'.repeat(65425)])assert.equal(request({...wrap({...claim,preimage}),constraints:{inputOutpoints:[point]}}),false);
  assert.equal(request({...wrap({...refund,preimage:''}),constraints:{inputOutpoints:[point]}}),false);
});
test('HTLC adds shared intents/material labels, not a private Provider signing method',()=>{
  const caps=validator('provider','capabilities');
  const value={standard:'1.0.0',provider:'1.0.0',chainId:'tbc:testnet',methods:{tbc_signTransaction:'1.0'},
    intents:{'tbc-htlc-lock':['1.0'],'tbc-htlc-claim':['1.0'],'tbc-htlc-refund':['1.0']},limits:{workflowSteps:5,transactionBundleSize:32},profiles:['defi']};
  assert.equal(caps(value),true,JSON.stringify(caps.errors));assert.equal(caps({...value,methods:{'tbc-htlc-claim':'1.0'}}),false);
  const u=validator('integration','utxo');assert.equal(u({...point,satoshis:'1000',scriptPubKey:'51',classification:'htlc'}),true,JSON.stringify(u.errors));
  const check=validator('integration','chainDataResolveParams');
  const requirement={intentType:'tbc-htlc-claim',includeAncestry:true,inputOutpoints:[point],assets:[{kind:'htlc'}]};
  assert.equal(check({version:'1.0',chainId:'tbc:testnet',accountId:`tbc:testnet:${address}`,requirement}),true,JSON.stringify(check.errors));
  // Accepted classification does not authenticate script or prove unspentness.
});
test('HTLC Token profiles are explicit and target one deployed pair without requiring fee inputs',()=>{
  for(const assetStandard of ['tbc20-standard','tbc20-stablecoin'])for(const type of ['tbc-htlc-lock','tbc-htlc-claim','tbc-htlc-refund']){
    const intent={type,version:'1.0',assetStandard,contractId:point.txid,...(type.endsWith('-lock')?
      {amount:'250',to:address,hashlock:'ab'.repeat(32),lockTime:'830010'}:
      {targetOutpoints:[{...point,vout:1}],...(type.endsWith('-claim')?{preimage:'33'.repeat(32)}:{})})};
    assert.equal(request(wrap(intent)),true,JSON.stringify(request.errors));
    for(const key of ['assetStandard','contractId',...(type.endsWith('-lock')?[]:['targetOutpoints'])]){
      const bad={...intent};delete bad[key];assert.equal(request(wrap(bad)),false);
    }
    assert.equal(request(wrap({...intent,assetStandard:'legacy-ft'})),false);
    if(!type.endsWith('-lock'))for(const targets of [[],[point],[{...point,vout:1},{...point,vout:1}]]){
      assert.equal(request(wrap({...intent,targetOutpoints:targets})),false);
    }
  }
});
