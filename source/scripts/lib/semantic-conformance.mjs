import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalize } from "./canonical-json.mjs";
import { readJson } from "./repository.mjs";
import { validateProviderSessionSnapshot } from "./provider-session-conformance.mjs";

function sortedUnique(values, label, expectedCount) {
  const unique = new Set(values);
  if (values.length !== expectedCount || unique.size !== expectedCount) {
    throw new Error(
      `${label} expected ${expectedCount} unique values, received ${values.length}/${unique.size}`,
    );
  }
  return [...unique].sort();
}

function assertSameSet(left, right, label) {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  if (JSON.stringify(leftSorted) !== JSON.stringify(rightSorted)) {
    throw new Error(
      `${label} differs: ${JSON.stringify(leftSorted)} != ${JSON.stringify(rightSorted)}`,
    );
  }
}

function containsObjectKey(value, expectedKey) {
  if (Array.isArray(value)) {
    return value.some((item) => containsObjectKey(item, expectedKey));
  }
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) =>
      key === expectedKey || containsObjectKey(child, expectedKey),
  );
}

export function normalizeForbiddenFieldName(name) {
  return name
    .replace(/[A-Z]/g, (character) => character.toLowerCase())
    .replaceAll(/[_\-.]/g, "");
}

function escapeJsonPointerSegment(segment) {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function findForbiddenFields(value, forbiddenNames) {
  const forbidden = new Set(
    forbiddenNames.map((name) => normalizeForbiddenFieldName(name)),
  );
  const hits = [];

  function visit(current, pointer) {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${pointer}/${index}`));
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      const childPointer = `${pointer}/${escapeJsonPointerSegment(key)}`;
      if (forbidden.has(normalizeForbiddenFieldName(key))) {
        hits.push(childPointer);
      }
      visit(child, childPointer);
    }
  }

  visit(value, "");
  return hits;
}

export function projectApprovalRequester(context) {
  return {
    transport: context.transport,
    origin: context.origin,
    topOrigin: context.topOrigin,
    frame: context.frame,
  };
}

export function validateTrustedContextSemantics(context) {
  for (const field of ["origin", "topOrigin"]) {
    let parsed;
    try {
      parsed = new URL(context[field]);
    } catch {
      throw new Error(`NON_CANONICAL_ORIGIN: ${field}`);
    }
    if (parsed.origin !== context[field]) {
      throw new Error(`NON_CANONICAL_ORIGIN: ${field}`);
    }
  }
  if (context.frame === "top" && context.origin !== context.topOrigin) {
    throw new Error("TOP_FRAME_ORIGIN_MISMATCH");
  }
  if (
    (context.transport === "webview" || context.transport === "extension") &&
    !context.navigationId
  ) {
    throw new Error("NAVIGATION_ID_REQUIRED");
  }
  if (context.transport === "remote" && "navigationId" in context) {
    throw new Error("NAVIGATION_ID_FORBIDDEN");
  }
  return context;
}

function findCaveat(permission, type) {
  return permission.caveats.find((caveat) => caveat.type === type);
}

export function validatePermissionStoreChange(change) {
  for (const permission of change.permissions) {
    if (permission.invoker !== change.scope.origin) {
      throw new Error(`PERMISSION_ORIGIN_MISMATCH: ${permission.id}`);
    }
    const chainCaveat = findCaveat(permission, "restrictChains");
    if (
      !chainCaveat ||
      chainCaveat.value.length !== 1 ||
      chainCaveat.value[0] !== change.scope.chainId
    ) {
      throw new Error(`CHAIN_SCOPE_MISMATCH: ${permission.id}`);
    }
    const accountCaveat = findCaveat(permission, "restrictAccounts");
    if (
      !accountCaveat ||
      accountCaveat.value.some(
        (accountId) => !accountId.startsWith(`${change.scope.chainId}:`),
      )
    ) {
      throw new Error(`ACCOUNT_SCOPE_MISMATCH: ${permission.id}`);
    }
  }
  return change;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameJson(left, right) {
  return canonicalize(left) === canonicalize(right);
}

function compactSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid CompactSize value: ${value}`);
  }
  if (value < 0xfd) return Buffer.from([value]);
  if (value <= 0xffff) {
    const encoded = Buffer.alloc(3);
    encoded[0] = 0xfd;
    encoded.writeUInt16LE(value, 1);
    return encoded;
  }
  if (value <= 0xffffffff) {
    const encoded = Buffer.alloc(5);
    encoded[0] = 0xfe;
    encoded.writeUInt32LE(value, 1);
    return encoded;
  }
  throw new RangeError(`CompactSize exceeds uint32: ${value}`);
}

function typedDataDigest(envelope) {
  const magic = Buffer.from("TBC Signed Typed Data:\n", "utf8");
  const body = Buffer.from(canonicalize(envelope), "utf8");
  const payload = Buffer.concat([
    compactSize(magic.length),
    magic,
    compactSize(body.length),
    body,
  ]);
  const first = createHash("sha256").update(payload).digest();
  return createHash("sha256").update(first).digest("hex");
}

function pointerSegments(pointer) {
  if (!/^\/message\/[A-Za-z][A-Za-z0-9_]{0,63}$/.test(pointer)) {
    throw new Error("DEFERRED_TARGET_POINTER_INVALID");
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function pointerValue(value, pointer) {
  return pointerSegments(pointer).reduce((current, segment) => {
    if (!current || typeof current !== "object" || !(segment in current)) {
      throw new Error("DEFERRED_TARGET_POINTER_INVALID");
    }
    return current[segment];
  }, value);
}

function replacePointer(value, pointer, replacement) {
  const clone = structuredClone(value);
  const segments = pointerSegments(pointer);
  const key = segments.pop();
  const parent = segments.reduce((current, segment) => {
    if (!current || typeof current !== "object" || !(segment in current)) {
      throw new Error("DEFERRED_TARGET_POINTER_INVALID");
    }
    return current[segment];
  }, clone);
  if (!parent || typeof parent !== "object" || !(key in parent)) {
    throw new Error("DEFERRED_TARGET_POINTER_INVALID");
  }
  parent[key] = structuredClone(replacement);
  return clone;
}

function applyJsonPointerMutation(value, pointer, replacement) {
  if (!pointer.startsWith("/")) throw new Error(`Invalid mutation: ${pointer}`);
  const clone = structuredClone(value);
  const segments = pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  const key = segments.pop();
  const parent = segments.reduce((current, segment) => current[segment], clone);
  parent[key] = structuredClone(replacement);
  return clone;
}

function collectBindingPointers(value, pointer = "") {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectBindingPointers(item, `${pointer}/${index}`),
    );
  }
  if (!value || typeof value !== "object") return [];
  if (
    Object.keys(value).length === 1 &&
    value.$tbcBinding === "unresolved"
  ) {
    return [pointer];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    collectBindingPointers(
      child,
      `${pointer}/${escapeJsonPointerSegment(key)}`,
    ),
  );
}

