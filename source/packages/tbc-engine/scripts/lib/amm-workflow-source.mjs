// Offline current-source workflow probe. SDK creates independent, VM-verified
// fixtures; production Kit/Core/Host/Engine prepare and sign the tested batch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";

export async function checkMultiControllerWorkflow({ kit, engine, keyless, base, upstream, dependencies }) {
  const oracle = JSON.parse(execFileSync(process.execPath, [
    new URL("../check-amm-pool-proof-source.mjs", import.meta.url).pathname,
    upstream, dependencies, "--emit-multi-controller",
  ], { encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024 }));
  assert.equal(oracle.vmInputs, 72);
  const tbc = createRequire(resolve(dependencies, "package.json"))("tbc-lib-js");
  const chainId = "tbc:mainnet"; // Synthetic fixture label; every HTTP request is intercepted.
  const accounts = [1, 2, 3].map(scalar => {
    const publicKey = Buffer.from(secp256k1.getPublicKey(scalar.toString(16).padStart(64, "0"), true)).toString("hex");
    const address = new tbc.PublicKey(publicKey).toAddress().toString();
    return { chainId, accountId: `${chainId}:${address}`, address, publicKey };
  });
  const raw = txid => { assert.ok(oracle.raws[txid]); return { txid, rawTransaction: oracle.raws[txid] }; };
  const tx = txid => kit.inspectTbcTransaction(raw(txid).rawTransaction).transaction;
  const inspect = async input => JSON.parse(await keyless.execute("inspectAmmMaterial", JSON.stringify(input)));
  const indexes = new Map(), nativeRows = [], steps = [];
  for (const [index, label] of ["controller-plain", "controller-locked"].entries()) {
    const vector = oracle.vectors.find(v => v.id === `${label}-buy`);
    const genesisId = oracle.vectors.find(v => v.id === `${label}-add`).parentTxid;
    const meta = await inspect({ phase: "inspectPool", pool: raw(genesisId) });
    const descriptor = await inspect({ phase: "describe", poolGenesis: raw(genesisId), ftGenesis: raw(meta.ftContractId),
      currentPool: raw(vector.parentTxid), publicKey: accounts[0].publicKey, controllerPublicKey: accounts[index + 1].publicKey });
    const current = tx(vector.parentTxid);
    indexes.set(`/api/tbc/pool/poolinfo/poolid/${genesisId}`, {
      txid: vector.parentTxid, vout: 0, value: String(current.outputs[0].satoshis),
      pool_code_script: descriptor.poolCodeScript, ft_contract_id: descriptor.ftContractId,
      lp_balance: descriptor.state.lpAmount, token_balance: descriptor.state.ftAmount,
      tbc_balance: descriptor.state.tbcAmount, service_fee_rate: descriptor.serviceFeeRate,
    });
    const inputPoints = kit.inspectTbcTransaction(vector.currentRaw).transaction.inputs;
    const fee = inputPoints[1], poolFt = inputPoints[2];
    const ft = await inspect({ phase: "inspectAssets", parents: [raw(poolFt.txid)], outputs: [{ txid: poolFt.txid, vout: poolFt.vout, kind: "ft" }] });
    indexes.set(`/api/tbc/ft/utxo/combinescript/${descriptor.poolCombineScript}/contract/${descriptor.ftContractId}`,
      { utxos: [{ txid: poolFt.txid, index: poolFt.vout, tbc_value: "500", ft_value: ft.items[0].balance, height: 0 }] });
    nativeRows.push({ txid: fee.txid, index: fee.vout, value: String(tx(fee.txid).outputs[fee.vout].satoshis), height: 0 });
    steps.push({ id: `pool-${index + 1}`, kind: "transaction", dependsOn: [],
      intent: { type: "tbc-amm-swap", version: "1.0", poolContractId: genesisId,
        direction: "tbc-to-ft", amount: "10000", minimumOutput: "0" },
      signingRoles: [{ role: "pool-controller", accountId: accounts[index + 1].accountId }],
      constraints: { maxFee: "10000", inputOutpoints: inputPoints.map(({ txid, vout }) => ({ txid, vout })) },
    });
  }
  steps.push({ id: "receipt", kind: "message", dependsOn: ["pool-1", "pool-2"], message: { encoding: "utf8", data: "Both pools" } });
  const budgets = []; let verifiedInputs = 0, duplicateRejections = 0;
  for (const prepared of [false, true]) {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
    const expiresAt = new Date(Date.parse(now) + 120000).toISOString().replace(/\.\d{3}Z$/u, "Z");
    const trace = [], signed = []; let approvals = 0, reads = 0, accountReads = 0, nativeFailure, materialFailure;
    const current = async () => { accountReads++; return accounts; };
    const network = kit.createDefaultTbcNetwork({ network: kit.createTbcNetworkContext({ network: "mainnet" }),
      accounts: { current }, poolNative: { async execute(method, input) {
        try { return await keyless.execute(method, input); }
        catch (error) { nativeFailure = `${method}/${JSON.parse(input).phase}: ${error.message}`; throw error; }
      } }, now: () => Date.parse(now), confirmationPolicy: { minConfirmations: "0" },
      fetch: async (input, init) => {
        assert.equal(approvals, 0, "HTTP after approval"); assert.equal(init?.method ?? "GET", "GET");
        const url = new URL(String(input)); assert.equal(url.origin, "https://api.turingbitchain.io"); trace.push(url.pathname);
        let data;
        if (url.pathname === "/api/tbc/nodeinfo") data = { blocks: "830000", bestblockhash: base.snapshot.payload.block.hash };
        else if (url.pathname === `/api/tbc/utxo/address/${accounts[0].address}`) data = { utxos: nativeRows };
        else if (indexes.has(url.pathname)) data = indexes.get(url.pathname);
        else if (url.pathname.startsWith("/api/tbc/txraw/txid/")) data = { txraw: raw(url.pathname.split("/").at(-1)).rawTransaction };
        else throw new Error(`Unexpected fixture endpoint ${url.pathname}`);
        return new Response(JSON.stringify({ code: "200", data }), { status: 200 });
      },
    });
    const request = { version: "1.0", chainId, from: accounts[0].address, expiresAt, steps };
    const params = prepared ? await kit.prepareTbcWorkflow({ request, network, engine }) : request;
    const preparedReads = trace.length;
    const store = kit.createMemoryTwsHostStore({ now: () => Date.parse(now) });
    const evidence = kit.createApprovalHostEvidenceReader({ store, releaseFingerprint: kit.TWS_RELEASE_FINGERPRINT,
      parseApprovalRequest(value) { kit.assertValidTws("approvalRequestParams", value); return value; } });
    const permissions = ["tbc_accounts", "tbc_signWorkflow", "tbc_signTransaction", "tbc_signMessage"].map(capability => ({
      id: capability, parentCapability: capability, invoker: "https://wallet.test", date: Date.parse(now), caveats: [
        { type: "restrictChains", value: [chainId] },
        { type: "restrictAccounts", value: (capability === "tbc_signMessage" ? accounts.slice(0, 1) : accounts).map(a => a.accountId) },
        { type: "restrictMethods", value: [capability] },
      ],
    }));
    const runtime = kit.createTbcWallet({ legacy: false, engine, accounts: { current },
      network: { ...network, async resolveChainData(params, call, bound) {
        reads++; const result = await network.resolveChainData(params, call, bound);
        if (!result.steps && !result.snapshotHash) materialFailure = `Material failed: ${JSON.stringify(result)}, native=${nativeFailure}, GET=${JSON.stringify(trace)}`;
        return result;
      } },
      storage: { async loadPermissions() { return { revision: "0", permissions }; }, async commitPermissions() { throw new Error("Unexpected permission write"); } },
      approval: { supportedSigningRoles: ["pool-controller"], async request(input, call) {
        approvals++;
        const model = kit.projectTbcApprovalPresentation(await evidence.read(call.callId, input.binding.bindingHash));
        assert.deepEqual(model.signingRoles.value, steps.slice(0, 2).map(step => ({ stepId: step.id, ...step.signingRoles[0] })));
        return { status: "approved", approvalId: "multi-pool", approvalToken: "fixture", bindingHash: input.binding.bindingHash,
          approvedAt: now, expiresAt: input.binding.payload.expiresAt };
      } },
      signer: { async sign({ task }) {
        assert.equal(approvals, 1);
        const index = accounts.findIndex(a => a.accountId === task.accountId && a.publicKey === task.publicKey); assert.ok(index >= 0);
        if (index > 0) assert.equal(task.purpose, "transaction");
        signed.push({ taskId: task.taskId, purpose: task.purpose, accountId: task.accountId });
        const signature = secp256k1.sign(task.digest, (index + 1).toString(16).padStart(64, "0"), { prehash: false, lowS: true });
        return { taskId: task.taskId, signatureEncoding: task.signatureEncoding, signature: task.signatureEncoding === "compact64"
          ? signature.toCompactHex() : Buffer.concat([Buffer.from([31 + signature.recovery]), Buffer.from(signature.toCompactRawBytes())]).toString("hex") };
      } }, clock: () => now, randomBytes: length => Uint8Array.from({ length }, (_, i) => i),
    });
    const session = await runtime.openSession({ origin: "https://wallet.test", sessionId: `multi-pool-${prepared}`, execution: { hostStore: store } });
    try {
      const delivery = await session.startOperation({ id: "multi-pool", method: prepared ? "tbc_signPreparedWorkflow" : "tbc_signWorkflow", params });
      if (delivery.status === "failed") {
        const row = await store.readOperation(delivery.operationId), checkpoint = row.transition.checkpoint;
        const call = checkpoint.payload.pendingCalls[0], record = call ? await store.readCall(call.callId) : undefined;
        await kit.createTwsCore({ transactionEngine: engine }).resume({ version: "1.0", checkpoint,
          currentContext: checkpoint.payload.context, currentSession: checkpoint.payload.session,
          ...(record?.response ? { response: record.response } : {}) });
      }
      assert.equal(delivery.status, "complete", JSON.stringify(delivery.error));
      assert.equal(delivery.completion.response.error, undefined, materialFailure ?? JSON.stringify(delivery.completion.response.error));
      assert.equal(delivery.completion.response.result.steps.length, 3);
      for (const [index, step] of delivery.completion.response.result.steps.slice(0, 2).entries()) {
        assert.equal(step.id, steps[index].id);
        assert.equal(step.result.transactions.length, 1);
        const transaction = step.result.transactions[0];
        const signedTx = new tbc.Transaction(transaction.rawTransaction);
        assert.equal(signedTx.id, transaction.txid);
        assert.equal(signedTx.inputs[0].prevTxId.toString("hex"), steps[index].constraints.inputOutpoints[0].txid);
        for (const [vin, input] of signedTx.inputs.entries()) {
          const parent = new tbc.Transaction(raw(input.prevTxId.toString("hex")).rawTransaction);
          input.output = parent.outputs[input.outputIndex];
          const verdict = signedTx.verifyScript(vin);
          assert.equal(verdict.success, true, `Independent VM rejected step ${step.id} input ${vin}: ${verdict.error}`);
          verifiedInputs++;
        }
      }
      assert.equal(approvals, 1); assert.equal(reads, 1); assert.equal(signed.length, 7);
      for (const account of accounts.slice(1)) assert.equal(signed.filter(t => t.accountId === account.accountId).length, 1);
      assert.equal(signed.at(-1).purpose, "message"); assert.equal(signed.at(-1).accountId, accounts[0].accountId);
      const walletTrace = trace.slice(preparedReads);
      assert.equal(walletTrace.filter(p => p.includes("/utxo/address/")).length, 1);
      assert.equal(walletTrace.filter(p => p.endsWith("/nodeinfo")).length, 1);
      budgets.push(`${prepared ? "prepared" : "ordinary"}:GET=${trace.length},walletGET=${walletTrace.length},accountReads=${accountReads},approval=${approvals},signatures=${signed.length}`);
      // Explicit inputs do not authorize a second spend. Check both entry points
      // using real Engine plans, not mocked transaction identifiers.
      approvals = 0;
      const duplicate = { ...request, steps: [steps[0], { ...steps[0], id: "pool-2" }, steps[2]] };
      if (prepared) {
        await assert.rejects(() => kit.prepareTbcWorkflow({ request: duplicate, network, engine }), /same input outpoint/);
      } else {
        const rejected = await session.startOperation({ id: "duplicate-pool", method: "tbc_signWorkflow", params: duplicate });
        assert.equal(rejected.status, "failed");
        const checkpoint = (await store.readOperation(rejected.operationId)).transition.checkpoint;
        const call = checkpoint.payload.pendingCalls[0], record = call ? await store.readCall(call.callId) : undefined;
        await assert.rejects(() => kit.createTwsCore({ transactionEngine: engine }).resume({ version: "1.0", checkpoint,
          currentContext: checkpoint.payload.context, currentSession: checkpoint.payload.session,
          ...(record?.response ? { response: record.response } : {}) }), /same input outpoint/);
      }
      assert.equal(approvals, 0); assert.equal(signed.length, 7); duplicateRejections++;
    } finally { await session.close(); }
  }
  assert.equal(verifiedInputs, 12);
  assert.equal(duplicateRejections, 2);
  console.log(`AMM_MULTI_CONTROLLER_WORKFLOW_PASS ${budgets.join(" ")}; independent VM inputs=${verifiedInputs}; duplicate-input negatives=${duplicateRejections}; distinct pools/controllers/inputs; post-approval HTTP=0 for successful batches; broadcast POST=0`);
}
