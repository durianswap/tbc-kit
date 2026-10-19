// Exercises the shipped installer with real pinned archives, not fake binaries.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {fileInventory,sha256} from './platform-resources.mjs';
import {verifiedKitCandidate} from '../../../native/flutter/scripts/candidate-inputs.mjs';
const [consumerArg,deliveryArg,outArg]=process.argv.slice(2);assert.ok(outArg,'CONSUMER FROZEN_NATIVE_DELIVERY NEW_EVIDENCE');
const consumer=resolve(consumerArg),delivery=resolve(deliveryArg),out=resolve(outArg),kit=join(consumer,'node_modules/@tbc/kit');
await mkdir(out);const identity=await verifiedKitCandidate(kit);
const baseline=JSON.parse(await readFile(join(delivery,'acceptance.json')));
const lock=JSON.parse(await readFile(join(kit,'examples/react-native-engine/module/native-sdk-lock.json')));
assert.equal(lock.artifactSetId,baseline.sdkArtifactSetId);
const results=[];
for(const platform of ['ios','android']){
  const stage=await mkdtemp(join(tmpdir(),'tbc-demand-native-'));
  try{
    const sdk=join(stage,'sdk'),app=join(stage,'app');await mkdir(sdk);await mkdir(app);
    await writeFile(join(app,'package.json'),'{}\n');await symlink(join(consumer,'node_modules'),join(app,'node_modules'));
    const selected=platform==='ios'?'apple-sdk.tgz':'maven-repository.tgz',archiveRows=[];
    for(const name of ['sdk-metadata.tgz',selected]){
      const metadata=baseline.sizes.sdkDownloads.find(r=>r.file===name);assert.ok(metadata);
      const p=join(delivery,name),bytes=await readFile(p);assert.equal(sha256(bytes),metadata.sha256);assert.equal(bytes.length,metadata.bytes);
      const entries=execFileSync('tar',['-tzf',p],{encoding:'utf8'}).trim().split('\n');
      assert.ok(entries.every(n=>!n.startsWith('/')&&!n.includes('\\')&&!n.split('/').includes('..')));
      const kinds=execFileSync('tar',['-tvzf',p],{encoding:'utf8'}).trim().split('\n');assert.ok(kinds.every(n=>['-','d'].includes(n[0])));
      execFileSync('tar',['-xzf',p,'-C',sdk]);archiveRows.push(metadata);
    }
    execFileSync(process.execPath,[join(kit,'examples/react-native-engine/install.mjs'),app,sdk,'--platform',platform],{encoding:'utf8'});
    const moduleRoot=join(app,'modules/tbc-kit-engine');
    const cli=execFileSync(process.execPath,[join(moduleRoot,'scripts/sync-native.mjs'),'--check','--platform',platform],{encoding:'utf8'});
    const installedIdentity=JSON.parse(cli);assert.equal(installedIdentity.platform,platform);
    const files=await fileInventory(join(moduleRoot,'platform-sdk'));
    const expected=Object.keys(lock.files).filter(p=>p==='identity.json'||p.startsWith(platform==='ios'?'apple/':'maven-repository/')).sort();
    assert.deepEqual(Object.keys(files).sort(),expected);
    for(const [p,value]of Object.entries(files))assert.equal(value.sha256,lock.files[p]);
    assert.ok(!Object.keys(files).some(p=>p.startsWith(platform==='ios'?'maven-repository/':'apple/')));
    const other=platform==='ios'?'android':'ios';
    assert.throws(()=>execFileSync(process.execPath,[join(moduleRoot,'scripts/sync-native.mjs'),'--check','--platform',other],{stdio:'pipe'}),
      e=>e.status!==0&&String(e.stderr).includes(`not ${other}`));
    // The actual installed script also retains the API used by build tooling.
    const {syncNative}=await import(pathToFileURL(join(moduleRoot,'scripts/sync-native.mjs')));
    await syncNative({moduleRoot,kitRoot:kit,check:true});
    results.push({platform,archives:archiveRows,downloadBytes:archiveRows.reduce((n,a)=>n+a.bytes,0),
      copiedBytes:Object.values(files).reduce((n,v)=>n+v.bytes,0),files:expected.length,oppositePlatformFiles:0,wrongPlatformRejected:true,installedIdentity});
  }finally{await rm(stage,{recursive:true,force:true});}
}
const report={status:'PASS_REAL_SINGLE_PLATFORM_INSTALL',identity,results,completeSdkLockRetained:true,
  runtimeBytesChanged:false,deviceAcceptance:false,realBroadcast:false,appSizeReductionClaimed:false};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
