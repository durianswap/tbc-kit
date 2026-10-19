import assert from "node:assert/strict";
import test from "node:test";
import {pathToFileURL} from "node:url";

const {
  createLegacyStandardWorkflowBatchAdapter,
  mapLegacyAssociatedTransactionToReviewed,
  mapLegacyGenericBatchToWorkflow,
} = await import(process.env.TBC_KIT_WALLET_TEST_MODULE
  ? pathToFileURL(process.env.TBC_KIT_WALLET_TEST_MODULE).href
  : new URL("../dist/esm/wallet.js",import.meta.url).href);

const CHAIN_ID = "tbc:testnet";
const ADDRESS = "1LEF3thAWxd4WG8nvtjPb4An6kGCoweUu6";
const SCRIPT = "76a914d2eb868eee7a7ee4238e67a646f3caeca5ffc2c788ac";
const RAW = [
  "0a000000", "01", "00".repeat(32), "00000000", "00", "ffffffff", "01",
  "0100000000000000", "19", SCRIPT, "00000000",
].join("");
const CONTEXT = Object.freeze({
  origin: "https://dapp.example",
  chainId: CHAIN_ID,
  sessionId: "session-1",
  navigationId: "navigation-1",
});
const REQUESTS = Object.freeze([
  Object.freeze({
    method: "sendTransaction",
    params: Object.freeze({ flag: "P2PKH", broadcastEnabled: false }),
  }),
  Object.freeze({
    method: "signTransaction",
    params: Object.freeze({
      txraws: Object.freeze([RAW]),
      utxos_satoshis: Object.freeze([Object.freeze([1_000])]),
      script_pubkeys: Object.freeze([Object.freeze([SCRIPT])]),
    }),
  }),
  Object.freeze({
    method: "signMessage",
    dependsOn: "settlement",
    params: Object.freeze({ message: JSON.stringify({ order: "42" }), encoding: "utf8" }),
  }),
  Object.freeze({ method: "encrypt", params: Object.freeze({ message: "plain" }) }),
  Object.freeze({
    method: "decrypt",
    params: Object.freeze({ encryptedMessage: Buffer.alloc(85, 7).toString("base64") }),
  }),
]);

function options(overrides = {}) {
  return {
    chainId: CHAIN_ID,
    context: CONTEXT,
    async readAccount() {
      return Object.freeze({ address: ADDRESS, accountId: `${CHAIN_ID}:${ADDRESS}` });
    },
    async resolveSendTransaction({ chainId, from }) {
      return Object.freeze({
        version: "1.0",
        chainId,
        from,
        intent: Object.freeze({
          type: "tbc.transfer",
          version: "1.0",
          to: ADDRESS,
          amount: "1",
        }),
      });
    },
    async executeWorkflow() {
      throw new Error("not configured");
    },
    async executeAction() {
      throw new Error("not configured");
    },
    ...overrides,
  };
}

test("Legacy mixed batch maps to one reviewed standard workflow with bound dependency", async () => {
  const workflow = await mapLegacyGenericBatchToWorkflow(REQUESTS, options());
  assert.equal(workflow.failureMode, "continue-independent");
  assert.equal(workflow.chainId, CHAIN_ID);
  assert.equal(workflow.from, ADDRESS);
  assert.deepEqual(workflow.steps.map(({ kind }) => kind), [
    "transaction",
    "reviewedTransaction",
    "message",
    "encrypt",
    "decrypt",
  ]);
  assert.deepEqual(workflow.steps[2].dependsOn, ["legacy-2"]);
  assert.deepEqual(workflow.steps[2].bindings, [{
    target: "settlement",
    source: { stepId: "legacy-2", output: "transactionIds" },
  }]);
  assert.equal(workflow.steps[1].request.payload.format, "raw");
});

test("Legacy encryption mapping reuses the standard decoded-byte budget", async () => {
  const accepted = await mapLegacyGenericBatchToWorkflow([{method:"encrypt",params:{message:"中".repeat(21845)+"a"}}],options());
  assert.equal(accepted.steps[0].message.data.length,21846);
  await assert.rejects(()=>mapLegacyGenericBatchToWorkflow([{method:"encrypt",params:{message:"中".repeat(21846)}}],options()));
});

