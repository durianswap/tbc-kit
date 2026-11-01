import{readFile,writeFile,copyFile}from'node:fs/promises';import{resolve,join}from'node:path';import{execFileSync}from'node:child_process';
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.verify/rc25-real');
const log=await readFile(join(out,'ios-builder.log'),'utf8'),ios=JSON.parse(log.slice(log.indexOf('{\n  "status"')));
const android=(await readFile(join(out,'android-builder.log'),'utf8')).trim().split('\n').at(-1),a=JSON.parse(await readFile(join(android,'build-report.json')));
const profile=JSON.parse(await readFile(join(out,'collection-profile.json')));
for(const path of [join(ios.app,'fixture.json'),join(android,'src/main/assets/fixture.json')]){const f=JSON.parse(await readFile(path));f.transactionProfile=profile;if(path.startsWith(ios.app))f.origin='http://127.0.0.1:4197';await writeFile(path,JSON.stringify(f));}
ios.origin='http://127.0.0.1:4197';
await writeFile(join(out,'ios-build-report.json'),JSON.stringify(ios,null,2));await writeFile(join(out,'android-build-report.json'),JSON.stringify(a,null,2));
execFileSync('codesign',['--force','--sign','-',ios.app],{stdio:'inherit'});
await writeFile(join(out,'candidate.json'),JSON.stringify({kit:'0.1.0-rc.25',consumer:join(root,'.verify/nft-job-install-f1sefH'),sdk:join(root,'.verify/rc23-native/sdk'),iosApp:ios.app,android,iosBundle:'org.tbc.rc25.realfunds',iosUDID:'DA8B84D5-FEFF-4F44-9A21-30E730076411',androidBundle:'io.tbc.rc25.realfunds',androidSerial:'emulator-5556',api:'https://api.tbcdev.org'},null,2));
console.log(JSON.stringify({iosApp:ios.app,android}));
