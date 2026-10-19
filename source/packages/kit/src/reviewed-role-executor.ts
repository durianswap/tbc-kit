import { canonicalize, type ResolvedTransactionSigningRole } from "@tbc-wallet/core";
import type { createApprovedHostTaskReader } from "./approved-host-task.js";
import type { KitHostPortCall } from "./wallet-runtime.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { TbcReviewedPolicyMaterial } from "./reviewed-transaction-types.js";

type RecordValue = Readonly<Record<string, unknown>>;
type Evidence = Awaited<ReturnType<ReturnType<typeof createApprovedHostTaskReader>["readReviewed"]>>;
export type TbcReviewedInputSigningTask = Readonly<{
  inputIndex: number; accountId: string; publicKey: string; digest: string;
  algorithm: "secp256k1-ecdsa" | "secp256k1-schnorr";
}>;
/** Wallet-private custody only. The adapter must retain its normal Vault/user
 * authorization and one-shot checks, including when it delegates to MuSig.
 * Stage/request material stays in memory; never log or persist it. */
export interface TbcReviewedRoleSigner {
  readonly approvedTasks: Pick<ReturnType<typeof createApprovedHostTaskReader>, "readReviewed">;
  readonly signStage: (input: Readonly<{
    evidence: Evidence; tasks: readonly TbcReviewedInputSigningTask[];
    transactionIndex: number; stage: RecordValue;
    /** The exact keyless material to bind at approval and independently
     * reconstruct in custody. Private memory only; never page authority. */
    material: Readonly<{format: "raw" | "associated"; request: RecordValue; policyMaterial: TbcReviewedPolicyMaterial}>;
  }>, call: KitHostPortCall) => Promise<readonly string[]>;
}
function object(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Reviewed role stage");
  return value as RecordValue;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** One shared, keyless continuation loop for role-aware raw/associated requests.
 * No HTTP, broadcast, durable writes or key ownership. Only public material is
 * mapped here; Core/Host approval and wallet custody remain authoritative. */
export function createReviewedRoleExecutor() {
  const consumed = new Set<string>();
  return async (options: Readonly<{
    native: PoolMaterialNativeProviderInput; signer: TbcReviewedRoleSigner;
    request: RecordValue; params: RecordValue; call: KitHostPortCall;
    format?: "raw" | "associated";
    primary: Readonly<{accountId: string; publicKey: string}>;
    roles: readonly ResolvedTransactionSigningRole[]; policyMaterial: TbcReviewedPolicyMaterial;
    assertAuthority: () => Promise<void>;
  }>): Promise<Readonly<{transactions: readonly string[]; detachedSignatures?: readonly (readonly string[])[]}>> => {
    const {signer, call} = options;
    const evidence = freeze(JSON.parse(canonicalize(await signer.approvedTasks.readReviewed(call.callId, options.params))) as Evidence);
    if (evidence.callId !== call.callId || canonicalize(evidence.task) !== canonicalize(options.params.task)) {
      throw new Error("Reviewed role execution evidence mismatch");
    }
    // Keep failed/uncertain custody attempts consumed too. A new user request
    // obtains a new Host call; never automatically replay the same approval.
    if (consumed.has(call.callId) || consumed.size >= 4096) throw new Error("Reviewed signing call already consumed or session exhausted");
    consumed.add(call.callId);
    // request is already the Kit-owned, authenticated role-material snapshot;
    // freeze that snapshot once rather than reserializing the full batch.
    const format = options.format ?? "associated";
    const material = freeze({format,request:options.request,
      policyMaterial:options.policyMaterial});
    const native = options.native;
    const raws: string[] = [], detached: string[][] = [], items = format === "raw" ? options.request.txraws : options.request.inputs;
    if (!Array.isArray(items) || items.length > (format === "raw" ? 32 : 31) ||
        (format === "raw" && items.length === 0)) throw new Error("Invalid Reviewed role transaction count");
    const count = format === "raw" ? items.length : items.length + 1;
    for (let index = 0; index < count; index++) {
      await options.assertAuthority();
      // A canceled/replaced Host call cannot authorize another parent/child.
      await signer.approvedTasks.readReviewed(call.callId, options.params);
      const stage = object(JSON.parse(await native.execute("prepareReviewedStage", JSON.stringify({
        format, request: options.request, publicKey: options.primary.publicKey,
        transactionIndex: index, previousTransactions: format === "raw" ? [] : raws, resolvedOutputs: options.policyMaterial.resolvedOutputs,
      }))));
      const inputs = stage.inputs, digests = stage.digests, indexes = stage.signingInputIndexes;
      if (stage.format !== format || stage.transactionIndex !== index || stage.publicKey !== options.primary.publicKey ||
          !Array.isArray(inputs) || !Array.isArray(digests) || !Array.isArray(indexes) || digests.length !== indexes.length) {
        throw new Error("Reviewed role stage identity mismatch");
      }
      const engineTasks = stage.signingTasks;
      if (engineTasks !== undefined && (!Array.isArray(engineTasks) || engineTasks.length !== digests.length)) {
        throw new Error("Reviewed input signing tasks missing");
      }
      const tasks = digests.map((digest, n): TbcReviewedInputSigningTask => {
        const inputIndex = indexes[n], input = object(inputs[inputIndex]);
        const selected = input.signingPublicKey === undefined ? options.primary : options.roles[0]?.account;
        if (!selected || !Number.isSafeInteger(inputIndex) || inputIndex < 0 ||
            typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) throw new Error("Invalid Reviewed signing input");
        const publicKey = input.signingPublicKey ?? options.primary.publicKey;
        if (typeof publicKey !== "string" || ![selected.publicKey, selected.publicKey.slice(2)].includes(publicKey) ||
            (input.signingPublicKey !== undefined && (options.roles[0]?.role !== "coin-admin" || input.scriptSigType !== "tbc20-stablecoin"))) {
          throw new Error("Reviewed input account binding mismatch");
        }
        const algorithm = publicKey.length === 64 ? "secp256k1-schnorr" : "secp256k1-ecdsa";
        if (engineTasks !== undefined && canonicalize(engineTasks[n]) !== canonicalize({inputIndex,digest,publicKey,algorithm})) {
          throw new Error("Reviewed Engine signing task mismatch");
        }
        if (input.signingPublicKey !== undefined && engineTasks === undefined) throw new Error("Reviewed administrator task missing");
        return Object.freeze({inputIndex,accountId:selected.accountId,publicKey,digest,algorithm});
      });
      freeze(stage);
      await options.assertAuthority();
      await signer.approvedTasks.readReviewed(call.callId, options.params);
      const signatures = await signer.signStage(Object.freeze({evidence,tasks:Object.freeze(tasks),transactionIndex:index,stage,material}), call);
      if (!Array.isArray(signatures) || signatures.length !== tasks.length ||
          signatures.some(s => typeof s !== "string" || !/^[0-9a-f]{128}$/u.test(s))) throw new Error("Invalid Reviewed compact signatures");
      await options.assertAuthority();
      await signer.approvedTasks.readReviewed(call.callId, options.params);
      const finalized = object(JSON.parse(await native.execute("finalizeReviewedStage", JSON.stringify({stage,signatures,signatureEncoding:"compact64"}))));
      if (typeof finalized.txraw !== "string") throw new Error("Invalid Reviewed finalized transaction");
      if (format === "raw") {
        if (finalized.txraw !== items[index] || !Array.isArray(finalized.sigs) ||
            finalized.sigs.length !== inputs.length || finalized.sigs.some(signature =>
              typeof signature !== "string" || !/^(?:[0-9a-f]{2})+$/u.test(signature) || signature.length > 1_024)) {
          throw new Error("Invalid Reviewed detached signature result");
        }
        detached.push(finalized.sigs as string[]);
      }
      raws.push(finalized.txraw);
    }
    return freeze({transactions:raws,...(format === "raw" ? {detachedSignatures:detached} : {})});
  };
}
