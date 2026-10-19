// Compile the already pinned Bitcoin library with its MuSig module enabled.
// Isolated offline probe: never changes Cargo.toml/lock, signer delivery or wallet.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const run=(cmd,args,options={})=>execFileSync(cmd,args,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024,...options});
const host=run('rustc',['-vV']).match(/^host: (.+)$/m)?.[1];assert.ok(host);
const metadata=JSON.parse(run('cargo',['metadata','--locked','--offline','--format-version','1','--filter-platform',host]));
const dep=metadata.packages.find(p=>p.name==='secp256k1-sys');assert.equal(dep?.version,'0.11.0');
const source=join(dirname(dep.manifest_path),'depend/secp256k1');
const out=await mkdtemp(join(tmpdir(),'tbc-musig-library-probe-'));
const binary=join(out,'probe');
run('cc',['-O2','-include','stdio.h','-DENABLE_MODULE_EXTRAKEYS=1','-DENABLE_MODULE_SCHNORRSIG=1','-DENABLE_MODULE_MUSIG=1',
  '-DECMULT_WINDOW_SIZE=15','-DECMULT_GEN_PREC_BITS=4',
  '-I'+join(source,'include'),'-I'+source,
  join(root,'fixtures/musig-library-probe.c'),join(source,'src/secp256k1.c'),
  join(source,'src/precomputed_ecmult.c'),join(source,'src/precomputed_ecmult_gen.c'),'-o',binary]);
const transcript=JSON.parse(run(binary,[]));
const require=createRequire(import.meta.url),tbc=require('tbc-lib-js');
assert.equal(require('tbc-lib-js/package.json').version,'1.0.31');
const {MuSig2,Schnorr}=tbc.crypto,buf=x=>Buffer.from(x,'hex');
const ctx=MuSig2.keyAgg(MuSig2.keySort(transcript.parties.map(p=>buf(p.publicKey))));
assert.equal(MuSig2.getAggPubkey(ctx).toString('hex'),transcript.aggregateKey);
const session=MuSig2.buildSession(ctx,MuSig2.nonceAgg(transcript.parties.map(p=>buf(p.publicNonce))),buf(transcript.message));
for(const p of transcript.parties){
  assert.equal(MuSig2.partialVerify(buf(p.partialSignature),buf(p.publicNonce),buf(p.publicKey),session),true);
  const altered=buf(p.partialSignature);altered[31]^=1;
  assert.equal(MuSig2.partialVerify(altered,buf(p.publicNonce),buf(p.publicKey),session),false);
}
assert.equal(MuSig2.partialSigAgg(transcript.parties.map(p=>buf(p.partialSignature)),session).toString('hex'),transcript.signature);
assert.equal(Schnorr.verify(buf(transcript.message),buf(transcript.signature),buf(transcript.aggregateKey)),true);
assert.equal(transcript.nonceCleared,true);assert.equal(transcript.nonceReuseRejected,true);assert.equal(transcript.wrongMessageRejected,true);
const hashes={};
for(const file of ['include/secp256k1_musig.h','src/modules/musig/main_impl.h','src/modules/musig/session_impl.h','src/modules/musig/keyagg_impl.h'])
  hashes[file]=createHash('sha256').update(await readFile(join(source,file))).digest('hex');
const report={status:'PASS',at:new Date().toISOString(),source:dep.source,version:dep.version,sourceHashes:hashes,
  transcript,scope:'offline public fixtures; no production bindings or delivery; not a cryptographic audit',
  sdkInterop:true,networkRequests:0,realKeys:false};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'PASS',output:out,sdkInterop:true,nonceCleared:true,networkRequests:0}));
