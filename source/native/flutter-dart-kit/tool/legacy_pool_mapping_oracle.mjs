// Frozen public resolver, not a second implementation of Pool fee/amount rules.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifiedKitCandidate} from '../../flutter/scripts/candidate-inputs.mjs';
const base=resolve(import.meta.dirname,'..'),pkg=resolve(base,'../../release/kit-contract173-20261014-c/package');
const identity=await verifiedKitCandidate(pkg);
assert.equal(identity.artifactId,'9601507ee4961e9d99bac98984d112a80854b3ef8a979f8b0728f152ae335626');
const k=await import(pathToFileURL(join(pkg,'dist/esm/wallet.js')));
assert.equal(typeof k.createLegacyPoolIntentResolver,'function');
const {account}=JSON.parse(await readFile(join(base,'test/fixtures/legacy-mapping.json')));
const now='2026-10-14T12:00:00.123Z',contract='AB'.repeat(32),cases=[];
async function add(name,input,extra={}) {
  const chainId=extra.chainId??account.chainId,decimals=extra.decimals??6;
  const resolver=k.createLegacyPoolIntentResolver({chainId,now:()=>new Date(now),
    ...(extra.noMetadata?{}:{resolvePoolFtDecimals:async()=>decimals})});
  let expected,error=false;
  try {expected=await resolver.resolve(input,account.address)}catch{error=true}
  cases.push({name,input,chainId,decimals,...extra,...(error?{error:true}:{expected})});
}
for(const flag of ['POOLNFT_SWAP_TO_TOKEN','POOLNFT_SWAP_TO_TBC','POOLNFT_LP_INCREASE','POOLNFT_LP_CONSUME']) {
  const field=['POOLNFT_SWAP_TO_TOKEN','POOLNFT_LP_INCREASE'].includes(flag)?'tbc_amount':'ft_amount';
  const input={flag,nft_contract_address:contract,address:account.address,[field]:'1.25',poolNFT_version:2,broadcastEnabled:false};
  await add(flag,input);
  await add(flag+'-mainnet',input,{chainId:'tbc:mainnet'});
  for(const amount of ['0','0.0000001','1.1234567','18446744073709.551615','18446744073709.551616',1.25])
    await add(flag+'-amount-'+amount,{...input,[field]:amount});
  for(const [name,change] of Object.entries({broadcast:{broadcastEnabled:true},version:{poolNFT_version:3},address:{address:'wrong'},contract:{nft_contract_address:'wrong'},override:{serviceFeeRate:130},endpoint:{endpoint:'https://wrong.invalid'}}))
    await add(flag+'-'+name,{...input,...change});
  const absentVersion={...input};delete absentVersion.poolNFT_version;
  await add(flag+'-absentVersion',absentVersion);
  await add(flag+'-wrapped',[input]);
  if(flag.includes('SWAP'))for(const lpPlan of [1,2,3,4,5,6,0,7,1.5,'6',null])
    await add(flag+'-plan-'+lpPlan,{...input,lpPlan});
  if(flag==='POOLNFT_SWAP_TO_TBC') {
    await add(flag+'-noMetadata',input,{noMetadata:true});
    for(const decimals of [0,18,19,-1])await add(flag+'-decimals-'+decimals,input,{decimals});
  }
}
for(const flag of ['POOLNFT_MERGE','FTLP_MERGE','POOLNFT_LP_BURN']) {
  const input={flag,nft_contract_address:contract};
  await add(flag,input);
  await add(flag+'-domain',{...input,domain:'display only'});
  await add(flag+'-override',{...input,serviceFeeRate:130});
  await add(flag+'-broadcast',{...input,broadcastEnabled:true});
  await add(flag+'-invalid',{...input,nft_contract_address:'wrong'});
}
assert(cases.some(c=>c.name==='POOLNFT_SWAP_TO_TBC-plan-6'&&!c.error));
const report={status:'LEGACY_POOL_MAPPING_FROZEN_KIT_ORACLE',kitIdentity:identity,account,now,cases,
  proof:'Pure frozen Pool resolver comparison. Historical pool creation is excluded. Metadata decimals are trusted test inputs, not live extraction proof. No HTTP, signatures, broadcast or device use.'};
const dest=join(base,'test/fixtures/legacy-pool-mapping.json');
if(process.argv[2]==='--check')assert.deepEqual(JSON.parse(await readFile(dest)),report);
else {assert.equal(process.argv.length,2);await writeFile(dest,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify({status:report.status,cases:cases.length,rejections:cases.filter(c=>c.error).length}));
