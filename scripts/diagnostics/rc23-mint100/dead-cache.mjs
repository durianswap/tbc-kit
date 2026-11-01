// Simulator-owned retired installation caches only. Never current App/Data containers.
import {readdir,lstat,realpath,writeFile,mkdir,readFile,rm,statfs,unlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve,relative} from 'node:path';
const root=resolve(import.meta.dirname,'../../..'),dir=join(root,'docs/acceptance/evidence/rc23-mint100-repro');await mkdir(dir,{recursive:true});
const deviceIds=['CCD4C673-62BE-41EA-8209-1519ED0BD392','DA8B84D5-FEFF-4F44-9A21-30E730076411'];
const bases=deviceIds.map(id=>`/Users/alex/Library/Developer/CoreSimulator/Devices/${id}/data/Library/Caches/com.apple.containermanagerd/Dead`);
const cutoff=Date.now()-48*3600000;
const openPaths=execFileSync('lsof',['-nP','-F','n'],{encoding:'utf8',timeout:30000,maxBuffer:64*1024*1024}).split('\n').filter(v=>v.startsWith('n/')).map(v=>v.slice(1));
const installed=deviceIds.map(id=>execFileSync('xcrun',['simctl','listapps',id],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024})).join('\n');
async function inspect(path){
 const entries=[],apps=[];let valid=true,bytes=0,blocks=0,lastActivity=0;
 async function visit(p){
  const s=await lstat(p),r=relative(path,p);
  if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory())){valid=false;return;}
  // Directory reads by this audit are not application use; file reads count.
  lastActivity=Math.max(lastActivity,s.mtimeMs,s.ctimeMs,...(s.isFile()?[s.atimeMs]:[]));
  if(s.isDirectory()){
   if(p.endsWith('.app'))apps.push(r);
   if(/(^|\/)(Documents|Application Support|Keychains)$/.test(r))valid=false;
   for(const n of await readdir(p))await visit(join(p,n));
  }else{bytes+=s.size;blocks+=s.blocks;entries.push({path:r,size:s.size,mtime:s.mtimeMs,ctime:s.ctimeMs});}
 }
 await visit(path);
 entries.sort((a,b)=>a.path.localeCompare(b.path));
 const noData=entries.every(e=>/^[A-F0-9-]+\/(?:[^/]+\.app\/|com\.apple\.mobileinstallation\.placeholder\/|\.com\.apple\.mobile_container_manager\.metadata\.plist$)/.test(e.path));
 return {path,valid:valid&&noData&&apps.length===1,apps,bytes,allocatedBytes:blocks*512,lastActivity,entries};
}
function eligible(v){return v.valid&&v.lastActivity<cutoff&&!openPaths.some(p=>p===v.path||p.startsWith(v.path+'/'))&&!installed.includes(v.path);}
if(process.argv[2]==='binaries'||process.argv[2]==='delete-binaries'){
 const candidates=[],skipped=[];
 for(const base of bases)for(const temp of await readdir(base)){
  if(!/^temp\.[A-Za-z0-9]+$/.test(temp))continue;
  for(const uuid of await readdir(join(base,temp))){
   if(!/^[A-F0-9-]{36}$/.test(uuid))continue;
   const path=join(base,temp,uuid,'TuringClientLab.app','TuringClientLab');
   let s;try{s=await lstat(path)}catch{continue;}
   if(!s.isFile()||await realpath(path)!==path||Math.max(s.atimeMs,s.mtimeMs,s.ctimeMs)>=cutoff||openPaths.includes(path)||installed.includes(join(base,temp,uuid))){skipped.push(path);continue;}
   candidates.push({path,bytes:s.size,allocatedBytes:s.blocks*512,atime:s.atimeMs,mtime:s.mtimeMs,ctime:s.ctimeMs});
  }
 }
 const report={at:new Date().toISOString(),candidates,skipped,bytes:candidates.reduce((n,x)=>n+x.bytes,0),allocatedBytes:candidates.reduce((n,x)=>n+x.allocatedBytes,0),rule:'Only TuringClientLab Mach-O executable inside simulator-owned Dead cache; file atime/mtime/ctime older than 48h; not installed or open; no app data or evidence'};
 if(process.argv[2]==='delete-binaries'){
  const old=JSON.parse(await readFile(join(dir,'dead-binaries-audit.json'),'utf8'));
  const known=new Map(old.candidates.map(f=>[f.path,f])),before=await statfs(bases[0]),deleted=[];
  for(const f of candidates){if(JSON.stringify(f)!==JSON.stringify(known.get(f.path)))continue;await unlink(f.path);deleted.push(f);}
  const after=await statfs(bases[0]);
  const done={...report,candidates:undefined,deleted,bytes:deleted.reduce((n,f)=>n+f.bytes,0),allocatedBytes:deleted.reduce((n,f)=>n+f.allocatedBytes,0),availableDelta:Number(after.bavail*after.bsize-before.bavail*before.bsize),permanent:true,currentInstalledAppsRemoved:0,userDataRemoved:false};
  await writeFile(join(dir,'dead-binaries-deletion.json'),JSON.stringify(done,null,2));console.log(JSON.stringify({...done,deleted:deleted.length,skipped:skipped.length}));
 }else{await writeFile(join(dir,'dead-binaries-audit.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,candidates:candidates.length,skipped:skipped.length}));}
}else if(process.argv[2]==='delete'){
 const manifest=JSON.parse(await readFile(join(dir,'dead-cache-audit.json'),'utf8')),before=await statfs(bases[0]),deleted=[],skipped=[];
 for(const old of manifest.candidates){
  const base=bases.find(b=>old.path.startsWith(b+'/'));
  if(!base||!/^temp\.[A-Za-z0-9]+$/.test(relative(base,old.path))||await realpath(old.path)!==old.path)throw Error('Unexpected deletion target');
  const current=await inspect(old.path);
  if(!eligible(current)||JSON.stringify(current.entries)!==JSON.stringify(old.entries)){skipped.push(old.path);continue;}
  await rm(old.path,{recursive:true,force:false});deleted.push({...current,entries:undefined});
 }
 const after=await statfs(bases[0]);
 const report={at:new Date().toISOString(),deleted,skipped,bytes:deleted.reduce((n,r)=>n+r.bytes,0),allocatedBytes:deleted.reduce((n,r)=>n+r.allocatedBytes,0),availableDelta:Number(after.bavail*after.bsize-before.bavail*before.bsize),currentInstalledAppsRemoved:0,userDataRemoved:false,permanent:true};
 await writeFile(join(dir,'dead-cache-deletion.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,deleted:deleted.length,skipped:skipped.length}));
}else{
 const all=[];for(const base of bases)for(const n of await readdir(base)){if(/^temp\.[A-Za-z0-9]+$/.test(n))all.push(await inspect(join(base,n)));}
 const candidates=all.filter(eligible),report={at:new Date().toISOString(),cutoff:new Date(cutoff).toISOString(),rule:'Only retired installation caches with one .app, no user data, all file activity older than 48h, no open handles and not an installed path',candidates,excluded:all.filter(v=>!eligible(v)).map(({entries,...v})=>v)};
 await writeFile(join(dir,'dead-cache-audit.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({candidates:candidates.length,bytes:candidates.reduce((n,v)=>n+v.bytes,0),allocated:candidates.reduce((n,v)=>n+v.allocatedBytes,0),excluded:report.excluded.length}));
}