function expectedSourceValue(output, bundle) {
  if (!bundle || !Array.isArray(bundle.transactions)) {
    throw new Error("DEFERRED_SOURCE_NOT_FINALIZED");
  }
  if (output === "transactionIds") {
    return bundle.transactions.map((transaction) => transaction.txid);
  }
  if (output === "primaryTransactionId") {
    const primary = bundle.transactions.filter(
      (transaction) => transaction.role === "primary",
    );
    if (primary.length !== 1) {
      throw new Error("DEFERRED_SOURCE_NOT_FINALIZED");
    }
    return primary[0].txid;
  }
  if (output.startsWith("artifacts.")) {
    const key = output.slice("artifacts.".length);
    const artifact = bundle.artifacts?.[key];
    if (!artifact) throw new Error("DEFERRED_SOURCE_NOT_FINALIZED");
    return artifact;
  }
  throw new Error("DEFERRED_SOURCE_UNDECLARED");
}

function expectedTargetType(sourceOutput) {
  return sourceOutput === "transactionIds" ? "bytes32[]" : "bytes32";
}

function typeFieldForTarget(step, target) {
  const [root, fieldName] = pointerSegments(target);
  if (root !== "message") throw new Error("DEFERRED_TARGET_POINTER_INVALID");
  const fields = step.data.types[step.data.primaryType];
  if (!Array.isArray(fields)) throw new Error("DEFERRED_TARGET_TYPE_MISMATCH");
  const matches = fields.filter((field) => field.name === fieldName);
  if (matches.length !== 1) throw new Error("DEFERRED_TARGET_TYPE_MISMATCH");
  return matches[0].type;
}

export function validateWorkflowPlanSemantics(request, plan) {
  const stepById = new Map();
  for (const step of request.steps) {
    if (stepById.has(step.id)) throw new Error("WORKFLOW_STEP_DUPLICATE");
    stepById.set(step.id, step);
  }
  if (!sameJson(plan.payload.stepOrder, request.steps.map((step) => step.id))) {
    throw new Error("WORKFLOW_STEP_ORDER_MISMATCH");
  }
  const order = new Map(
    plan.payload.stepOrder.map((stepId, index) => [stepId, index]),
  );
  for (const step of request.steps) {
    for (const dependency of step.dependsOn) {
      if (!stepById.has(dependency)) {
        throw new Error("WORKFLOW_SOURCE_UNDECLARED");
      }
      if (order.get(dependency) >= order.get(step.id)) {
        throw new Error("WORKFLOW_DAG_CYCLE");
      }
    }
  }

  const requestHash = sha256Hex(Buffer.from(canonicalize(request), "utf8"));
  if (plan.payload.requestHash !== requestHash) {
    throw new Error("WORKFLOW_REQUEST_HASH_MISMATCH");
  }
  if (
    plan.payload.chainId !== request.chainId ||
    plan.payload.accountId !== `${request.chainId}:${request.from}`
  ) {
    throw new Error("WORKFLOW_ACCOUNT_SCOPE_MISMATCH");
  }
  if (
    (request.maxTotalFee !== undefined &&
      plan.payload.maxTotalFee !== request.maxTotalFee) ||
    BigInt(plan.payload.totalFee) > BigInt(plan.payload.maxTotalFee)
  ) {
    throw new Error("WORKFLOW_FEE_LIMIT_MISMATCH");
  }
  if (
    request.expiresAt !== undefined &&
    Date.parse(plan.payload.expiresAt) > Date.parse(request.expiresAt)
  ) {
    throw new Error("WORKFLOW_EXPIRY_MISMATCH");
  }

  const transactionSteps = request.steps.filter(
    (step) => step.kind === "transaction",
  );
  const transactionPlanIds = plan.payload.transactionPlans.map(
    (entry) => entry.stepId,
  );
  if (
    new Set(transactionPlanIds).size !== transactionPlanIds.length ||
    !sameJson(transactionPlanIds, transactionSteps.map((step) => step.id))
  ) {
    throw new Error("WORKFLOW_TRANSACTION_PLAN_MISMATCH");
  }
  for (const entry of plan.payload.transactionPlans) {
    if (
      entry.plan.payload.chainId !== plan.payload.chainId ||
      entry.plan.payload.accountId !== plan.payload.accountId
    ) {
      throw new Error("WORKFLOW_TRANSACTION_PLAN_MISMATCH");
    }
    if (
      Date.parse(entry.plan.payload.expiresAt) >
      Date.parse(plan.payload.expiresAt)
    ) {
      throw new Error("WORKFLOW_EXPIRY_MISMATCH");
    }
    const actualPlanHash = sha256Hex(
      Buffer.from(canonicalize(entry.plan.payload), "utf8"),
    );
    if (actualPlanHash !== entry.plan.planHash) {
      throw new Error("WORKFLOW_TRANSACTION_PLAN_HASH_MISMATCH");
    }
  }
  const plannedTotalFee = plan.payload.transactionPlans.reduce(
    (total, entry) =>
      total +
      entry.plan.payload.transactions.reduce(
        (stepTotal, transaction) => stepTotal + BigInt(transaction.fee),
        0n,
      ),
    0n,
  );
  if (BigInt(plan.payload.totalFee) !== plannedTotalFee) {
    throw new Error("WORKFLOW_FEE_LIMIT_MISMATCH");
  }
  const transactionPlanByStepId = new Map(
    plan.payload.transactionPlans.map((entry) => [entry.stepId, entry.plan]),
  );
  const expectedPreviewSteps = request.steps.map((step) => {
    if (step.kind === "transaction") {
      return {
        id: step.id,
        kind: step.kind,
        dependsOn: step.dependsOn,
        assetFlows:
          transactionPlanByStepId.get(step.id)?.payload.preview.assetFlows,
      };
    }
    return {
      id: step.id,
      kind: step.kind,
      dependsOn: step.dependsOn,
      typedData: step.data,
    };
  });
  if (
    plan.payload.preview.operationKind !== "workflow" ||
    !sameJson(plan.payload.preview.steps, expectedPreviewSteps) ||
    plan.payload.preview.totalFee !== plan.payload.totalFee
  ) {
    throw new Error("WORKFLOW_PREVIEW_MISMATCH");
  }

  const immediateTaskIds = plan.payload.immediateSigningTasks.map(
    (entry) => entry.task.taskId,
  );
  if (new Set(immediateTaskIds).size !== immediateTaskIds.length) {
    throw new Error("WORKFLOW_SIGNING_TASK_DUPLICATE");
  }
  const plannedTransactionTasks = plan.payload.transactionPlans.flatMap(
    (entry) =>
      entry.plan.payload.signingTasks.map((task) => ({
        stepId: entry.stepId,
        task,
      })),
  );
  for (const planned of plannedTransactionTasks) {
    if (
      !plan.payload.immediateSigningTasks.some((candidate) =>
        sameJson(candidate, planned),
      )
    ) {
      throw new Error("WORKFLOW_IMMEDIATE_TASK_MISMATCH");
    }
  }
  for (const entry of plan.payload.immediateSigningTasks) {
    const step = stepById.get(entry.stepId);
    if (!step) throw new Error("WORKFLOW_IMMEDIATE_TASK_MISMATCH");
    if (entry.task.purpose === "transaction") {
      if (
        step.kind !== "transaction" ||
        "envelope" in entry ||
        !plannedTransactionTasks.some((planned) => sameJson(planned, entry))
      ) {
        throw new Error("WORKFLOW_IMMEDIATE_TASK_MISMATCH");
      }
      continue;
    }
    if (
      entry.task.purpose !== "typedData" ||
      step.kind !== "typedData" ||
      step.bindings.length !== 0 ||
      !entry.envelope
    ) {
      throw new Error("WORKFLOW_IMMEDIATE_TASK_MISMATCH");
    }
    const projectedDomain = Object.fromEntries(
      Object.keys(step.data.domain).map((key) => [key, entry.envelope.domain[key]]),
    );
    const projectedTypedData = {
      domain: projectedDomain,
      types: entry.envelope.types,
      primaryType: entry.envelope.primaryType,
      message: entry.envelope.message,
    };
    if (
      !sameJson(projectedTypedData, step.data) ||
      entry.envelope.domain.chainId !== plan.payload.chainId ||
      (entry.envelope.domain.origin !== undefined &&
        entry.envelope.domain.origin !== entry.task.origin) ||
      entry.task.digest !== typedDataDigest(entry.envelope) ||
      entry.task.accountId !== plan.payload.accountId
    ) {
      throw new Error("WORKFLOW_IMMEDIATE_TASK_MISMATCH");
    }
  }
  const immediateTypedStepIds = plan.payload.immediateSigningTasks
    .filter((entry) => entry.task.purpose === "typedData")
    .map((entry) => entry.stepId);
  const expectedImmediateTypedStepIds = request.steps
    .filter((step) => step.kind === "typedData" && step.bindings.length === 0)
    .map((step) => step.id);
  if (!sameJson(immediateTypedStepIds, expectedImmediateTypedStepIds)) {
    throw new Error("WORKFLOW_IMMEDIATE_TASK_MISMATCH");
  }

  const deferredTaskIds = plan.payload.deferredSigningTasks.map(
    (task) => task.taskId,
  );
  if (new Set(deferredTaskIds).size !== deferredTaskIds.length) {
    throw new Error("WORKFLOW_SIGNING_TASK_DUPLICATE");
  }
  if (deferredTaskIds.some((taskId) => immediateTaskIds.includes(taskId))) {
    throw new Error("WORKFLOW_SIGNING_TASK_DUPLICATE");
  }
  const requestBindings = request.steps.flatMap((step) =>
    step.kind === "typedData"
      ? step.bindings.map((binding) => ({ ...binding, targetStepId: step.id }))
      : [],
  );
  if (requestBindings.length !== plan.payload.deferredSigningTasks.length) {
    throw new Error("DEFERRED_SOURCE_UNDECLARED");
  }
  const expectedPreviewBindings = plan.payload.deferredSigningTasks.map(
    (task) => ({
      sourceStepId: task.source.stepId,
      sourceOutput: task.source.output,
      target: task.target,
      targetType: task.targetType,
    }),
  );
  if (!sameJson(plan.payload.preview.bindings, expectedPreviewBindings)) {
    throw new Error("WORKFLOW_PREVIEW_MISMATCH");
  }
  if (
    expectedPreviewBindings.length > 0 &&
    !plan.payload.preview.warnings.includes("DYNAMIC_BINDING")
  ) {
    throw new Error("WORKFLOW_PREVIEW_MISMATCH");
  }
  for (const task of plan.payload.deferredSigningTasks) {
    const targetStep = stepById.get(task.targetStepId);
    const sourceStep = stepById.get(task.source.stepId);
    if (!sourceStep || sourceStep.kind !== "transaction") {
      throw new Error("DEFERRED_SOURCE_UNDECLARED");
    }
    if (!targetStep || targetStep.kind !== "typedData") {
      throw new Error("DEFERRED_TARGET_POINTER_INVALID");
    }
    if (!targetStep.dependsOn.includes(task.source.stepId)) {
      throw new Error("DEFERRED_SOURCE_NOT_DEPENDENCY");
    }
    if (!sameJson(pointerValue(targetStep.data, task.target), {
      $tbcBinding: "unresolved",
    })) {
      throw new Error("DEFERRED_TARGET_POINTER_INVALID");
    }
    const approvedBinding = requestBindings.filter(
      (binding) =>
        binding.targetStepId === task.targetStepId &&
        binding.target === task.target &&
        sameJson(binding.source, task.source),
    );
    if (approvedBinding.length !== 1) {
      throw new Error("DEFERRED_SOURCE_UNDECLARED");
    }
    if (
      task.targetType !== expectedTargetType(task.source.output) ||
      task.targetType !== typeFieldForTarget(targetStep, task.target)
    ) {
      throw new Error("DEFERRED_TARGET_TYPE_MISMATCH");
    }
    const placeholders = collectBindingPointers(task.envelopeTemplate);
    if (placeholders.length !== 1 || placeholders[0] !== task.target) {
      throw new Error("DEFERRED_EXTRA_REPLACEMENT");
    }
    const projectedDomain = Object.fromEntries(
      Object.keys(targetStep.data.domain).map((key) => [
        key,
        task.envelopeTemplate.domain[key],
      ]),
    );
    const projectedTypedData = {
      domain: projectedDomain,
      types: task.envelopeTemplate.types,
      primaryType: task.envelopeTemplate.primaryType,
      message: task.envelopeTemplate.message,
    };
    if (!sameJson(projectedTypedData, targetStep.data)) {
      throw new Error("DEFERRED_ENVELOPE_TEMPLATE_MISMATCH");
    }
    if (task.envelopeTemplate.domain.chainId !== plan.payload.chainId) {
      throw new Error("DEFERRED_ENVELOPE_TEMPLATE_MISMATCH");
    }
  }

  const actualPlanHash = sha256Hex(
    Buffer.from(canonicalize(plan.payload), "utf8"),
  );
  if (actualPlanHash !== plan.workflowPlanHash) {
    throw new Error("WORKFLOW_PLAN_HASH_MISMATCH");
  }
  return plan;
}

