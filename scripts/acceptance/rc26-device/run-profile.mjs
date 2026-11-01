import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync as exec} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'../../..'),[platform,variant]=process.argv.slice(2),out=join(root,'docs/acceptance/evidence/rc26-devices');
assert(['ios','android'].includes(platform));assert.match(variant,/^[a-z0-9-]+$/);
const adb='/Users/alex/Library/Android/sdk/platform-tools/adb';
const ar=args=>exec(adb,['-s','emulator-5556',...args],{encoding:'utf8',maxBuffer:8e6});
let getReport,build;
if(platform==='android'){
 const project=join(root,'.verify/rc26-profile',variant.startsWith('native-sha')?'android-native-sha':'android');
 build=join(project,'build/outputs/apk/release/rc26-local-profile-release.apk');
 ar(['install','-r',build]);ar(['shell','am','force-stop','io.tbc.rc26.profile']);
 getReport=async()=>ar(['exec-out','run-as','io.tbc.rc26.profile','cat','files/report.json']);
}else{
 const udid='DA8B84D5-FEFF-4F44-9A21-30E730076411',bundle='io.tbc.rc26.acceptance';build=join(root,'.verify/rc26-profile',variant,'Rc26Probe.app');
 exec('xcrun',['simctl','install',udid,build]);
 try{exec('xcrun',['simctl','terminate',udid,bundle],{stdio:'ignore'})}catch{}
 const container=exec('xcrun',['simctl','get_app_container',udid,bundle,'data'],{encoding:'utf8'}).trim();
 getReport=()=>readFile(join(container,'Documents/report.json'),'utf8');
}
const before=await getReport().catch(()=>null),started=new Date().toISOString();
if(platform==='android')ar(['shell','am','start','-n','io.tbc.rc26.profile/io.tbc.kitloop.ProfileActivity']);
else exec('xcrun',['simctl','launch','DA8B84D5-FEFF-4F44-9A21-30E730076411','io.tbc.rc26.acceptance']);
for(let i=0;i<180;i++){
 await new Promise(r=>setTimeout(r,1000));
 const raw=await getReport().catch(()=>null);if(raw===before||!raw)continue;
 const r=JSON.parse(raw);if(r.variant!==variant){if(r.status==='FAIL')throw Error(JSON.stringify(r));continue;}
 const artifact=platform==='ios'?join(build,'suite.js'):build;
 r.evidence={started,collected:new Date().toISOString(),platform,artifact,sha256:createHash('sha256').update(await readFile(artifact)).digest('hex'),actualNative:true,syntheticMaterials:true,realBroadcasts:0};
 await writeFile(join(out,platform+'-'+variant+'.json'),JSON.stringify(r,null,2)+'\n');
 console.log(JSON.stringify({platform,variant,status:r.status,tests:r.tests,profile:r.profileRuns.map(x=>({elapsedMs:x.elapsedMs,shaMs:x.profile.sha256Bytes?.selfMs,counts:x.stats,reads:x.reads})),metrics:r.metrics}));
 assert.equal(r.status,'PASS');process.exit(0);
}
throw Error('Device checks did not finish; do not restart any real-chain operation');
