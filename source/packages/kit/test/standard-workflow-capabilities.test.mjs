import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";

const walletModule = process.env.TBC_KIT_WALLET_TEST_MODULE
  ? pathToFileURL(process.env.TBC_KIT_WALLET_TEST_MODULE)
  : new URL("../dist/esm/wallet.js", import.meta.url);
const {
  createTbcKitMemoryHostStore,
} = await import(new URL("sqlite.js", walletModule));
const {
  createTbcStandardWorkflowCapabilities,
  createWasmTbcKeylessEngine,
  normalizeTbcReviewedTransactionMaterial,
  createTbcWallet,
  hashCanonical,
} = await import(walletModule);
const { parseTbcTransaction, turingTransactionId } = await import(new URL("api.js", walletModule));

const materialNative = await createWasmTbcKeylessEngine(await readFile(process.env.TBC_KIT_WALLET_TEST_MODULE
  ? new URL("../../artifacts/wasm/tbc_keyless_wasm.wasm", walletModule)
  : new URL(
  '../../tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm', import.meta.url,
)));

const CHAIN_ID = "tbc:mainnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const ACCOUNT_ID = `${CHAIN_ID}:${ADDRESS}`;
const PUBLIC_KEY = `0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798`;
const SCRIPT = "76a914751e76e8199196d454941c45d1b3a323f1433bd688ac";
const RAW = [
  "0a000000", "01", "00".repeat(32), "00000000", "00", "ffffffff", "01",
  "0100000000000000", "19", SCRIPT, "00000000",
].join("");
const NAVIGATION = Object.freeze({
  webViewInstanceId: "standard-webview",
  sessionId: "standard-session",
  navigationId: "standard-navigation",
  committedUrl: "https://standard.example/app",
  origin: "https://standard.example",
  topOrigin: "https://standard.example",
  frame: "top",
  createdAt: "2026-09-21T00:00:00Z",
});
const ACCOUNT = Object.freeze({ accountId: ACCOUNT_ID, address: ADDRESS, publicKey: PUBLIC_KEY });

function rawStandardRequest(transactionCount = 1) {
  return Object.freeze({
    payload: Object.freeze({
      format: "raw",
      transactions: Object.freeze(Array.from({ length: transactionCount }, (_value, index) => Object.freeze({
        rawTransaction: index === 0
          ? RAW
          : `${RAW.slice(0, 10)}${index.toString(16).padStart(2, "0").repeat(32)}${RAW.slice(74)}`,
        inputs: Object.freeze([Object.freeze({ satoshis: "1000", scriptPubKey: SCRIPT })]),
      }))),
    }),
  });
}

function associatedStandardRequest(withChild = false) {
  return Object.freeze({
    payload: Object.freeze({
      format: "associated",
      sourceTransaction: RAW,
      sourceInputs: Object.freeze([Object.freeze({
        txid: "00".repeat(32),
        outputIndex: 0,
        satoshis: "1000",
        scriptPubKey: SCRIPT,
        signingProfile: "p2pkh",
      })]),
      children: Object.freeze(withChild ? [Object.freeze({
        inputs: Object.freeze([Object.freeze({
          outputIndex: 0,
          signingProfile: "p2pkh",
        })]),
        outputs: Object.freeze([Object.freeze({
          satoshis: "0",
          scriptPubKey: SCRIPT,
        })]),
      })] : []),
    }),
  });
}

test("native reviewed material projection reuses the Standard raw and associated normalization", () => {
  const raw=normalizeTbcReviewedTransactionMaterial(rawStandardRequest());
  assert.deepEqual(raw,{format:"raw",request:{txraws:[RAW],utxos_satoshis:[[1000]],script_pubkeys:[[SCRIPT]]}});
  const associated=normalizeTbcReviewedTransactionMaterial(associatedStandardRequest(true));
  assert.equal(associated.format,"associated");
  assert.equal(associated.request.sourceUtxos[0].scriptSigType,"p2pkh");
  assert.equal(associated.request.inputs[0][0].txId,undefined);
  assert.equal(associated.request.outputs[0][0].satoshis,0);
  assert.throws(()=>normalizeTbcReviewedTransactionMaterial({payload:{format:"unknown"}}));
});

