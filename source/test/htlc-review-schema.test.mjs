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
const check=ajv.getSchema(`${schemas.find(s=>s.$id.endsWith('/integration.schema.json')).$id}#/$defs/transactionPreview`);
test('native TimeLock public terms are strict and do not imply chain maturity or full VM validation',()=>{
  for(const position of ['input','output'])for(const lockHeight of [0,100,499999999]){
    const v=preview();delete v.htlcLocks;
    v.timeLocks=[{transactionIndex:0,position,index:0,amount:'10000',owner:'1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
      lockHeight,domain:'height',transactionLockTime:lockHeight,verification:'exact-template',
      scriptLockChecked:position==='input',chainMaturityChecked:false,scriptExecutionVerified:false,
      ...(position==='input'?{sequence:4294967294}:{})}];
    assert.equal(check(v),true,JSON.stringify(check.errors));
    for(const mutate of [t=>delete t.owner,t=>t.domain='timestamp',t=>t.lockHeight=500000000,
      t=>t.chainMaturityChecked=true,t=>t.scriptExecutionVerified=true,t=>t.preimage='unexpected',
      t=>t.scriptLockChecked=!t.scriptLockChecked,t=>t.amount=10000,t=>t.sequence=4294967295,
      ...(position==='input'?[t=>delete t.sequence,t=>t.transactionLockTime=500000000]:[t=>t.sequence=1])]){
      const bad=structuredClone(v);mutate(bad.timeLocks[0]);assert.equal(check(bad),false);
    }
  }
});
function preview(){return{operationKind:'transaction',assetFlows:[],totalFee:'80',transactionCount:1,warnings:[],irreversible:true,
  htlcLocks:[{transactionIndex:0,position:'input',index:0,amount:'10000',hashlock:'12'.repeat(32),
    sender:'1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',receiver:'1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',lockTime:100,
    domain:'height',transactionLockTime:0,sequence:4294967295,verification:'exact-template',branch:'unresolved',
    preimageVerified:false,chainMaturityChecked:false,scriptExecutionVerified:false}]};}
test('resolved HTLC review binds proof state and requires claim disclosure without carrying a secret',()=>{
  for(const branch of ['claim','refund']){
    const v=preview(),t=v.htlcLocks[0];t.branch=branch;t.preimageVerified=branch==='claim';
    if(branch==='claim')v.warnings=['HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE'];
    else {t.sequence=4294967294;t.transactionLockTime=100;}
    assert.equal(check(v),true,JSON.stringify(check.errors));
    for(const mutate of [v=>v.htlcLocks[0].preimageVerified=!v.htlcLocks[0].preimageVerified,
      v=>{v.htlcLocks[0].position='output';delete v.htlcLocks[0].sequence;},
      v=>v.htlcLocks[0].preimage='PUBLIC_SYNTHETIC_SENTINEL',
      ...(branch==='claim'?[v=>v.warnings=[]]:[v=>v.htlcLocks[0].sequence=4294967295,v=>v.htlcLocks[0].transactionLockTime=500000000])]){
      const bad=structuredClone(v);mutate(bad);assert.equal(check(bad),false);
    }
  }
});
test('public HTLC terms bind both roles and lock domains without claiming a witness or chain proof',()=>{
  for(const domain of ['height','timestamp'])for(const position of ['input','output']){
    const v=preview(),t=v.htlcLocks[0];Object.assign(t,{domain,position,lockTime:domain==='height'?100:500000001});
    if(position==='output')delete t.sequence;
    assert.equal(check(v),true,JSON.stringify(check.errors));
  }
});
test('HTLC review schema rejects secrets, proof inflation, missing roles and inconsistent lock domains',()=>{
  for(const mutate of [t=>t.preimage='secret',t=>t.preimageVerified=true,t=>t.chainMaturityChecked=true,t=>t.scriptExecutionVerified=true,
    t=>t.branch='claim',t=>delete t.sender,t=>delete t.hashlock,t=>t.lockTime=0,t=>t.lockTime=2147483648,t=>t.domain='timestamp',
    t=>delete t.sequence,t=>t.position='output',t=>t.amount=10000,t=>t.transactionIndex=32,t=>t.verification='consensus']){
    const v=preview();mutate(v.htlcLocks[0]);assert.equal(check(v),false);
  }
});
test('escrow Token identity/amount and Coin lock checks are bounded and position-sensitive',()=>{
  for(const coin of [false,true]){
    const v=preview();v.htlcLocks[0].escrowToken={index:1,standardId:coin?'tbc20-stablecoin':'tbc20-standard',contractId:'34'.repeat(32),amount:'250',
      ...(coin?{coinLockTime:0,coinInputLockChecked:true}:{})};
    assert.equal(check(v),true,JSON.stringify(check.errors));
    for(const change of [t=>t.amount=250,t=>delete t.contractId,t=>t.preimage='secret',t=>t.coinInputLockChecked=false,
      ...(coin?[t=>delete t.coinLockTime]:[t=>t.coinLockTime=1])]){
      const bad=structuredClone(v);change(bad.htlcLocks[0].escrowToken);assert.equal(check(bad),false);
    }
  }
});
