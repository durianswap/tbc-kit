// Keep the package-private raw-transaction reviewer aligned with Pool2 1.7.3.
// This is a build transform, not a runtime fallback or a new network request.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const sha=v=>createHash('sha256').update(v).digest('hex');
export async function patchContract173Parser(parserRoot){
 const patches={
  'protocols/pool-nft/fees.js':[
   'return lpPlan === 6 ? 80 : 5;',
   'return lpPlan === 6 ? (serviceFeeRate === 330 ? 200 : undefined) : 5;',
  ],
  'script-parser/op-return.js':[
   "const serviceFeeRate = parts.length === 8 ? parseInt(parts[3] ?? '', 16) : undefined;",
   `// Pool2 encodes the rate in little-endian bytes (330 bps = 4a01).
    const rateHex = parts.length === 8 ? parts[3] : undefined;
    if (parts.length === 8 && !/^(?:[0-9a-fA-F]{2}){1,2}$/.test(rateHex ?? '')) return undefined;
    const serviceFeeRate = rateHex === undefined ? undefined : Buffer.from(rateHex, 'hex').readUIntLE(0, rateHex.length / 2);`,
  ],
 };
 const changes={};
 for(const [path,[before,after]]of Object.entries(patches)){
  const filename=join(parserRoot,path),source=await readFile(filename,'utf8');
  if(source.split(after).length===2&&!source.includes(before)){
   changes[path]={beforeSha256:sha(source),afterSha256:sha(source),alreadyApplied:true};
   continue;
  }
  assert.equal(source.split(before).length,2,`Unexpected parser source: ${path}; review upstream before applying patch`);
  const next=source.replace(before,after);await writeFile(filename,next);
  changes[path]={beforeSha256:sha(source),afterSha256:sha(next)};
 }
 return {upstream:'tbc-contract@1.7.3',pool2Lp6:{totalFeeBps:330,lpFeeBps:200,providerFeeBps:130,historical130Compatibility:false},changes};
}
