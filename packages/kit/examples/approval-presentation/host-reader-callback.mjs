import {
  assertValidTws,
  createApprovalHostEvidenceReader,
  projectTbcApprovalPresentation,
  TWS_RELEASE_FINGERPRINT,
} from "@tbc/kit/wallet";
import { renderApprovalPresentation } from "./renderer.mjs";

/**
 * Production integration shape: read the authoritative checkpoint from the
 * same session Host store. Consumers must not synthesize bindings or evidence.
 */
export function createApprovalCallback({ hostStore, show, decide, requestSpecializedApproval }) {
  const evidenceReader = createApprovalHostEvidenceReader({
    store: hostStore,
    releaseFingerprint: TWS_RELEASE_FINGERPRINT,
    parseApprovalRequest(value) {
      assertValidTws("approvalRequestParams", value);
      return value;
    },
  });

  return async function requestApproval(params, call) {
    if (params.binding.payload.operationKind !== "transaction" &&
        params.binding.payload.operationKind !== "workflow") {
      if (typeof requestSpecializedApproval !== "function") {
        throw new Error(`Missing specialized approval handler for ${params.binding.payload.operationKind}`);
      }
      return requestSpecializedApproval({ params, call });
    }
    const evidence = await evidenceReader.read(call.callId, params.binding.bindingHash);
    const presentation = projectTbcApprovalPresentation(evidence);
    await show(Object.freeze({
      presentation: renderApprovalPresentation(presentation),
      // The same validated approval params carry message, typed-data,
      // dynamic-binding and reviewed-transaction details for dedicated views.
      specializedEvidence: evidence.params,
    }));
    return decide({ params, call, presentation });
  };
}
