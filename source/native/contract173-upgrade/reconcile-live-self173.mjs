// Read-only Testnet reconciliation for the bounded private self-transfer probe.
// Never signs, submits, replays a request, or records raw transactions/keys.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {verifiedKitCandidate} from '../flutter/scripts/candidate-inputs.mjs';
const [kitArg,evidenceArg,outArg]=process.argv.slice(2);
assert(kitArg&&evidenceArg&&outArg,'KIT_PACKAGE COLLECTED_PROBE NEW_RECEIPT');
const kit=resolve(kitArg),evidence=JSON.parse(await readFile(resolve(evidenceArg)));
const identity=await verifiedKitCandidate(kit);
assert.deepEqual(identity,evidence.provenance.kitIdentity);
const {report}=evidence,{request}=report.plan;
assert.equal(report.status,'RETURNED_RECONCILIATION_REQUIRED');
assert.equal(report.plan.method,'tbc_sendTransaction');
assert.equal(request.chainId,'tbc:testnet');
assert.equal(request.intent.type,'tbc.transfer');
assert.equal(request.intent.to,request.from);
assert.equal(request.intent.amount,'1000');
assert.equal(report.approvalDelta,1);assert.equal(report.signatureDelta,1);
const result=report.result.value;assert.equal(report.result.ok,true);
assert.equal(result.transactions.length,1);
const submitted=result.transactions[0];assert.equal(submitted.status,'submitted');
const account=JSON.parse(await readFile(new URL('../flutter-dart-live-token-exploration/evidence/private-accounts-20261012-a/accounts.json',import.meta.url))).accounts.ios;
assert.equal(request.from,account.address);
const hash160=createHash('ripemd160').update(createHash('sha256').update(Buffer.from(account.publicKey,'hex')).digest()).digest('hex');
const expectedScript='76a914'+hash160+'88ac';
const {createTbcChainClient,inspectTbcTransaction}=createRequire(import.meta.url)(join(kit,'dist/cjs/api.cjs'));
let reads=0;
const client=createTbcChainClient({baseUrl:'https://devapi.tbcdev.org',allowedOrigins:['https://devapi.tbcdev.org'],fetch:(u,o)=>{
 assert.equal(o?.method??'GET','GET');reads++;
 return fetch(u,{...o,redirect:'error',signal:AbortSignal.timeout(20000)});
}});
const [status,raw]=await Promise.all([client.getTransactionStatus(submitted.txid),client.getRawTransaction(submitted.txid)]);
const parsed=inspectTbcTransaction(raw.rawTransaction);assert.equal(parsed.txid,submitted.txid);
const {inputs,outputs}=parsed.transaction;
assert.equal(outputs.length,2);
for(const output of outputs)assert.equal(Buffer.from(output.scriptPubKey).toString('hex'),expectedScript);
assert.equal(outputs[0].satoshis,1000n);
assert.equal(new Set(inputs.map(i=>i.txid+':'+i.vout)).size,inputs.length);
const parents=await Promise.all(inputs.map(async input=>{
 const p=inspectTbcTransaction((await client.getRawTransaction(input.txid)).rawTransaction);
 assert.equal(p.txid,input.txid);const output=p.transaction.outputs[input.vout];assert(output);
 assert.equal(Buffer.from(output.scriptPubKey).toString('hex'),expectedScript);
 return {txid:input.txid,vout:input.vout,atomic:output.satoshis.toString()};
}));
const fee=parents.reduce((a,p)=>a+BigInt(p.atomic),0n)-outputs.reduce((a,o)=>a+o.satoshis,0n);
assert(fee>=0n&&fee<=BigInt(request.constraints.maxFee));assert.equal(fee.toString(),result.totalFee);
const receipt={checkedAt:new Date().toISOString(),status:'READ_ONLY_SELF_TRANSFER_VERIFIED',runId:report.runId,
 kitIdentity:identity,txid:parsed.txid,nodeStatus:status,parents,
 outputs:outputs.map((o,vout)=>({vout,recipient:account.address,atomic:o.satoshis.toString()})),feeAtomic:fee.toString(),
 approvalCount:report.approvalDelta,signatureCount:report.signatureDelta,
 timing:{pageRequestMs:report.result.ms,approvalToLastSignatureUs:report.approvalToLastSignatureUs,nativeSignUs:report.nativeSignUs},reads,
 scope:'Trusted Testnet API plus local raw-transaction hash, prevout ownership, output and fee consistency. Not an independent full-node proof, AMM acceptance, or matched performance comparison.'};
await writeFile(resolve(outArg),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(receipt));