test("Legacy standard adapter executes exactly one workflow and restores historical results", async () => {
  const calls = [];
  const adapter = createLegacyStandardWorkflowBatchAdapter(options({
    async executeWorkflow(request) {
      calls.push(structuredClone(request));
      return Object.freeze({
        deliveryId: "11".repeat(32),
        response: Object.freeze({
          jsonrpc: "2.0",
          id: request.id,
          result: Object.freeze({
            steps: Object.freeze([
              Object.freeze({ id: "legacy-1", kind: "transaction", result: Object.freeze({
                transactions: Object.freeze([Object.freeze({ rawTransaction: RAW })]),
              }) }),
              Object.freeze({ id: "legacy-2", kind: "reviewedTransaction", result: Object.freeze({
                transactions: Object.freeze([Object.freeze({ rawTransaction: RAW })]),
                detachedSignatures: Object.freeze([Object.freeze(["aa"])]),
              }) }),
              Object.freeze({ id: "legacy-3", kind: "message", result: Object.freeze({
                address: ADDRESS,
                publicKey: `02${"11".repeat(32)}`,
                signature: "signature",
                envelope: Object.freeze({ message: Object.freeze({
                  encoding: "utf8",
                  data: JSON.stringify({ order: "42", settlement: ["txid"] }),
                }) }),
              }) }),
              Object.freeze({ id: "legacy-4", kind: "encrypt", result: Object.freeze({ ciphertext: "ciphertext" }) }),
              Object.freeze({ id: "legacy-5", kind: "decrypt", result: Object.freeze({
                message: Object.freeze({ encoding: "base64", data: "aGVsbG8=" }),
              }) }),
            ]),
          }),
        }),
        events: Object.freeze([]),
      });
    },
  }));
  const outcome = await adapter.execute({ requestId: "legacy-batch-1", requests: REQUESTS, context: CONTEXT });
  assert.equal(calls.length, 1);
  assert.equal(outcome.deliveryId, "11".repeat(32));
  assert.equal(calls[0].method, "tbc_signWorkflow");
  assert.deepEqual(outcome.results[0], { txraw: RAW });
  assert.deepEqual(outcome.results[1], { sigs: [["aa"]] });
  assert.deepEqual(outcome.results[2], {
    address: ADDRESS,
    maddress: ADDRESS,
    pubkey: `02${"11".repeat(32)}`,
    pubKey: `02${"11".repeat(32)}`,
    message: JSON.stringify({ order: "42", settlement: ["txid"] }),
    sig: "signature",
  });
  assert.deepEqual(outcome.results[3], { encryptedMessage: "ciphertext" });
  assert.deepEqual(outcome.results[4], { decryptedMessage: "hello" });
});