export function validateDeferredDerivation(
  request,
  plan,
  derivation,
  finalizedOutputs,
) {
  const deferredTask = plan.payload.deferredSigningTasks.find(
    (task) => task.taskId === derivation.planTaskId,
  );
  if (!deferredTask) throw new Error("DEFERRED_SOURCE_UNDECLARED");
  if (
    !sameJson(deferredTask.source, derivation.source) ||
    deferredTask.targetStepId !== derivation.targetStepId ||
    deferredTask.target !== derivation.target ||
    deferredTask.purpose !== derivation.purpose
  ) {
    throw new Error("DEFERRED_SOURCE_UNDECLARED");
  }
  if (
    deferredTask.targetType !== expectedTargetType(deferredTask.source.output) ||
    derivation.targetType !== deferredTask.targetType
  ) {
    throw new Error("DEFERRED_TARGET_TYPE_MISMATCH");
  }
  const sourceStep = request.steps.find(
    (step) => step.id === deferredTask.source.stepId,
  );
  const targetStep = request.steps.find(
    (step) => step.id === deferredTask.targetStepId,
  );
  if (!sourceStep || sourceStep.kind !== "transaction") {
    throw new Error("DEFERRED_SOURCE_UNDECLARED");
  }
  if (!targetStep || targetStep.kind !== "typedData") {
    throw new Error("DEFERRED_TARGET_POINTER_INVALID");
  }
  if (!targetStep.dependsOn.includes(sourceStep.id)) {
    throw new Error("DEFERRED_SOURCE_NOT_DEPENDENCY");
  }

  validateWorkflowPlanSemantics(request, plan);
  const sourcePlan = plan.payload.transactionPlans.find(
    (entry) => entry.stepId === deferredTask.source.stepId,
  );
  const finalized = finalizedOutputs[deferredTask.source.stepId];
  if (
    !sourcePlan ||
    !finalized ||
    finalized.requestHash !== sourcePlan.plan.payload.requestHash ||
    finalized.chainId !== plan.payload.chainId ||
    finalized.from !== request.from
  ) {
    throw new Error("DEFERRED_SOURCE_NOT_FINALIZED");
  }
  const sourceValue = expectedSourceValue(
    deferredTask.source.output,
    finalized,
  );
  if (!sameJson(sourceValue, derivation.sourceValue)) {
    throw new Error("DEFERRED_SOURCE_VALUE_MISMATCH");
  }
  const resolved = replacePointer(
    deferredTask.envelopeTemplate,
    deferredTask.target,
    sourceValue,
  );
  if (!sameJson(resolved, derivation.resolvedEnvelope)) {
    throw new Error("DEFERRED_EXTRA_REPLACEMENT");
  }
  const canonical = canonicalize(resolved);
  if (derivation.canonical !== canonical) {
    throw new Error("DEFERRED_CANONICAL_MISMATCH");
  }
  const digest = typedDataDigest(resolved);
  if (derivation.digest !== digest) {
    throw new Error("DEFERRED_DIGEST_MISMATCH");
  }
  const concreteTask = {
    taskId: deferredTask.taskId,
    purpose: "typedData",
    algorithm: "secp256k1-recoverable-ecdsa-sha256d",
    digest,
    signatureEncoding: "compact65-recoverable",
    origin: deferredTask.envelopeTemplate.domain.origin,
    accountId: plan.payload.accountId,
    publicKey: deferredTask.publicKey,
  };
  if (!sameJson(concreteTask, derivation.concreteTask)) {
    throw new Error("DEFERRED_CONCRETE_TASK_MISMATCH");
  }
  return derivation;
}

