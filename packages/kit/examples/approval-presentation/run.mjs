import {
  hashCanonical,
  projectTbcApprovalPreparation,
  projectTbcApprovalPresentation,
} from "@tbc/kit/wallet";
import { renderApprovalPresentation } from "./renderer.mjs";

const chainId = "tbc:testnet";
const from = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const to = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
const accountId = `${chainId}:${from}`;
const expiresAt = "2026-09-25T00:05:00Z";
const request = Object.freeze({
  version: "1.0",
  chainId,
  from,
  intent: Object.freeze({ version: "1.0", type: "tbc.transfer", to, amount: "1000" }),
  constraints: Object.freeze({ maxFee: "200" }),
});
const requestHash = hashCanonical(request);

const preparation = projectTbcApprovalPreparation({
  method: "tbc_signTransaction",
  operationKind: "transaction",
  requestHash,
  chainId,
  accountId,
  suggestedFeeCapAtomic: "200",
  warningScope: [],
  expiresAt: Date.parse(expiresAt),
  request,
});

const preview = Object.freeze({
  operationKind: "transaction",
  assetFlows: Object.freeze([
    Object.freeze({ kind: "native", direction: "send", amount: "1000", from, to }),
    Object.freeze({ kind: "native", direction: "fee", amount: "80", from }),
  ]),
  totalFee: "80",
  transactionCount: 1,
  warnings: Object.freeze([]),
  irreversible: false,
});
const planPayload = Object.freeze({
  requestHash,
  preview,
  transactions: Object.freeze([Object.freeze({ id: "primary" })]),
  signingTasks: Object.freeze([Object.freeze({ taskId: "sign-primary-0" })]),
});
const planHash = hashCanonical(planPayload);
const bindingPayload = Object.freeze({
  version: "1.0",
  method: "tbc_signTransaction",
  operationKind: "transaction",
  contextHash: "11".repeat(32),
  origin: "https://wallet.example",
  sessionId: "approval-presentation-example",
  chainId,
  accountId,
  requestHash,
  operationHash: planHash,
  expiresAt,
});
const binding = Object.freeze({ payload: bindingPayload, bindingHash: hashCanonical(bindingPayload) });
const params = Object.freeze({
  version: "1.0",
  binding,
  requester: Object.freeze({
    transport: "remote",
    origin: "https://wallet.example",
    topOrigin: "https://wallet.example",
    frame: "top",
  }),
  preview,
});
const callId = "approval-presentation-example-call";
const operationId = "approval-presentation-example-operation";
const formal = projectTbcApprovalPresentation(Object.freeze({
  callId,
  operationId,
  releaseFingerprint: "08".repeat(32),
  call: Object.freeze({ callId, operation: "approval.request", params }),
  params,
  operation: Object.freeze({ operationId, releaseFingerprint: "08".repeat(32), transition: Object.freeze({}) }),
  payload: Object.freeze({
    operationId,
    operation: Object.freeze({ method: "tbc_signTransaction", params: request }),
  }),
  memory: Object.freeze({
    requestHash,
    approvalBinding: binding,
    approvalPreview: preview,
    normalizedTransaction: Object.freeze({ request, requestHash }),
    executionPlan: Object.freeze({ payload: planPayload, planHash }),
  }),
}));
const rendered = renderApprovalPresentation(formal);

console.log(JSON.stringify({
  preparation: {
    phase: preparation.phase,
    trust: preparation.trust,
    binding: preparation.binding.status,
    actualFee: preparation.fees.actualAtomic.status,
  },
  formal: {
    phase: formal.phase,
    trust: formal.trust,
    binding: formal.binding.status,
    actualFeeAtomic: formal.fees.actualAtomic.value,
    maximumFeeAtomic: formal.fees.maximumAtomic.value,
    transactions: formal.counts.transactions.value,
    signingTasks: formal.counts.signingTasks.value,
    assetPrecision: formal.assets[0].amount.precision.status,
    businessType: formal.businessTerms.value.type,
    businessAmount: formal.businessTerms.value.amount,
    renderedStepCount: rendered.steps.length,
    retainedSpecializedDetails: rendered.retainedSpecializedDetails,
  },
}));