function reviewResult(transactionIds, request) {
  return Object.freeze({
    preview: Object.freeze({
      transactions: Object.freeze(transactionIds.map((txid, index) => Object.freeze({
        index,
        txid,
        feeSatoshis: 999,
        classification: Object.freeze({ action: "transfer" }),
        groups: Object.freeze([Object.freeze({
          key: "tbc:TBC",
          asset: Object.freeze({ type: "tbc", symbol: "TBC" }),
          flows: Object.freeze([Object.freeze({
            purpose: "transfer",
            direction: "out",
            amount: Object.freeze({ satoshis: 1 }),
            from: Object.freeze({ address: ADDRESS }),
            to: Object.freeze({ address: ADDRESS }),
            recognized: true,
          })]),
        })]),
      }))),
    }),
    policyMaterial: Object.freeze({ resolvedOutputs: Object.freeze([]) }),
    verifiedInputs: Object.freeze(request.txraws.map((raw, index) => Object.freeze(
      parseTbcTransaction(raw).inputs.map((input, inputIndex) => Object.freeze({
        txid: input.txid,
        vout: input.vout,
        satoshis: request.utxos_satoshis[index][inputIndex],
        scriptPubKey: request.script_pubkeys[index][inputIndex],
        spent: false,
      })),
    ))),
  });
}

// Independent one-input P2PKH fixture serializer; no fake child identities.
function associatedRawFixture(request) {
  const txraws = [request.sourceTxraw];
  const utxos_satoshis = [request.sourceUtxos.map(input => input.satoshis)];
  const script_pubkeys = [request.sourceUtxos.map(input => input.script)];
  for (let index = 0; index < request.inputs.length; index++) {
    const previous = txraws.at(-1);
    const output = request.outputs[index][0];
    assert.equal(request.inputs[index].length, 1);
    assert.equal(request.outputs[index].length, 1);
    assert.equal(output.script, SCRIPT);
    assert.equal(request.inputs[index][0].outputIndex, 0);
    const amount = Buffer.alloc(8); amount.writeBigUInt64LE(BigInt(output.satoshis));
    txraws.push('0a00000001' + Buffer.from(turingTransactionId(previous), 'hex').reverse().toString('hex') +
      '0000000000ffffffff01' + amount.toString('hex') + '19' + SCRIPT + '00000000');
    utxos_satoshis.push([Number(parseTbcTransaction(previous).outputs[0].satoshis)]);
    script_pubkeys.push([SCRIPT]);
  }
  return { txraws, utxos_satoshis, script_pubkeys };
}

function portCall(operation, callId = `${operation}-call`) {
  return Object.freeze({
    version: "1.0",
    callId,
    operation,
    params: Object.freeze({}),
    execution: Object.freeze({ type: "durable" }),
  });
}

function approval(bindingHash = "aa".repeat(32)) {
  return Object.freeze({
    status: "approved",
    approvalId: "standard-approval",
    approvalToken: "standard-token",
    bindingHash,
    approvedAt: "2026-09-21T00:00:10Z",
    expiresAt: "2026-09-21T00:02:00Z",
  });
}

function capabilityFixture(now = "2026-09-21T00:00:00Z", decryptedMessage = "hello") {
  const counts = {
    authority: 0,
    rawReviews: 0,
    associatedReviews: 0,
    privateLoads: 0,
    rawSigns: 0,
    associatedExecutes: 0,
    encrypts: 0,
    decrypts: 0,
  };
  let authority = Object.freeze({
    accountId: ACCOUNT_ID,
    address: ADDRESS,
    networkSourceIdentity: "testnet:official",
  });
  const capabilities = createTbcStandardWorkflowCapabilities({
    navigation: NAVIGATION,
    chainId: CHAIN_ID,
    account: ACCOUNT,
    materialNative,
    networkSourceIdentity: "testnet:official",
    async readCurrentAuthority() {
      counts.authority += 1;
      return authority;
    },
    rawReviewer: {
      async review({ request, transactionIds }) {
        counts.rawReviews += 1;
        return reviewResult(transactionIds, request);
      },
    },
    associatedReviewer: {
      async review({ request }) {
        counts.associatedReviews += 1;
        const material = associatedRawFixture(request);
        return reviewResult(material.txraws.map(turingTransactionId), material);
      },
    },
    privateNative: async (accountId) => {
      counts.privateLoads += 1;
      assert.equal(accountId, ACCOUNT_ID);
      return Object.freeze({
        rawSigner: Object.freeze({
          async sign({ binding, approval: decision }) {
            counts.rawSigns += 1;
            assert.equal(binding.bindingHash, decision.bindingHash);
            return { sigs: binding.request.txraws.map(() => ["30"]) };
          },
        }),
        associatedExecutor: Object.freeze({
          async execute({ request }) {
            counts.associatedExecutes += 1;
            return {
              txraws: associatedRawFixture(request).txraws,
            };
          },
        }),
        cryptoAdapter: Object.freeze({
          async encrypt({ binding, approval: decision }) {
            counts.encrypts += 1;
            assert.equal(binding.bindingHash, decision.bindingHash);
            return { encryptedMessage: "A".repeat(116) };
          },
          async decrypt({ binding, approval: decision }) {
            counts.decrypts += 1;
            assert.equal(binding.bindingHash, decision.bindingHash);
            return { decryptedMessage };
          },
        }),
      });
    },
    now: () => now,
  });
  return {
    capabilities,
    counts,
    changeAuthority(next) { authority = next; },
  };
}

