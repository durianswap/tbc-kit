import { assertValidTws, canonicalize, chainDataRequirement, hashCanonical,
  type TransactionEngine, type PlanParams, type PlanResult, type ApprovalRequestParams } from "@tbc-wallet/core";
import { createTbcNftMintJobOrchestrator, type TbcNftMintJobScope,
  type TbcNftMintJobExecution, type TbcNftMintJobTransaction } from "./nft-mint-job.js";
import type { TbcNftMintJobMaterial } from "./nft-mint-job-material.js";
import type { KitWalletOptions, KitWalletSession, KitWalletAuthoritySource, KitWalletAccount,
  KitWalletNetwork } from "./wallet-runtime.js";

type Prepared = Readonly<{ params: PlanParams; plan: PlanResult["plan"] }>;
const own = <T>(value: T): T => JSON.parse(canonicalize(value)) as T;
const equal = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);

/** Only explicit resource failures from the pinned Engine permit local resizing.
 * Semantic, funding, identity and validation failures must never become retries. */
export function nftMintPreparationResource(error: unknown): "plan-bytes" | "continuation-bytes" | "inputs" | "outputs" | undefined {
  if (!(error instanceof Error) || Reflect.get(error, "rustCode") !== "INVALID_PLAN") return undefined;
  if (error.message === "unsigned plan exceeds the serialized byte budget") return "plan-bytes";
  if (error.message === "signing continuation exceeds the serialized byte budget") return "continuation-bytes";
  if (error.message === "unsigned plan exceeds the input budget") return "inputs";
  if (error.message === "unsigned plan exceeds the output budget") return "outputs";
  return undefined;
}

/** Private execution channel over the same Core/Host composition. It is never
 * exposed to the page, and therefore cannot lend job consent to another call.
 * Wallet adapters only render one consent and issue exact Core credentials. */