export function validateWorkflowTerminalFailure(failure) {
  for (const forbidden of ["steps", "signature", "signatures", "result"]) {
    if (containsObjectKey(failure, forbidden)) {
      throw new Error("WORKFLOW_PARTIAL_RESULT_FORBIDDEN");
    }
  }
  return failure;
}

const EXPECTED_METHOD_PATHS = {
  "session-read": {
    methods: ["tbc_chainId"],
    states: ["initializing", "validating", "completed"],
  },
  "permission-read": {
    methods: ["wallet_getPermissions"],
    states: ["initializing", "validating", "authorizing", "completed"],
  },
  "account-read": {
    methods: ["tbc_accounts", "tbc_getAccount", "tbc_getCapabilities"],
    states: [
      "initializing",
      "validating",
      "authorizing",
      "resolving",
      "completed",
    ],
  },
  "permission-request": {
    methods: ["tbc_requestAccounts", "wallet_requestPermissions"],
    states: [
      "initializing",
      "validating",
      "authorizing",
      "resolving",
      "approval",
      "committing",
      "completed",
    ],
  },
  "switch-chain": {
    methods: ["tbc_switchChain"],
    states: [
      "initializing",
      "validating",
      "authorizing",
      "approval",
      "committing",
      "completed",
    ],
  },
  "message-signing": {
    methods: ["tbc_signMessage", "tbc_signTypedData"],
    states: [
      "initializing",
      "validating",
      "authorizing",
      "resolving",
      "approval",
      "signing",
      "completed",
    ],
  },
  "sign-transaction": {
    methods: ["tbc_signTransaction", "tbc_signPreparedTransaction"],
    states: [
      "initializing",
      "validating",
      "authorizing",
      "resolving",
      "planning",
      "approval",
      "signing",
      "finalizing",
      "completed",
    ],
  },
  "send-transaction": {
    methods: ["tbc_sendTransaction", "tbc_sendPreparedTransaction"],
    states: [
      "initializing",
      "validating",
      "authorizing",
      "resolving",
      "planning",
      "approval",
      "signing",
      "finalizing",
      "broadcasting",
      "reconciliation",
      "completed",
    ],
  },
  "sign-workflow": {
    methods: ["tbc_signWorkflow", "tbc_signPreparedWorkflow"],
    states: [
      "initializing",
      "validating",
      "authorizing",
      "resolving",
      "planning",
      "approval",
      "signing",
      "finalizing",
      "completed",
    ],
  },
  "send-workflow": {
    methods: ["tbc_sendWorkflow", "tbc_sendPreparedWorkflow"],
    states: [
      "initializing",
      "validating",
      "authorizing",
      "resolving",
      "planning",
      "approval",
      "signing",
      "finalizing",
      "broadcasting",
      "completed",
    ],
  },
  "wallet-action": {
    methods: ["tbc_signReviewedTransaction", "tbc_encrypt", "tbc_decrypt"],
    states: [
      "initializing",
      "validating",
      "authorizing",
      "resolving",
      "approval",
      "signing",
      "completed",
    ],
  },
  disconnect: {
    methods: ["tbc_disconnect"],
    states: [
      "initializing",
      "validating",
      "authorizing",
      "committing",
      "completed",
    ],
  },
};

function stateEffectData(root) {
  const stateRegistry = readJson(root, "registry/operation-states.json");
  return {
    stateRegistry,
    stateByName: new Map(
      stateRegistry.states.map((state) => [state.name, state]),
    ),
  };
}

export function methodCanEmit(root, methodName, operationName) {
  const { stateRegistry, stateByName } = stateEffectData(root);
  const pathDefinition = stateRegistry.methodPaths.find((entry) =>
    entry.methods.includes(methodName),
  );
  if (!pathDefinition) throw new Error(`Unknown method path: ${methodName}`);
  return pathDefinition.states.some((stateName) =>
    stateByName.get(stateName)?.allowedPortOperations.includes(operationName),
  );
}

