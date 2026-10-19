// Read-only readiness probe through a clean installation's public Kit API.
// This is not account-custody proof, transaction approval or chain acceptance.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const [consumerArg,reportArg]=process.argv.slice(2);assert.ok(consumerArg&&reportArg);
const consumer=resolve(consumerArg),repo=resolve(import.meta.dirname,'..');
const expected='907f2734edb7d861abca4b5581477ffc344718c5efc9d81e826ea38ed4b51a7a';
assert.equal(createHash('sha256').update(await readFile(join(repo,'native/engine/delivery/candidate233/tbc-kit-0.1.0-candidate.233.tgz'))).digest('hex'),expected);
const build=JSON.parse(await readFile(join(consumer,'build-report.json')));
assert.equal(build.kitSha256,expected);assert.equal(build.candidate,'0.1.0-candidate.233');
const require=createRequire(join(consumer,'package.json'));
const {createTbcOfficialApi}=require('@tbc/kit/api');
const apiOrigin='https://devapi.tbcdev.org';
// Previously authorized independent native Testnet address; public read only.
// Never interpret its presence here as possession by the browser extension.
const address='18sYQfVvBM4av7gojJzbVwvQR2vxrohAS2';
assert.notEqual(address,'1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH');
const http=[];
const api=createTbcOfficialApi({network:'testnet',baseUrl:apiOrigin,allowedOrigins:[apiOrigin],timeoutMs:15000,
  fetch:async(url,options={})=>{
    const parsed=new URL(url);assert.equal(parsed.origin,apiOrigin);assert.equal(options.method??'GET','GET');
    assert.ok(['/api/tbc/nodeinfo',`/api/tbc/utxo/address/${address}`].includes(parsed.pathname),'Unexpected readiness endpoint');
    const entry={method:'GET',path:parsed.pathname};http.push(entry);
    const response=await fetch(url,{...options,redirect:'error'});entry.status=response.status;return response;
  }});
const results=await Promise.allSettled([api.nodeInfo({retry:'none'}),api.utxosByAddress({address},{retry:'none'})]);
const failures=results.flatMap((r,i)=>r.status==='rejected'?[{method:i?'utxosByAddress':'nodeInfo',name:r.reason?.name,code:r.reason?.code??null,status:r.reason?.status??null}]:[]);
const node=results[0].status==='fulfilled'?results[0].value:null;
const utxos=results[1].status==='fulfilled'?results[1].value.utxos:null;
const report={status:failures.length?'READINESS_BLOCKED':'PASS_READ_ONLY_API_RETRIEVAL',observedAt:new Date().toISOString(),candidate:build.candidate,kitSha256:expected,
  apiOrigin,configuredNetwork:'testnet',address,accountCustody:'Existing native account; not established for this browser wallet',
  node:node?{reportedChain:node.chain,height:node.blocks,bestblockhash:node.bestblockhash}:null,
  utxos,atomicBalance:utxos?.reduce((total,u)=>total+BigInt(u.value),0n).toString()??null,http,failures,
  secretReads:0,signerCalls:0,posts:0,realChainAcceptance:false,
  remaining:['Real browser transaction cancellation counters','Independent non-public browser wallet custody','Durable public-Kit journal adapter for selected browser custody platform','Visible approval and one real submission','Read-only receipt and confirmation verification'],
  caution:'This snapshot proves retrieval only, not unspent-at-signing, custody, network attestation or successful broadcast.'};
await writeFile(resolve(reportArg),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report));if(failures.length)process.exitCode=1;
