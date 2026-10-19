// Test-only translation oracle from the immutable current Kit, not source dist.
// No signer, chain-data lookup, HTTP, transaction execution or broadcast.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifiedKitCandidate} from '../../flutter/scripts/candidate-inputs.mjs';
const base=resolve(import.meta.dirname,'..'),repo=resolve(base,'../..');
const pkg=join(repo,'release/kit-contract173-20261014-c');
const sha=x=>createHash('sha256').update(x).digest('hex');
assert.equal(sha(await readFile(join(pkg,'tbc-kit-0.1.0-platform-slim.20261014.3.tgz'))),'65441bc8dec3cf659f9ab2d65f722559b52eb68af4ab2b95e04470e3c4acf7fa');
const identity=await verifiedKitCandidate(join(pkg,'package'));
assert.equal(identity.artifactId,'9601507ee4961e9d99bac98984d112a80854b3ef8a979f8b0728f152ae335626');
const k=await import(pathToFileURL(join(pkg,'package/dist/esm/wallet.js')));
for(const name of ['mapLegacyRawTransactionToReviewed','mapLegacyAssociatedTransactionToReviewed','mapLegacyGenericBatchToWorkflow','normalizeLegacyGenericBatchRequests','createLegacyStandardWorkflowBatchAdapter','digestTbcLegacyBitcoinMessage'])assert.equal(typeof k[name],'function',name);
const clone=x=>JSON.parse(JSON.stringify(x));
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const publicKey='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const account={chainId:'tbc:testnet',address,accountId:`tbc:testnet:${address}`};
const script='76a914751e76e8199196d454941c45d1b3a323f1433bd688ac';
const raw=['0a000000','01','00'.repeat(32),'00000000','00','ffffffff','01','0100000000000000','19',script,'00000000'].join('');
const rawParams={txraws:[raw],utxos_satoshis:[[1000]],script_pubkeys:[[script]]};
const input={txId:'AB'.repeat(32),outputIndex:0,satoshis:1000,script,scriptSigType:'p2pkh',preTx:raw};
const associated={sourceTxraw:raw,sourceUtxos:[input],inputs:[[{...input,txId:'00'.repeat(32)}]],outputs:[[{satoshis:'900',script}]]};
const ciphertext=Buffer.alloc(85,7).toString('base64');
const rows=[
 {method:'sendTransaction',params:{flag:'P2PKH',address,satoshis:42,broadcastEnabled:false}},
 {method:'signTransaction',params:rawParams},
 {method:'signAssociatedTransaction',params:associated},
 {method:'signMessage',params:{message:'{"purpose":"legacy","txids":[]}',encoding:'utf8'}},
 {method:'encrypt',params:{message:'hello 💰'}},
 {method:'decrypt',params:{encryptedMessage:ciphertext}},
];
const transaction={version:'1.0',chainId:account.chainId,from:address,intent:{version:'1.0',type:'tbc.transfer',to:address,amount:'42'}};
const context={origin:'https://partner.example',chainId:account.chainId,sessionId:'legacy-oracle',navigationId:'document-1'};
const options={chainId:account.chainId,context,readAccount:async()=>account,
 resolveSendTransaction:async()=>clone(transaction),
 executeAction:async()=>{throw Error('not configured')},executeWorkflow:async()=>{throw Error('not configured')}};
