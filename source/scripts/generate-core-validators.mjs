import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";
import { compactValidatorSchemas } from "./lib/compact-validator-schemas.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = path.join(root, "schemas");
const releasePath = path.join(
  root,
  "release",
  "tws-v1-candidate.json",
);
const outputPath = path.join(
  root,
  "packages",
  "core",
  "src",
  "generated",
  "validators.ts",
);

const CORE_SCHEMA_NAMES = Object.freeze([
  "common.schema.json",
  "integration.schema.json",
  "permissions.schema.json",
  "prepared-transaction.schema.json",
  "prepared-workflow.schema.json",
  "provider.schema.json",
  "reviewed-transaction.schema.json",
  "signing.schema.json",
  "transaction-request.schema.json",
  "workflow.schema.json",
  "wallet-actions.schema.json",
]);
const release = JSON.parse(await readFile(releasePath, "utf8"));
for (const entry of release.schemaFiles.filter(({ path: file }) =>
  CORE_SCHEMA_NAMES.includes(path.basename(file)),
)) {
  const bytes = await readFile(path.join(root, entry.path));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== entry.sha256) {
    throw new Error(`Public integration candidate schema changed: ${entry.path}`);
  }
}

const schemaNames = CORE_SCHEMA_NAMES;
const schemaEntries = await Promise.all(
  schemaNames.map(async (name) => [
    name,
    JSON.parse(await readFile(path.join(schemaRoot, name), "utf8")),
  ]),
);
const schemaIds = new Map(
  schemaEntries.map(([name, schema]) => [name, schema.$id]),
);

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  validateFormats: true,
  inlineRefs: false,
  code: { source: true, esm: true, lines: true, optimize: true },
});
ajv.addFormat("uri", /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]*$/);
ajv.addFormat("date-time", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/);
for (const [, schema] of schemaEntries) ajv.addSchema(schema);

const integration = schemaIds.get("integration.schema.json");
if (!integration) throw new Error("integration.schema.json has no $id");
const ref = (definition) => `${integration}#/$defs/${definition}`;
const schemaRef = (schemaName, definition) => {
  const schemaId = schemaIds.get(schemaName);
  if (!schemaId) throw new Error(`${schemaName} has no $id`);
  return `${schemaId}#/$defs/${definition}`;
};
const validatorReferences = {
  validateSignReviewedTransactionRequest: schemaRef("wallet-actions.schema.json", "signReviewedTransactionRequest"),
  validateEncryptRequest: schemaRef("wallet-actions.schema.json", "encryptRequest"),
  validateDecryptRequest: schemaRef("wallet-actions.schema.json", "decryptRequest"),
  validateStartInput: ref("startInput"),
  validateResumeInput: ref("resumeInput"),
  validateCommitAckInput: ref("commitAckInput"),
  validateCancelInput: ref("cancelInput"),
  validateOperationCheckpoint: ref("operationCheckpoint"),
  validatePortResponse: ref("portResponse"),
  validateCoreTransition: ref("coreTransition"),
  validateAccountsResolveResult: ref("accountsResolveResult"),
  validateChainDataResolveParams: ref("chainDataResolveParams"),
  validateChainDataResolveResult: ref("chainDataResolveResult"),
  validatePolicyResolveResult: ref("policyResolveResult"),
  validatePermissionStoreLoadResult: ref("permissionStoreLoadResult"),
  validatePermissionStoreCommitResult: ref("permissionStoreCommitResult"),
  validateApprovalRequestResult: ref("approvalRequestResult"),
  validateSignerSignResult: ref("signerSignResult"),
  validateCryptoExecuteResult: ref("cryptoExecuteResult"),
  validateReviewedTransactionReviewResult: ref("reviewedTransactionReviewResult"),
  validateReviewedTransactionExecuteResult: ref("reviewedTransactionExecuteResult"),
  validateBroadcastSubmitResult: ref("broadcastSubmitResult"),
  validateBroadcastSubmitBatchResult: ref("broadcastSubmitBatchResult"),
  validateBroadcastReconcileResult: ref("broadcastReconcileResult"),
  validateClockNowResult: ref("clockNowResult"),
  validateEntropyRandomBytesResult: ref("entropyRandomBytesResult"),
  validateGetAccountParams: schemaRef("provider.schema.json", "getAccountParams"),
  validateGetCapabilitiesParams: schemaRef("provider.schema.json", "getCapabilitiesParams"),
  validateSwitchChainParams: schemaRef("provider.schema.json", "switchChainParams"),
  validateMessageRequest: schemaRef("signing.schema.json", "messageRequest"),
  validateTypedDataRequest: schemaRef("signing.schema.json", "typedDataRequest"),
  validateTransactionRequest: schemaRef("transaction-request.schema.json", "transactionRequest"),
  validatePreparedTransactionRequest: schemaRef("prepared-transaction.schema.json", "preparedTransactionRequest"),
  validateWorkflowRequest: schemaRef("workflow.schema.json", "request"),
  validatePreparedWorkflowRequest: schemaRef("prepared-workflow.schema.json", "request"),
  validateRequestPermissionsParams: schemaRef("permissions.schema.json", "requestPermissionsParams"),
  validateApprovalBinding: ref("approvalBinding"),
  validateApprovalPreview: ref("approvalPreview"),
  validateApprovalRequestParams: ref("approvalRequestParams"),
  validateApprovalReceipt: ref("approvalReceipt"),
  validateNormalizeRequestParams: ref("normalizeRequestParams"),
  validateNormalizeRequestResult: ref("normalizeRequestResult"),
  validatePlanParams: ref("planParams"),
  validatePlanResult: ref("planResult"),
  validateValidateParams: ref("validateParams"),
  validateValidationResult: ref("validationResult"),
  validateFinalizeParams: ref("finalizeParams"),
  validateFinalizeResult: ref("finalizeResult"),
  validateSignedTransactionBundle: schemaRef("transaction-request.schema.json", "signedTransactionBundle"),
  validateSubmittedTransactionBundle: schemaRef("transaction-request.schema.json", "submittedTransactionBundle"),
};
for (const [name, reference] of Object.entries(validatorReferences)) {
  if (!ajv.getSchema(reference)) throw new Error(`${name} cannot resolve ${reference}`);
}

