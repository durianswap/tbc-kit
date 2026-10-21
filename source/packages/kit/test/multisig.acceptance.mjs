// Invoked by check-multisig.mjs with freshly built Native/WASM fixtures.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp } from "node:fs/promises";
import { openSync, closeSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { secp256k1 } from "@noble/curves/secp256k1";

const root = resolve(import.meta.dirname, "../../..");
const fixtures = process.env.TBC_MULTISIG_FIXTURE_DIR;
if (!fixtures) throw new Error("Run Rust multisig fixtures first; TBC_MULTISIG_FIXTURE_DIR is required");
const installed = process.env.TBC_MULTISIG_PACKAGE_ROOT;
const output = installed ? resolve(installed,"dist/esm") : await mkdtemp(resolve(tmpdir(), "tbc-multisig-client-"));
if(!installed)await build({ entryPoints: [resolve(root, "packages/kit/src/multisig.ts"), resolve(root, "packages/kit/src/keyless.ts")],
  bundle: true, format: "esm", platform: "node", outdir: output, logLevel: "silent" });
const { createMultisigClient, createMultisigMaterialLoader } = await import(pathToFileURL(resolve(output, "multisig.js")));
const { createWasmTbcKeylessEngine } = await import(pathToFileURL(resolve(output, installed ? "index.node.js" : "keyless.js")));
const wasm = await readFile(process.env.TBC_MULTISIG_WASM || (installed ? resolve(installed,"artifacts/wasm/tbc_keyless_wasm.wasm") :
  resolve(root, "packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm")));
const engine = await createWasmTbcKeylessEngine(wasm);
const client = createMultisigClient(engine);
const nativeDriver = process.env.TBC_MULTISIG_NATIVE_DRIVER;
const nativeInput=resolve(await mkdtemp(resolve(tmpdir(),"tbc-multisig-abi-input-")),"public.json");
const nativeCall = (operation, input) => {
  // A regular file provides deterministic EOF; the macOS synchronous pipe
  // harness can otherwise leave fread waiting after the public JSON arrives.
  writeFileSync(nativeInput,JSON.stringify(input),{mode:0o600});const fd=openSync(nativeInput,"r");
  try{return JSON.parse(execFileSync(nativeDriver,[operation],{stdio:[fd,"pipe","pipe"],encoding:"utf8",timeout:30000,maxBuffer:32*1024*1024}));}
  finally{closeSync(fd);}
};
const cases = (await Promise.all(["native", "token", "coin"].map(async name => JSON.parse(await readFile(resolve(fixtures, `${name}.json`), "utf8"))))).flat();
const require = createRequire(resolve(root, "packages/kit/package.json"));
const tbc = require("tbc-lib-js");
const Interpreter = require("tbc-lib-js/lib/script/interpreter.js");
const contractRoot=process.env.TBC_CONTRACT_ROOT;
const sdk=contractRoot?require(resolve(contractRoot,"lib/contract/multiSig.js")):undefined;
if(contractRoot)assert.equal(JSON.parse(await readFile(resolve(contractRoot,"package.json"),"utf8")).version,"1.7.3");
for (const key of ["MAX_SCRIPT_ELEMENT_SIZE", "MAXIMUM_ELEMENT_SIZE", "MAX_SCRIPT_SIZE", "MAX_OPCODE_COUNT"]) Interpreter[key] = Number.MAX_SAFE_INTEGER;
const keys = [1,2,3].map(n => new Uint8Array(32).fill(n)).sort((a,b) => Buffer.compare(secp256k1.getPublicKey(a), secp256k1.getPublicKey(b)));
const publicKey = key => Buffer.from(secp256k1.getPublicKey(key)).toString("hex");
function signer(key, counter) {
  return { publicKey: publicKey(key), approve: async () => {counter.approvals++; return true;},
    signDigest: async ({digest}) => { counter.signatures++; return {signature: secp256k1.sign(digest,key,{prehash:false,lowS:true}).toCompactHex(),encoding:"compact64"}; } };
}
function verifyVm(tx, inputs) {
  inputs.forEach((input,index) => {
    const vm = new Interpreter();
    const pass = vm.verify(tx.inputs[index].script,tbc.Script.fromHex(input.scriptPubKey),tx,index,
      Interpreter.DEFAULT_FLAGS,new tbc.crypto.BN(input.satoshis,10));
    assert.equal(pass,true,`input ${index}: ${vm.errstr}`);
  });
}

for (const fixture of cases) test(`Native/WASM + external signer + independent VM: ${fixture.name}`, async () => {
  const proposal = await client.prepare(fixture.proposal.request);
  assert.deepEqual(proposal, fixture.proposal);
  assert.deepEqual(await client.importProposal(await client.exportProposal(proposal)), proposal);
  const counter = {approvals:0,signatures:0};
  const participants = keys.filter(k => proposal.tasks.some(t=>t.publicKeys.includes(publicKey(k))));
  const sets = await Promise.all(participants.map(k => client.sign(proposal, signer(k,counter))));
  assert.equal(counter.approvals,participants.length);
  const merged = await client.combine(proposal,...sets);
  assert.equal((await client.verify(proposal,merged)).complete,true);
  const final = await client.finalize(proposal,merged);
  assert.deepEqual(final,fixture.result);
  if (nativeDriver) {
    assert.deepEqual(nativeCall("prepareMultisig", proposal.request), proposal, "real Native C ABI/WASM proposal parity");
    assert.deepEqual(nativeCall("finalizeMultisig", {proposal, signatures:merged}), final, "real Native C ABI/WASM finalization parity");
  }
  const tx = new tbc.Transaction(final.txraw);
  assert.equal(tx.id,final.txid);
  verifyVm(tx,fixture.inputs);
  if(sdk&&["transferTbc","mergeTbc","transferFt","mergeFt"].includes(proposal.request.action.type)){
    const groupTasks=proposal.tasks.filter(t=>t.requiredSignatures>1);
    const matrix=groupTasks.map(t=>t.publicKeys.flatMap(pk=>merged.filter(s=>s.inputIndex===t.inputIndex&&s.publicKey===pk).map(s=>s.signature)).slice(0,t.requiredSignatures));
    const partial=new tbc.Transaction(final.txraw);
    for(const task of groupTasks)partial.inputs[task.inputIndex].setScript(tbc.Script.empty());
    const ft=proposal.request.action.type.endsWith("Ft");
    const raw=sdk[ft?"finishMultiSigTransaction_transferFT":"finishMultiSigTransaction_sendTBC"](partial.uncheckedSerialize(),matrix,proposal.request.group.publicKeys);
    assert.equal(raw,final.txraw,"published SDK 1.7.3 finalization parity");
  }
  // Independent VM must reject a changed output, not just trust our own digest.
  tx.outputs[0].satoshis += 1;
  assert.throws(() => verifyVm(tx,fixture.inputs));
});

test("SDK key-order import and threshold boundaries execute in the script VM",async()=>{
  for(const [m,n,preserve]of [[1,3,false],[6,10,false],[2,3,true]]){
    const local=Array.from({length:n},(_,i)=>new Uint8Array(32).fill(i+1));
    const unsorted=local.map(publicKey).sort().reverse();
    const group={publicKeys:unsorted,requiredSignatures:m,...(preserve?{keyOrder:"provided"}:{})};
    const d=await client.describe(group);
    const decoded=await client.decodeAddress(d.address);
    assert.equal(decoded.requiredSignatures,m);assert.equal(decoded.publicKeyCount,n);
    assert.equal(decoded.scriptPubKey,d.scriptPubKey);assert.equal(decoded.tokenOwner,d.tokenOwner);
    assert.equal(await client.verifyAddress(d.address,group),true);
    await assert.rejects(client.decodeAddress(`${d.address}0`));
    if(sdk)assert.equal(d.address,sdk.getMultiSigAddress(d.group.publicKeys,m,n));
    if(preserve)assert.deepEqual(d.group.publicKeys,unsorted);
    const funding=new tbc.Transaction(cases[0].inputs[0].parentTxraw);
    funding.outputs[0].setScript(tbc.Script.fromHex(d.scriptPubKey));
    const input={txid:funding.id,vout:0,satoshis:String(funding.outputs[0].satoshis),scriptPubKey:d.scriptPubKey,parentTxraw:funding.uncheckedSerialize()};
    const p=await client.prepare({chainId:"tbc:testnet",group:d.group,maxFee:"10000",action:{type:"transferTbc",destination:cases[2].proposal.request.action.destination,amount:"10000",inputs:[input]}});
    const count={approvals:0,signatures:0};
    const sigs=await client.combine(p,...await Promise.all(local.slice(0,m).map(k=>client.sign(p,signer(k,count)))));
    const final=await client.finalize(p,sigs);verifyVm(new tbc.Transaction(final.txraw),[input]);
  }
});

test("approval rejection, canonical import, duplicate exchange and immutable handoff",async()=>{
  const p=await client.prepare(cases.find(c=>c.name==="transferTbc").proposal.request);
  const count={approvals:0,signatures:0};
  await assert.rejects(client.sign(p,{...signer(keys[0],count),approve:async()=>false}),/rejected/);
  assert.equal(count.signatures,0);
  const one=await client.sign(p,signer(keys[0],count));
  assert.equal((await client.verify(p,one)).complete,false);
  assert.deepEqual(await client.combine(p,one,one),one);
  await assert.rejects(client.finalize(p,one),/threshold/);
  const bad=JSON.parse(JSON.stringify(p));bad.request.action.amount="1";
  await assert.rejects(client.inspect(bad));
  assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.request.action)&&Object.isFrozen(p.tasks[0]));
});

