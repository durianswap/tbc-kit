// Offline synthetic funding and public fixture scalars 1/2 only. This does not
// load wallet keys, call an API, or broadcast. Unmodified npm SDK builds and
// signs; its independent script interpreter verifies each spent input.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../..'), upstream=resolve(process.argv[2]??'/private/tmp/tbc-contract-audit-20261014');
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(await readFile(join(upstream,'npm-1.7.3.tgz'))),'32c3d291e9f566a9ccfcca73d42fe54a25c592361004b2acf3946f04547f028e');
const req=createRequire(join(upstream,'package/index.js'));
const {TBCAMM}=req('./lib/contract/tbc-amm.js'),TBC20=req('./lib/contract/tbc20-standard.js');
const {privateKeySigner}=req('./lib/util/tbc-amm/transaction.js');
const tbc=createRequire(join(root,'packages/kit/package.json'))('tbc-lib-js');
const key=new tbc.PrivateKey(new tbc.crypto.BN(1)),controller=new tbc.PrivateKey(new tbc.crypto.BN(2));
const signer=privateKeySigner(key),address=key.toAddress().toString(),p2pkh=tbc.Script.buildPublicKeyHashOut(address);
const fees=[{lpFeeRate:25,taxFeeRate:100,serviceProviderFeeRate:10,protocolFeeRate:5},
  {lpFeeRate:200,taxFeeRate:0,serviceProviderFeeRate:130,protocolFeeRate:0}];
const raws={},cases=[];let vmInputs=0;
const remember=tx=>{const raw=tx.uncheckedSerialize();if(raws[tx.id])assert.equal(raws[tx.id],raw);raws[tx.id]=raw;};
const ref=(tx,vout)=>({txId:tx.id,outputIndex:vout,script:tx.outputs[vout].script.toHex(),satoshis:tx.outputs[vout].satoshis});
const stringify=v=>JSON.parse(JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x));
for(const [feeIndex,rates] of fees.entries())for(const [controlled,locked] of [[false,false],[false,true],[true,false],[true,true]]){
  const label=`fees${feeIndex}-${controlled?'controller':'public'}-${locked?'locked':'plain'}`;
  const funding=new tbc.Transaction().from({txId:sha(label),outputIndex:0,script:p2pkh.toHex(),satoshis:5000000}).to(address,4999000).fee(1000).sign(key);
  const history=new Map([[funding.id,funding]]);remember(funding);
  function keep(tx){for(const [vin,input]of tx.inputs.entries()){
    const parent=history.get(input.prevTxId.toString('hex'));assert.ok(parent);input.output=parent.outputs[input.outputIndex];
    const verdict=tx.verifyScript(vin);assert.equal(verdict.success,true,`${label} ${vin} ${verdict.error}`);vmInputs++;
  }remember(tx);history.set(tx.id,tx);}
  const token=new TBC20(locked?{tapeSize:66,extensionData:'000000000009'}:{});
  const ft=token.mint(key,address,1000000n,ref(funding,0));keep(ft.sourceTransaction);keep(ft.transaction);
  const serviceProviderTag=controlled?Buffer.from('PARTNER POOLCODE2'):Buffer.alloc(0);
  const feeAddress=feeIndex===0?'13oCEJaqyyiC8iRrfup6PDL2GKZ3xQrsZL':'1N7rf2AuAHB2aCrVgnbQhSWhaUVk3rGhjm';
  const pool=new TBCAMM({ftGenesisTx:ft.transaction,lp:{kind:locked?'timelocked':'plain'},...rates,feeAddress,serviceProviderTag,
    authorization:controlled?{kind:'controller',controllerPubKeyHashes:[tbc.crypto.Hash.sha256ripemd160(controller.publicKey.toBuffer()).toString('hex')]}:{kind:'public'}});
  const mint=await pool.mintTbcAmm({funding:{parentTx:ft.transaction,outputIndex:ft.transaction.outputs.length-1,signer}});
  keep(mint.source.transaction);keep(mint.transaction);
  const fund=r=>({parentTx:r.transaction,outputIndex:r.changeVout,signer});
  const asset=(r,role)=>({parentTx:r.transaction,outputIndex:r.layout.assetOutputs.find(a=>a.role===role).codeVout,signer,ancestors:history});
  const source=r=>({parentTx:r.transaction,ancestorTx:history.get(r.transaction.inputs[0].prevTxId.toString('hex'))});
  const authorization=controlled?{controllerSigner:privateKeySigner(controller)}:{};
  const added=await pool.prepareAddLP({pool:source(mint),poolFT:asset(mint,'pool-ft'),
    userFT:{parentTx:ft.transaction,outputIndex:0,signer,ancestors:history},funding:fund(mint),incrementSat:100000n,
    firstFtAmountRaw:200000n,lpReceiverAddress:address,...authorization,...(locked?{lpLockTime:829999}:{})}).sign();keep(added.transaction);
  const bought=await pool.prepareSwapFT({pool:source(added),poolFT:asset(added,'pool-ft'),funding:fund(added),inputTbcSat:10000n,minFtOutRaw:1n,receiverAddress:address,...authorization}).sign();keep(bought.transaction);
  const sold=await pool.prepareSwapTBC({pool:source(bought),poolFT:asset(bought,'pool-ft'),userFT:asset(bought,'user-ft'),funding:fund(bought),inputFtRaw:1000n,minTbcOutSat:1n,receiverAddress:address,...authorization}).sign();keep(sold.transaction);
  const removed=await pool.prepareRemoveLP({pool:source(sold),poolFT:asset(sold,'pool-ft'),userLP:asset(added,'new-lp'),funding:fund(sold),burnAmountRaw:10000n,receiverAddress:address,...authorization}).sign();keep(removed.transaction);
  cases.push({label,controlled,locked,rates,feeAddress,serviceProviderTag:serviceProviderTag.toString('hex'),
    ftGenesisId:ft.transaction.id,fundingVout:ft.transaction.outputs.length-1,sourceId:mint.source.transaction.id,genesisId:mint.transaction.id,
    sourceFee:mint.source.feeSat,genesisFee:mint.feeSat,
    actions:[['add',added],['buy',bought],['sell',sold],['remove',removed]].map(([operation,r])=>({operation,txid:r.transaction.id,fee:r.feeSat,quote:stringify(r.quote)}))});
}
const output=join(root,'packages/tbc-engine/rust/fixtures/amm-explicit173-lifecycle.json');
const data=JSON.stringify({upstream:{version:'1.7.3',commit:'2f3fe7873e05d8b6f1f53b8720f066776b847b03'},scope:'Offline SDK fixture plus independent VM, not chain acceptance',publicFixtureScalars:[1,2],vmInputs,cases,raws},(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
await writeFile(output,data,{flag:'wx'});console.log(JSON.stringify({path:output,sha256:sha(data),cases:cases.length,vmInputs}));
