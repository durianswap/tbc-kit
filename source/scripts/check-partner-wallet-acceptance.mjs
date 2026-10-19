// Fresh outside-repo consumer; no workspace imports, builds, devices or funds.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const repo=resolve(import.meta.dirname,'..'),[arg,expectedSha,reportOutput]=process.argv.slice(2);
assert.ok(arg&&/^[0-9a-f]{64}$/.test(expectedSha??''));
const tar=resolve(arg),sha=b=>createHash('sha256').update(b).digest('hex');assert.equal(sha(await readFile(tar)),expectedSha);
const root=await mkdtemp(join(tmpdir(),'tbc-partner-wallet-'));
console.log(JSON.stringify({stage:'install',root}));
await writeFile(join(root,'package.json'),JSON.stringify({name:'independent-partner-wallet',private:true,type:'module',dependencies:{'@tbc/kit':`file:${tar}`,'@noble/curves':'1.9.7'}}));
execFileSync('npm',['install','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,stdio:'pipe',timeout:180000});
const installed=join(root,'node_modules/@tbc/kit'),manifest=JSON.parse(await readFile(join(installed,'package.json')));
assert.equal(manifest.version,'0.1.0-candidate.233');
const sources={};for(const name of ['storage.mjs','platform.mjs','chain-fixture.mjs','run-phase.mjs']){
  const file=join(repo,'examples/partner-wallet-acceptance',name),bytes=await readFile(file);
  assert.doesNotMatch(bytes.toString(),/@tbc-wallet\/|tws-mobile-reference|\.\.\/.*(?:src|dist)/);
  sources[name]=sha(bytes);await copyFile(file,join(root,name));
}
const results=[];
for(const mode of ['reject','navigation','success','unknown','recover']){
  const dir=join(root,mode==='recover'?'unknown':mode);if(mode!=='recover')await mkdir(dir);
  console.log(JSON.stringify({stage:mode,root}));
  try{
    const log=execFileSync(process.execPath,['run-phase.mjs',mode,dir],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
    results.push(JSON.parse(log.trim().split('\n').at(-1)));
  }catch(e){console.error(String(e.stderr??e.message));console.error(JSON.stringify({failedPhase:mode,root}));process.exitCode=1;break;}
}
if(process.exitCode!==1){
  assert.notEqual(results.find(r=>r.mode==='unknown').pid,results.find(r=>r.mode==='recover').pid);
  const report={status:'PASS_INDEPENDENT_WALLET_CONTROLLED_LIFECYCLE',root,kitVersion:manifest.version,kitSha256:expectedSha,sources,results,
    limitations:['Node descriptor selection, not real browser discovery or native UI','Public fixture Signer only; no production Vault','Synthetic HTTP acceptance, not actual Testnet broadcast'],realChainAcceptance:false};
  const bytes=JSON.stringify(report,null,2)+'\n';
  await writeFile(join(root,'report.json'),bytes,{flag:'wx'});
  if(reportOutput)await writeFile(resolve(reportOutput),bytes,{flag:'wx'});
  console.log(JSON.stringify({status:report.status,root,phases:results.length}));
}
