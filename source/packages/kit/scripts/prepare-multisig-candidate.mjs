// Local development candidate only. Frozen releases and partner files are read-only.
import assert from "node:assert/strict";
import {cp,mkdir,readFile,writeFile,copyFile,readdir,rm} from "node:fs/promises";
import {resolve,join,relative} from "node:path";
import {execFileSync} from "node:child_process";
import {buildKitRuntime} from "./runtime-build.mjs";
import {stripWasmNameSection} from "./wasm-metadata.mjs";
import {fileInventory,sha256,platformCatalog} from "./platform-resources.mjs";
import {verifiedKitCandidate,rustSourceIdentity} from "../../../native/flutter/scripts/candidate-inputs.mjs";

const [baseArg,outArg,version,proofArg]=process.argv.slice(2);
assert.ok(baseArg&&outArg&&version&&proofArg,"FROZEN_BASE NEW_DIRECTORY NEW_VERSION OFFLINE_REPORT");
assert.match(version,/^0\.1\.0-multisig\.\d{8}\.\d+$/);
const root=resolve(import.meta.dirname,"../../.."),base=resolve(baseArg),out=resolve(outArg);
const proof=JSON.parse(await readFile(resolve(proofArg)));
assert.equal(proof.status,"PASS_OFFLINE_MULTISIG");
for(const p of Object.values(proof.proofs))assert.equal(sha256(await readFile(p.path)),p.sha256,"Acceptance source/artifact drift");
const baseline=await verifiedKitCandidate(base),before=await fileInventory(base);
const rust=await rustSourceIdentity(root);
await mkdir(out);const kit=join(out,"package");
await cp(base,kit,{recursive:true,force:false,errorOnExist:true,filter:p=>{
  const r=relative(base,p).replaceAll("\\","/");
  // Rebuild executable JS; only the existing private parser copy is reused.
  return !/^dist\/(?:esm|cjs)\/[^/]+/.test(r)||/^dist\/(?:esm|cjs)\/vendor(?:\/|$)/.test(r);
}});
await buildKitRuntime({root,packageRoot:kit,minifyWhitespace:true});
async function removeGeneratedMaps(dir){
  for(const e of await readdir(dir,{withFileTypes:true})){
    const p=join(dir,e.name);if(e.isDirectory()){await removeGeneratedMaps(p);continue;}
    if(e.name.endsWith(".map"))await rm(p);
    else if(/\.(js|cjs)$/.test(e.name)){
      const text=await readFile(p,"utf8");await writeFile(p,text.replace(/\/\/# sourceMappingURL=[^\r\n]*/g,""));
    }
  }
}
await removeGeneratedMaps(join(kit,"dist/esm"));await removeGeneratedMaps(join(kit,"dist/cjs"));
const types=join(out,"types-build");
execFileSync(join(root,"node_modules/.bin/tsc"),["-p",join(root,"packages/kit/tsconfig.json"),"--declarationDir",types],{cwd:root,stdio:"inherit"});
for(const name of ["multisig","multisig-material","keyless"])
  await copyFile(join(types,`${name}.d.ts`),join(kit,"dist/types",`${name}.d.ts`));
await copyFile(join(root,"packages/kit/docs/multisig.md"),join(kit,"docs/multisig.md"));
await cp(join(root,"packages/kit/examples/multisig"),join(kit,"examples/multisig"),{recursive:true});
await copyFile(join(root,"packages/kit/README.md"),join(kit,"README.md"));
const manifest=JSON.parse(await readFile(join(kit,"package.json")));
manifest.version=version;
manifest.exports["./multisig"]=JSON.parse(await readFile(join(root,"packages/kit/package.json"))).exports["./multisig"];
await writeFile(join(kit,"package.json"),JSON.stringify(manifest,null,2)+"\n");
const wasm=stripWasmNameSection(await readFile(proof.proofs.wasm.path));
await writeFile(join(kit,"artifacts/wasm/tbc_keyless_wasm.wasm"),wasm);
// Native host proof is a separate local artifact. Do not relabel frozen phone
// resources or claim they contain the new multisig operation dispatch.
await mkdir(join(out,"native"));
await copyFile(proof.proofs.native.path,join(out,"native/libtbc_keyless_native.dylib"));
await copyFile(join(root,"packages/tbc-engine/rust/crates/tbc-keyless-native/include/tbc_keyless.h"),join(out,"native/tbc_keyless.h"));
const provenance=JSON.parse(await readFile(join(kit,"artifacts/provenance.json")));
provenance.package=`@tbc/kit@${version}`;
for(const a of provenance.artifacts)if(a.path==="artifacts/wasm/tbc_keyless_wasm.wasm"){
  a.sha256=sha256(wasm);a.rustSourceSha256=rust.sha256;
}
const catalog=await platformCatalog(base);
if(catalog){catalog.package=provenance.package;const bytes=JSON.stringify(catalog,null,2)+"\n";
  await writeFile(join(kit,"artifacts/platform-resources.json"),bytes);provenance.platformResources.sha256=sha256(bytes);}
provenance.multisig={baseline,keylessRustSourceSha256:rust.sha256,proofs:proof.proofs,
  validated:["WASM","macOS arm64 C ABI"],phoneNativeResources:"inherited; no multisig acceptance",realChain:false,
  partnerDelivery:false,scope:"Optional SDK M-of-N entry. Main Engine and external phone resources retain their baseline source identity."};
await writeFile(join(kit,"artifacts/provenance.json"),JSON.stringify(provenance,null,2)+"\n");
const source=JSON.parse(await readFile(join(kit,"artifacts/source-build.json")));
source.version=version;source.multisig={rustSourceSha256:rust.sha256,proofs:proof.proofs};
for(const name of ["core","host","provider","wallet-standard","tbc-engine","kit"])
  for(const [p,item]of Object.entries(await fileInventory(join(root,"packages",name,"src"))))source.sourceFiles[`packages/${name}/src/${p}`]=item.sha256;
await writeFile(join(kit,"artifacts/source-build.json"),JSON.stringify(source,null,2)+"\n");
const files=await fileInventory(kit);
const identity={schema:1,version,sourceVersion:baseline.version,protocolFingerprint:baseline.protocolFingerprint,
  rustSourceSha256:baseline.rustSourceSha256,multisigRustSourceSha256:rust.sha256,
  files:Object.fromEntries(Object.entries(files).filter(([p])=>p!=="artifacts/flutter-kit-candidate.json").map(([p,x])=>[p,x.sha256]))};
await writeFile(join(kit,"artifacts/flutter-kit-candidate.json"),JSON.stringify({artifactId:sha256(JSON.stringify(identity)),...identity},null,2)+"\n");
await verifiedKitCandidate(kit);await platformCatalog(kit);
assert.deepEqual(await fileInventory(base),before,"Frozen Kit was modified");
const [packed]=JSON.parse(execFileSync("npm",["pack","--ignore-scripts","--json","--pack-destination",out],{cwd:kit,encoding:"utf8",maxBuffer:8*1024*1024}));
const report={status:"BUILT_LOCAL_MULTISIG_CANDIDATE",version,baseline,tarball:packed.filename,
  sha256:sha256(await readFile(join(out,packed.filename))),bytes:packed.size,unpackedBytes:packed.unpackedSize,
  keylessWasmSha256:sha256(wasm),nativeHostSha256:proof.proofs.native.sha256,rustSourceSha256:rust.sha256,
  frozenBaseUnchanged:true,published:false,realChain:false,phoneNativeAcceptance:false,partnerDeliveryChanged:false};
await writeFile(join(out,"candidate.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
