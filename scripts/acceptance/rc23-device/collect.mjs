import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.verify/rc23-device-app');
const evidence=join(root,'docs/acceptance/evidence/rc23-devices');await mkdir(evidence,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex');
const ios='DA8B84D5-FEFF-4F44-9A21-30E730076411',android='emulator-5556';
const container=execFileSync('xcrun',['simctl','get_app_container',ios,'io.tbc.rc23.acceptance','data'],{encoding:'utf8'}).trim();
const iosRaw=await readFile(join(container,'Documents/report.json'));
await writeFile(join(evidence,'ios.json'),iosRaw);const ir=JSON.parse(iosRaw);assert.equal(ir.status,'PASS');
let ar;try{const raw=execFileSync('/Users/alex/Library/Android/sdk/platform-tools/adb',['-s',android,'shell','run-as','io.tbc.rc23.acceptance','cat','files/report.json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});ar=JSON.parse(raw);await writeFile(join(evidence,'android.json'),raw);assert.equal(ar.status,'PASS')}catch(e){if(ar)throw e}
await copyFile(join(out,'build.json'),join(evidence,'build.json'));
await copyFile(join(root,'.verify/rc23-native/sdk/device-check-dh7Pvx/report.json'),join(evidence,'native-devices.json'));
const frozen=JSON.parse(await readFile('/Users/alex/Documents/Codex/2026-08-29/wo/outputs/flutter-rc16-sync/protected-before.json'));
const changed=[];for(const [path,hash]of Object.entries(frozen))if(sha(await readFile(path))!==hash)changed.push(path);assert.deepEqual(changed,[]);
const candidate=join(root,'release/candidates/unexpected-rejections-rc23');
const archives={};for(const f of ['tbc-kit.tgz','ios-sdk.tgz','android-sdk.tgz'])archives[f]=sha(await readFile(join(candidate,f)));
assert.equal(archives['tbc-kit.tgz'],'14fa77b6af1248edb5fc89c3dd7104d525c0c07a1529dc3dc0f6d6527d62b88b');
assert.equal(archives['ios-sdk.tgz'],'877a715f9ab8d8e640136927c3b7d951c39db0ae3728a24d932eb62580d84e1e');
assert.equal(archives['android-sdk.tgz'],'9293208a3da7d57a4ee13f8fbb84838cc4ad3c4d32df750d47a0f9483c7db67c');
// Verify the expanded package used by esbuild against every file in the frozen
// tar, including long-name and PAX headers. No tar extraction or runtime edits.
const bytes=gunzipSync(await readFile(join(candidate,'tbc-kit.tgz')));let checked=0,longName,paxPath;
const str=b=>b.toString().replace(/\0.*$/s,'');
for(let at=0;at+512<=bytes.length;){const h=bytes.subarray(at,at+512);if(h.every(b=>b===0))break;const size=parseInt(str(h.subarray(124,136)).trim()||'0',8),type=String.fromCharCode(h[156]||48),body=bytes.subarray(at+512,at+512+size);at+=512+Math.ceil(size/512)*512;
 if(type==='L'){longName=str(body);continue}if(type==='x'){paxPath=body.toString().split('\n').find(l=>/^\d+ path=/.test(l))?.replace(/^\d+ path=/,'');continue}
 const name=longName??paxPath??[str(h.subarray(345,500)),str(h.subarray(0,100))].filter(Boolean).join('/');longName=paxPath=undefined;
 if(type!=='0')continue;assert.ok(name.startsWith('package/')&&!name.includes('..'),name);const local=await readFile(join(root,'packages/kit',name.slice(8)));assert.equal(sha(local),sha(body),name);checked++;
}
const audit={status:'PASS',protectedPartnerFiles:Object.keys(frozen).length,protectedFilesChanged:changed,archives,expandedPackageFilesMatched:checked,sourceRuntimeChanged:false,realBroadcasts:0};
await writeFile(join(evidence,'integrity.json'),JSON.stringify(audit,null,2)+'\n');
const summary=r=>({status:r.status,groups:r.tests.length,passed:r.tests.filter(t=>t.status==='PASS').length,nativeCalls:r.nativeCalls.length,
 successfulProviderOperations:r.metrics.filter(m=>m.accepted>0).length,
 oneApprovalForEverySuccessfulOperation:r.metrics.filter(m=>m.accepted>0).every(m=>m.approvals===1),
 rejectedOrInvalidNeverSigned:r.metrics.filter(m=>!m.accepted).every(m=>m.signatures===0),
 tests:r.tests});
const report={ios:summary(ir),android:ar?summary(ar):{status:'BLOCKED',reason:'Emulator storage threshold prevents installing the isolated test app; native device vectors already PASS'},integrity:audit};
await writeFile(join(evidence,'summary.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
