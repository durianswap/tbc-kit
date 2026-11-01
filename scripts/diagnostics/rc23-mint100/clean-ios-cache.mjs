// Delete only the already audited, old, unopened regenerable GPU cache files.
import {readFile,writeFile,lstat,realpath,unlink,mkdir,statfs} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../../..');
const out=join(root,'.verify/rc23-mint100-repro');
const manifest=JSON.parse(await readFile(join(out,'ios-cache-approved.json'),'utf8'));
const allowed='/Users/alex/Library/Developer/CoreSimulator/Devices/CCD4C673-62BE-41EA-8209-1519ED0BD392/data/Containers/Data/Application/F98ADCC9-2B6B-4EDD-AB0A-9A3F297E3222/Library/Caches/com.apple.WebKit.GPU/';
const openFiles=new Set(execFileSync('lsof',['-nP','-F','n'],{encoding:'utf8',maxBuffer:64*1024*1024,timeout:30000}).split('\n').filter(s=>s.startsWith('n/')).map(s=>s.slice(1)));
const before=await statfs(allowed),deleted=[],skipped=[],cutoff=Date.now()-48*3600000;
for(const f of manifest.files){
 if(!f.path.startsWith(allowed)||!/(?:modules\.idx|monolithic_metal\.pcm|functions\.(?:data|list)|libraries\.(?:data|list)|modules\.timestamp)$/.test(f.path))throw Error('Not an approved GPU cache');
 const st=await lstat(f.path);
 if(!st.isFile()||await realpath(f.path)!==f.path||openFiles.has(f.path)||Math.max(st.atimeMs,st.mtimeMs,st.ctimeMs)>=cutoff||st.size!==f.bytes||st.mtimeMs!==f.mtimeMs||st.ctimeMs!==f.ctimeMs){skipped.push(f.path);continue;}
 await unlink(f.path);deleted.push({...f,allocatedBytes:st.blocks*512});
}
const after=await statfs(allowed);
const report={time:new Date().toISOString(),rule:'Last access/modification/change older than 48h; unchanged audited file; not open; allowlisted regenerable GPU cache only',deleted,skipped,deletedBytes:deleted.reduce((n,f)=>n+f.bytes,0),allocatedBytes:deleted.reduce((n,f)=>n+f.allocatedBytes,0),filesystemAvailableDelta:Number(after.bavail*after.bsize-before.bavail*before.bsize),permanent:true,regenerable:true,appsRemoved:0,accountOrDatabaseFilesRemoved:0};
const dest=join(root,'docs/acceptance/evidence/rc23-mint100-repro');await mkdir(dest,{recursive:true});
await writeFile(join(dest,'cache-cleanup.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({deleted:deleted.length,skipped:skipped.length,bytes:report.deletedBytes,allocated:report.allocatedBytes,availableDelta:report.filesystemAvailableDelta}));
