import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const repo=resolve(import.meta.dirname,'..'),out=resolve(process.argv[2]);
const installed=process.argv[3]??JSON.parse(await readFile(join(out,'evidence/installed-check.json'))).installed;
const consumer=resolve(installed,'../../..'),file=join(consumer,'nft-job-consumer.mts');
await writeFile(file,`import {createTbcClient} from '@tbc/kit';
const wallet=await createTbcClient({network:'testnet'}).connect();
const common={collectionId:'ab'.repeat(32),items:[{slot:1,name:'N',symbol:'N',description:'',attributes:[]}]};
const result=await wallet.tbc721.batchMint({...common,limits:{maxTotalFee:'1000',expiresAt:'2099-01-01T00:00:00Z'}});
const count:number=result.minted;
const compatibility=await wallet.tbc721.batchMint({...common,constraints:{maxFee:'1000',expiresAt:'2099-01-01T00:00:00Z'}});
const alsoCount:number=compatibility.minted;
// @ts-expect-error explicit whole-task deadline is required
wallet.tbc721.batchMint({...common,constraints:{maxFee:'1000'}});
// @ts-expect-error unsupported exact inputs must not be silently ignored
wallet.tbc721.batchMint({...common,constraints:{maxFee:'1000',expiresAt:'2099-01-01T00:00:00Z',inputOutpoints:[]}});
void [count,alsoCount];
`);
const p=spawnSync(join(repo,'source/node_modules/.bin/tsc'),['--noEmit','--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext',file],{cwd:consumer,encoding:'utf8'});
await writeFile(join(out,'evidence/consumer-types.log'),(p.stdout??'')+(p.stderr??''));
assert.equal(p.status,0,p.stdout+p.stderr);console.log('INSTALLED_DECLARATIONS_PASS');