// AJV emits separate entry/reference functions for this frozen schema. Reuse
// the existing Core ownership proof at each checkpoint boundary, not a cache
// of arbitrary transitions or caller-frozen values. All outer schemas and
// unowned checkpoint values still execute their original generated validators.
const standalone = standaloneCode(ajv, validatorReferences);
const checkpointEntry = /export const validateOperationCheckpoint = (\w+);/.exec(standalone)?.[1];
const checkpointValidators = [];
const optimized = standalone.split(/(?=^function validate\d+\()/m).map(block => {
  const name = /^function (validate\d+)\(/.exec(block)?.[1];
  if (!name || !block.includes("if(data.payload === undefined)") ||
      !block.includes("if(data.checkpointHash === undefined)")) return block;
  const evaluatedText = new RegExp(`${name}\\.evaluated = (\\{[^\\n]+\\});`).exec(standalone)?.[1];
  const evaluated = evaluatedText === undefined ? undefined : JSON.parse(evaluatedText);
  if (!evaluated || evaluated.dynamicProps || evaluated.dynamicItems) {
    throw new Error("Checkpoint schema optimization requires static evaluated fields");
  }
  checkpointValidators.push(name);
  return block.replace("let vErrors = null;",
    `if (verifiedCheckpoints.has(data)) { ${name}.errors = null; return true; }\nlet vErrors = null;`);
}).join("");
if (checkpointValidators.length !== 2 || !checkpointValidators.includes(checkpointEntry)) {
  throw new Error("Frozen checkpoint validator layout changed; re-audit ownership optimization");
}
const generated = `import { verifiedCheckpoints } from "../checkpoint-ownership.js";\n${compactValidatorSchemas(optimized)}`;
if (generated.includes("new Function") || /eval\s*\(/.test(generated)) {
  throw new Error("Generated validator contains dynamic code execution");
}
const banner = `// @ts-nocheck
// Generated by scripts/generate-core-validators.mjs from the TWS v1 Candidate.
// Candidate: ${release.candidateVersion}
// Schema bundle: ${release.schemaBundleSha256}
`;
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${banner}${generated.trim()}\n`, "utf8");
