// Scoped, offline gate. No source generation, publication, wallet or funds.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFile, writeFile, mkdir, mkdtemp} from "node:fs/promises";
import {resolve, join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";

const root=resolve(import.meta.dirname,"../../.."), rust=join(root,"packages/tbc-engine/rust");
const sdk=process.env.TBC_CONTRACT_ROOT;
assert.ok(sdk,"TBC_CONTRACT_ROOT must point to the audited tbc-contract 1.7.3 source");
assert.equal(JSON.parse(await readFile(join(sdk,"package.json"))).version,"1.7.3");
const out=process.argv[2]?resolve(process.argv[2]):await mkdtemp(join(tmpdir(),"tbc-multisig-check-"));
if(process.argv[2])await mkdir(out);
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const fixtures=join(out,"fixtures");await mkdir(fixtures);
const evidence=[];
function run(label,command,args,options={}) {
  console.log(`Running ${label}`);
  const start=performance.now();
  try {
    const result=execFileSync(command,args,{cwd:root,encoding:"utf8",timeout:300000,maxBuffer:32*1024*1024,
      env:{...process.env,TBC_MULTISIG_FIXTURE_DIR:fixtures},...options});
    evidence.push({label,milliseconds:performance.now()-start,exitCode:0});
    return result;
  } catch(error) {
    console.error(error.stdout?.toString()??"",error.stderr?.toString()??"");throw error;
  }
}
const tests=run("keyless regression and multisig fixtures","cargo",["test","--offline","--locked","-p","tbc-keyless-core","-p","tbc-keyless-native"],{cwd:rust});
await writeFile(join(out,"rust-tests.log"),tests);
run("release WASM","cargo",["build","--offline","--locked","--release","-p","tbc-keyless-wasm","--target","wasm32-unknown-unknown"],{cwd:rust});
run("release host Native","cargo",["build","--offline","--locked","--release","-p","tbc-keyless-native"],{cwd:rust});
const library=join(rust,"target/release",process.platform==="darwin"?"libtbc_keyless_native.dylib":"libtbc_keyless_native.so");
const driver=join(out,"native-driver");
run("C ABI consumer","cc",[join(root,"packages/kit/test/fixtures/multisig-native-driver.c"),
  "-I",join(rust,"crates/tbc-keyless-native/include"),"-L",join(rust,"target/release"),
  "-Wl,-rpath,"+join(rust,"target/release"),"-ltbc_keyless_native","-o",driver]);
const node=run("SDK parity, independent VM, batching and request budget",process.execPath,["--test","packages/kit/test/multisig.acceptance.mjs"],{
  env:{...process.env,NODE_PATH:join(root,"packages/kit/node_modules"),TBC_MULTISIG_FIXTURE_DIR:fixtures,TBC_MULTISIG_NATIVE_DRIVER:driver,TBC_CONTRACT_ROOT:sdk},
});
await writeFile(join(out,"node-tests.log"),node);
run("Kit TypeScript","./node_modules/.bin/tsc",["-p","packages/kit/tsconfig.json","--noEmit"]);
const source=await readFile(join(rust,"crates/tbc-keyless-core/src/multisig.rs"),"utf8");
assert.doesNotMatch(source,/PrivateKey|sign_ecdsa_digest|reqwest|tokio|sqlx|keychain/i);
const featureTree=run("production signing boundary","cargo",["tree","--offline","--locked","-p","tbc-keyless-native","-e","features,no-dev"],{cwd:rust});
assert.doesNotMatch(featureTree,/tbc-sdk feature "internal-signing"/);
await writeFile(join(out,"production-features.log"),featureTree);
const proofs={};
for(const [name,p]of Object.entries({
  wasm:join(rust,"target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm"),native:library,
  sdk:join(sdk,"lib/contract/multiSig.ts"),core:join(rust,"crates/tbc-keyless-core/src/multisig.rs"),
  client:join(root,"packages/kit/src/multisig.ts"),loader:join(root,"packages/kit/src/multisig-material.ts"),
}))proofs[name]={path:p,sha256:hash(await readFile(p))};
const report={status:"PASS_OFFLINE_MULTISIG",timestamp:new Date().toISOString(),evidence,proofs,
  rustPassed:[...tests.matchAll(/test result: ok\. (\d+) passed/g)].reduce((s,m)=>s+Number(m[1]),0),
  nodePassed:Number(node.match(/# pass (\d+)/)[1]),realChain:false,networkRequests:0,broadcasts:0,
  mobileDeviceAcceptance:false,partnerDeliveryChanged:false};
await writeFile(join(out,"report.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({report:join(out,"report.json"),...report},null,2));
