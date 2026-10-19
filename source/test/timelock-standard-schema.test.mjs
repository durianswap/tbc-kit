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
const request=validator('transaction-request','transactionRequest');
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const point={txid:'11'.repeat(32),vout:0};
const wrap=intent=>({version:'1.0',chainId:'tbc:testnet',from:address,intent});
test('timelock exact height-profile intents isolate units and require explicit unlock deposits',()=>{
  const lock={type:'tbc-timelock-lock',version:'1.0',amount:'1000',lockTime:'830000'};
  const unlock={type:'tbc-timelock-unlock',version:'1.0'};
  for(const chainId of ['tbc:mainnet','tbc:testnet']){
    assert.equal(request({...wrap(lock),chainId}),true,JSON.stringify(request.errors));
    assert.equal(request({...wrap(unlock),chainId,constraints:{inputOutpoints:[point]}}),true,JSON.stringify(request.errors));
  }
  for(const patch of [{lockTime:'0'},{lockTime:'500000000'},{lockTime:'1700000000'},{lockTime:'01'},{lockTime:830000},
    {amount:'0'},{amount:'1.0'},{to:address},{contractId:point.txid}]) assert.equal(request(wrap({...lock,...patch})),false);
  assert.equal(request(wrap(unlock)),false);
  assert.equal(request({...wrap(unlock),constraints:{inputOutpoints:[]}}),false);
  assert.equal(request({...wrap({...unlock,amount:'1'}),constraints:{inputOutpoints:[point]}}),false);
});
test('timelock capabilities and snapshot classification do not add a Provider signing method',()=>{
  const caps=validator('provider','capabilities');
  const value={standard:'1.0.0',provider:'1.0.0',chainId:'tbc:testnet',methods:{tbc_signTransaction:'1.0'},
    intents:{'tbc-timelock-lock':['1.0'],'tbc-timelock-unlock':['1.0']},limits:{workflowSteps:5,transactionBundleSize:32},profiles:['defi']};
  assert.equal(caps(value),true,JSON.stringify(caps.errors));
  assert.equal(caps({...value,methods:{'tbc-timelock-unlock':'1.0'}}),false);
  const u=validator('integration','utxo');
  assert.equal(u({...point,satoshis:'1000',scriptPubKey:'51',classification:'timelock'}),true,JSON.stringify(u.errors));
  // Schema labels aren't script proof; Engine authenticates the full parent output.
});
test('Integration accepts both timelock requirements alone and in a mixed per-step request',()=>{
  const check=validator('integration','chainDataResolveParams');
  const lock={intentType:'tbc-timelock-lock',includeAncestry:false,nativeAmount:'1000',assets:[{kind:'native',minimumAmount:'1000'}]};
  const unlock={intentType:'tbc-timelock-unlock',includeAncestry:true,inputOutpoints:[point],assets:[{kind:'timelock'}]};
  const base={version:'1.0',chainId:'tbc:testnet',accountId:`tbc:testnet:${address}`};
  for(const requirement of [lock,unlock])assert.equal(check({...base,requirement}),true,JSON.stringify(check.errors));
  const mixed={...base,requirement:lock,workflowSteps:[{stepId:'lock',requirement:lock},{stepId:'unlock',requirement:unlock}]};
  assert.equal(check(mixed),true,JSON.stringify(check.errors));
  const bad=structuredClone(mixed);bad.workflowSteps[1].requirement.intentType='tbc-timelock-unknown';
  assert.equal(check(bad),false);
});