test("Legacy consumes canonical preparation before concurrent read-only mapping", async () => {
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handle = Object.freeze({
    preparationId: "preparation-1",
    cancel(outcome) { events.push(`cancel:${outcome}`); },
  });
  const adapter = createLegacyStandardWorkflowBatchAdapter(options({
    beginApprovalPreparation(input) {
      events.push("begin");
      assert.equal(input.method, "tbc_signWorkflow");
      assert.equal(input.requestCount, 2);
      assert.match(input.inputHash, /^[0-9a-f]{64}$/u);
      return handle;
    },
    async readAccount() {
      events.push("account");
      return Object.freeze({ address: ADDRESS, accountId: `${CHAIN_ID}:${ADDRESS}` });
    },
    async resolveSendTransaction({ chainId, from, params }) {
      events.push(`resolve:${params.marker}`);
      await gate;
      return Object.freeze({
        version: "1.0",
        chainId,
        from,
        intent: Object.freeze({
          type: "tbc.transfer",
          version: "1.0",
          to: ADDRESS,
          amount: String(params.marker),
        }),
      });
    },
    async executeWorkflow(request) {
      events.push("execute");
      assert.equal(request.approvalPreparation, handle);
      assert.match(request.params.clientRequestId, /^legacy-standard:[0-9a-f]{64}$/u);
      assert.deepEqual(request.params.steps.map(({ intent }) => intent.amount), ["1", "2"]);
      return Object.freeze({
        deliveryId: "44".repeat(32),
        response: Object.freeze({
          jsonrpc: "2.0",
          id: request.id,
          error: Object.freeze({ code: 4001, message: "User rejected" }),
        }),
        events: Object.freeze([]),
      });
    },
  }));
  const pending = adapter.execute({
    requestId: "legacy-shared-preparation",
    context: CONTEXT,
    requests: [1, 2].map((marker) => ({
      method: "sendTransaction",
      params: { flag: "P2PKH", broadcastEnabled: false, marker },
    })),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["begin", "account", "resolve:1", "resolve:2"]);
  release();
  await pending;
  assert.deepEqual(events, ["begin", "account", "resolve:1", "resolve:2", "execute"]);
});

test("canonical preparation cancels mapping failure", async () => {
  const cancellations = [];
  let executes = 0;
  const adapter = createLegacyStandardWorkflowBatchAdapter(options({
    beginApprovalPreparation() {
      return { preparationId: "canonical-failure", cancel: (value) => cancellations.push(value) };
    },
    async readAccount() { throw new Error("account unavailable"); },
    async executeWorkflow() { executes++; },
  }));
  await assert.rejects(adapter.execute({
    requestId: "failure", context: CONTEXT, requests: REQUESTS,
  }), /account unavailable/);
  assert.deepEqual(cancellations, ["failed"]);
  assert.equal(executes, 0);
});

test("Legacy P2PKH dependent batch preserves the historical bounded fee consent", async () => {
  const adapter = createLegacyStandardWorkflowBatchAdapter(options({
    async executeWorkflow(request) {
      assert.equal(request.params.maxTotalFee, "1000");
      assert.equal(request.params.steps[0].intent.type, "tbc.transfer");
      assert.equal(request.params.steps[1].dependsOn[0], request.params.steps[0].id);
      return Object.freeze({
        deliveryId: "55".repeat(32),
        response: Object.freeze({
          jsonrpc: "2.0",
          id: request.id,
          error: Object.freeze({ code: 4001, message: "User rejected" }),
        }),
        events: Object.freeze([]),
      });
    },
  }));
  await adapter.execute({
    requestId: "legacy-p2pkh-bounded-consent",
    context: CONTEXT,
    requests: [{
      method: "sendTransaction",
      params: { flag: "P2PKH", broadcastEnabled: false },
    }, {
      method: "signMessage",
      dependsOn: "settlement",
      params: { message: JSON.stringify({ order: "42" }), encoding: "utf8" },
    }],
  });
});

test("Legacy standard adapter keeps associated signing on its historical txraws-only shape", async () => {
  const adapter = createLegacyStandardWorkflowBatchAdapter(options({
    async executeAction(request) {
      assert.equal(request.method, "tbc_signReviewedTransaction");
      assert.equal(request.params.request.payload.format, "associated");
      return Object.freeze({
        deliveryId: "33".repeat(32),
        response: Object.freeze({
          jsonrpc: "2.0",
          id: request.id,
          result: Object.freeze({
            transactions: Object.freeze([Object.freeze({ rawTransaction: RAW })]),
          }),
        }),
        events: Object.freeze([]),
      });
    },
  }));
  const outcome = await adapter.execute({
    requestId: "legacy-associated-shape",
    context: CONTEXT,
    requests: Object.freeze([Object.freeze({
      method: "signAssociatedTransaction",
      params: Object.freeze({
        sourceTxraw: RAW,
        sourceUtxos: Object.freeze([Object.freeze({
          txId: "00".repeat(32),
          outputIndex: 0,
          satoshis: 1_000,
          script: SCRIPT,
          scriptSigType: "p2pkh",
        })]),
        inputs: Object.freeze([]),
        outputs: Object.freeze([]),
      }),
    })]),
  });
  assert.deepEqual(outcome.results, [{ txraws: [RAW] }]);
});

test("Legacy standalone signing and crypto use independent Standard methods", async () => {
  const methods = [];
  const adapter = createLegacyStandardWorkflowBatchAdapter(options({
    async executeAction(request) {
      methods.push(request.method);
      const result = request.method === "tbc_signReviewedTransaction"
        ? Object.freeze({ detachedSignatures: Object.freeze([Object.freeze(["aa"])]) })
        : request.method === "tbc_encrypt"
          ? Object.freeze({ ciphertext: "ciphertext" })
          : Object.freeze({ message: Object.freeze({ encoding: "utf8", data: "plain" }) });
      return Object.freeze({
        deliveryId: String(methods.length).repeat(64),
        response: Object.freeze({ jsonrpc: "2.0", id: request.id, result }),
        events: Object.freeze([]),
      });
    },
  }));
  const requests = [
    REQUESTS[1],
    REQUESTS[3],
    REQUESTS[4],
  ];
  const results = [];
  for (const [index, request] of requests.entries()) {
    const outcome = await adapter.execute({
      requestId: `standalone-${index}`,
      requests: Object.freeze([request]),
      context: CONTEXT,
    });
    results.push(outcome.results[0]);
  }
  assert.deepEqual(methods, ["tbc_signReviewedTransaction", "tbc_encrypt", "tbc_decrypt"]);
  assert.deepEqual(results, [
    { sigs: [["aa"]] },
    { encryptedMessage: "ciphertext" },
    { decryptedMessage: "plain" },
  ]);
});

test("Legacy standard rejection preserves one ACK-able delivery and performs no result mapping", async () => {
  let workflowCalls = 0;
  const adapter = createLegacyStandardWorkflowBatchAdapter(options({
    async executeWorkflow(request) {
      workflowCalls += 1;
      return Object.freeze({
        deliveryId: "22".repeat(32),
        response: Object.freeze({
          jsonrpc: "2.0",
          id: request.id,
          error: Object.freeze({ code: 4001, message: "User rejected" }),
        }),
        events: Object.freeze([]),
      });
    },
  }));
  const outcome = await adapter.execute({
    requestId: "legacy-batch-rejected",
    requests: REQUESTS,
    context: CONTEXT,
  });
  assert.equal(workflowCalls, 1);
  assert.equal(outcome.deliveryId, "22".repeat(32));
  assert.deepEqual(
    outcome.results,
    REQUESTS.map(() => ({ error: "User cancelled the batch request" })),
  );
});

test("Legacy standard adapter rejects navigation rebinding before account or workflow execution", async () => {
  let accountReads = 0;
  let executions = 0;
  const adapter = createLegacyStandardWorkflowBatchAdapter(options({
    async readAccount() {
      accountReads += 1;
      return { address: ADDRESS, accountId: `${CHAIN_ID}:${ADDRESS}` };
    },
    async executeWorkflow() {
      executions += 1;
      throw new Error("must not execute");
    },
  }));
  await assert.rejects(
    adapter.execute({
      requestId: "legacy-batch-1",
      requests: REQUESTS,
      context: { ...CONTEXT, navigationId: "navigation-2" },
    }),
    /session changed/u,
  );
  assert.equal(accountReads, 0);
  assert.equal(executions, 0);
});

test("Legacy associated mapping rejects unreviewed unknown fields instead of dropping them", () => {
  assert.throws(
    () => mapLegacyAssociatedTransactionToReviewed({
      sourceTxraw: RAW,
      sourceUtxos: [{ outputIndex: 0, scriptSigType: "p2pkh", hiddenRoute: "page-selected" }],
    }),
    /Unsupported Legacy associated input field/u,
  );
  assert.throws(
    () => mapLegacyAssociatedTransactionToReviewed({
      sourceTxraw: RAW,
      sourceUtxos: [],
      hiddenRoute: "page-selected",
    }),
    /Unsupported Legacy associated request field/u,
  );
});
