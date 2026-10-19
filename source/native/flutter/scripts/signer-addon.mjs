import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
export async function verifiedSignerAddon(arg,source){
 if(!arg)return null;
 const path=resolve(arg),bytes=await readFile(join(path,'signer-artifacts.json')),manifest=JSON.parse(bytes);
 const sha=b=>createHash('sha256').update(b).digest('hex');
 assert.equal(manifest.abi,1);
 assert.equal(manifest.artifactId,sha(JSON.stringify({inputs:manifest.inputs,artifacts:manifest.artifacts,dartSources:manifest.dartSources})));
 if(manifest.appleStripSha256)assert.equal(manifest.appleStripSha256,
  sha(await readFile(join(source,'scripts/portable-apple-binary.mjs'))));
 for(const [p,h]of Object.entries(manifest.artifacts))assert.equal(sha(await readFile(join(path,p))),h,p);
 for(const [p,h]of Object.entries(manifest.dartSources))assert.equal(sha(await readFile(join(source,p))),h,p);
 return {path,manifest,manifestSha256:sha(bytes)};
}
