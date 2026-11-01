import assert from 'node:assert/strict';
import{readFile,writeFile,mkdir,copyFile}from'node:fs/promises';
import{execFileSync}from'node:child_process';
import{createHash}from'node:crypto';
import{join,resolve}from'node:path';
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'docs/acceptance/evidence/rc25-devices');await mkdir(out,{recursive:true});
const device='DA8B84D5-FEFF-4F44-9A21-30E730076411',adb='/Users/alex/Library/Android/sdk/platform-tools/adb';
const container=execFileSync('xcrun',['simctl','get_app_container',device,'io.tbc.rc25.acceptance','data'],{encoding:'utf8'}).trim();
const report={};for(const platform of ['ios','android']){
 const bytes=platform==='ios'?await readFile(join(container,'Documents/report.json')):execFileSync(adb,['-s','emulator-5556','shell','run-as','io.tbc.rc25.acceptance','cat','files/report.json']);
 const r=JSON.parse(bytes);assert.equal(r.kit,'0.1.0-rc.25');assert.equal(r.status,'PASS');assert.equal(r.tests.length,11);
 await writeFile(join(out,platform+'-controlled.json'),bytes);report[platform]={status:r.status,groups:r.tests.length,elapsedMs:r.elapsedMs,tests:r.tests};
}
const protectedFiles=JSON.parse(await readFile('/Users/alex/Documents/Codex/2026-08-29/wo/outputs/flutter-rc16-sync/protected-before.json'));
const sha=b=>createHash('sha256').update(b).digest('hex');for(const[p,h]of Object.entries(protectedFiles))assert.equal(sha(await readFile(p)),h,p);
assert.equal(sha(await readFile(join(root,'release/candidates/kit-stress-rc25/tbc-kit.tgz'))),'035364a3251415107cdd14500a84e8b99551f4674a46a65373b5171b14dab746');
await copyFile(join(root,'.verify/rc25-device-app/build.json'),join(out,'controlled-build.json'));
await writeFile(join(out,'controlled-summary.json'),JSON.stringify({...report,integrity:{protectedFiles:Object.keys(protectedFiles).length,changed:0},limitations:['Synthetic reads and submission; public fixture signer; simulated approvals','Not Testnet broadcast evidence or real-device performance']},null,2));
console.log(JSON.stringify({ios:report.ios.status,android:report.android.status,groupsEach:11,protectedFiles:Object.keys(protectedFiles).length}));
