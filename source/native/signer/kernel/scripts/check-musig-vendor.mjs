// Verify exact imported crate bytes; allow only the declared optional build flag.
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
const root=resolve(import.meta.dirname,'../vendor/secp256k1-sys');
const expectedPackage='dcb913707158fadaf0d8702c2db0e857de66eb003ccfdda5924b5f5ac98efb38';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const provenance=resolve(root,'../secp256k1-sys-provenance.json');
// One-time mechanical import record from checksum-verified Cargo archive.
if(process.argv[2]){
  assert.equal(process.argv.length,3);const archive=resolve(process.argv[2]);
  assert.equal(sha(await readFile(archive)),expectedPackage);
  const output=await mkdtemp(join(tmpdir(),'tbc-secp-import-'));
  execFileSync('tar',['-xf',archive,'-C',output]);
  const source=join(output,'secp256k1-sys-0.11.0'),files={};
  async function walk(prefix=''){for(const e of await readdir(join(source,prefix),{withFileTypes:true})){
    const path=prefix?prefix+'/'+e.name:e.name;assert.ok(!e.isSymbolicLink());
    if(e.isDirectory())await walk(path);else files[path]=sha(await readFile(join(source,path)));
  }}await walk();
  await writeFile(provenance,JSON.stringify({package:expectedPackage,crate:'secp256k1-sys',version:'0.11.0',files},null,2)+'\n',{flag:'wx'});
}
const checksum=JSON.parse(await readFile(provenance,'utf8'));
assert.equal(checksum.package,expectedPackage);
const patches={
  'Cargo.toml':'tbc-musig = []\n',
  'build.rs':'    // TBC extension: compile the unmodified, pinned upstream MuSig2 module.\n    #[cfg(feature = "tbc-musig")]\n    base_config.define("ENABLE_MODULE_MUSIG", Some("1"));\n',
};
for(const [file,expected] of Object.entries(checksum.files)){
  assert.ok(!file.split('/').includes('..')&&!file.startsWith('/'));
  let bytes=await readFile(join(root,file));
  if(patches[file]){const content=bytes.toString('utf8');assert.equal(content.split(patches[file]).length,2);bytes=Buffer.from(content.replace(patches[file],''));}
  // apply_patch normalizes the upstream build.rs extra terminal blank line.
  if(file==='build.rs'){assert.ok(bytes.toString().endsWith('}\n'));bytes=Buffer.concat([bytes,Buffer.from('\n')]);}
  assert.equal(sha(bytes),expected,file);
}
console.log(JSON.stringify({status:'PASS',files:Object.keys(checksum.files).length,allowedChanges:Object.keys(patches),algorithmChanges:0}));