export function runStateEffectClosure(root) {
  const methodRegistry = readJson(root, "registry/methods.json");
  const integrationPorts = readJson(root, "registry/integration-ports.json");
  const integrationSchema = readJson(root, "schemas/integration.schema.json");
  const { stateRegistry, stateByName } = stateEffectData(root);
  const operations = integrationPorts.ports.flatMap((port) =>
    port.operations.map((operation) => operation.name),
  );
  assertSameSet(
    operations,
    integrationSchema.$defs.operationName.enum,
    "state/effect operation set",
  );
  const memoryFields = Object.keys(
    integrationSchema.$defs.operationMemory.properties,
  );

  for (const state of stateRegistry.states) {
    for (const operation of state.allowedPortOperations) {
      if (!operations.includes(operation)) {
        throw new Error(`${state.name} allows unknown Port operation ${operation}`);
      }
    }
    for (const field of state.memoryRequired) {
      if (!state.memoryAllowed.includes(field)) {
        throw new Error(`${state.name} requires disallowed memory ${field}`);
      }
    }
    for (const field of state.memoryAllowed) {
      if (!memoryFields.includes(field)) {
        throw new Error(`${state.name} allows unknown memory ${field}`);
      }
    }
    if (
      state.terminal &&
      (state.allowedTransitions.length !== 0 ||
        state.allowedPortOperations.length !== 0 ||
        state.allowsContinue)
    ) {
      throw new Error(`${state.name} terminal policy allows Port or progress`);
    }
  }

  const selfTransitionStates = stateRegistry.states
    .filter((state) => state.allowedTransitions.includes(state.name))
    .map((state) => state.name);
  assertSameSet(
    selfTransitionStates,
    [
      "authorizing",
      "resolving",
      "planning",
      "approval",
      "signing",
      "finalizing",
      "broadcasting",
      "committing",
    ],
    "resolving and peer self transition set",
  );
  const continueStates = stateRegistry.states
    .filter((state) => state.allowsContinue)
    .map((state) => state.name);
  assertSameSet(
    continueStates,
    ["validating", "planning", "finalizing"],
    "continue state set",
  );
  const clockStates = stateRegistry.states
    .filter((state) => state.allowedPortOperations.includes("clock.now"))
    .map((state) => state.name);
  assertSameSet(
    clockStates,
    [
      "initializing",
      "planning",
      "approval",
      "signing",
      "finalizing",
      "broadcasting",
      "committing",
    ],
    "clock state set",
  );
  const permissionCommitStates = stateRegistry.states
    .filter((state) =>
      state.allowedPortOperations.includes("permissionStore.commit"),
    )
    .map((state) => state.name);
  assertSameSet(
    permissionCommitStates,
    ["committing"],
    "permission commit state set",
  );

  const categoryNames = stateRegistry.methodPaths.map((entry) => entry.category);
  assertSameSet(
    categoryNames,
    Object.keys(EXPECTED_METHOD_PATHS),
    "method path categories",
  );
  const pathMethods = [];
  for (const pathDefinition of stateRegistry.methodPaths) {
    const expected = EXPECTED_METHOD_PATHS[pathDefinition.category];
    if (!sameJson(pathDefinition.methods, expected.methods)) {
      throw new Error(`${pathDefinition.category} method set differs`);
    }
    if (!sameJson(pathDefinition.states, expected.states)) {
      const requiredState = expected.states.find(
        (state) => !pathDefinition.states.includes(state),
      );
      throw new Error(
        `${pathDefinition.category} path differs${
          requiredState ? `; requires ${requiredState}` : ""
        }`,
      );
    }
    pathMethods.push(...pathDefinition.methods);
    for (let index = 0; index < pathDefinition.states.length - 1; index += 1) {
      const from = pathDefinition.states[index];
      const to = pathDefinition.states[index + 1];
      if (!stateByName.get(from)?.allowedTransitions.includes(to)) {
        throw new Error(
          `${pathDefinition.category} path uses illegal transition ${from} -> ${to}`,
        );
      }
    }
  }
  assertSameSet(
    pathMethods,
    methodRegistry.methods.map((method) => method.name),
    "state/effect method coverage",
  );
  for (const category of [
    "session-read",
    "permission-read",
    "account-read",
    "permission-request",
    "switch-chain",
    "message-signing",
    "sign-transaction",
    "sign-workflow",
    "disconnect",
  ]) {
    for (const methodName of EXPECTED_METHOD_PATHS[category].methods) {
      if (methodCanEmit(root, methodName, "broadcast.submit")) {
        throw new Error(`${category} illegally emits broadcast.submit`);
      }
    }
  }
  if (!methodCanEmit(root, "tbc_sendTransaction", "broadcast.submit")) {
    throw new Error("send-transaction cannot emit broadcast.submit");
  }
  if (!methodCanEmit(root, "tbc_sendWorkflow", "broadcast.submitBatch")) {
    throw new Error("send-workflow cannot emit broadcast.submitBatch");
  }

  const committingRefs =
    integrationSchema.$defs.committingCheckpointData.oneOf?.map(
      (branch) => branch.$ref,
    ) ?? [];
  assertSameSet(
    committingRefs,
    [
      "#/$defs/permissionStoreCommittingCheckpointData",
      "#/$defs/providerSessionCommittingCheckpointData",
    ],
    "committing checkpoint kinds",
  );

  return {
    methods: methodRegistry.methods.length,
    categories: stateRegistry.methodPaths.length,
    states: stateRegistry.states.length,
    terminalStates: stateRegistry.states.filter((state) => state.terminal).length,
    ports: integrationPorts.ports.length,
    operations: operations.length,
    continueStates: continueStates.length,
    selfTransitionStates: selfTransitionStates.length,
    committingKinds: committingRefs.length,
    unreachableMethods: [],
    illegalEffects: [],
  };
}