const cases=[];
async function add(name,kind,value,call,extra={}){
 let expected,error=false;try{expected=await call()}catch{error=true}
 cases.push({name,kind,input:clone(value),...extra,...(error?{error:true}:{expected:clone(expected)})});
}
await add('raw','raw',rawParams,()=>k.mapLegacyRawTransactionToReviewed(rawParams));
await add('raw-uppercase','raw',{...rawParams,txraws:[raw.toUpperCase()],script_pubkeys:[[script.toUpperCase()]]},()=>k.mapLegacyRawTransactionToReviewed({...rawParams,txraws:[raw.toUpperCase()],script_pubkeys:[[script.toUpperCase()]]}));
await add('raw-two','raw',{txraws:[raw,raw],utxos_satoshis:[[0],[9007199254740991]],script_pubkeys:[[script],[script]]},()=>k.mapLegacyRawTransactionToReviewed({txraws:[raw,raw],utxos_satoshis:[[0],[9007199254740991]],script_pubkeys:[[script],[script]]}));
for(const [name,p] of Object.entries({
 extra:{...rawParams,privateKey:'forbidden-not-a-secret'},empty:{...rawParams,txraws:[]},
 inputCount:{...rawParams,utxos_satoshis:[[1,2]],script_pubkeys:[[script,script]]},
 negative:{...rawParams,utxos_satoshis:[[-1]]},fraction:{...rawParams,utxos_satoshis:[[1.5]]},
 stringAmount:{...rawParams,utxos_satoshis:[['1']]},badRaw:{...rawParams,txraws:['00']},
 badScript:{...rawParams,script_pubkeys:[['xyz']]},
}))await add('raw-reject-'+name,'raw',p,()=>k.mapLegacyRawTransactionToReviewed(p));
for(const [name,p] of Object.entries({normal:associated,sourceOnly:{sourceTxraw:raw,sourceUtxos:[input]},
 contract:{...associated,sourceUtxos:[{...input,scriptSigType:'tbc20_contract',ftVersion:3,prePreTxData:'aa',contractTx:raw,unfinishedScriptSig:'bb'}]},
 other:{...associated,sourceUtxos:[{...input,scriptSigType:'other'}]},
 badProfile:{...associated,sourceUtxos:[{...input,scriptSigType:'arbitrary'}]},
 badIndex:{...associated,sourceUtxos:[{...input,outputIndex:-1}]},
 badVersion:{...associated,sourceUtxos:[{...input,ftVersion:4}]},
 extra:{...associated,endpoint:'https://evil.invalid'},
 mismatched:{...associated,outputs:[]},missingOutputs:{sourceTxraw:raw,sourceUtxos:[input],inputs:[]},
}))await add('associated-'+name,'associated',p,()=>k.mapLegacyAssociatedTransactionToReviewed(p));
function result(r){switch(r.method){
 case 'sendTransaction':case 'signAssociatedTransaction':return {transactions:[{rawTransaction:raw},{rawTransaction:raw}]};
 case 'signTransaction':return {detachedSignatures:[['3001']]};
 case 'signMessage':return {address,publicKey,signature:'fixture-signature',envelope:{message:{encoding:'utf8',data:r.params.message}}};
 case 'encrypt':return {ciphertext};case 'decrypt':return {message:{encoding:'utf8',data:'hello 💰'}};
}}
for(const row of rows.filter(r=>['signTransaction','signAssociatedTransaction','encrypt','decrypt'].includes(r.method))){
 let captured;
 const adapter=k.createLegacyStandardWorkflowBatchAdapter({...options,executeAction:async action=>{
  const {clientRequestId,...params}=action.params;assert.match(clientRequestId,/^legacy-standard:/);
  captured={method:action.method,params};return {deliveryId:'11'.repeat(32),response:{result:result(row)},events:[]};
 }});
 const output=await adapter.execute({requestId:'standalone-'+row.method,requests:[row],context});
 cases.push({name:'standalone-'+row.method,kind:'standalone',input:row,expected:captured,result:result(row),expectedResult:output.results[0]});
}
// All36 ordered pairs demonstrate arbitrary supported combinations, not three recipes.
for(const a of rows)for(const b of rows){const input=[a,b];
 await add(`pair-${a.method}-${b.method}`,'workflow',input,()=>k.mapLegacyGenericBatchToWorkflow(input,options));
}
for(const input of [rows.slice(0,5),rows.slice(1,6),[rows[0],{...rows[3],dependsOn:'txids'}],[rows[2],{...rows[3],dependsOn:'settlement'}]]){
 await add('batch-'+cases.length,'workflow',input,()=>k.mapLegacyGenericBatchToWorkflow(input,options));
 const steps=input.map(r=>({status:'completed',result:result(r)}));
 const adapter=k.createLegacyStandardWorkflowBatchAdapter({...options,executeWorkflow:async()=>({deliveryId:'22'.repeat(32),response:{result:{steps}},events:[]})});
 const out=await adapter.execute({requestId:'results',requests:input,context});
 cases.push({name:'results-'+cases.length,kind:'results',input,standardResult:{steps},expected:out.results});
}
const failures=[rows[0],{...rows[3],dependsOn:'txids'},rows[4]];
const failedSteps=[{status:'failed',error:{message:'Request rejected'}},{status:'skipped'},{status:'completed',result:result(rows[4])}];
const failedAdapter=k.createLegacyStandardWorkflowBatchAdapter({...options,executeWorkflow:async()=>({deliveryId:'33'.repeat(32),response:{result:{steps:failedSteps}},events:[]})});
cases.push({name:'results-failed-dependent-independent',kind:'results',input:failures,standardResult:{steps:failedSteps},expected:(await failedAdapter.execute({requestId:'failed',requests:failures,context})).results});
for(const [name,input] of Object.entries({empty:[],tooMany:rows,extra:[{...rows[4],endpoint:'no'}],unsupported:[{method:'arbitrary',params:{}}],
 broadcast:[{...rows[0],params:{...rows[0].params,broadcastEnabled:true}}],merge:[{...rows[0],params:{...rows[0].params,flag:'FT_MERGE'}}],
 firstDepends:[{...rows[3],dependsOn:'txids'}],badField:[rows[0],{...rows[3],dependsOn:'constructor'}],
 badObject:[rows[0],{...rows[3],params:{encoding:'utf8',message:'[]'},dependsOn:'txids'}],
 wrongTarget:[rows[0],{...rows[3],params:{encoding:'utf8',message:'{"txids":1}'},dependsOn:'txids'}],
 unsafeObject:[rows[0],{...rows[3],params:{encoding:'utf8',message:'{"__proto__":{}}'},dependsOn:'txids'}],
 wrongPrevious:[rows[4],{...rows[3],dependsOn:'txids'}],
}))await add('normalize-'+name,'normalize',input,()=>k.normalizeLegacyGenericBatchRequests(input));
for(const [name,message] of Object.entries({utf8:{encoding:'utf8',data:'hello 💰'},hex:{encoding:'hex',data:'00ff'},base64:{encoding:'base64',data:'AP8='},boundary252:{encoding:'utf8',data:'a'.repeat(252)},boundary253:{encoding:'utf8',data:'a'.repeat(253)},max:{encoding:'utf8',data:'a'.repeat(65536)},oversize:{encoding:'utf8',data:'a'.repeat(65537)}}))
 await add('bitcoin-'+name,'digest',message,()=>k.digestTbcLegacyBitcoinMessage({version:'1.0',message}));
const report={status:'LEGACY_MAPPING_FROZEN_KIT_ORACLE',kitIdentity:identity,account,transaction,cases,
 proof:'Pure mapping/output/error reference. Synthetic result signatures are not cryptographic proof; zero approvals, key use, HTTP or broadcasts.'};
const dest=join(base,'test/fixtures/legacy-mapping.json');
if(process.argv[2]==='--check')assert.deepEqual(JSON.parse(await readFile(dest)),report);
else {assert.equal(process.argv.length,2);await writeFile(dest,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify({status:report.status,cases:cases.length,expectedRejections:cases.filter(c=>c.error).length,artifactId:identity.artifactId}));
