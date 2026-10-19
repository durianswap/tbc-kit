#!/usr/bin/env node
/** Current Kit/Core source -> public Rust source, entirely offline.
 * Public scalar 1 signs fabricated funding only. No installed Engine artifact,
 * real wallet, HTTP request, broadcast, or delivery baseline is touched.
 */
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import Ajv2020 from "ajv/dist/2020.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const rust = fileURLToPath(new URL("../rust/", import.meta.url));
const fixture = JSON.parse(readFileSync(new URL("../rust/fixtures/tbc20-standard-transfer.json", import.meta.url), "utf8"));
const base = JSON.parse(readFileSync(new URL("../rust/fixtures/tbc-transfer.json", import.meta.url), "utf8"));
const NOW = "2026-09-28T12:00:00Z";
const scalar = "01".padStart(64, "0"); // Published synthetic fixture identity, never funded.
const checks = [];
function check(condition, label) { if (!condition) throw new Error(label); }

async function main() {
  check(process.argv.length === 2, "This gate accepts no arguments");
  // Core intentionally exports Port Result validators, not these Port Params.
  // Test the actual input contracts without expanding the production bundle.
  const schemas = readdirSync(`${root}schemas`).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(`${root}schemas/${name}`, "utf8")));
  const integration = schemas.find((schema) => schema.$id?.endsWith("/integration.schema.json"));
  check(typeof integration?.$id === "string", "Integration schema ID is missing");
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
  ajv.addFormat("uri", /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]*$/u);
  ajv.addFormat("date-time", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u);
  for (const schema of schemas) ajv.addSchema(schema);
  const portParams = Object.fromEntries(["chainDataResolveParams", "policyResolveParams"].map((definition) => {
    const validator = ajv.getSchema(`${integration.$id}#/$defs/${definition}`);
    check(typeof validator === "function", `Missing official schema: ${definition}`);
    return [definition, validator];
  }));
  function assertPortParams(definition, value) {
    const validator = portParams[definition];
    check(validator(value), `${definition} rejected: ${JSON.stringify(validator.errors)}`);
  }
  const compile = spawnSync("cargo", ["build", "--offline", "--locked", "-p", "tbc-engine-core",
    "--example", "call_public_engine", "--message-format=json"],
  { cwd: rust, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  check(!compile.error && compile.status === 0, `Rust example build failed (${compile.status ?? compile.error?.code}); output withheld`);
  const executable = compile.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
    .findLast((record) => record.reason === "compiler-artifact" && record.target?.name === "call_public_engine")?.executable;
  check(typeof executable === "string", "Cargo did not identify the public Engine executable");
  const bundled = await build({
    stdin: { contents: `
      export { createDefaultTbcNetwork } from './packages/kit/src/default-network.ts';
      export { createTbcNetworkContext } from './packages/kit/src/network-context.ts';
      export { prepareTbcTransaction } from './packages/kit/src/prepared.ts';
      export { inspectTbcTransaction, assertTbcAddress } from './packages/kit/src/testnet-validation.ts';
      export { assertPreparedProposalForPlan } from './packages/core/src/reducers/planning.ts';
      export { hashCanonical, assertValidTws } from './packages/core/src/index.ts';
      export { createTbcWallet } from './packages/kit/src/wallet-runtime.ts';
      export { createMemoryTwsHostStore } from './packages/host/src/index.ts';
    `, resolveDir: root, loader: "ts" },
    alias: { "@tbc-wallet/core": `${root}packages/core/src/index.ts`,
      "@tbc-wallet/host": `${root}packages/host/src/index.ts`,
      "@tbc-wallet/provider/in-memory": `${root}packages/provider/src/in-memory.ts`,
      "@tbc-wallet/provider": `${root}packages/provider/src/index.ts` },
    bundle: true, write: false, format: "esm", platform: "node", target: "node22", logLevel: "silent",
  });
  const kit = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
  const definitions = {
    normalizeRequest: ["normalizeRequestParams", "normalizeRequestResult"],
    plan: ["planParams", "planResult"], validate: ["validateParams", "validationResult"],
    finalize: ["finalizeParams", "finalizeResult"],
  };
  let calls = 0;
  function invoke(method, params) {
    kit.assertValidTws(definitions[method][0], params);
    const run = spawnSync(executable, [method], { input: JSON.stringify(params), encoding: "utf8",
      timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
    check(!run.error && run.status === 0, `Rust ${method} process failed; output withheld`);
    let envelope; try { envelope = JSON.parse(run.stdout); } catch { throw new Error(`Rust ${method} returned invalid JSON`); }
    check(envelope.ok === true, `Rust ${method} rejected material: ${envelope.error?.code ?? "unknown"} at ${envelope.error?.path ?? "unknown"}`);
    kit.assertValidTws(definitions[method][1], envelope.result); calls++;
    return envelope.result;
  }
  for (const operation of ["create", "transfer", "merge"]) {
    const stage = fixture.stages[operation === "merge" ? 2 : 1];
    const raw = new Map(fixture.stages.map((item) => [item.txid, item.signedRaw]));
    const genesis = fixture.stages[1];
    const account = { chainId: "tbc:testnet", address: fixture.request.ownerAddress,
      accountId: `tbc:testnet:${fixture.request.ownerAddress}`, publicKey: fixture.request.publicKeyHex };
    const trace = [];
    const fetch = async (input, init) => {
      const url = new URL(String(input)); const pathname = url.pathname;
      check(url.origin === "https://api.tbcdev.org", "Unexpected API origin");
      check(init?.method === undefined || init.method === "GET", "Write transport is forbidden");
      trace.push(pathname);
      let data;
      if (pathname === "/api/tbc/nodeinfo") data = { blocks: 100, bestblockhash: "aa".repeat(32) };
      else if (pathname === `/api/tbc/utxo/address/${account.address}`) {
        const funding = stage.outputs.at(-1);
        data = { utxos: [{ txid: stage.txid, index: funding.vout, value: funding.value, height: 99 }] };
      } else if (pathname.startsWith("/api/tbc/ft/utxo/combinescript/") && pathname.endsWith(`/contract/${genesis.txid}`)) {
        data = { utxos: stage.tokenOutputs.map((token) => ({ txid: stage.txid, index: token.codeVout,
          tbc_value: "500", ft_value: token.amount, height: 99 })) };
      } else if (pathname.startsWith("/api/tbc/txraw/txid/")) {
        const txid = pathname.slice("/api/tbc/txraw/txid/".length);
        check(raw.has(txid), "Unexpected ancestor fetch");data = { txraw: raw.get(txid) };
      } else throw new Error(`Unexpected read endpoint: ${pathname}`);
      return new Response(JSON.stringify({ code: "200", data }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const configuredNetwork = kit.createDefaultTbcNetwork({ network: kit.createTbcNetworkContext({ network: "testnet" }),
      accounts: { current: async () => [account] }, fetch, now: () => Date.parse(NOW),
      snapshotId: () => `tbc20-kit-source-${operation}`,
      poolMaterial: { async resolveLiquidityAdd() { throw new Error("Unrelated Pool machinery must remain lazy"); } },
    });
    const network = {
      async resolveChainData(params) {
        assertPortParams("chainDataResolveParams", params);
        const result = await configuredNetwork.resolveChainData(params);
        kit.assertValidTws("chainDataResolveResult", result);
        check(result.portError === undefined, "Default Chain Data returned a Port error");
        return result;
      },
      async resolvePolicy(params) {
        assertPortParams("policyResolveParams", params);
        const result = await configuredNetwork.resolvePolicy(params);
        kit.assertValidTws("policyResolveResult", result);
        check(result.portError === undefined, "Default policy returned a Port error");
        return result;
      },
    };
    let planParams, planned;
    const engine = Object.fromEntries(Object.keys(definitions).map((method) => [method, (params) => {
      const result = invoke(method, params);
      if (method === "plan") { planParams = params; planned = result; }
      return result;
    }]));
    const intent = { type: `tbc20-standard-${operation}`, version: "1.0",
      ...(operation === "create" ? { name: "Kit Source", symbol: "KITS", decimals: 6, initialSupply: "123456" }
        : { contractId: genesis.txid }),
      ...(operation === "transfer" ? { to: account.address, amount: "40000" } : {}),
    };
    const prepared = await kit.prepareTbcTransaction({ engine, network,
      request: { version: "1.0", chainId: account.chainId, from: account.address, intent,
        constraints: { maxFee: "5000" } } });
    kit.assertValidTws("preparedTransactionRequest", prepared);
    kit.assertPreparedProposalForPlan(prepared, planParams.snapshot, planned.plan);
    check(planParams.policy.payload.dustThreshold === "42", "Kit selected an old policy for new TBC20");
    const readCount = trace.length;
    check(new Set(trace).size === trace.length, "Duplicate reads inside one preparation");
    check(trace.filter((path) => path.includes("/txraw/")).length === (operation === "create" ? 0 : operation === "transfer" ? 2 : 3),
      "Chain Data did not preserve the minimal raw dependency closure");
    const binding = structuredClone(base.finalizeInput.binding);
    Object.assign(binding.payload, { chainId: account.chainId, accountId: account.accountId,
      requestHash: planParams.requestHash, operationHash: planned.plan.planHash, expiresAt: planned.plan.payload.expiresAt });
    binding.bindingHash = kit.hashCanonical(binding.payload);
    const approval = { ...base.finalizeInput.approval, bindingHash: binding.bindingHash,
      approvedAt: NOW, expiresAt: planned.plan.payload.expiresAt };
    const finalize = { ...planParams, plan: planned.plan, binding, approval };
    const presign = invoke("validate", { ...finalize, phase: "pre-sign" });
    check(presign.valid === true, "Public pre-sign approval binding rejected");
    const sign = (tasks) => tasks.map((task) => ({ taskId: task.taskId, signatureEncoding: "compact64",
      signature: secp256k1.sign(task.digest, scalar, { prehash: false, lowS: true }).toCompactHex() }));
    finalize.signatures = sign(planned.plan.payload.signingTasks);
    let result = invoke("finalize", finalize); let stages = 1;
    while (result.status === "pending") {
      finalize.continuation = result.continuation;finalize.signatures = sign(result.signingRequests);
      result = invoke("finalize", finalize);stages++;
      check(stages <= 2, "Unexpected signing stage growth");
    }
    check(stages === (operation === "create" ? 2 : 1), "Wrong parent-dependent signing count");
    for (const transaction of result.bundle.transactions) {
      const parsed = kit.inspectTbcTransaction(transaction.rawTransaction);
      check(parsed.txid === transaction.txid, "Finalized raw/txid mismatch");
    }
    for (const phase of ["finalized", "pre-broadcast"]) {
      check(invoke("validate", { ...finalize, phase, bundle: result.bundle }).valid === true, `Public ${phase} verification failed`);
    }
    check(trace.length === readCount, "Signing/finalization re-fetched chain data");
    checks.push(`${operation}:reads=${readCount},raw=${planParams.snapshot.payload.parents.length},stages=${stages},txs=${result.bundle.transactions.length}`);
  }
  console.log(`TBC20_KIT_SOURCE_PASS ${checks.join(" ")} rustCalls=${calls}; source-only, offline synthetic funds, POST=0`);
  const baselineCalls = calls;
  const walletChecks = [];
  const materialRun = spawnSync("cargo", ["test", "--offline", "--locked", "-p", "tbc-engine-core", "--test", "tbc20_public",
    "tbc20_public_create_transfer_merge_all_four_validation_phases", "--", "--exact", "--nocapture"],
  { cwd: rust, env: { ...process.env, TBC20_DUMP_MATERIAL: "1" }, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  check(!materialRun.error && materialRun.status === 0, "Rust public synthetic-material test failed; output withheld");
  const materials = materialRun.stdout.split(/\r?\n/u).filter((line) => line.startsWith("TBC20_MATERIAL:"))
    .map((line) => JSON.parse(line.slice("TBC20_MATERIAL:".length)));
  const multi = materials.find(({ label, planInput }) => label === "tbc20-standard-merge"
    && planInput?.snapshot?.payload?.utxos?.filter((u) => u.classification === "ft").length === 7)?.planInput;
  check(multi !== undefined, "Rust did not emit seven-fragment synthetic material");
  const receivers = [
    { to: "1FMZk84eVEJ1QHas3Gke1U9ZPMKrPk36ex", amount: "40000" },
    { to: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", amount: "10000" },
  ];
  for (const receiver of receivers) kit.assertTbcAddress(receiver.to, 0);
  function assertRecipientFlows(preview, account, label) {
    const sends = preview.assetFlows.filter((flow) => flow.kind === "ft" && flow.direction === "send");
    check(sends.length === receivers.length, `${label}: recipient flow count includes change or lost a recipient`);
    for (const receiver of receivers) {
      const matches = sends.filter((flow) => flow.to === receiver.to && flow.amount === receiver.amount
        && flow.from === account.address && flow.contractId === fixture.stages[1].txid);
      check(matches.length === 1, `${label}: recipient amount/identity missing from trusted send flows`);
    }
    check(!sends.some((flow) => flow.to === account.address), `${label}: sender change was presented as a send`);
  }
  function assertRecipientOutputs(bundle, account, label) {
    check(bundle.transactions.length === 1, `${label}: unexpected recipient transaction splitting`);
    const outputs = kit.inspectTbcTransaction(bundle.transactions[0].rawTransaction).transaction.outputs;
    const source = fixture.stages[1].outputs[0].scriptHex;
    const ownerController = `${kit.assertTbcAddress(account.address, 0).publicKeyHash}00`;
    check(source.split(ownerController).length === 2, `${label}: fixture controller must have one exact replacement site`);
    const expected = [...receivers, { to: account.address, amount: "73456" }];
    const seen = new Set();
    for (const receiver of expected) {
      const controller = `${kit.assertTbcAddress(receiver.to, 0).publicKeyHash}00`;
      const expectedCode = source.replace(ownerController, controller);
      const vouts = outputs.flatMap((output, index) => Buffer.from(output.scriptPubKey).toString("hex") === expectedCode ? [index] : []);
      check(vouts.length === 1, `${label}: recipient Code or asset origin differs from frozen identity`);
      const vout = vouts[0]; seen.add(vout);
      const code = outputs[vout], tape = outputs[vout + 1];
      check(code.satoshis === 500n && tape?.satoshis === 0n, `${label}: recipient Code/Tape values`);
      const script = Buffer.from(tape.scriptPubKey);
      check(script.length === fixture.stages[1].outputs[1].scriptHex.length / 2
        && script.subarray(0, 3).equals(Buffer.from([0, 106, 48]))
        && script.subarray(-9).toString("ascii") === "TBC20TAPE", `${label}: recipient Tape framing`);
      let amount = 0n;
      for (let slot = 0; slot < 6; slot++) amount += script.readBigUInt64LE(3 + 8 * slot);
      check(amount.toString() === receiver.amount, `${label}: finalized recipient amount mismatch`);
    }
    check(seen.size === 3 && outputs.length === 7, `${label}: expected two recipient pairs, one change pair, and native change`);
  }
  for (const { operation, material, multiRecipient } of ["create", "transfer", "merge"].map((operation) => ({ operation }))
    .concat([{ operation: "merge", material: multi }, { operation: "transfer", multiRecipient: true }])) {
    for (const preparedMode of [false, true]) {
      const label = `${material ? "multi-round-" : multiRecipient ? "multi-recipient-" : ""}${operation}/${preparedMode ? "prepared" : "ordinary"}`;
      const stage = fixture.stages[operation === "merge" ? 2 : 1];
      const genesis = material ? { txid: material.request.intent.contractId } : fixture.stages[1];
      const raw = new Map(material ? material.snapshot.payload.parents.map((item) => [item.txid, item.rawTransaction])
        : fixture.stages.map((item) => [item.txid, item.signedRaw]));
      const account = { chainId: "tbc:testnet", address: fixture.request.ownerAddress,
        accountId: `tbc:testnet:${fixture.request.ownerAddress}`, publicKey: fixture.request.publicKeyHex };
      const trace = [];
      let approvals = 0, signatures = 0, readsAtApproval, finalizations = 0;
      const fetch = async (input, init) => {
        const url = new URL(String(input));
        check(url.origin === "https://api.tbcdev.org" && (init?.method === undefined || init.method === "GET"), `${label}: forbidden transport`);
        check(approvals === 0, `${label}: read after approval`);
        trace.push(url.pathname);
        let data;
        if (url.pathname === "/api/tbc/nodeinfo") data = { blocks: 100, bestblockhash: "aa".repeat(32) };
        else if (url.pathname === `/api/tbc/utxo/address/${account.address}`) {
          const funding = stage.outputs.at(-1);
          data = { utxos: material ? material.snapshot.payload.utxos.filter((u) => u.classification === "native")
            .map((u) => ({ txid: u.txid, index: u.vout, value: u.satoshis, height: 99 }))
            : [{ txid: stage.txid, index: funding.vout, value: funding.value, height: 99 }] };
        } else if (url.pathname.startsWith("/api/tbc/ft/utxo/combinescript/") && url.pathname.endsWith(`/contract/${genesis.txid}`)) {
          data = { utxos: material ? material.snapshot.payload.utxos.filter((u) => u.classification === "ft").map((u) => {
            const tape = Buffer.from(kit.inspectTbcTransaction(raw.get(u.txid)).transaction.outputs[u.vout + 1].scriptPubKey);
            check(tape.length >= 61 && tape.subarray(0, 3).equals(Buffer.from([0, 106, 48])), "Synthetic TBC20 Tape header mismatch");
            let amount = 0n; for (let slot = 0; slot < 6; slot++) amount += tape.readBigUInt64LE(3 + 8 * slot);
            return { txid: u.txid, index: u.vout, tbc_value: u.satoshis, ft_value: amount.toString(), height: 99 };
          }) : stage.tokenOutputs.map((token) => ({ txid: stage.txid, index: token.codeVout,
            tbc_value: "500", ft_value: token.amount, height: 99 })) };
        } else if (url.pathname.startsWith("/api/tbc/txraw/txid/")) {
          const txid = url.pathname.slice("/api/tbc/txraw/txid/".length);
          check(raw.has(txid), `${label}: unknown ancestor`); data = { txraw: raw.get(txid) };
        } else throw new Error(`${label}: unknown read endpoint`);
        return new Response(JSON.stringify({ code: "200", data }), { status: 200, headers: { "content-type": "application/json" } });
      };
      let snapshots = 0;
      function isolatedNetwork() {
        const configuredNetwork = kit.createDefaultTbcNetwork({ network: kit.createTbcNetworkContext({ network: "testnet" }),
        accounts: { current: async () => [account] }, fetch, now: () => Date.parse(NOW),
        snapshotId: () => `tbc20-wallet-${operation}-${++snapshots}`,
        poolMaterial: { async resolveLiquidityAdd() { throw new Error("Unrelated Pool machinery must remain lazy"); } },
      });
        return {
        async resolveChainData(params) {
          assertPortParams("chainDataResolveParams", params);
          const result = await configuredNetwork.resolveChainData(params);
          kit.assertValidTws("chainDataResolveResult", result); return result;
        },
        async resolvePolicy(params) {
          assertPortParams("policyResolveParams", params);
          const result = await configuredNetwork.resolvePolicy(params);
          kit.assertValidTws("policyResolveResult", result); return result;
        },
        async broadcastSubmit() { throw new Error("Broadcast forbidden"); },
        async broadcastReconcile() { throw new Error("Reconcile forbidden"); },
        };
      }
      // Independent DApp and wallet resolvers must not share immutable raw caches.
      const network = isolatedNetwork();
      let latestSnapshot, latestPlan;
      const engine = Object.fromEntries(Object.keys(definitions).map((method) => [method, (params) => {
        const result = invoke(method, params);
        if (method === "plan") { latestSnapshot = params.snapshot; latestPlan = result.plan; }
        if (method === "finalize") finalizations++;
        return result;
      }]));
      const intent = { type: `tbc20-standard-${operation}`, version: "1.0",
        ...(operation === "create" ? { name: "Kit Source", symbol: "KITS", decimals: 6, initialSupply: "123456" }
          : { contractId: genesis.txid }),
        ...(operation === "transfer" ? multiRecipient ? { receivers } : { to: account.address, amount: "40000" } : {}),
      };
      const request = material ? structuredClone(material.request) : { version: "1.0", chainId: account.chainId, from: account.address, intent,
        constraints: { maxFee: "5000" } };
      if (material) {
        // Fixture funding has no live network authority: the new preparation is
        // bound to this controlled Testnet session and its current policy clock.
        request.chainId = account.chainId;
        request.constraints.expiresAt = "2026-09-28T12:02:00Z";
      }
      const params = preparedMode ? await kit.prepareTbcTransaction({ engine, network: isolatedNetwork(), request }) : request;
      const dappReads = trace.length;
      const method = preparedMode ? "tbc_signPreparedTransaction" : "tbc_signTransaction";
      const permissions = ["tbc_accounts", "tbc_signTransaction"].map((capability) => ({
        id: `offline-${capability}`, parentCapability: capability, invoker: "https://wallet.test",
        date: Date.parse(NOW), caveats: [
          { type: "restrictChains", value: [account.chainId] },
          { type: "restrictAccounts", value: [account.accountId] },
          { type: "restrictMethods", value: [capability] },
        ],
      }));
      const runtime = kit.createTbcWallet({
        legacy: false, accounts: { current: async () => [account] },
        capabilities: { version: "1.0", scopes: [{ chainId: account.chainId,
          intents: ["tbc.transfer", "tbc20-standard-create", "tbc20-standard-transfer", "tbc20-standard-merge"], profiles: ["core"] }] },
        approval: { async request(approval, call) {
          check(call.operation === "approval.request", `${label}: wrong approval Port`);
          if (multiRecipient) assertRecipientFlows(approval.preview, account, `${label}/approval`);
          approvals++; readsAtApproval = trace.length;
          return { status: "approved", approvalId: `offline-${operation}`, approvalToken: `offline-token-${operation}`,
            bindingHash: approval.binding.bindingHash, approvedAt: NOW, expiresAt: approval.binding.payload.expiresAt };
        } },
        signer: { async sign(input, call) {
          check(approvals === 1 && call.operation === "signer.sign", `${label}: signer outside approval`);
          signatures++;
          return { taskId: input.task.taskId, signatureEncoding: "compact64",
            signature: secp256k1.sign(input.task.digest, scalar, { prehash: false, lowS: true }).toCompactHex() };
        } },
        storage: { async loadPermissions() { return { revision: "0", permissions }; },
          async commitPermissions(input) { return { revisions: input.changes.map((change) => ({ scope: change.scope, revision: "1" })) }; } },
        network, engine, clock: () => NOW,
        randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
      });
      let ids = 0;
      const session = await runtime.openSession({ origin: "https://wallet.test", sessionId: `tbc20-${operation}-${preparedMode}`,
        requestIdFactory: () => `offline-${++ids}`, execution: { hostStore: kit.createMemoryTwsHostStore({ now: () => Date.parse(NOW) }) } });
      try {
        const result = await session.provider.request({ method, params });
        check(approvals === 1, `${label}: expected one approval`);
        if (material) {
          check(finalizations >= 2 && signatures > 7, `${label}: maintenance signing stages missing`);
          const child = latestPlan.payload.transactions.find((tx) => tx.deferredInputs?.length >= 2);
          check(child !== undefined, "Explicit child dependency edges are missing");
          const edges = child.deferredInputs;
          check(edges.some((left, i) => edges.some((right, j) => i !== j && left.sourceTransactionId === right.sourceTransactionId
            && left.sourceOutputIndex !== right.sourceOutputIndex)), "Token and native change do not bind distinct outputs of the same signed parent");
          const signedChild = result.transactions.find((tx) => tx.id === child.id);
          check(signedChild !== undefined, "Signed child is missing");
          const parsedChild = kit.inspectTbcTransaction(signedChild.rawTransaction).transaction;
          for (const edge of edges) {
            const signedParent = result.transactions.find((tx) => tx.id === edge.sourceTransactionId);
            const input = parsedChild.inputs[edge.inputIndex];
            check(signedParent !== undefined && input.txid === signedParent.txid && input.vout === edge.sourceOutputIndex,
              "Final child did not resolve the exact output of its signed parent");
          }
        } else {
          check(finalizations === (operation === "create" ? 2 : 1), `${label}: signing stage count`);
          check(signatures === (operation === "merge" ? 3 : 2), `${label}: input signer count`);
        }
        check(trace.length === readsAtApproval, `${label}: post-approval data read`);
        const expectedReads = material ? 3 + material.snapshot.payload.parents.length : operation === "create" ? 2 : operation === "transfer" ? 5 : 6;
        check(dappReads === (preparedMode ? expectedReads : 0), `${label}: unexpected DApp read count`);
        check(trace.length - dappReads === expectedReads, `${label}: unexpected independent wallet read count`);
        check(new Set(trace.slice(dappReads)).size === expectedReads, `${label}: duplicate wallet read endpoint`);
        check(result.transactions.length === (material ? finalizations : operation === "create" ? 2 : 1), `${label}: transaction count`);
        for (const transaction of result.transactions) {
          check(kit.inspectTbcTransaction(transaction.rawTransaction).txid === transaction.txid, `${label}: signed raw mismatch`);
        }
        if (multiRecipient) {
          assertRecipientFlows(latestPlan.payload.preview, account, `${label}/engine`);
          assertRecipientOutputs(result, account, label);
        }
        walletChecks.push(`${label}:dappReads=${dappReads},walletReads=${trace.length - dappReads},approvals=${approvals},signatures=${signatures},stages=${finalizations}`);
        if (material && preparedMode) {
          const tampered = structuredClone(params);
          const child = tampered.proposal.payload.transactions.find((tx) => tx.deferredInputs?.length >= 2);
          check(child !== undefined, "Prepared proposal lost explicit child dependency edges");
          child.deferredInputs[0].sourceOutputIndex += 1;
          tampered.proposal.proposalHash = kit.hashCanonical(tampered.proposal.payload);
          kit.assertValidTws("preparedTransactionRequest", tampered);
          let mismatch;
          try { kit.assertPreparedProposalForPlan(tampered, latestSnapshot, latestPlan); }
          catch (error) { mismatch = error; }
          check(mismatch?.code === "ENGINE_ARTIFACT_MISMATCH", "Wrong dependency vout was not bound to the verified plan");
          approvals = 0; signatures = 0;
          let rejection;
          try { await session.provider.request({ method, params: tampered }); }
          catch (error) { rejection = error; }
          check(rejection !== undefined && approvals === 0 && signatures === 0, "Wrong dependency vout reached approval or signing");
          walletChecks.push(`tampered-deferred-vout:code=${rejection.code},artifact=ENGINE_ARTIFACT_MISMATCH,approvals=0,signatures=0`);
        }
        if (operation === "transfer" && preparedMode && !multiRecipient) {
          const tampered = structuredClone(params);
          tampered.proposal.payload.evidence.contracts[0].genesisOutpoint.txid = "ee".repeat(32);
          tampered.proposal.proposalHash = kit.hashCanonical(tampered.proposal.payload);
          // A schema-valid and freshly rehashed false identity must not reach approval.
          kit.assertValidTws("preparedTransactionRequest", tampered);
          approvals = 0; signatures = 0;
          const before = trace.length;
          latestPlan = undefined;
          let rejection;
          try { await session.provider.request({ method, params: tampered }); }
          catch (error) { rejection = error; }
          check(rejection !== undefined, "Tampered Prepared evidence was accepted");
          check(approvals === 0 && signatures === 0, "Tampered Prepared evidence reached approval or signer");
          check(rejection.code === -32603, `Unexpected tamper rejection boundary: ${rejection.code} ${rejection.message}`);
          check(latestPlan !== undefined, "Tampered request did not reach independent Rust re-planning");
          let artifactError;
          try { kit.assertPreparedProposalForPlan(tampered, latestSnapshot, latestPlan); }
          catch (error) { artifactError = error; }
          check(artifactError?.code === "ENGINE_ARTIFACT_MISMATCH", "Tamper rejection was not verified against the wallet plan");
          walletChecks.push(`tampered-genesis:code=${rejection.code},artifact=ENGINE_ARTIFACT_MISMATCH,reads=${trace.length - before},approvals=0,signatures=0`);
        }
      } catch (error) { throw new Error(`${label}: ${error?.code ?? "unknown"} ${error?.message ?? "failure"}`); }
      finally { session.close(); }
    }
  }
  console.log(`TBC20_WALLET_SOURCE_PASS ${walletChecks.join(" ")} rustCalls=${calls - baselineCalls}; offline synthetic funds, POST=0`);
}
try { await main(); }
catch (error) {
  console.error(`TBC20_KIT_SOURCE_FAIL ${String(error instanceof Error ? error.message : "unknown failure").slice(0,600)}`);
  process.exitCode = 1;
}
