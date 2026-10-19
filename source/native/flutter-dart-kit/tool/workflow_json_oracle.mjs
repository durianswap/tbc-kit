// Language-level JSON parse/stringify reference used by frozen Core's
// bindJsonMessage. No wallet, signer, chain reads, or accepted artifact writes.
import {writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const inputs=[
 '{"purpose":"settlement","txids":[]}',
 '{"2":true,"1":false,"01":null,"4294967295":{},"4294967294":[],"name":"test"}',
 '{"z":{"3":3,"1":1},"txids":[],"a":1.0}',
 '{"decimal":0.1,"negativeZero":-0,"small":0.000001,"tiny":1e-7,"huge":1e21}',
 '{"integer":9007199254740993,"rounded":1000000000000000128,"overflow":1e999}',
 '{"array":[1.0,1e20,1e21,-1e-7,true,null,"💰"],"txids":[]}',
 '{"escaped":"\\ud800","line":"\\n","slash":"/","txids":[]}',
 ...[0,5e-324,-5e-324,1.7976931348623157e308,2.2250738585072014e-308,
   1.0000000000000002,1.2345678901234567,1e-6,1e-7,1e20,1e21,
   1e23,333333333.33333329,1424953923781206.25,0.002,1e-27]
   .map(n=>`{"n":${n},"txids":[]}`),
];
const txids=['11'.repeat(32),'22'.repeat(32)];
const cases=inputs.map(input=>{const parsed=JSON.parse(input);parsed.txids=txids;
 return {input,field:'txids',txids,expected:JSON.stringify(parsed)};});
await writeFile(join(resolve(import.meta.dirname,'..'),'test/fixtures/workflow-json.json'),
 JSON.stringify({status:'JAVASCRIPT_WORKFLOW_JSON_REFERENCE',cases},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({cases:cases.length}));
