// Build/test staging only. Does not load an extension or touch a private key.
import assert from 'node:assert/strict';
import {copyFile,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
const [rootArg,reportArg]=process.argv.slice(2);assert.ok(rootArg&&reportArg);
const root=resolve(rootArg),repo=resolve(import.meta.dirname,'..');
const build=JSON.parse(await readFile(join(root,'build-report.json')));
assert.equal(build.kitSha256,'907f2734edb7d861abca4b5581477ffc344718c5efc9d81e826ea38ed4b51a7a');
const sources={};
for(const name of ['browser-sqlite.mjs','browser-sqlite.test.mjs']){
  const source=join(repo,'examples/partner-wallet-acceptance',name);
  sources[name]=createHash('sha256').update(await readFile(source)).digest('hex');
  await copyFile(source,join(root,name));
}
const output=execFileSync(process.execPath,['--test','browser-sqlite.test.mjs'],{cwd:root,encoding:'utf8',timeout:30000});
const report={status:'PASS_PLATFORM_SQLITE_ADAPTER',candidate:'0.1.0-candidate.233',kitSha256:build.kitSha256,
  sqlJs:JSON.parse(await readFile(join(root,'node_modules/sql.js/package.json'))).version,sources,output,
  limitation:'SQL.js and public Kit journal with controlled persistence callbacks; not actual Chrome storage, private-key signing or chain acceptance.',realChainAcceptance:false};
await writeFile(resolve(reportArg),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(output);
