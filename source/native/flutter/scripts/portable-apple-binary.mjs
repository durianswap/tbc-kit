// Strip only staging-copy debug/local symbols. Public ABI symbols must remain
// identical; signing, if any, is performed after this packaging step.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';

// Derive roots from the complete C headers, not whichever symbols happen to be
// called by one smoke test. ObjC classes are also dynamic dispatch roots.
export function applePublicSymbols(headers,classes=[]) {
 const names=new Set(classes.flatMap(name=>{
  assert.match(name,/^[A-Za-z][A-Za-z0-9_]*$/);
  return [`_OBJC_CLASS_$_${name}`,`_OBJC_METACLASS_$_${name}`];
 }));
 for(const header of headers) {
  const declarations=header.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
  for(const match of declarations.matchAll(/\b(tbc_[A-Za-z0-9_]+)\s*\(/g))names.add('_'+match[1]);
 }
 assert.ok(names.size,'Empty Apple public ABI');
 return [...names].sort();
}
export function applePublicLinkFlags(exportFile,headerPaths,classes=[]) {
 const names=applePublicSymbols(headerPaths.map(p=>readFileSync(p,'utf8')),classes);
 writeFileSync(exportFile,names.join('\n')+'\n',{flag:'wx'});
 return ['-O2','-Wl,-dead_strip',`-Wl,-exported_symbols_list,${exportFile}`];
}
export function verifyApplePublicAbi(binary,exportFile) {
 const actual=execFileSync('xcrun',['nm','-gU',binary],{encoding:'utf8',maxBuffer:32*1024*1024})
  .trim().split('\n').filter(Boolean).map(line=>line.trim().split(/\s+/).at(-1)).sort();
 assert.deepEqual(actual,readFileSync(exportFile,'utf8').trim().split('\n').sort(),
  'Apple framework must export the complete declared ABI and no private Rust/C++ symbols');
}

export function stripAppleDebugSymbols(binary) {
  const symbols = () => execFileSync('xcrun', ['nm', '-gU', binary],
    {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024})
    .trim().split('\n').map(line => line.replace(/^[0-9a-fA-F]+\s+/u, '')).sort();
  const before = symbols();
  execFileSync('xcrun', ['strip', '-S', '-x', binary],
    {maxBuffer: 8 * 1024 * 1024});
  assert.deepEqual(symbols(), before, 'Apple framework exported symbols changed');
  const staged = readFileSync(binary);
  for (const prefix of ['/Users/', '/private/tmp/', '/var/folders/']) {
    assert.ok(!staged.includes(Buffer.from(prefix)),
      `Apple framework still embeds a build-machine path: ${prefix}`);
  }
}
