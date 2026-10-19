import assert from 'node:assert/strict';
import test from 'node:test';
import {readdirSync,readFileSync} from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
const directory=new URL('../schemas/',import.meta.url);
const schemas=readdirSync(directory).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(readFileSync(new URL(n,directory),'utf8')));
const ajv=new Ajv2020({strict:true,allErrors:true});
ajv.addFormat('uri',/^[A-Za-z][A-Za-z0-9+.-]*:/u);
ajv.addFormat('date-time',/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u);
schemas.forEach(s=>ajv.addSchema(s));
const lookup=(file,name)=>ajv.getSchema(schemas.find(s=>s.$id.endsWith('/'+file)).$id+'#/$defs/'+name);
const associated=lookup('reviewed-transaction.schema.json','associatedPayload');
const raw=lookup('reviewed-transaction.schema.json','rawPayload');
const preview=lookup('integration.schema.json','transactionPreview');
const child=()=>({inputs:[{outputIndex:0,signingProfile:'p2pkh'}],outputs:[{satoshis:'1',scriptPubKey:'51'}]});
const request=count=>({format:'associated',sourceTransaction:'00',sourceInputs:[],children:Array.from({length:count},child)});
test('associated source plus children fits the existing 32-transaction approval limit',()=>{
 for(const children of [0,1,30,31])assert.equal(associated(request(children)),true,JSON.stringify(associated.errors));
 for(const children of [32,33]){
  assert.equal(associated(request(children)),false,'source is a transaction too');
  assert.ok(associated.errors.some(e=>e.instancePath==='/children'&&e.keyword==='maxItems'));
 }
});
test('raw count and transaction preview retain the existing 32 total maximum',()=>{
 for(const count of [1,32,33]){
  assert.equal(raw({format:'raw',transactions:Array.from({length:count},()=>({rawTransaction:'00',inputs:[{satoshis:'1',scriptPubKey:'51'}]}))}),count<=32);
  assert.equal(preview({operationKind:'transaction',assetFlows:[],totalFee:'0',transactionCount:count,warnings:[],irreversible:true}),count<=32);
 }
});
