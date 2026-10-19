// Acceptance fixture only: public scalars 1/2 in separate WASM instances in one
// Node process. This is NOT independent custody, UI consent or a production signer.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join, resolve} from 'node:path';

export async function createCoinMuSigFixtureSigner(sdkPath, tbc, hashCanonical) {
  assert.ok(sdkPath, 'TBC_COIN_MUSIG_SIGNER_SDK required');
  const sdk=resolve(sdkPath),sha=b=>createHash('sha256').update(b).digest('hex');
  const identity=JSON.parse(await readFile(join(sdk,'identity.json')));
  assert.equal(identity.sdkVersion,'0.1.0-local.5');
  assert.equal(identity.artifactSetId,'b1e6fa0d78a85b4702eabea52aa16cfae74fbfee82c90edb37142218c9fd0bfd');
  const adapter=join(sdk,'kernel/wasm/musig-adapter.mjs');
  assert.equal(sha(await readFile(adapter)),'5457aeb7beffaef2526afe53143f1c8c78f9f28524f327ef5e25395bcfce2122');
  const wasm=await readFile(join(sdk,'kernel/artifacts/wasm/tbc_signer_kernel.wasm'));
  assert.equal(sha(wasm),'fde7b3c63a0a9a1a585b7d62de6d9f39cac0646fa7892bab1892d9b6f73ec580');
  const {createWasmMuSigSigner}=await import(pathToFileURL(adapter));
  const peers=await Promise.all([1,2].map(()=>createWasmMuSigSigner(wasm)));
  const scalar=n=>{const v=new Uint8Array(32);v[31]=n;return v;};
  const publicKeys=[1,2].map(n=>{
    const key=scalar(n);try{return tbc.crypto.MuSig2.pubkeyFromSk(Buffer.from(key)).toString('hex');}finally{key.fill(0);}
  });
  assert.deepEqual([...publicKeys].sort(),publicKeys);
  const aggregateKey=peers[0].aggregateKey(publicKeys);
  assert.equal(peers[1].aggregateKey(publicKeys),aggregateKey);
  const group=tbc.crypto.MuSig2.keyAgg(publicKeys.map(k=>Buffer.from(k,'hex')));
  assert.equal(tbc.crypto.MuSig2.getAggPubkey(group).toString('hex'),aggregateKey);
  const address=tbc.PublicKey.fromString('02'+aggregateKey).toAddress().toString();
  let tasks=0,partials=0,reuseRejected=0;
  return Object.freeze({
    publicKey:'02'+aggregateKey,address,
    async sign(input) {
      assert.equal(input.approval.status,'approved');
      assert.equal(input.task.signatureEncoding,'schnorr64');
      assert.equal(input.task.algorithm,'secp256k1-schnorr-bip340');
      assert.equal(input.task.publicKey,aggregateKey);
      assert.equal(input.task.accountId,'tbc:testnet:'+address);
      const digest=input.task.digest,binding=hashCanonical({task:input.task,approval:input.approval});
      const common={publicKeys,aggregateKey,digest,binding,expiresAt:Math.floor(performance.now())+120000};
      const sessions=[],keys=[scalar(1),scalar(2)];
      try {
        for(let i=0;i<2;i++)sessions.push(peers[i].begin({...common,scalar:keys[i]}));
        const publicNonces=sessions.map(s=>s.publicNonce);
        const signatures=peers.map((peer,i)=>peer.sign({handle:sessions[i].handle,binding,digest,scalar:keys[i],publicNonces}));
        const oracle=tbc.crypto.MuSig2.buildSession(group,tbc.crypto.MuSig2.nonceAgg(publicNonces.map(n=>Buffer.from(n,'hex'))),Buffer.from(digest,'hex'));
        for(let i=0;i<2;i++) {
          assert.equal(tbc.crypto.MuSig2.partialVerify(Buffer.from(signatures[i],'hex'),Buffer.from(publicNonces[i],'hex'),Buffer.from(publicKeys[i],'hex'),oracle),true);
          assert.throws(()=>peers[i].sign({handle:sessions[i].handle,binding,digest,scalar:keys[i],publicNonces}),/106/);
          reuseRejected++;
        }
        const signature=peers[0].combine({...common,publicNonces,partialSignatures:signatures});
        assert.equal(tbc.crypto.Schnorr.verify(Buffer.from(digest,'hex'),Buffer.from(signature,'hex'),Buffer.from(aggregateKey,'hex')),true);
        tasks++;partials+=2;return signature;
      } finally {keys.forEach(k=>k.fill(0));peers.forEach(p=>p.cancelAll());}
    },
    evidence:()=>({tasks,partials,reuseRejected,actualRustWasm:true,sdkPartialAndFinalVerified:true,
      independentCustody:false,publicFixtureOnly:true,secretNonceExported:false}),
  });
}
