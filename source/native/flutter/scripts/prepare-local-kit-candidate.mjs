// Freeze built package bytes under a new local identity, without publication.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join,dirname} from 'node:path';
import {rustSourceIdentity,sha256,verifiedKitCandidate} from './candidate-inputs.mjs';
const [outArg,version,scope='UTC millisecond protocol']=process.argv.slice(2);
assert.ok(outArg&&/^0\.1\.0-flutter-ms\.\d{8}\.\d+$/.test(version),'NEW_OUTPUT LOCAL_VERSION');
const root=resolve(import.meta.dirname,'../../..'),source=join(root,'packages/kit'),out=resolve(outArg);
const files=JSON.parse(execFileSync('npm',['pack',source,'--dry-run','--ignore-scripts','--json'],{encoding:'utf8',maxBuffer:8*1024*1024}))[0].files;
const rust=await rustSourceIdentity(root);
await mkdir(out);await mkdir(join(out,'package'));
const kit=join(out,'package');
for(const {path}of files) {
  assert.ok(!path.startsWith('/')&&!path.split('/').includes('..'));
  await mkdir(dirname(join(kit,path)),{recursive:true});await copyFile(join(source,path),join(kit,path));
}
const pkg=JSON.parse(await readFile(join(kit,'package.json'))),sourceVersion=pkg.version;
pkg.version=version;pkg.private=true;
await writeFile(join(kit,'package.json'),JSON.stringify(pkg,null,2)+'\n');
const provenance=JSON.parse(await readFile(join(kit,'artifacts/provenance.json')));
provenance.package=`@tbc/kit@${version}`;
provenance.localProtocolTimeCandidate={sourceVersion,scope,deviceAcceptance:false,published:false};
await writeFile(join(kit,'artifacts/provenance.json'),JSON.stringify(provenance,null,2)+'\n');
const identity={schema:1,version,sourceVersion,protocolFingerprint:provenance.protocolFingerprint,rustSourceSha256:rust.sha256,files:{}};
for(const {path}of [...files].sort((a,b)=>a.path.localeCompare(b.path)))identity.files[path]=sha256(await readFile(join(kit,path)));
await writeFile(join(kit,'artifacts/flutter-kit-candidate.json'),JSON.stringify({artifactId:sha256(JSON.stringify(identity)),...identity},null,2)+'\n');
const verified=await verifiedKitCandidate(kit);
const tar=`tbc-kit-${version}.tgz`;
execFileSync('tar',['-czf',join(out,tar),'-C',out,'package']);
await writeFile(join(out,'candidate.json'),JSON.stringify({status:'FROZEN_LOCAL_NOT_DEVICE_ACCEPTED',...verified,tarball:tar,tarballSha256:sha256(await readFile(join(out,tar))),published:false,realChain:false},null,2)+'\n');
console.log(JSON.stringify({out,...verified}));
