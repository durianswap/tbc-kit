import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../../..');
process.env.TBC_TEST_INSTALLED_KIT=join(root,'.verify/nft-job-install-f1sefH/node_modules/@tbc/kit');
process.env.TBC_TEST_WASM_DIR=join(process.env.TBC_TEST_INSTALLED_KIT,'artifacts/wasm');
const {harness,NOW}=await import(join(root,'source/packages/kit/test/nft-job-stress-fixture.mjs'));
const results=[];
for(const mode of ['native-rejects-after-expiry','native-rejects-before-expiry','previously-approved-receipt-returned-after-expiry']){
 let h;
 const options=mode==='previously-approved-receipt-returned-after-expiry'?{expireInApproval:true}:{duringApprove:async()=>{
  if(mode==='native-rejects-after-expiry')h.setClock(NOW+120001);
  throw new Error('native approval fence expired');
 }};
 h=await harness(1,options);
 let result,error;try{result=await h.wallet.tbc721.batchMint(h.input);}catch(e){error=e;}finally{h.close();}
 assert.equal(h.stats().signatures,0);assert.equal(h.dispatched.length,0);
 const expected=mode==='native-rejects-before-expiry'?'preserve-error':'stopped/expired';
 const observed=error?'provider-error-'+error.code:`${result.status}/${result.reason}`;
 results.push({mode,expected,observed,passes:mode==='native-rejects-before-expiry'?!!error:result?.status==='stopped'&&result?.reason==='expired',signatures:h.stats().signatures,broadcasts:h.dispatched.length,reads:h.calls});
}
await writeFile(join(root,'docs/acceptance/evidence/rc25-devices/approval-expiry-repro.json'),JSON.stringify({kit:'0.1.0-rc.25',results},null,2));
console.log(JSON.stringify(results));
if(results.some(r=>!r.passes))process.exitCode=1;
