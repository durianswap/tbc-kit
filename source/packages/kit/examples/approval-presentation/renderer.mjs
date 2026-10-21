function field(value) {
  return value.status === "known"
    ? Object.freeze({ status: "known", value: value.value, source: value.source })
    : Object.freeze({ status: "unknown", reason: value.reason });
}

function asset(value) {
  return Object.freeze({
    kind: value.kind,
    direction: value.direction,
    contractId: field(value.contractId),
    symbol: field(value.symbol),
    amount: Object.freeze({
      atomic: value.amount.atomic,
      precision: field(value.amount.precision),
      display: field(value.amount.display),
    }),
    from: field(value.from),
    to: field(value.to),
  });
}

function retainedSpecializedDetails(model) {
  const kinds = new Set(model.steps.map(({ kind }) => kind));
  const details = [];
  if (model.operationKind === "permission") details.push("permission scopes and caveats");
  if (kinds.has("message") || model.operationKind === "message") details.push("message bytes, encoding, domain and sign-in context");
  if (kinds.has("typedData") || model.operationKind === "typedData") details.push("typed-data domain, types and message");
  if (kinds.has("reviewedTransaction") || model.operationKind === "reviewedTransaction") details.push("reviewed raw transactions, associated inputs and dependencies");
  if (kinds.has("encrypt") || kinds.has("decrypt") || model.operationKind === "crypto") details.push("crypto algorithm and payload policy");
  if (model.operationKind === "workflow") details.push("dynamic-binding source, target and resolved value");
  return Object.freeze(details);
}

function transaction(value) {
  return Object.freeze({
    id: value.id,
    role: field(value.role),
    dependsOn: Object.freeze([...value.dependsOn]),
    templateHash: field(value.templateHash),
    feeAtomic: field(value.feeAtomic),
    assets: Object.freeze(value.assets.map(asset)),
    assetsStatus: value.assetsStatus,
    warnings: Object.freeze([...value.warnings]),
    outputsStatus: value.outputsStatus,
    outputs: Object.freeze(value.outputs.map(o => Object.freeze({
      outputIndices: Object.freeze([...o.outputIndices]), kind: o.kind,
      assetIdentity: field(o.assetIdentity), amountAtomic: field(o.amountAtomic), recipient: field(o.recipient),
      nativeValueAtomic: o.nativeValueAtomic, lockTime: field(o.lockTime), warnings: Object.freeze([...o.warnings]),
    }))),
  });
}

/**
 * Example wallet renderer. It keeps unknown values explicit and renders
 * workflow ownership from steps[]; top-level assets are summary-only.
 */
export function renderApprovalPresentation(model) {
  return Object.freeze({
    phase: model.phase,
    trust: model.trust,
    method: model.method,
    prepared: model.prepared,
    businessType: field(model.businessType),
    contractExecution: field(model.contractExecution),
    businessTerms: field(model.businessTerms),
    requester: field(model.requester),
    chainId: field(model.chainId),
    accountId: field(model.accountId),
    ...(model.signingRoles === undefined ? {} : { signingRoles: field(model.signingRoles) }),
    expiresAt: field(model.expiresAt),
    fees: Object.freeze({
      maximumAtomic: field(model.fees.maximumAtomic),
      actualAtomic: field(model.fees.actualAtomic),
    }),
    counts: Object.freeze({
      steps: field(model.counts.steps),
      transactions: field(model.counts.transactions),
      signingTasks: field(model.counts.signingTasks),
    }),
    summaryAssets: Object.freeze(model.assets.map(asset)),
    transactions: Object.freeze(model.transactions.map(transaction)),
    transactionsStatus: model.transactionsStatus,
    steps: Object.freeze(model.steps.map((step) => Object.freeze({
      id: step.id,
      kind: step.kind,
      dependsOn: Object.freeze([...step.dependsOn]),
      businessType: field(step.businessType),
      contractExecution: field(step.contractExecution),
      businessTerms: field(step.businessTerms),
      actualFeeAtomic: field(step.actualFeeAtomic),
      signingTaskCount: field(step.signingTaskCount),
      assets: Object.freeze(step.assets.map(asset)),
      transactions: Object.freeze(step.transactions.map(transaction)),
      transactionsStatus: step.transactionsStatus,
      warnings: Object.freeze([...step.warnings]),
    }))),
    warnings: Object.freeze([...model.warnings]),
    binding: model.binding,
    unknown: Object.freeze([...model.unknown]),
    retainedSpecializedDetails: retainedSpecializedDetails(model),
  });
}
