import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.verify/rc23-mint100-repro');await mkdir(out,{recursive:true});
const adb='/Users/alex/Library/Android/sdk/platform-tools/adb';
const run=args=>execFileSync(adb,['-s','emulator-5556',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,timeout:30000});
const usage=run(['shell','dumpsys','usagestats']),processes=run(['shell','ps','-A','-o','PID,NAME']);
const packages=run(['shell','pm','list','packages','-3']).trim().split('\n').map(l=>l.replace(/^package:/,''));
const cutoff=Date.now()-48*3600000,lastUse=new Map();
for(const line of usage.split('\n')){
 const pkg=line.match(/package=(\S+)/)?.[1];if(!pkg)continue;
 const dates=[...line.matchAll(/lastTime(?:Used|Visible|ComponentUsed|FS)="([^"]+)"/g)].map(m=>Date.parse(m[1].replace(' ','T')+'+08:00')).filter(Number.isFinite);
 if(dates.length)lastUse.set(pkg,Math.max(lastUse.get(pkg)||0,...dates));
}
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const candidates=[],skipped=[];
for(const pkg of packages){
 if(!/^(io|org)\.tbc\.[A-Za-z0-9_.]+$/.test(pkg))continue;
 const last=lastUse.get(pkg);
 if(!last||last<Date.parse('2000-01-01')||last>=cutoff||processes.split('\n').some(l=>l.trim().split(/\s+/).at(-1)?.startsWith(pkg))){skipped.push({pkg,reason:'recent, running, or no reliable last-use record',last});continue}
 let files;const query='find cache code_cache -type f -exec stat -c "%n|%s|%Y|%Z|%b" {} + 2>/dev/null';
 try{files=run(['shell',`run-as ${pkg} sh -c ${quote(query)}`]);}catch{
  try{files=run(['shell',`su 0 sh -c ${quote(`cd /data/user/0/${pkg} && ${query}`)}`]);}
  catch{skipped.push({pkg,reason:'cache inspection unavailable'});continue}
 }
 for(const line of files.trim().split('\n')){const [path,size,mtime,ctime,blocks]=line.split('|');
  if(!path||!/^((code_)?cache)\/[A-Za-z0-9_./ -]+$/.test(path)||path.split('/').includes('..')||/sqlite|\.db(?:-|$)|journal|receipt|wallet|session|credential|keychain|vault|account|evidence|report/i.test(path))continue;
  if(Math.max(Number(mtime),Number(ctime))*1000>=cutoff)continue;
  candidates.push({pkg,path,bytes:Number(size),blocks:Number(blocks),mtime:Number(mtime),ctime:Number(ctime),packageLastUse:new Date(last).toISOString()});
 }
}
const report={cutoff:new Date(cutoff).toISOString(),androidNoAtime:true,rule:'positive OS package last-use older than 48h, inactive process, old cache file mtime/ctime; never infer use from noatime',candidates,skipped};
await writeFile(join(out,'android-cache-inventory.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({candidates:candidates.length,bytes:candidates.reduce((n,c)=>n+c.bytes,0),packages:[...new Set(candidates.map(c=>c.pkg))],skipped:skipped.length},null,2));
