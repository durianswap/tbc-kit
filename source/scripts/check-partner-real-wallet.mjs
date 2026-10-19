import assert from 'node:assert/strict';
import {readFile,copyFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
const [consumerArg,reportArg]=process.argv.slice(2);assert.ok(consumerArg&&reportArg);
const root=resolve(consumerArg),repo=resolve(import.meta.dirname,'..');
const build=JSON.parse(await readFile(join(root,'build-report.json')));
assert.equal(build.kitSha256,'907f2734edb7d861abca4b5581477ffc344718c5efc9d81e826ea38ed4b51a7a');
const file=join(repo,'examples/partner-wallet-acceptance/real-browser-wallet.test.mjs');
await copyFile(file,join(root,'real-browser-wallet.test.mjs'));
const output=execFileSync(process.execPath,['--test','real-browser-wallet.test.mjs'],{cwd:root,encoding:'utf8',timeout:60000});
const report={status:'PASS_REAL_ADAPTER_CONTROLLED_KIT_WIRING',kitSha256:build.kitSha256,buildSources:build.sources,
  testSha256:createHash('sha256').update(await readFile(file)).digest('hex'),output,
  realChainAcceptance:false,realPrivateKeyLoaded:false,externalPosts:0,limitation:'Controlled Node Chrome-storage callbacks and synthetic HTTP; not browser or real-key approval.'};
await writeFile(resolve(reportArg),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(output);