test("standard crypto preserves empty and historical UTF-8 messages at the private adapter boundary", async () => {
  const algorithm = "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";
  const base = { taskId: "crypto-boundary", algorithm, origin: NAVIGATION.origin, accountId: ACCOUNT_ID, publicKey: PUBLIC_KEY };
  for (const encoding of ["utf8", "hex", "base64"]) {
    const fixture = capabilityFixture();
    await fixture.capabilities.crypto.execute({version:"1.0",approval:approval(),task:{...base,purpose:"encrypt",message:{encoding,data:""}}},portCall("crypto.execute","empty-encrypt"));
    assert.equal(fixture.counts.encrypts,1);
  }
  for (const text of ["", "中".repeat(24000)]) {
    const fixture = capabilityFixture(undefined,text);
    const result = await fixture.capabilities.crypto.execute({version:"1.0",approval:approval(),task:{...base,purpose:"decrypt",ciphertext:"A".repeat(116)}},portCall("crypto.execute","decrypt-result"));
    assert.deepEqual(result.message,{encoding:"utf8",data:text});
    assert.equal(fixture.counts.decrypts,1);
  }
});

test("standard reviewed transaction expiry preserves millisecond trusted time", async () => {
  const fixture = capabilityFixture("2026-09-21T00:00:00.123Z");
  for (const [kind, request] of [
    ["raw", rawStandardRequest()],
    ["associated", associatedStandardRequest()],
  ]) {
    const review = await fixture.capabilities.reviewedTransaction.review({
      version: "1.0",
      taskId: `review-fractional-${kind}`,
      contextHash: "11".repeat(32),
      origin: NAVIGATION.origin,
      sessionId: NAVIGATION.sessionId,
      chainId: CHAIN_ID,
      accountId: ACCOUNT_ID,
      publicKey: PUBLIC_KEY,
      requestHash: hashCanonical(request),
      request,
    }, portCall("reviewedTransaction.review", `review-fractional-${kind}`));
    assert.equal(review.payload.expiresAt, "2026-09-21T00:02:00.123Z");
  }
});

