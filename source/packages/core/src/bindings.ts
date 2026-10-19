import { canonicalize } from "./canonical-json.js";
import { TwsApprovalError } from "./errors.js";
import { hashCanonical } from "./hash.js";
import { assertValidTws } from "./validation.js";

export interface ApprovalBindingPayload {
  readonly version: "1.0";
  readonly method: string;
  readonly operationKind: string;
  readonly contextHash: string;
  readonly origin: string;
  readonly sessionId: string;
  readonly chainId?: string;
  readonly chainIds?: readonly string[];
  readonly accountId?: string;
  readonly requestHash: string;
  readonly operationHash: string;
  readonly expiresAt: string;
}

export interface ApprovalBinding {
  readonly payload: ApprovalBindingPayload;
  readonly bindingHash: string;
}

export interface ApprovalReceipt {
  readonly status: "approved";
  readonly approvalId: string;
  readonly approvalToken: string;
  readonly bindingHash: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
}

export interface ApprovalRequester {
  readonly transport: "webview" | "extension" | "remote";
  readonly origin: string;
  readonly topOrigin: string;
  readonly frame: "top" | "child";
}

function fail(
  code: ConstructorParameters<typeof TwsApprovalError>[0],
  message: string,
): never {
  throw new TwsApprovalError(code, message);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function validateBindingSemantics(payload: ApprovalBindingPayload): void {
  if (payload.chainIds !== undefined) {
    for (let index = 1; index < payload.chainIds.length; index += 1) {
      const previous = payload.chainIds[index - 1];
      const current = payload.chainIds[index];
      if (previous === undefined || current === undefined || previous >= current) {
        fail("CHAIN_IDS_NOT_SORTED", "approval chain IDs are not strictly sorted");
      }
    }
  }
  if (
    payload.chainId !== undefined &&
    payload.accountId !== undefined &&
    !payload.accountId.startsWith(`${payload.chainId}:`)
  ) {
    fail("ACCOUNT_CHAIN_MISMATCH", "approval account does not belong to its chain");
  }
}

export function createApprovalBinding(
  payloadValue: ApprovalBindingPayload,
): ApprovalBinding {
  const payload = cloneJson(payloadValue);
  validateBindingSemantics(payload);
  const binding = {
    payload,
    bindingHash: hashCanonical(payload),
  };
  try {
    assertValidTws("approvalBinding", binding);
  } catch {
    fail("APPROVAL_BINDING_INVALID", "approval binding is invalid");
  }
  return deepFreeze(binding);
}

export function assertApprovalBinding(
  bindingValue: ApprovalBinding,
  expectedPayload?: ApprovalBindingPayload,
): ApprovalBinding {
  let binding: ApprovalBinding;
  try {
    binding = cloneJson(bindingValue);
    assertValidTws("approvalBinding", binding);
  } catch {
    fail("APPROVAL_BINDING_INVALID", "approval binding is invalid");
  }
  validateBindingSemantics(binding.payload);
  if (hashCanonical(binding.payload) !== binding.bindingHash) {
    fail("BINDING_HASH_MISMATCH", "approval binding hash does not match its payload");
  }
  if (expectedPayload !== undefined && !sameJson(binding.payload, expectedPayload)) {
    fail("BINDING_EXPECTATION_MISMATCH", "approval binding differs from expected input");
  }
  return deepFreeze(binding);
}

export function projectApprovalRequester(context: {
  readonly transport: ApprovalRequester["transport"];
  readonly origin: string;
  readonly topOrigin: string;
  readonly frame: ApprovalRequester["frame"];
}): ApprovalRequester {
  return Object.freeze({
    transport: context.transport,
    origin: context.origin,
    topOrigin: context.topOrigin,
    frame: context.frame,
  });
}

export function createApprovalRequest(
  bindingValue: ApprovalBinding,
  previewValue: unknown,
  context: Parameters<typeof projectApprovalRequester>[0],
): Readonly<Record<string, unknown>> {
  const binding = assertApprovalBinding(bindingValue);
  const preview = cloneJson(previewValue) as { readonly operationKind?: unknown };
  try {
    assertValidTws("approvalPreview", preview);
  } catch {
    fail("PREVIEW_MISMATCH", "approval preview is invalid");
  }
  if (preview.operationKind !== binding.payload.operationKind) {
    fail("PREVIEW_MISMATCH", "approval preview kind differs from the binding");
  }
  const requester = projectApprovalRequester(context);
  if (
    requester.origin !== binding.payload.origin ||
    context.origin !== binding.payload.origin
  ) {
    fail("REQUESTER_CONTEXT_MISMATCH", "approval requester differs from the binding");
  }
  const request = { version: "1.0", binding, requester, preview };
  try {
    assertValidTws("approvalRequestParams", request);
  } catch {
    fail("APPROVAL_REQUEST_INVALID", "approval request is invalid");
  }
  return deepFreeze(request);
}

export function assertApprovalRequest(
  requestValue: unknown,
  expectedValue: unknown,
): Readonly<Record<string, unknown>> {
  let request: Readonly<Record<string, unknown>>;
  try {
    request = cloneJson(requestValue) as Readonly<Record<string, unknown>>;
    assertValidTws("approvalRequestParams", request);
  } catch {
    fail("APPROVAL_REQUEST_INVALID", "approval request is invalid");
  }
  if (!sameJson(request, expectedValue)) {
    fail("PREVIEW_MISMATCH", "approval request differs from the stored request");
  }
  return deepFreeze(request);
}

export function assertApprovalReceipt(
  bindingValue: ApprovalBinding,
  receiptValue: ApprovalReceipt,
  trustedNow: string,
): ApprovalReceipt {
  const binding = assertApprovalBinding(bindingValue);
  let receipt: ApprovalReceipt;
  try {
    receipt = cloneJson(receiptValue);
    assertValidTws("approvalReceipt", receipt);
  } catch {
    fail("RECEIPT_INVALID", "approval receipt is invalid");
  }
  if (receipt.bindingHash !== binding.bindingHash) {
    fail("RECEIPT_BINDING_MISMATCH", "approval receipt does not match the binding");
  }
  if (Date.parse(receipt.expiresAt) > Date.parse(binding.payload.expiresAt)) {
    fail("RECEIPT_EXPIRY_EXTENDED", "approval receipt extends binding expiry");
  }
  const now = Date.parse(trustedNow);
  const approvedAt = Date.parse(receipt.approvedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  if (
    ![now, approvedAt, expiresAt].every(Number.isFinite) ||
    approvedAt > expiresAt
  ) {
    fail("RECEIPT_TIME_INVALID", "approval receipt time ordering is invalid");
  }
  if (now >= expiresAt) {
    fail("RECEIPT_EXPIRED", "approval receipt has expired");
  }
  return deepFreeze(receipt);
}
