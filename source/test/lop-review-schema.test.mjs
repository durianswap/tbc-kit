import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
const directory=new URL('../schemas/',import.meta.url);
const schemas=readdirSync(directory).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(readFileSync(new URL(n,directory),'utf8')));
const ajv=new Ajv2020({strict:true,allErrors:true});
ajv.addFormat('uri',/^[A-Za-z][A-Za-z0-9+.-]*:/u);
ajv.addFormat('date-time',/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u);
schemas.forEach(s=>ajv.addSchema(s));
const schema=schemas.find(s=>s.$id.endsWith('/integration.schema.json'));
const check=ajv.getSchema(`${schema.$id}#/$defs/transactionPreview`);
test('associated standard explicitly names permissionless LOP match, without allowing arbitrary no-sign profiles',()=>{
  const requestSchema=schemas.find(s=>s.$id.endsWith('/reviewed-transaction.schema.json'));
  const validate=ajv.getSchema(`${requestSchema.$id}#/$defs/associatedInput`);
  assert.equal(validate({outputIndex:0,signingProfile:'tbc-lop-match',previousTransaction:'00'}),true,JSON.stringify(validate.errors));
  assert.equal(validate({outputIndex:0,signingProfile:'no-sign'}),false);
  assert.equal(validate({outputIndex:0,signingProfile:'tbc-lop-match',skipVerification:true}),false);
});
function preview(){return{operationKind:'transaction',assetFlows:[],totalFee:'80',transactionCount:1,warnings:[],irreversible:true,
  lopOrders:[{transactionIndex:0,verification:'exact-template',assetIdentityVerified:false,inputs:[],outputs:[{index:0,terms:{
    standardId:'tbc-lop',market:'native-token',side:'sell',ownerHash:'11'.repeat(20),feeRecipientHash:'22'.repeat(20),
    saleVolume:'9007199254740993',unitPrice:'1000000',feeRate:'100',priceScale:'1000000',feeScale:'1000000',
    baseAsset:{kind:'native'},quoteAsset:{kind:'token',contractId:'33'.repeat(32),partialHash:'44'.repeat(32)},
  }}]}]};}
test('bounded committed LOP terms support both markets without numeric precision loss',()=>{
  for(const pair of [false,true]){
    const value=preview(),terms=value.lopOrders[0].outputs[0].terms;
    if(pair){terms.market='token-token';terms.baseAsset={...terms.quoteAsset,contractId:'55'.repeat(32)};}
    assert.equal(check(value),true,JSON.stringify(check.errors));
  }
});
test('LOP review rejects missing terms, wrong scale/market, claimed identity proof and unknown fields',()=>{
  for(const mutate of [
    (v,t)=>delete t.feeRecipientHash,(v,t)=>t.saleVolume=9007199254740993,(v,t)=>t.feeScale='10000',
    (v,t)=>t.market='token-token',(v,t)=>t.extra='unbound',(v,t)=>t.ownerHash='x',
    v=>v.lopOrders[0].assetIdentityVerified=true,v=>v.lopOrders[0].outputs=[],v=>v.lopOrders[0].transactionIndex=32,
  ]){
    const value=preview();mutate(value,value.lopOrders[0].outputs[0].terms);assert.equal(check(value),false);
  }
});
function coinLock(){return{transactionIndex:0,position:'input',index:1,contractId:'55'.repeat(32),amount:'100',
  owner:'1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',lockTime:12,domain:'height',transactionLockTime:12,sequence:4294967294,scriptLockChecked:true,chainMaturityChecked:false};}
test('Coin approval locks separate script predicates from chain maturity and output locks',()=>{
  for(const [lockTime,domain]of [[0,'none'],[12,'height'],[500000001,'timestamp']]){
    const value=preview(),input={...coinLock(),lockTime,domain,transactionLockTime:lockTime},output={...input,position:'output',scriptLockChecked:false};delete output.sequence;
    value.coinLocks=[input,output];assert.equal(check(value),true,JSON.stringify(check.errors));
  }
});
test('Coin lock schema rejects false authority, inconsistent domains and unbounded positions',()=>{
  for(const change of [l=>l.chainMaturityChecked=true,l=>l.scriptLockChecked=false,l=>l.domain='timestamp',l=>l.sequence=4294967295,
    l=>delete l.sequence,l=>l.position='output',l=>l.transactionIndex=32,l=>l.administrator=true]){
    const value=preview(),lock=coinLock();change(lock);value.coinLocks=[lock];assert.equal(check(value),false);
  }
});
test('unlocked Coin inputs permit final sequence without weakening positive locks',()=>{
  const value=preview();value.coinLocks=[{...coinLock(),lockTime:0,domain:'none',transactionLockTime:0,sequence:4294967295}];
  assert.equal(check(value),true,JSON.stringify(check.errors));
  value.coinLocks[0].lockTime=1;value.coinLocks[0].domain='height';assert.equal(check(value),false);
});