test("Standard composer depends only on neutral shared layers while Legacy consumes the neutral ABI", async () => {
  const [standardSource, compatibilitySource, neutralTypes] = await Promise.all([
    readFile(new URL("../src/standard-workflow-capabilities.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/legacy-wallet-private-native.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/types/standard-workflow-capabilities.d.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(/from ["']\.\/legacy-/u.test(standardSource), false);
  assert.match(standardSource, /from "\.\/wallet-private-native\.js"/u);
  assert.match(compatibilitySource, /from "\.\/wallet-private-native\.js"/u);
  assert.equal(/legacy-|LegacyWallet/u.test(neutralTypes), false);
});

test("standard capabilities review and execute raw/associated/crypto without a Legacy runtime", async () => {
  const fixture = capabilityFixture();
  const raw = rawStandardRequest();
  const rawReview = await fixture.capabilities.reviewedTransaction.review({
    version: "1.0",
    taskId: "review-raw",
    contextHash: "11".repeat(32),
    origin: NAVIGATION.origin,
    sessionId: NAVIGATION.sessionId,
    chainId: CHAIN_ID,
    accountId: ACCOUNT_ID,
    publicKey: PUBLIC_KEY,
    requestHash: hashCanonical(raw),
    request: raw,
  }, portCall("reviewedTransaction.review", "review-raw"));
  assert.equal(rawReview.payload.totalFee, "999");
  assert.equal(rawReview.payload.preview.assetFlows[0].direction, "send");
  assert.equal(fixture.counts.rawReviews, 1);

  const rawExecute = await fixture.capabilities.reviewedTransaction.execute({
    version: "1.0",
    approval: approval(),
    task: {
      taskId: "review-raw",
      purpose: "reviewedTransaction",
      contextHash: "11".repeat(32),
      requestHash: hashCanonical(raw),
      reviewHash: rawReview.reviewHash,
      policyMaterial: rawReview.payload.policyMaterial,
      chainId: CHAIN_ID,
      accountId: ACCOUNT_ID,
      publicKey: PUBLIC_KEY,
      request: raw,
    },
  }, portCall("reviewedTransaction.execute", "execute-raw"));
  assert.deepEqual(rawExecute.bundle.detachedSignatures, [["30"]]);
  assert.equal(rawExecute.bundle.totalFee, "999");
  assert.equal(fixture.counts.rawSigns, 1);
  assert.equal(fixture.counts.rawReviews, 1, "approved execution adds no second review/read");

  const associated = associatedStandardRequest();
  const associatedReview = await fixture.capabilities.reviewedTransaction.review({
    version: "1.0",
    taskId: "review-associated",
    contextHash: "22".repeat(32),
    origin: NAVIGATION.origin,
    sessionId: NAVIGATION.sessionId,
    chainId: CHAIN_ID,
    accountId: ACCOUNT_ID,
    publicKey: PUBLIC_KEY,
    requestHash: hashCanonical(associated),
    request: associated,
  }, portCall("reviewedTransaction.review", "review-associated"));
  const associatedExecute = await fixture.capabilities.reviewedTransaction.execute({
    version: "1.0",
    approval: approval("bb".repeat(32)),
    task: {
      taskId: "review-associated",
      purpose: "reviewedTransaction",
      contextHash: "22".repeat(32),
      requestHash: hashCanonical(associated),
      reviewHash: associatedReview.reviewHash,
      policyMaterial: associatedReview.payload.policyMaterial,
      chainId: CHAIN_ID,
      accountId: ACCOUNT_ID,
      publicKey: PUBLIC_KEY,
      request: associated,
    },
  }, portCall("reviewedTransaction.execute", "execute-associated"));
  assert.equal(associatedExecute.bundle.transactions.length, 1);
  assert.equal(Object.hasOwn(associatedExecute.bundle, "detachedSignatures"), false);
  assert.equal(fixture.counts.associatedReviews, 1);
  assert.equal(fixture.counts.associatedExecutes, 1);

  const encrypted = await fixture.capabilities.crypto.execute({
    version: "1.0",
    approval: approval("cc".repeat(32)),
    task: {
      taskId: "encrypt-1",
      purpose: "encrypt",
      algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1",
      origin: NAVIGATION.origin,
      accountId: ACCOUNT_ID,
      publicKey: PUBLIC_KEY,
      message: { encoding: "utf8", data: "hello" },
    },
  }, portCall("crypto.execute", "encrypt"));
  assert.equal(encrypted.ciphertext, "A".repeat(116));
  assert.equal(fixture.counts.encrypts, 1);
  assert.equal(fixture.counts.privateLoads, 3, "one private adapter load per approved effect");
});

test("approved reviewed execution survives capability-composer recreation without another review", async () => {
  const beforeRestart = capabilityFixture();
  const request = rawStandardRequest();
  const reviewed = await beforeRestart.capabilities.reviewedTransaction.review({
    version: "1.0",
    taskId: "review-reopen",
    contextHash: "11".repeat(32),
    origin: NAVIGATION.origin,
    sessionId: NAVIGATION.sessionId,
    chainId: CHAIN_ID,
    accountId: ACCOUNT_ID,
    publicKey: PUBLIC_KEY,
    requestHash: hashCanonical(request),
    request,
  }, portCall("reviewedTransaction.review", "review-reopen"));
  assert.equal(beforeRestart.counts.rawReviews, 1);

  const afterRestart = capabilityFixture();
  const executed = await afterRestart.capabilities.reviewedTransaction.execute({
    version: "1.0",
    approval: approval(),
    task: {
      taskId: "review-reopen",
      purpose: "reviewedTransaction",
      contextHash: "11".repeat(32),
      requestHash: hashCanonical(request),
      reviewHash: reviewed.reviewHash,
      policyMaterial: reviewed.payload.policyMaterial,
      chainId: CHAIN_ID,
      accountId: ACCOUNT_ID,
      publicKey: PUBLIC_KEY,
      request,
    },
  }, portCall("reviewedTransaction.execute", "execute-reopen"));
  assert.equal(executed.reviewHash, reviewed.reviewHash);
  assert.equal(afterRestart.counts.rawReviews, 0);
  assert.equal(afterRestart.counts.rawSigns, 1);
});

test("standard capability authority drift fails before a private native effect", async () => {
  const fixture = capabilityFixture();
  fixture.changeAuthority(Object.freeze({
    accountId: ACCOUNT_ID,
    address: ADDRESS,
    networkSourceIdentity: "testnet:changed",
  }));
  const request = rawStandardRequest();
  await assert.rejects(
    fixture.capabilities.reviewedTransaction.execute({
      version: "1.0",
      approval: approval(),
      task: {
        taskId: "review-drift",
        purpose: "reviewedTransaction",
        contextHash: "11".repeat(32),
        requestHash: hashCanonical(request),
        reviewHash: "22".repeat(32),
        policyMaterial: { resolvedOutputs: [] },
        chainId: CHAIN_ID,
        accountId: ACCOUNT_ID,
        publicKey: PUBLIC_KEY,
        request,
      },
    }, portCall("reviewedTransaction.execute", "execute-drift")),
    /authority changed/u,
  );
  assert.equal(fixture.counts.privateLoads, 0);
  assert.equal(fixture.counts.rawSigns, 0);
});

function permission(capability) {
  return Object.freeze({
    id: `standard-${capability}`,
    parentCapability: capability,
    invoker: NAVIGATION.origin,
    date: Date.parse("2026-09-21T00:00:00Z"),
    caveats: Object.freeze([
      Object.freeze({ type: "restrictChains", value: Object.freeze([CHAIN_ID]) }),
      Object.freeze({ type: "restrictAccounts", value: Object.freeze([ACCOUNT_ID]) }),
      Object.freeze({ type: "restrictMethods", value: Object.freeze([capability]) }),
    ]),
  });
}

test("createTbcWallet runs Standard reviewed workflow with Legacy omitted and one approval", async () => {
  const fixture = capabilityFixture();
  let approvals = 0;
  const forbidden = async () => { throw new Error("unexpected transaction Port"); };
  const wallet = createTbcWallet({
    accounts: { current: async () => [{ ...ACCOUNT, chainId: CHAIN_ID }] },
    approval: {
      async request(params) {
        approvals += 1;
        return {
          status: "approved",
          approvalId: "workflow-approval",
          approvalToken: "workflow-token",
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-09-21T00:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: { sign: forbidden },
    crypto: fixture.capabilities.crypto,
    reviewedTransaction: fixture.capabilities.reviewedTransaction,
    storage: {
      hostStore: createTbcKitMemoryHostStore({ now: () => Date.parse("2026-09-21T00:00:10Z") }),
      async loadPermissions() {
        return {
          revision: "0",
          permissions: [
            permission("tbc_accounts"),
            permission("tbc_signWorkflow"),
            permission("tbc_signTransaction"),
          ],
        };
      },
      commitPermissions: forbidden,
    },
    network: {
      resolveChainData: forbidden,
      resolvePolicy: forbidden,
      broadcastSubmit: forbidden,
      broadcastReconcile: forbidden,
    },
    clock: () => "2026-09-21T00:00:10Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_value, index) => index),
    // `legacy` is intentionally absent.
  });
  const session = await wallet.openSession({ origin: NAVIGATION.origin, sessionId: NAVIGATION.sessionId });
  const delivery = await session.handleRequest({
    id: "standard-workflow-no-legacy",
    method: "tbc_signWorkflow",
    params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      expiresAt: "2026-09-21T00:02:00Z",
      maxTotalFee: "999",
      steps: [{
        id: "raw",
        kind: "reviewedTransaction",
        dependsOn: [],
        request: rawStandardRequest(),
      }],
    },
  });
  assert.equal("error" in delivery.response, false, JSON.stringify(delivery.response));
  assert.equal(approvals, 1);
  assert.equal(fixture.counts.rawReviews, 1);
  assert.equal(fixture.counts.rawSigns, 1);
  assert.equal(fixture.counts.associatedReviews, 0);
  session.close();
});

async function runPreparedReviewedRequest(request, options = {}) {
  const fixture = capabilityFixture();
  const reviews = [];
  const approvalCalls = [];
  const baseReviewed = fixture.capabilities.reviewedTransaction;
  const reviewedTransaction = options.mutateReview === undefined
    ? baseReviewed
    : Object.freeze({
        ...baseReviewed,
        async review(params, call) {
          const result = await baseReviewed.review(params, call);
          const payload = options.mutateReview(result.payload);
          return Object.freeze({ payload, reviewHash: hashCanonical(payload) });
        },
      });
  const forbidden = async () => { throw new Error("unexpected transaction Port"); };
  const wallet = createTbcWallet({
    accounts: { current: async () => [{ ...ACCOUNT, chainId: CHAIN_ID }] },
    approvalPreparation: {
      begin() {},
      async review(input) {
        reviews.push(input);
        options.inspectEarlyReview?.(input);
        return { status: "approved", feeCapAtomic: "10000" };
      },
      finish() {},
    },
    approval: {
      async request(params, call) {
        approvalCalls.push(call);
        return {
          status: "approved",
          approvalId: `prepared-reviewed-${String(approvalCalls.length)}`,
          approvalToken: `prepared-reviewed-token-${String(approvalCalls.length)}`,
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-09-21T00:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: { sign: forbidden },
    crypto: fixture.capabilities.crypto,
    reviewedTransaction,
    storage: {
      hostStore: createTbcKitMemoryHostStore({ now: () => Date.parse("2026-09-21T00:00:10Z") }),
      async loadPermissions() {
        return {
          revision: "0",
          permissions: [permission("tbc_accounts"), permission("tbc_signTransaction")],
        };
      },
      commitPermissions: forbidden,
    },
    network: {
      resolveChainData: forbidden,
      resolvePolicy: forbidden,
      broadcastSubmit: forbidden,
      broadcastReconcile: forbidden,
    },
    clock: () => "2026-09-21T00:00:10Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_value, index) => index),
  });
  const session = await wallet.openSession({
    origin: NAVIGATION.origin,
    sessionId: NAVIGATION.sessionId,
  });
  const delivery = await session.handleRequest({
    id: `prepared-reviewed-${options.name ?? "case"}`,
    method: "tbc_signReviewedTransaction",
    params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      request,
    },
  });
  session.close();
  return { approvalCalls, delivery, reviews };
}

test("reviewed early consent binds raw and associated transaction/dependency scope", async () => {
  for (const candidate of [
    {
      name: "raw-single",
      request: rawStandardRequest(),
      scope: { format: "raw", transactionCount: 1, dependencyCount: 0, warnings: [] },
    },
    {
      name: "raw-multiple",
      request: rawStandardRequest(2),
      scope: {
        format: "raw",
        transactionCount: 2,
        dependencyCount: 0,
        warnings: ["MULTI_TRANSACTION"],
      },
    },
    {
      name: "associated-child",
      request: associatedStandardRequest(true),
      scope: {
        format: "associated",
        transactionCount: 2,
        dependencyCount: 1,
        warnings: ["MULTI_TRANSACTION"],
      },
    },
  ]) {
    const result = await runPreparedReviewedRequest(candidate.request, {
      name: candidate.name,
      inspectEarlyReview(input) {
        assert.deepEqual(input.reviewedTransactionScope, candidate.scope);
        assert.deepEqual(input.warningScope, candidate.scope.warnings);
        const requestHash = hashCanonical(input.request);
        if (candidate.scope.format === "associated") {
          assert.throws(() => {
            input.request.request.payload.children.push({});
          }, TypeError, "associated children must be frozen before presentation");
        } else {
          assert.throws(() => {
            input.request.request.payload.format = "changed";
          }, TypeError, "the canonical reviewed request must be frozen before presentation");
        }
        assert.equal(hashCanonical(input.request), requestHash);
      },
    });
    assert.equal("error" in result.delivery.response, false, JSON.stringify(result.delivery.response));
    assert.equal(result.reviews.length, 1);
    assert.deepEqual(result.approvalCalls[0].approvalPreparation?.earlyConsent, {
      status: "approved",
      feeCapAtomic: "10000",
    });
  }
});

test("reviewed early consent falls back when final count or warnings leave its exact scope", async () => {
  for (const candidate of [
    {
      name: "count-drift",
      mutateReview(payload) {
        return Object.freeze({
          ...payload,
          preview: Object.freeze({ ...payload.preview, transactionCount: 3 }),
        });
      },
    },
    {
      name: "warning-drift",
      mutateReview(payload) {
        return Object.freeze({
          ...payload,
          preview: Object.freeze({ ...payload.preview, warnings: Object.freeze([]) }),
        });
      },
    },
  ]) {
    const result = await runPreparedReviewedRequest(associatedStandardRequest(true), candidate);
    assert.equal(result.approvalCalls.length, 1);
    assert.equal(
      result.approvalCalls[0].approvalPreparation?.earlyConsent,
      undefined,
      `${candidate.name} reused early consent`,
    );
  }
});