export function createWalletNftMintJob(input: Readonly<{
  account: KitWalletAccount;
  network: KitWalletNetwork;
  engine: TransactionEngine;
  wallet: KitWalletOptions;
  authority: KitWalletAuthoritySource;
  openExecution: (options: KitWalletOptions, authority: KitWalletAuthoritySource) => Promise<KitWalletSession>;
  assertAuthority: () => Promise<void>;
  now: () => number;
  refreshTime: () => Promise<void>;
}>) {
  const configured = input.wallet.nftMintJob;
  const prepareMaterial = input.network.prepareNftMintJob;
  if (!configured || !prepareMaterial) throw new Error("NFT mint jobs require bounded review and a task-scoped material provider");
  let execution: KitWalletSession | undefined;
  let current: { prepared: Prepared; scope: TbcNftMintJobScope; scopeHash: string;
    approval: Parameters<NonNullable<KitWalletOptions["nftMintJob"]>["authorizeBatch"]>[0]["approval"];
    signal?: AbortSignal; transactions: TbcNftMintJobTransaction[];
    signed: readonly { txid: string; rawTransaction: string }[] | undefined } | undefined;
  const assertCurrent = async () => {
    const active = current;
    if (!active || active.signal?.aborted || input.now() >= Date.parse(active.approval.expiresAt)) {
      throw new Error("NFT job authorization is no longer active");
    }
    // Live authority freshness is checked by the existing Host before Ports;
    // do not add another account read for each signing input here.
    return active;
  };
  const childEngine: TransactionEngine = {
    normalizeRequest: params => input.engine.normalizeRequest(params),
    async plan(params) {
      const active = await assertCurrent();
      if (!equal(params, active.prepared.params)) throw new Error("NFT job prepared material changed");
      return { plan: own(active.prepared.plan) };
    },
    validate: params => input.engine.validate(params),
    async finalize(params) {
      const active = await assertCurrent();
      const result = await input.engine.finalize(params);
      if ("bundle" in result && result.validation.valid) {
        active.signed = own(result.bundle.transactions);
      }
      return result;
    },
  };
  const childNetwork: KitWalletNetwork = {
    ...input.network,
    // Immutable native capability metadata was already warmed by the parent.
    warmup: async () => {},
    async resolveChainData(params) {
      const active = await assertCurrent();
      const expected = { version: "1.0", chainId: input.account.chainId, accountId: input.account.accountId,
        requirement: chainDataRequirement(active.prepared.params.request as Parameters<typeof chainDataRequirement>[0]) };
      if (!equal(params, expected)) throw new Error("NFT job material request differs");
      return own(active.prepared.params.snapshot);
    },
    async resolvePolicy(params) {
      const active = await assertCurrent();
      const prepared = active.prepared.params;
      if (!equal(params, { version: "1.0", request: prepared.request, requestHash: prepared.requestHash,
        snapshotHash: prepared.snapshot.snapshotHash })) throw new Error("NFT job policy request differs");
      return own(prepared.policy);
    },
    async broadcastSubmit(params, call) {
      const active = await assertCurrent();
      const request = params as { transaction: { txid: string; rawTransaction: string } };
      const index = active.transactions.length;
      const signed = active.signed?.[index];
      if (!signed || !equal(signed, request.transaction) ||
          active.transactions.some(tx => tx.status !== "accepted" && tx.status !== "known")) {
        throw new Error("NFT job broadcast is not the next validated transaction");
      }
      const tx: TbcNftMintJobTransaction = { txid: signed.txid,
        fee: active.prepared.plan.payload.transactions[index]!.fee, status: "uncertain" };
      // Record the dispatch window before awaiting the normal journaled Port.
      active.transactions.push(tx);
      const result = await input.network.broadcastSubmit(params, call);
      assertValidTws("broadcastSubmitResult", result);
      const reply = result as { txid?: string; status?: string };
      if (reply.txid === signed.txid && ["accepted", "known", "rejected"].includes(reply.status ?? "")) {
        active.transactions[index] = { ...tx, status: reply.status as "accepted" | "known" | "rejected" };
      }
      return result;
    },
    async broadcastSubmitBatch() { throw new Error("NFT mint job uses ordered dependent submission"); },
  };
  const runner = createTbcNftMintJobOrchestrator({
    assertAuthority: input.assertAuthority,
    begin: scope => prepareMaterial(scope, input.account),
    async approve(request) {
      const receipt = await configured.approve(request);
      // A UI wait must not compare a new receipt with a stale/truncated clock
      // sample. Read the same trusted clock, never alter the receipt or TTL.
      await input.refreshTime();
      return receipt;
    },
    async prepare({ request, context }) {
      const material = context as TbcNftMintJobMaterial;
      const normalized = await input.engine.normalizeRequest({ version: "1.0", request });
      const snapshot = material.snapshot(request.intent.items.map(item => item.slot));
      const policy = await input.network.resolvePolicy({ version: "1.0", ...normalized, snapshotHash: snapshot.snapshotHash });
      assertValidTws("policyResolveResult", policy);
      if (!policy || typeof policy !== "object" || "portError" in policy) throw new Error("NFT job policy unavailable");
      const params: PlanParams = { version: "1.0", ...normalized, snapshot, policy: policy as PlanParams["policy"] };
      let result: PlanResult;
      try { result = await input.engine.plan(params); }
      catch (error) { const resource = nftMintPreparationResource(error); if (resource) return { status: "resource-limit", resource }; throw error; }
      // Core independently validates the exact reused plan before approval and
      // signing. Resizing here is unsigned, local and does not reread material.
      if (result.plan.payload.preview.operationKind !== "transaction") throw new Error("NFT plan has no transaction preview");
      return { status: "ready", request, planHash: result.plan.planHash,
        totalFee: result.plan.payload.preview.totalFee, transactionCount: result.plan.payload.transactions.length,
        serializedPlanBytes: new TextEncoder().encode(canonicalize(result.plan)).length,
        prepared: { params, plan: result.plan } satisfies Prepared };
    },
    async execute({ batch, scope, scopeHash, approval, context, signal, offset }): Promise<TbcNftMintJobExecution> {
      if (current) throw new Error("NFT job execution is already active");
      const active = { prepared: batch.prepared as Prepared, scope, scopeHash, approval,
        ...(signal ? { signal } : {}), transactions: [] as TbcNftMintJobTransaction[],
        signed: undefined as readonly { txid: string; rawTransaction: string }[] | undefined };
      current = active;
      let operationId: string | undefined;
      try {
        const { nftMintJob: _job, multiRoundMerge: _merge, approvalPreparation: _preparation, ...childOptions } = input.wallet;
        if (!execution) execution = await input.openExecution({
          ...childOptions, legacy: false, engine: childEngine, network: childNetwork,
          // A private child has no public nested job or early UI. The single
          // bounded consent is owned by the outer job; formal checks stay here.
          approval: { async request(raw, call) {
            const binding = (raw as ApprovalRequestParams).binding.payload;
            const preview = (raw as ApprovalRequestParams).preview;
            const a = await assertCurrent();
            if (binding.operationKind !== "transaction" || binding.requestHash !== a.prepared.params.requestHash ||
                binding.operationHash !== a.prepared.plan.planHash || binding.chainId !== a.scope.authority.chainId ||
                binding.accountId !== a.scope.authority.accountId || binding.origin !== a.scope.authority.origin ||
                binding.sessionId !== a.scope.authority.sessionId ||
                Date.parse(binding.expiresAt) > Date.parse(a.approval.expiresAt) ||
                preview.operationKind !== "transaction" || a.prepared.plan.payload.preview.operationKind !== "transaction" ||
                preview.transactionCount !== a.prepared.plan.payload.transactions.length ||
                preview.totalFee !== a.prepared.plan.payload.preview.totalFee) {
              throw new Error("NFT formal approval is outside the whole-job consent");
            }
            return configured.authorizeBatch({ scope: a.scope, scopeHash: a.scopeHash, approval: a.approval, params: raw }, call);
          } },
        }, input.authority);
        const requestId = `kit-nft-job-${hashCanonical({ scopeHash, approvalId: approval.approvalId, offset })}`;
        let operation = await execution.startOperation({ id: requestId, method: "tbc_sendTransaction", params: batch.request });
        operationId = operation.operationId;
        // A failed/unknown Host is never blindly resumed. Only waiting/busy
        // live operations may advance, bounded by the approved deadline.
        const started = performance.now();
        while ((operation.status === "waiting" || operation.status === "busy") && performance.now() - started < 30_000) {
          await assertCurrent();
          await new Promise<void>(resolve => setTimeout(resolve, 25));
          operation = await execution.resumeOperation(operation.operationId);
        }
        const complete = operation.status === "complete" && operation.completion.delivery === "respond" &&
          !Object.hasOwn(operation.completion.response as object, "error");
        const accepted = active.transactions.filter(tx => tx.status === "accepted" || tx.status === "known").length;
        if (complete && accepted === batch.transactionCount && active.signed?.length === batch.transactionCount) {
          (context as TbcNftMintJobMaterial).acceptValidatedBatch(batch.request.intent.items.map(item => item.slot), active.signed);
          return { status: "complete", transactions: active.transactions };
        }
        return { status: active.transactions.some(tx => tx.status === "uncertain") ? "uncertain"
          : operation.status === "waiting" || operation.status === "busy" ? "pending" : accepted ? "partial" : "failed",
          transactions: active.transactions, recoveryId: operationId };
      } catch {
        return { status: active.transactions.some(tx => tx.status === "uncertain") ? "uncertain"
          : active.transactions.length ? "partial" : operationId ? "pending" : "failed",
          transactions: active.transactions, ...(operationId ? { recoveryId: operationId } : {}) };
      } finally {
        // Fence any delayed Port before disposing the private channel. The
        // normal submit journal remains available through the parent network.
        current = undefined;
      }
    },
  // Core checkpoints contain the exact plan and evolve per signing input.
  // Bounding the working set avoids quadratic large-plan copying/hashing.
  // This is execution chunking, not a public 10-item limit: the whole manifest
  // stays bound to one consent and retained materials fund every next chunk.
  }, { now: input.now, executionBatchSize: 10 });
  return Object.freeze({ async run(params: Parameters<typeof runner.run>[0]) {
    try { return await runner.run(params); }
    finally { current = undefined; execution?.close(); }
  } });
}