test("optional public module does not join partner/default entries",async()=>{
  const manifest=JSON.parse(await readFile(resolve(root,"packages/kit/package.json"),"utf8"));
  assert.ok(manifest.exports["./multisig"]);
  for(const name of ["index.ts","wallet.ts","index.native.ts"]){
    assert.doesNotMatch(await readFile(resolve(root,"packages/kit/src",name),"utf8"),/from ["']\.\/multisig/);
  }
});

test("one batch approval and rejection before signing duplicate outpoints",async()=>{
  const p=cases.find(c=>c.name==="create").proposal;
  const q=cases.find(c=>c.name==="transferTbc").proposal;
  const count={approvals:0,signatures:0};
  const sets=await client.signBatch([p,q],signer(keys[0],count));
  assert.equal(sets.length,2);assert.equal(count.approvals,1);
  const before={...count};
  await assert.rejects(client.signBatch([p,p],signer(keys[0],count)),/unique/);
  assert.deepEqual(count,before);
  const extra=await client.sign(q,signer(keys[1],count));
  const completed=await client.finalizeBatch([{proposal:p,signatures:sets[0]},
    {proposal:q,signatures:await client.combine(q,sets[1],extra)}]);
  assert.deepEqual(completed,[cases.find(c=>c.name==="create").result,cases.find(c=>c.name==="transferTbc").result]);
  await assert.rejects(client.finalizeBatch([{proposal:p,signatures:sets[0]},{proposal:p,signatures:sets[0]}]),/unique/);
});

test("review covers all outputs and distinguishes FT from legacy stablecoin without HTTP",async()=>{
  let token=false,coin=false;
  for(const f of cases){
    const reviewed=await client.review(f.proposal),r=reviewed.review;
    assert.deepEqual(reviewed.proposal,f.proposal);
    assert.equal(r.proposalId,f.proposal.proposalId);
    assert.equal(r.feeAtomic,f.proposal.fee);
    const tx=new tbc.Transaction(f.proposal.unsignedTxraw);
    assert.deepEqual(r.outputs.flatMap(x=>x.vouts),tx.outputs.map((_,i)=>i));
    assert.equal(r.outputs.reduce((n,x)=>n+BigInt(x.nativeValueAtomic),0n),tx.outputs.reduce((n,x)=>n+BigInt(x.satoshis),0n));
    for(const row of r.outputs){
      if(row.kind==='token'){assert.ok(row.assetIdentity);assert.match(row.amountAtomic,/^[0-9]+$/);token ||= row.assetFamily==='FT';coin ||=row.assetFamily==='STABLE_COIN';}
      if(row.kind!=='metadata')assert.ok(row.recipient);
    }
    if(nativeDriver)assert.deepEqual(nativeCall('reviewMultisig',f.proposal),reviewed);
  }
  assert.ok(token&&coin);
});

test("batch snapshot cannot be replaced, appended, reordered or mutated during approval",async()=>{
  const originals=[cases.find(c=>c.name==='create').proposal,cases.find(c=>c.name==='transferTbc').proposal];
  const supplied=structuredClone(originals),count={approvals:0,signatures:0},seen=[];
  const local=signer(keys[0],count),realSign=local.signDigest;
  local.signDigest=async t=>{seen.push(t);return realSign(t);};
  local.approve=async(proposals,reviews)=>{
    count.approvals++;
    assert.equal(proposals.length,2);assert.equal(reviews.length,2);
    assert.deepEqual(reviews.map(x=>x.proposalId),originals.map(x=>x.proposalId));
    assert.throws(()=>{reviews[1].outputs[0].amountAtomic='0';},TypeError);
    assert.throws(()=>{proposals[1].request.action.destination=originals[0].address;},TypeError);
    supplied[1].request.action.amount='1';supplied[1].request.action.destination=originals[0].address;
    supplied.reverse();supplied.push(structuredClone(originals[0]));
    local.signDigest=async()=>assert.fail('signer callback was replaced during approval');
    await Promise.resolve();return true;
  };
  const sets=await client.signBatch(supplied,local);
  assert.equal(count.approvals,1);assert.equal(sets.length,2);
  assert.deepEqual(seen.map(t=>t.digest),originals.flatMap(p=>p.tasks.filter(t=>t.publicKeys.includes(local.publicKey)).map(t=>t.digest)));
  for(let i=0;i<sets.length;i++)assert.equal((await client.verify(originals[i],sets[i])).proposalId,originals[i].proposalId);
});

test("rejecting any mixed batch signs no item",async()=>{
  const proposals=[cases.find(c=>c.name==='create').proposal,cases.find(c=>c.name==='transferTbc').proposal];
  const count={approvals:0,signatures:0};
  await assert.rejects(client.signBatch(proposals,{...signer(keys[0],count),approve:async(_,reviews)=>{count.approvals++;assert.equal(reviews.length,2);return false;}}),/rejected/);
  assert.equal(count.approvals,1);assert.equal(count.signatures,0);
});

test("material loader reads only witness parents, single-flights shared funding and ancestors",async()=>{
  const f=cases.find(c=>c.name==="mergeFt-v4"), action=f.proposal.request.action;
  const raws=new Map();
  for(const item of action.token.inputs){raws.set(item.input.txid,item.input.parentTxraw);
    for(const raw of item.ancestors)raws.set(new tbc.Transaction(raw).id,raw);}
  raws.set(action.funding.txid,action.funding.parentTxraw);
  const seen=[];
  const loader=createMultisigMaterialLoader({chainId:"tbc:testnet",engine,api:{rawTransaction:async({txid})=>{
    seen.push(txid);assert.ok(raws.has(txid));return {txraw:raws.get(txid)};
  }}});
  const resolved=await loader.resolveToken({code:action.token.code,tape:action.token.tape,
    funding:action.funding,selected:action.token.inputs.map(i=>({txid:i.input.txid,vout:i.input.vout,balance:i.balance}))});
  assert.deepEqual(resolved,{token:action.token,funding:action.funding});
  assert.equal(seen.length,new Set(seen).size);
  assert.equal(seen.length,raws.size-1,"known immutable funding parent reused, no origin or whole-UTXO ancestry scan");
  assert.deepEqual(await client.prepare({...f.proposal.request,action:{...action,...resolved}}),f.proposal);
});

test("explicit legacy Coin route uses only stablecoin indexes and shares witness reads",async()=>{
  const f=cases.find(c=>c.name==="coin-transfer"),action=f.proposal.request.action,raws=new Map(),seen=[];
  for(const item of action.token.inputs){raws.set(item.input.txid,item.input.parentTxraw);
    for(const raw of item.ancestors)raws.set(new tbc.Transaction(raw).id,raw);}
  raws.set(action.funding.txid,action.funding.parentTxraw);
  const id="55".repeat(32),descriptor=await client.describe(f.proposal.request.group);
  const loader=createMultisigMaterialLoader({chainId:"tbc:testnet",engine,api:{
    stablecoinInfo:async args=>{assert.deepEqual(args,{stablecoin_id:id});seen.push("info");return {code_script:action.token.code,tape_script:action.token.tape};},
    stablecoinUtxosByCombineScript:async args=>{assert.deepEqual(args,{combine_script:descriptor.tokenOwner,stablecoin_id:id});seen.push("utxos");return {utxos:action.token.inputs.map(x=>({txid:x.input.txid,index:String(x.input.vout),ft_value:x.balance}))};},
    rawTransaction:async({txid})=>{seen.push(txid);assert.ok(raws.has(txid));return {txraw:raws.get(txid)};},
    ftInfo:async()=>assert.fail("Must not probe FT for a known Coin"),
    ftUtxosByCombineScript:async()=>assert.fail("Must not probe FT for a known Coin"),
  }});
  const material=await loader.tokenInputs({group:f.proposal.request.group,contractId:id,asset:"legacy-stablecoin",funding:action.funding});
  assert.deepEqual(material,{token:action.token,funding:action.funding});
  assert.equal(seen.length,new Set(seen).size);assert.equal(seen.length,raws.size+1);
  assert.deepEqual(await client.prepare({...f.proposal.request,action:{...action,...material}}),f.proposal);
  const before=seen.length;await assert.rejects(loader.tokenInputs({group:f.proposal.request.group,contractId:id,asset:"unknown"}),/Unsupported/);assert.equal(seen.length,before);
});