export function runSemanticConformance(root) {
  const stateEffect = runStateEffectClosure(root);
  const methods = readJson(root, "registry/methods.json").methods.map(
    (method) => method.name,
  );
  const events = readJson(root, "registry/events.json").events.map(
    (event) => event.name,
  );
  const intents = readJson(root, "test-vectors/intents.json").vectors.map(
    (vector) => vector.request.intent.type,
  );
  const legacyFlags = readJson(
    root,
    "test-vectors/legacy-mapping.json",
  ).vectors.map((vector) => vector.flag);
  sortedUnique(methods, "methods", 22);
  sortedUnique(events, "events", 6);
  sortedUnique(intents, "intents", 14);
  sortedUnique(legacyFlags, "legacy flags", 18);

  const registry = readJson(root, "registry/integration-ports.json");
  const integrationSchema = readJson(root, "schemas/integration.schema.json");
  const integration = readJson(root, "test-vectors/integration.json");
  const provider = readJson(root, "test-vectors/provider.json");
  const approval = readJson(root, "test-vectors/approval.json");
  const permissionVectors = readJson(root, "test-vectors/permissions.json");
  const workflowVectors = readJson(root, "test-vectors/workflow.json");
  for (const snapshot of [
    provider.providerSessions.sessionA,
    provider.providerSessions.sessionB,
  ]) {
    validateProviderSessionSnapshot(snapshot, {
      sessionId: snapshot.scope.sessionId,
    });
  }
  const ports = registry.ports.map((port) => port.name);
  const operations = registry.ports.flatMap((port) =>
    port.operations.map((operation) => operation.name),
  );

  sortedUnique(ports, "Host Ports", 11);
  sortedUnique(operations, "Host Port operations", 15);
  sortedUnique(registry.errorNames, "Port errors", 9);
  sortedUnique(registry.validationPhases, "validation phases", 4);
  sortedUnique(registry.violationCodes, "violation codes", 26);
  sortedUnique(registry.forbiddenFieldNames, "forbidden fields", 14);

  assertSameSet(
    registry.errorNames,
    integrationSchema.$defs.portErrorName.enum,
    "Port error registry/schema",
  );
  assertSameSet(
    registry.validationPhases,
    integrationSchema.$defs.validationPhase.enum,
    "validation phase registry/schema",
  );
  assertSameSet(
    registry.violationCodes,
    integrationSchema.$defs.violationCode.enum,
    "violation registry/schema",
  );
  assertSameSet(
    registry.forbiddenFieldNames,
    integrationSchema.$defs.forbiddenFieldName.enum,
    "forbidden field registry/schema",
  );
  assertSameSet(
    operations,
    integration.portExamples.map((example) => example.operation),
    "Port operation/example coverage",
  );
  assertSameSet(
    registry.errorNames,
    integration.portFailureExamples.map(
      (example) => example.response.error.name,
    ),
    "Port error/example coverage",
  );

  const normalizedForbidden = registry.forbiddenFieldNames.map((name) =>
    normalizeForbiddenFieldName(name),
  );
  if (new Set(normalizedForbidden).size !== registry.forbiddenFieldNames.length) {
    throw new Error("Forbidden fields collide after normalization");
  }
  for (const name of registry.forbiddenFieldNames) {
    const aliases = [
      name,
      name.toUpperCase(),
      name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
      name.replace(/[A-Z]/g, (letter) => `.${letter.toLowerCase()}`),
    ];
    for (const alias of aliases) {
      if (!normalizedForbidden.includes(normalizeForbiddenFieldName(alias))) {
        throw new Error(`Forbidden field alias is not detected: ${alias}`);
      }
    }
  }

  const fixtureBoundary = {
    canonicalTransfer: integration.canonicalTransfer,
    portData: integration.portData,
    portEnvelopeExamples: integration.portEnvelopeExamples,
    portExamples: integration.portExamples,
    coreExamples: integration.coreExamples,
  };
  const forbiddenHits = findForbiddenFields(
    fixtureBoundary,
    registry.forbiddenFieldNames,
  );
  if (forbiddenHits.length > 0) {
    throw new Error(
      `Integration fixtures contain forbidden fields: ${forbiddenHits.join(", ")}`,
    );
  }

  const restrictedNames = integration.restrictedDataPolicy.fields.map(
    ({ name }) => name,
  );
  const normalizedRestricted = restrictedNames.map((name) =>
    normalizeForbiddenFieldName(name),
  );
  if (
    new Set(normalizedRestricted).size !== restrictedNames.length ||
    integration.restrictedDataPolicy.fields.some(
      ({ allowedSchemas }) => allowedSchemas.length === 0,
    )
  ) {
    throw new Error("Restricted data allowlist is ambiguous or empty");
  }
  for (const fixture of integration.restrictedDataPolicy.ordinaryFixtures) {
    const hits = findForbiddenFields(fixture.value, [
      ...registry.forbiddenFieldNames,
      ...restrictedNames,
    ]);
    if (hits.length !== 0) {
      throw new Error(
        `Ordinary ${fixture.kind} fixture contains restricted data: ${hits.join(", ")}`,
      );
    }
  }

  const secretFailures = integration.semanticFailures.filter(
    (failure) => failure.expectedViolation === "SECRET_FIELD_PRESENT",
  );
  if (secretFailures.length !== 3) {
    throw new Error(
      `Expected 3 secret-boundary failures, received ${secretFailures.length}`,
    );
  }
  for (const failure of secretFailures) {
    const fieldName = failure.mutation.path.split("/").at(-1);
    if (!normalizedForbidden.includes(normalizeForbiddenFieldName(fieldName))) {
      throw new Error(
        `Secret failure is not scanner-detectable: ${failure.id}`,
      );
    }
  }
  if (integration.semanticFailures.length !== 10) {
    throw new Error(
      `Expected 10 semantic failures, received ${integration.semanticFailures.length}`,
    );
  }
  for (const failure of integration.semanticFailures) {
    if (!registry.violationCodes.includes(failure.expectedViolation)) {
      throw new Error(
        `Semantic failure uses an unregistered violation: ${failure.id}`,
      );
    }
  }

  const hashRegistry = readJson(root, "registry/hash-bindings.json");
  const hashBindingNames = sortedUnique(
    hashRegistry.bindings.map((binding) => binding.name),
    "hash bindings",
    18,
  );
  assertSameSet(
    hashBindingNames,
    [
      "contextHash",
      "requestHash.transaction",
      "requestHash.message",
      "requestHash.typedData",
      "requestHash.permission",
      "requestHash.switchChain",
      "requestHash.workflow",
      "snapshotHash",
      "policyHash",
      "templateHash",
      "planHash",
      "permissionProposalHash",
      "chainSwitchProposalHash",
      "workflowPlanHash",
      "operationHash",
      "bindingHash",
      "releaseFingerprint",
      "checkpointHash",
    ],
    "Draft.2 hash binding set",
  );

  const stateRegistry = readJson(root, "registry/operation-states.json");
  const stateNames = sortedUnique(
    stateRegistry.states.map((state) => state.name),
    "operation states",
    15,
  );
  const terminalStateNames = sortedUnique(
    stateRegistry.states
      .filter((state) => state.terminal)
      .map((state) => state.name),
    "terminal states",
    4,
  );
  assertSameSet(
    terminalStateNames,
    ["completed", "rejected", "failed", "cancelled"],
    "terminal state set",
  );
  const stateByName = new Map(
    stateRegistry.states.map((state) => [state.name, state]),
  );
  for (const state of stateRegistry.states) {
    for (const target of state.allowedTransitions) {
      if (!stateByName.has(target)) {
        throw new Error(`State ${state.name} targets unknown state ${target}`);
      }
    }
    if (state.terminal && state.allowedTransitions.length !== 0) {
      throw new Error(`Terminal state ${state.name} has outgoing transitions`);
    }
  }
  const pathMethods = [];
  for (const pathDefinition of stateRegistry.methodPaths) {
    pathMethods.push(...pathDefinition.methods);
    for (let index = 0; index < pathDefinition.states.length - 1; index += 1) {
      const from = pathDefinition.states[index];
      const to = pathDefinition.states[index + 1];
      if (!stateByName.get(from)?.allowedTransitions.includes(to)) {
        throw new Error(
          `Method path ${pathDefinition.category} uses illegal transition ${from} -> ${to}`,
        );
      }
    }
  }
  sortedUnique(pathMethods, "method path coverage", 22);
  assertSameSet(pathMethods, methods, "method registry/state path coverage");

  const cancellationReasons = sortedUnique(
    stateRegistry.cancellationReasons.map((entry) => entry.reason),
    "cancellation reasons",
    11,
  );
  assertSameSet(
    cancellationReasons,
    [
      "USER_REJECTED",
      "REQUEST_ABORTED",
      "REQUEST_EXPIRED",
      "SESSION_REVOKED",
      "NAVIGATION_CHANGED",
      "ORIGIN_CHANGED",
      "CHAIN_CHANGED",
      "ACCOUNT_CHANGED",
      "TRANSPORT_CLOSED",
      "SNAPSHOT_INVALIDATED",
      "PROTOCOL_RELEASE_CHANGED",
    ],
    "Draft.2 cancellation reason set",
  );
  for (const cancellation of stateRegistry.cancellationReasons) {
    if (!terminalStateNames.includes(cancellation.terminalState)) {
      throw new Error(
        `Cancellation ${cancellation.reason} targets non-terminal ${cancellation.terminalState}`,
      );
    }
  }

  for (const vector of provider.trustedContexts) {
    validateTrustedContextSemantics(vector.context);
    const actualHash = createHash("sha256")
      .update(Buffer.from(canonicalize(vector.context), "utf8"))
      .digest("hex");
    if (actualHash !== vector.contextHash) {
      throw new Error(
        `Trusted Context ${vector.id} hash differs: ${actualHash} != ${vector.contextHash}`,
      );
    }
    const requester = projectApprovalRequester(vector.context);
    if (JSON.stringify(requester) !== JSON.stringify(vector.approvalRequester)) {
      throw new Error(`Approval requester projection differs: ${vector.id}`);
    }
  }
  for (const failure of provider.trustedContextSemanticFailures) {
    try {
      validateTrustedContextSemantics(failure.context);
    } catch (error) {
      if (!error.message.includes(failure.expectedViolation)) throw error;
      continue;
    }
    throw new Error(`Trusted Context failure was accepted: ${failure.id}`);
  }

  const expectedApprovalMap = new Map([
    ["tbc_requestAccounts", "permission"],
    ["wallet_requestPermissions", "permission"],
    ["tbc_switchChain", "switchChain"],
    ["tbc_signMessage", "message"],
    ["tbc_signTypedData", "typedData"],
    ["tbc_signTransaction", "transaction"],
    ["tbc_signPreparedTransaction", "transaction"],
    ["tbc_sendTransaction", "transaction"],
    ["tbc_sendPreparedTransaction", "transaction"],
    ["tbc_signReviewedTransaction", "transaction"],
    ["tbc_encrypt", "crypto"],
    ["tbc_decrypt", "crypto"],
    ["tbc_signWorkflow", "workflow"],
    ["tbc_signPreparedWorkflow", "workflow"],
    ["tbc_sendWorkflow", "workflow"],
    ["tbc_sendPreparedWorkflow", "workflow"],
  ]);
  const registeredApprovalMethods = methods.filter((methodName) =>
    expectedApprovalMap.has(methodName),
  );
  assertSameSet(
    registeredApprovalMethods,
    [...expectedApprovalMap.keys()],
    "approval method set",
  );
  const methodEntries = readJson(root, "registry/methods.json").methods;
  for (const method of methodEntries) {
    const expectedKind = expectedApprovalMap.get(method.name) ?? null;
    if (method.operationKind !== expectedKind) {
      throw new Error(
        `Method ${method.name} operationKind differs: ${method.operationKind} != ${expectedKind}`,
      );
    }
  }
  sortedUnique(
    approval.bindings.map((vector) => vector.method),
    "approval binding method coverage",
    8,
  );
  for (const vector of approval.bindings) {
    const { payload, bindingHash } = vector.binding;
    if (payload.method !== vector.method) {
      throw new Error(`Approval vector method differs: ${vector.method}`);
    }
    if (expectedApprovalMap.get(payload.method) !== payload.operationKind) {
      throw new Error(
        `Approval binding method/kind mismatch: ${payload.method}/${payload.operationKind}`,
      );
    }
    if (payload.operationKind === "permission") {
      const sorted = [...payload.chainIds].sort();
      if (JSON.stringify(payload.chainIds) !== JSON.stringify(sorted)) {
        throw new Error(`CHAIN_IDS_NOT_SORTED: ${vector.method}`);
      }
    }
    const actualBindingHash = createHash("sha256")
      .update(Buffer.from(canonicalize(payload), "utf8"))
      .digest("hex");
    if (actualBindingHash !== bindingHash) {
      throw new Error(
        `Approval binding ${vector.method} hash differs: ${actualBindingHash} != ${bindingHash}`,
      );
    }
  }
  const previewKinds = sortedUnique(
    approval.previews.map((preview) => preview.operationKind),
    "approval preview kinds",
    6,
  );
  assertSameSet(
    previewKinds,
    ["transaction", "message", "typedData", "permission", "switchChain", "workflow"],
    "approval preview kind set",
  );
  for (const failure of approval.semanticFailures) {
    let actualViolation;
    if (failure.id === "permission-chain-ids-not-sorted") {
      const sorted = [...failure.payload.chainIds].sort();
      if (JSON.stringify(failure.payload.chainIds) !== JSON.stringify(sorted)) {
        actualViolation = "CHAIN_IDS_NOT_SORTED";
      }
    } else if (failure.id === "requester-context-projection-mismatch") {
      const expectedRequester = projectApprovalRequester(failure.context);
      if (JSON.stringify(expectedRequester) !== JSON.stringify(failure.requester)) {
        actualViolation = "REQUESTER_CONTEXT_MISMATCH";
      }
    }
    if (actualViolation !== failure.expectedViolation) {
      throw new Error(
        `Approval semantic failure ${failure.id} produced ${actualViolation}`,
      );
    }
  }

  const permissionChanges = permissionVectors.commit.params.changes;
  const permissionScopeKeys = permissionChanges.map(
    (change) => `${change.scope.origin}\0${change.scope.chainId}`,
  );
  if (
    JSON.stringify(permissionScopeKeys) !==
    JSON.stringify([...permissionScopeKeys].sort())
  ) {
    throw new Error("PERMISSION_SCOPES_NOT_SORTED");
  }
  if (new Set(permissionScopeKeys).size !== permissionScopeKeys.length) {
    throw new Error("PERMISSION_SCOPE_DUPLICATE");
  }
  for (const change of permissionChanges) validatePermissionStoreChange(change);
  for (const change of permissionVectors.proposal.payload.changes) {
    validatePermissionStoreChange(change);
  }
  const proposalHash = createHash("sha256")
    .update(
      Buffer.from(canonicalize(permissionVectors.proposal.payload), "utf8"),
    )
    .digest("hex");
  if (proposalHash !== permissionVectors.proposal.permissionProposalHash) {
    throw new Error(
      `Permission Proposal hash differs: ${proposalHash} != ${permissionVectors.proposal.permissionProposalHash}`,
    );
  }
  if (
    JSON.stringify(permissionVectors.proposal.payload.changes) !==
    JSON.stringify(permissionChanges)
  ) {
    throw new Error("PROPOSAL_COMMIT_MISMATCH");
  }
  const proposalChains = permissionVectors.proposal.payload.changes.map(
    (change) => change.scope.chainId,
  );
  for (const [label, chains] of [
    ["binding", permissionVectors.bindingChainIds],
    ["preview", permissionVectors.previewChainIds],
  ]) {
    if (JSON.stringify(chains) !== JSON.stringify(proposalChains)) {
      throw new Error(`APPROVAL_SCOPE_MISMATCH: ${label}`);
    }
  }
  const resultScopes = permissionVectors.commit.result.revisions.map(
    (revision) => revision.scope,
  );
  if (
    JSON.stringify(resultScopes) !==
    JSON.stringify(permissionChanges.map((change) => change.scope))
  ) {
    throw new Error("RESULT_SCOPE_MISMATCH");
  }
  const proposalPermissionIds = permissionVectors.proposal.payload.changes.flatMap(
    (change) => change.permissions.map((permission) => permission.id),
  );
  if (new Set(proposalPermissionIds).size !== proposalPermissionIds.length) {
    throw new Error("PERMISSION_ID_DUPLICATE");
  }
  const permissionPreview = approval.previews.find(
    (preview) => preview.operationKind === "permission",
  );
  const expectedPreviewGrants = permissionVectors.proposal.payload.changes.flatMap(
    (change) =>
      change.permissions.map((permission) => {
        const expiry = findCaveat(permission, "expiresAt")?.value;
        return {
          capability: permission.parentCapability,
          chainId: change.scope.chainId,
          accountIds: findCaveat(permission, "restrictAccounts").value,
          methods: findCaveat(permission, "restrictMethods").value,
          ...(expiry ? { expiresAt: expiry } : {}),
        };
      }),
  );
  if (
    JSON.stringify(permissionPreview.granted) !==
    JSON.stringify(expectedPreviewGrants)
  ) {
    throw new Error("PERMISSION_PREVIEW_MISMATCH");
  }
  const mergedKeys = permissionVectors.mergedResult.map((permission) => {
    const chainId = findCaveat(permission, "restrictChains").value[0];
    return `${permission.parentCapability}\0${chainId}\0${permission.id}`;
  });
  if (JSON.stringify(mergedKeys) !== JSON.stringify([...mergedKeys].sort())) {
    throw new Error("MERGED_PERMISSIONS_NOT_SORTED");
  }
  for (const change of permissionVectors.disconnectCommit.params.changes) {
    if (change.permissions.length !== 0) {
      throw new Error("DISCONNECT_DID_NOT_REVOKE_SCOPE");
    }
  }
  for (const failure of permissionVectors.semanticFailures) {
    let actualViolation;
    if (failure.id === "commit-result-scope-mismatch") {
      if (JSON.stringify(failure.expectedScopes) !== JSON.stringify(failure.actualScopes)) {
        actualViolation = "RESULT_SCOPE_MISMATCH";
      }
    } else if (failure.id === "cross-chain-account-caveat") {
      try {
        validatePermissionStoreChange(failure.change);
      } catch (error) {
        actualViolation = error.message.split(":")[0];
      }
    } else if (failure.id === "proposal-approval-scope-mismatch") {
      if (
        JSON.stringify(failure.proposalScopes) !==
        JSON.stringify(failure.approvalChainIds)
      ) {
        actualViolation = "APPROVAL_SCOPE_MISMATCH";
      }
    } else if (failure.id === "proposal-duplicate-permission-id") {
      if (new Set(failure.permissionIds).size !== failure.permissionIds.length) {
        actualViolation = "PERMISSION_ID_DUPLICATE";
      }
    }
    if (actualViolation !== failure.expectedViolation) {
      throw new Error(
        `Permission semantic failure ${failure.id} produced ${actualViolation}`,
      );
    }
  }

  for (const vector of workflowVectors.vectors) {
    validateWorkflowPlanSemantics(vector.request, vector.plan);
    validateDeferredDerivation(
      vector.request,
      vector.plan,
      vector.derivation,
      { trade: integration.canonicalTransfer.bundle },
    );
  }
  const canonicalWorkflow = workflowVectors.vectors[0];
  const workflowPreview = approval.previews.find(
    (preview) => preview.operationKind === "workflow",
  );
  if (!sameJson(workflowPreview, canonicalWorkflow.plan.payload.preview)) {
    throw new Error("WORKFLOW_APPROVAL_PREVIEW_MISMATCH");
  }
  const workflowBinding = approval.bindings.find(
    (vector) => vector.method === "tbc_signWorkflow",
  ).binding.payload;
  if (
    workflowBinding.requestHash !== canonicalWorkflow.plan.payload.requestHash ||
    workflowBinding.operationHash !== canonicalWorkflow.plan.workflowPlanHash ||
    workflowBinding.origin !==
      canonicalWorkflow.plan.payload.deferredSigningTasks[0].envelopeTemplate
        .domain.origin
  ) {
    throw new Error("WORKFLOW_APPROVAL_BINDING_MISMATCH");
  }
  const workflowContext = provider.trustedContexts.find(
    (vector) => vector.contextHash === workflowBinding.contextHash,
  )?.context;
  if (
    !workflowContext ||
    workflowContext.origin !== workflowBinding.origin ||
    workflowContext.sessionId !== workflowBinding.sessionId
  ) {
    throw new Error("WORKFLOW_TRUSTED_CONTEXT_MISMATCH");
  }
  validateWorkflowTerminalFailure(workflowVectors.terminalFailure);
  for (const failure of workflowVectors.semanticFailures) {
    const mutated = applyJsonPointerMutation(
      {
        request: workflowVectors.vectors[0].request,
        plan: workflowVectors.vectors[0].plan,
        derivation: workflowVectors.vectors[0].derivation,
        terminalFailure: workflowVectors.terminalFailure,
      },
      failure.mutation.path,
      failure.mutation.value,
    );
    if (failure.id === "deferred-target-pointer-invalid") {
      mutated.derivation.target = failure.mutation.value;
      mutated.plan.payload.preview.bindings[0].target = failure.mutation.value;
    }
    let actualViolation;
    try {
      if (failure.id === "workflow-partial-result-forbidden") {
        validateWorkflowTerminalFailure(mutated.terminalFailure);
      } else {
        validateDeferredDerivation(
          mutated.request,
          mutated.plan,
          mutated.derivation,
          { trade: integration.canonicalTransfer.bundle },
        );
      }
    } catch (error) {
      actualViolation = error.message.split(":")[0];
    }
    if (actualViolation !== failure.expectedViolation) {
      throw new Error(
        `Workflow semantic failure ${failure.id} produced ${actualViolation}`,
      );
    }
  }

  const signerParams = integrationSchema.$defs.signerSignParams;
  assertSameSet(
    Object.keys(signerParams.properties),
    ["version", "approval", "task"],
    "Signer params properties",
  );
  assertSameSet(
    signerParams.required,
    ["version", "approval", "task"],
    "Signer params required",
  );
  if (
    containsObjectKey(
      readJson(root, "schemas/transaction-request.schema.json"),
      "serviceFeeRate",
    )
  ) {
    throw new Error("DApp transaction schema exposes serviceFeeRate");
  }

  const tws011 = fs.readFileSync(
    path.join(root, "standards/TWS-011-wallet-integration.md"),
    "utf8",
  );
  for (const normativeName of [
    ...ports,
    ...operations,
    ...registry.errorNames,
    ...registry.violationCodes,
  ]) {
    if (!tws011.includes(`\`${normativeName}\``)) {
      throw new Error(`TWS-011 does not name ${normativeName}`);
    }
  }

  return {
    methods: methods.length,
    events: events.length,
    intents: intents.length,
    legacyFlags: legacyFlags.length,
    ports: ports.length,
    operations: operations.length,
    portErrors: registry.errorNames.length,
    phases: registry.validationPhases.length,
    violations: registry.violationCodes.length,
    forbiddenFields: registry.forbiddenFieldNames.length,
    semanticNegative: integration.semanticFailures.length,
    hashBindings: hashRegistry.bindings.length,
    states: stateRegistry.states.length,
    terminalStates: terminalStateNames.length,
    methodCategories: stateEffect.categories,
    continueStates: stateEffect.continueStates,
    selfTransitionStates: stateEffect.selfTransitionStates,
    committingKinds: stateEffect.committingKinds,
    cancellationReasons: stateRegistry.cancellationReasons.length,
    stateNames,
    trustedContexts: provider.trustedContexts.length,
    trustedContextFailures: provider.trustedContextSemanticFailures.length,
    approvalBindings: approval.bindings.length,
    approvalPreviews: approval.previews.length,
    approvalFailures: approval.semanticFailures.length,
    permissionScopes: permissionChanges.length,
    permissionFailures: permissionVectors.semanticFailures.length,
    workflowPlans: workflowVectors.vectors.length,
    workflowDerivations: workflowVectors.vectors.length,
    workflowFailures: workflowVectors.semanticFailures.length,
    restrictedFields: restrictedNames.length,
    ordinaryDataFixtures:
      integration.restrictedDataPolicy.ordinaryFixtures.length,
  };
}
