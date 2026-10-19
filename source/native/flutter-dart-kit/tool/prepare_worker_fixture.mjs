import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const base=resolve(import.meta.dirname,'..'),p5=resolve(base,'../flutter-dart-live-token-exploration');
const seal=JSON.parse(await readFile(join(p5,'evidence/sealed-final-20261012-b/seal.json')));
const source='matched/dart/fixture.json', bytes=await readFile(join(p5,source));
assert.equal(createHash('sha256').update(bytes).digest('hex'),seal.sourceHashes[source]);
await writeFile(join(base,'test/fixtures/signing/material.json'),bytes,{flag:'wx'});
