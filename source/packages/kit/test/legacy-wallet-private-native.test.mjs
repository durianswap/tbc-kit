import assert from "node:assert/strict";
import test from "node:test";

import { createLegacyWalletPrivateNativeAdapters } from "../dist/esm/wallet.js";

const BINDING_HASH = "ab".repeat(32);
const approval = Object.freeze({
  status: "approved",
  bindingHash: BINDING_HASH,
  approvalId: "approval-1",
});

function binding(operationKind, request) {
  return Object.freeze({
    version: "1.0",
    operationKind,
    bindingHash: BINDING_HASH,
    requestHash: "cd".repeat(32),
    context: Object.freeze({
      origin: "https://private-native.test",
      chainId: "tbc:testnet",
      accountId: "tbc:testnet:1Wallet",
      sessionId: "session",
      navigationId: "navigation",
    }),
    request,
  });
}

test("restricted Native adapters pass canonical requests without key scalars and never retry", async () => {
  const calls = [];
  const adapters = createLegacyWalletPrivateNativeAdapters({
    async call(method, requestJson) {
      calls.push({ method, requestJson });
      assert.equal(requestJson.includes("scalar"), false);
      assert.equal(requestJson.includes("privateKey"), false);
      const request = JSON.parse(requestJson);
      const value = method === "signP2pkh"
        ? { sigs: [["3041"]] }
        : method === "signAssociated"
          ? { txraws: ["0102"] }
          : method === "encryptMessage"
            ? { encryptedMessage: "bie1" }
            : { messageHex: "68656c6c6f20e4bda0e5a5bd" };
      if (method === "encryptMessage") assert.deepEqual(request, { messageHex: "68656c6c6f" });
      if (method === "decryptMessage") assert.deepEqual(request, { encryptedMessage: "bie1" });
      return JSON.stringify({ ok: true, value, version: "1.0" });
    },
  });

  const rawRequest = Object.freeze({
    txraws: Object.freeze(["0102"]),
    utxos_satoshis: Object.freeze([Object.freeze([1])]),
    script_pubkeys: Object.freeze([Object.freeze(["00"])]),
  });
  assert.deepEqual(
    await adapters.rawSigner.sign({ binding: binding("signTransaction", rawRequest), approval }),
    { sigs: [["3041"]] },
  );
  assert.deepEqual(
    await adapters.cryptoAdapter.encrypt({
      binding: binding("encrypt", { message: "hello" }),
      approval,
    }),
    { encryptedMessage: "bie1" },
  );
  assert.deepEqual(
    await adapters.cryptoAdapter.decrypt({
      binding: binding("decrypt", { message: "bie1" }),
      approval,
    }),
    { decryptedMessage: "hello 你好" },
  );
  assert.deepEqual(
    await adapters.associatedExecutor.execute({
      operationDigest: "ef".repeat(32),
      request: Object.freeze({ sourceTxraw: "0102", sourceUtxos: Object.freeze([]) }),
    }),
    { txraws: ["0102"] },
  );
  assert.deepEqual(calls.map(({ method }) => method), [
    "signP2pkh",
    "encryptMessage",
    "decryptMessage",
    "signAssociated",
  ]);

  await assert.rejects(
    adapters.rawSigner.sign({
      binding: binding("signTransaction", rawRequest),
      approval: { ...approval, bindingHash: "00".repeat(32) },
    }),
    /approval binding mismatch/u,
  );
  assert.equal(calls.length, 4, "a failed binding never reaches Native");
});

test("restricted Native adapters fail closed on malformed and error envelopes", async () => {
  let calls = 0;
  const malformed = createLegacyWalletPrivateNativeAdapters({
    async call() {
      calls += 1;
      return JSON.stringify({ ok: true, value: {}, version: "1.0", extra: true });
    },
  });
  await assert.rejects(
    malformed.associatedExecutor.execute({
      operationDigest: "11".repeat(32),
      request: { sourceTxraw: "0102", sourceUtxos: [] },
    }),
    /Invalid wallet-private Native response/u,
  );
  assert.equal(calls, 1, "wallet-private operations are never retried");

  const failed = createLegacyWalletPrivateNativeAdapters({
    async call() {
      return JSON.stringify({
        ok: false,
        error: { code: "INVALID_INPUT", message: "invalid request", path: "wallet-private-native" },
        version: "1.0",
      });
    },
  });
  await assert.rejects(
    failed.associatedExecutor.execute({
      operationDigest: "22".repeat(32),
      request: { sourceTxraw: "0102", sourceUtxos: [] },
    }),
    /^Error: Wallet-private Native operation failed$/u,
  );
});

test("Native failure channels never echo request fragments or retain raw causes", async () => {
  const marker='PUBLIC_SYNTHETIC_PRIVACY_SENTINEL';
  for(const mode of ['envelope','throw','malformed'])for(const method of ['associated','raw','encrypt','decrypt']){
    let calls=0;
    const adapters=createLegacyWalletPrivateNativeAdapters({async call(){
      calls++;
      if(mode==='throw')throw new Error(marker,{cause:{request:marker}});
      return mode==='malformed'?`malformed ${marker}`:JSON.stringify({version:'1.0',ok:false,
        error:{code:marker,message:marker,path:marker,data:{request:marker}}});
    }});
    const execute=()=>method==='associated'?adapters.associatedExecutor.execute({operationDigest:'22'.repeat(32),request:{unfinishedScriptSig:marker}})
      :method==='raw'?adapters.rawSigner.sign({binding:binding('signTransaction',{txraws:[marker],utxos_satoshis:[[1]],script_pubkeys:[['00']]}),approval})
      :adapters.cryptoAdapter[method]({binding:binding(method,{message:marker}),approval});
    await assert.rejects(execute,error=>{
      assert.equal(String(error).includes(marker),false,'Native error must be sanitized');
      assert.equal(error.stack?.includes(marker),false);
      assert.equal(JSON.stringify(error).includes(marker),false);
      assert.equal(Object.hasOwn(error,'cause'),false);return true;
    });
    assert.equal(calls,1,'Privacy handling must not retry');
  }
});
