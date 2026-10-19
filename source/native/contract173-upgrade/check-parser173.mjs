import assert from 'node:assert/strict';
import {cp,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {patchContract173Parser} from '../../packages/kit/scripts/contract173-parser-patch.mjs';
// Keep dependencies resolvable while isolating output; never edit frozen input.
const root=resolve(import.meta.dirname,'../..');
const baseline='/private/tmp/tbc-amm-funding-kit-20261011-a/package/dist/esm/vendor/tbc-tx-parser';
const scratch=await mkdtemp(join(root,'packages/kit/node_modules/.contract173-parser-'));
await cp(baseline,scratch,{recursive:true});
const patch=await patchContract173Parser(scratch);
const {poolNftServiceFeeQuote}=await import(pathToFileURL(join(scratch,'protocols/pool-nft/fees.js')));
const {buildOpReturnData}=await import(pathToFileURL(join(scratch,'script-parser/op-return.js')));
const parts=['11'.repeat(64),'00'.repeat(24),'22'.repeat(32),'4a01','06','00','00','4e54617065'];
const decoded=buildOpReturnData(parts,()=>{throw Error('Unexpected address conversion')});
assert.equal(decoded.poolNft.serviceFeeRate,330);assert.equal(decoded.poolNft.lpPlan,6);
let checks=2;
assert.equal(poolNftServiceFeeQuote(10000n,{tape:{serviceFeeRate:130,lpPlan:6}}),undefined);checks++;
for(const [plan,total,lp]of [[1,30,20],[2,20,5],[3,30,5],[4,50,5],[5,100,5],[6,330,200]]){
 for(const amount of [1n,30n,769n,770n,10000n,1000000n]){
  const actual=poolNftServiceFeeQuote(amount,{tape:{serviceFeeRate:total,lpPlan:plan}});
  const totalFee=amount*BigInt(total)/10000n,lpFee=amount*BigInt(lp)/10000n,fee=totalFee-lpFee;
  assert.deepEqual(actual,{totalFee,lpFee,visibleFee:fee>=10n?fee:0n});checks++;
 }
}
// Existing single-byte plans still parse; malformed multi-byte fields do not.
assert.equal(buildOpReturnData(parts.map((v,i)=>i===3?'1e':v),()=>'' ).poolNft.serviceFeeRate,30);checks++;
for(const rate of ['', 'zz','4','4a0100']){assert.equal(buildOpReturnData(parts.map((v,i)=>i===3?rate:v),()=>'' ).poolNft,undefined);checks++;}
const result={status:'POOL2_PARSER173_PASS',checks,patch,scope:'Pool2 little-endian rate decoding, LP6 330/200, integer rounding and payout threshold; no historical LP6 130 mode',scratch,broadcasts:0};
if(process.argv[2])await writeFile(resolve(process.argv[2]),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:result.status,checks,scratch,broadcasts:0}));
