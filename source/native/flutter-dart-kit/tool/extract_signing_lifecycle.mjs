// One-time extraction; subsequent changes are normal reviewed source edits.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const base=resolve(import.meta.dirname,'..'),root=resolve(base,'../..');
const p5=join(root,'native/flutter-dart-live-token-exploration');
const sha=b=>createHash('sha256').update(b).digest('hex');
const seal=JSON.parse(await readFile(join(p5,'evidence/sealed-final-20261012-b/seal.json')));
const provenance=[];
for(const [name,to] of [['pilot_host.dart','signing_executor.dart'],['pilot_signer.dart','signature_verification.dart']]){
 const from=join(p5,'lib',name), bytes=await readFile(from);
 assert.equal(sha(bytes),seal.sourceHashes['lib/'+name]);
 await writeFile(join(base,'lib/src/internal',to),bytes,{flag:'wx'});
 provenance.push({source:from,sourceSha256:sha(bytes),destination:'lib/src/internal/'+to,extractedSha256:sha(bytes)});
}
await writeFile(join(base,'evidence/f1-signing-extraction.json'),JSON.stringify({status:'F1_SIGNING_BASELINE_EXTRACTED_FOR_ADAPTATION',provenance,acceptedDeliveryChanged:false},null,2)+'\n',{flag:'wx'});
