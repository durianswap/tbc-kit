import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {
  materializeCheckpoints,
  materializePreClockTerminals,
  materializeTransitions,
} from "./lifecycle-conformance.mjs";
import { resolveHashKnownAnswerSource } from "./crypto-conformance.mjs";
import { listFiles, readJson } from "./repository.mjs";

function decodeJsonPointerSegment(segment) {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolvePointer(root, pointer) {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer: ${pointer}`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map(decodeJsonPointerSegment)
    .reduce((value, key) => {
      if (value === undefined || value === null || !(key in value)) {
        throw new Error(`JSON Pointer does not resolve: ${pointer}`);
      }
      return value[key];
    }, root);
}

function resolveReferenceTemplates(value, integration) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveReferenceTemplates(item, integration));
  }
  if (value && typeof value === "object") {
    if (
      Object.keys(value).length === 1 &&
      typeof value.$refPointer === "string"
    ) {
      return structuredClone(resolvePointer(integration, value.$refPointer));
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        resolveReferenceTemplates(child, integration),
      ]),
    );
  }
  return value;
}

function mutateJsonPointer(value, mutation) {
  const clone = structuredClone(value);
  const segments = mutation.path
    .slice(1)
    .split("/")
    .map(decodeJsonPointerSegment);
  const key = segments.pop();
  const parent = segments.reduce((current, segment) => current[segment], clone);
  if (mutation.operation === "delete") delete parent[key];
  else if (mutation.operation === "set") {
    parent[key] = structuredClone(mutation.value);
  } else {
    throw new Error(`Unknown invalid-vector mutation: ${mutation.operation}`);
  }
  return clone;
}

export function runSchemaConformance(root) {
  const schemaFiles = listFiles(root, "schemas", ".json");
  const schemas = schemaFiles.map((file) => ({
    basename: path.basename(file.relativePath),
    schema: readJson(root, file.relativePath),
  }));
  const schemaIdByBasename = new Map(
    schemas.map(({ basename, schema }) => [basename, schema.$id]),
  );
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    validateFormats: true,
  });
  ajv.addFormat("uri", (value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  });
  ajv.addFormat(
    "date-time",
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/,
  );
  for (const { schema } of schemas) ajv.addSchema(schema);

  function validator(reference) {
    const [schemaPath, fragment = ""] = reference.split("#");
    const schemaId =
      schemaIdByBasename.get(path.basename(schemaPath)) ?? schemaPath;
    const resolvedReference = `${schemaId}${fragment ? `#${fragment}` : ""}`;
    const compiled = ajv.getSchema(resolvedReference);
    if (!compiled) {
      throw new Error(
        `Schema reference does not resolve: ${reference} (${resolvedReference})`,
      );
    }
    return compiled;
  }

  let definitionCount = 0;
  let registryCount = 0;
  let positiveCount = 0;
  let negativeCount = 0;

  function validate(reference, value, label) {
    const compiled = validator(reference);
    if (!compiled(value)) {
      throw new Error(
        `${label} failed ${reference}: ${ajv.errorsText(compiled.errors, { separator: " | " })}`,
      );
    }
    positiveCount += 1;
  }

  function validateRejects(reference, value, label, expectedKeyword) {
    const compiled = validator(reference);
    if (compiled(value)) {
      throw new Error(`${label} mutation was accepted by ${reference}`);
    }
    if (!compiled.errors.some(({ keyword }) => keyword === expectedKeyword)) {
      throw new Error(
        `${label} did not produce ${expectedKeyword}: ${JSON.stringify(compiled.errors)}`,
      );
    }
    negativeCount += 1;
  }

  for (const { basename, schema } of schemas) {
    validator(basename);
    for (const definitionName of Object.keys(schema.$defs ?? {})) {
      validator(`${basename}#/$defs/${definitionName}`);
      definitionCount += 1;
    }
  }

  const registryRoutes = [
    ["registry/errors.json", "error-registry.schema.json"],
    ["registry/events.json", "event-registry.schema.json"],
    ["registry/hash-bindings.json", "hash-binding-registry.schema.json"],
    ["registry/methods.json", "method-registry.schema.json"],
    ["registry/networks.json", "network-registry.schema.json"],
    [
      "registry/operation-states.json",
      "operation-state-registry.schema.json",
    ],
    [
      "registry/integration-ports.json",
      "integration-port-registry.schema.json",
    ],
  ];
  for (const [dataPath, schemaReference] of registryRoutes) {
    validate(schemaReference, readJson(root, dataPath), dataPath);
    registryCount += 1;
  }

  const methodRegistry = readJson(root, "registry/methods.json");
  for (const method of methodRegistry.methods) {
    if (method.params.kind === "schema") validator(method.params.schema);
    validator(method.result.schema);
  }
  for (const event of readJson(root, "registry/events.json").events) {
    validator(event.payload.schema);
  }
  const integrationRegistry = readJson(
    root,
    "registry/integration-ports.json",
  );
  for (const port of integrationRegistry.ports) {
    for (const operation of port.operations) {
      validator(operation.params.schema);
      validator(operation.result.schema);
    }
  }
  const operationRoutes = new Map(
    integrationRegistry.ports.flatMap((port) =>
      port.operations.map((operation) => [operation.name, operation]),
    ),
  );
  const hashBindingRegistry = readJson(root, "registry/hash-bindings.json");
  for (const binding of hashBindingRegistry.bindings) {
    validator(binding.inputSchema);
  }

  const provider = readJson(root, "test-vectors/provider.json");
  provider.concurrentRequests.forEach((value, index) =>
    validate(
      "provider.schema.json#/$defs/request",
      value,
      `provider request ${index}`,
    ),
  );
  provider.responsesOutOfOrder.forEach((value, index) =>
    validate(
      "provider.schema.json#/$defs/response",
      value,
      `provider response ${index}`,
    ),
  );
  validate(
    "provider.schema.json#/$defs/account",
    provider.account,
    "provider account",
  );
  validate(
    "provider.schema.json#/$defs/capabilities",
    provider.capabilities,
    "provider capabilities",
  );
  validate(
    "integration.schema.json#/$defs/protocolRelease",
    provider.protocolRelease,
    "provider protocol release",
  );
  provider.trustedContexts.forEach((vector) => {
    validate(
      "integration.schema.json#/$defs/trustedContext",
      vector.context,
      `trusted context ${vector.id}`,
    );
    validate(
      "integration.schema.json#/$defs/approvalRequester",
      vector.approvalRequester,
      `approval requester ${vector.id}`,
    );
  });
  for (const [name, record] of Object.entries({
    sessionA: provider.providerSessions.sessionA,
    sessionB: provider.providerSessions.sessionB,
  })) {
    validate(
      "provider.schema.json#/$defs/providerSessionSnapshot",
      record,
      `provider session snapshot ${name}`,
    );
    validate(
      "provider.schema.json#/$defs/providerSessionScope",
      record.scope,
      `provider session scope ${name}`,
    );
    validate(
      "provider.schema.json#/$defs/providerSessionState",
      record.state,
      `provider session state ${name}`,
    );
  }
  validate(
    "provider.schema.json#/$defs/providerSessionMutation",
    provider.providerSessions.switchA,
    "provider session switch mutation",
  );
  validate(
    "provider.schema.json#/$defs/providerSessionCommitAck",
    provider.providerSessions.commitAck,
    "provider session commit acknowledgment",
  );
  validate(
    "provider.schema.json#/$defs/providerCompletion",
    provider.providerSessions.switchCompletion,
    "provider session switch completion",
  );
  validate(
    "provider.schema.json#/$defs/providerCompletion",
    provider.providerSessions.switchNoop.completion,
    "provider session no-op completion",
  );
  validate(
    "integration.schema.json#/$defs/permissionStoreCommitParams",
    provider.providerSessions.disconnect.permissionCommit.params,
    "provider session disconnect permission commit",
  );

  const permissions = readJson(root, "test-vectors/permissions.json");
  validate(
    "permissions.schema.json#/$defs/requestPermissionsParams",
    permissions.request,
    "permission request",
  );
  validate(
    "permissions.schema.json#/$defs/permissionArray",
    permissions.result,
    "permission result",
  );
  validate(
    "integration.schema.json#/$defs/permissionProposal",
    permissions.proposal,
    "permission proposal",
  );
  validate(
    "integration.schema.json#/$defs/permissionStoreCommitParams",
    permissions.commit.params,
    "permission batch commit params",
  );
  validate(
    "integration.schema.json#/$defs/permissionStoreCommitResult",
    permissions.commit.result,
    "permission batch commit result",
  );
  validate(
    "integration.schema.json#/$defs/permissionCommitArtifact",
    permissions.commit,
    "permission checkpoint commit artifact",
  );
  validate(
    "integration.schema.json#/$defs/permissionStoreCommitParams",
    permissions.disconnectCommit.params,
    "permission disconnect batch",
  );
  validate(
    "permissions.schema.json#/$defs/permissionArray",
    permissions.mergedResult,
    "merged permissions",
  );

  const approval = readJson(root, "test-vectors/approval.json");
  approval.bindings.forEach((vector) =>
    validate(
      "integration.schema.json#/$defs/approvalBinding",
      vector.binding,
      `approval binding ${vector.method}`,
    ),
  );
  approval.previews.forEach((preview) =>
    validate(
      "integration.schema.json#/$defs/approvalPreview",
      preview,
      `approval preview ${preview.operationKind}`,
    ),
  );

  for (const vector of readJson(root, "test-vectors/intents.json").vectors) {
    validate(
      "transaction-request.schema.json",
      vector.request,
      `intent ${vector.id}`,
    );
  }
  const errors = readJson(root, "test-vectors/errors.json");
  for (const vector of errors.vectors) {
    validate(
      "provider.schema.json#/$defs/response",
      vector.response,
      `error ${vector.id}`,
    );
  }
  errors.cancellationOutcomes.forEach((vector) =>
    validate(
      "provider.schema.json#/$defs/providerCancellationDisposition",
      vector.disposition,
      `cancellation disposition ${vector.reason}`,
    ),
  );
  const workflow = readJson(root, "test-vectors/workflow.json");
  for (const vector of workflow.vectors) {
    validate(
      "workflow.schema.json#/$defs/request",
      vector.request,
      `workflow ${vector.id}`,
    );
    validate(
      "workflow.schema.json#/$defs/workflowPlan",
      vector.plan,
      `workflow plan ${vector.id}`,
    );
    validate(
      "workflow.schema.json#/$defs/resolvedDeferredSigningTask",
      vector.derivation,
      `workflow derivation ${vector.id}`,
    );
  }
  validate(
    "workflow.schema.json#/$defs/workflowTerminalFailure",
    workflow.terminalFailure,
    "workflow terminal failure",
  );
  validate(
    "workflow.schema.json#/$defs/workflowProgress",
    workflow.progress,
    "workflow checkpoint progress",
  );

  const lifecycle = readJson(root, "test-vectors/checkpoints.json");
  const replay = readJson(root, "test-vectors/port-replay.json");
  const checkpoints = materializeCheckpoints(lifecycle);
  const preClockTerminals = materializePreClockTerminals(lifecycle);
  checkpoints.forEach((vector) =>
    validate(
      "integration.schema.json#/$defs/operationCheckpoint",
      vector.checkpoint,
      `checkpoint ${vector.id}`,
    ),
  );
  preClockTerminals.forEach((vector) =>
    validate(
      "integration.schema.json#/$defs/operationCheckpoint",
      vector.checkpoint,
      `pre-clock checkpoint ${vector.id}`,
    ),
  );
  const transitions = materializeTransitions(lifecycle, checkpoints);
  transitions.forEach((vector) =>
    validate(
      "integration.schema.json#/$defs/coreTransition",
      vector.transition,
      `core transition ${vector.id}`,
    ),
  );
  const permissionCommitting = structuredClone(
    checkpoints.find(({ id }) => id === "committing").checkpoint,
  );
  permissionCommitting.payload.pendingCalls = [
    {
      version: "1.0",
      callId: "etIjrXRWdnGta84eKtv6Ixg4_lqK8aS0zIXlWDcSZDY",
      operation: "permissionStore.commit",
      params: lifecycle.fixture.artifacts.permissionCommitting.permissionCommit
        .params,
    },
  ];
  permissionCommitting.payload.data = structuredClone(
    lifecycle.fixture.artifacts.permissionCommitting,
  );
  permissionCommitting.payload.operation = {
    method: "wallet_requestPermissions",
    params: structuredClone(permissions.request),
  };
  delete permissionCommitting.payload.memory.providerSessionMutation;
  permissionCommitting.payload.memory.permissionCommit = structuredClone(
    lifecycle.fixture.artifacts.permissionCommitting.permissionCommit,
  );
  validate(
    "integration.schema.json#/$defs/operationCheckpoint",
    permissionCommitting,
    "permission Store committing checkpoint",
  );
  validate(
    "integration.schema.json#/$defs/commitAckInput",
    {
      version: "1.0",
      checkpoint: checkpoints.find(({ id }) => id === "committing")
        .checkpoint,
      acknowledgment: provider.providerSessions.commitAck,
      currentContext: lifecycle.fixture.basePayload.context,
      currentSession: {
        version: "1.0",
        scope: provider.providerSessions.sessionA.scope,
        state: provider.providerSessions.switchA.payload.target,
      },
    },
    "provider session commit acknowledgment input",
  );
  validate(
    "integration.schema.json#/$defs/cancelInput",
    {
      version: "1.0",
      checkpoint: checkpoints.find(({ id }) => id === "cancelled").checkpoint,
      reason: "REQUEST_ABORTED",
      currentContext: lifecycle.fixture.basePayload.context,
      currentSession: provider.providerSessions.sessionA,
    },
    "Core cancel input",
  );
  const cancelAuthority = readJson(root, "test-vectors/cancel-authority.json");
  const cancelBase = {
    version: "1.0",
    checkpoint: checkpoints.find(({ id }) => id === "authorizing").checkpoint,
  };
  const currentAuthority = {
    currentContext: lifecycle.fixture.basePayload.context,
    currentSession: provider.providerSessions.sessionA,
  };
  for (const reason of cancelAuthority.optionalReasons) {
    validate(
      "integration.schema.json#/$defs/cancelInput",
      { ...cancelBase, reason },
      `Core cancel optional authority ${reason}`,
    );
    validate(
      "integration.schema.json#/$defs/cancelInput",
      { ...cancelBase, reason, ...currentAuthority },
      `Core cancel provided optional authority ${reason}`,
    );
    validateRejects(
      "integration.schema.json#/$defs/cancelInput",
      {
        ...cancelBase,
        reason,
        currentContext: currentAuthority.currentContext,
      },
      `Core cancel partial authority ${reason}`,
      "dependentRequired",
    );
  }
  for (const reason of cancelAuthority.requiredReasons) {
    validateRejects(
      "integration.schema.json#/$defs/cancelInput",
      { ...cancelBase, reason },
      `Core cancel required authority ${reason}`,
      "required",
    );
    validate(
      "integration.schema.json#/$defs/cancelInput",
      { ...cancelBase, reason, ...currentAuthority },
      `Core cancel supplied authority ${reason}`,
    );
  }
  validate(
    "integration.schema.json#/$defs/startInput",
    {
      version: "1.0",
      release: lifecycle.fixture.basePayload.release,
      request: provider.concurrentRequests[0],
      currentContext: lifecycle.fixture.basePayload.context,
      currentSession: provider.providerSessions.sessionA,
    },
    "Core start input",
  );
  validate(
    "integration.schema.json#/$defs/resumeInput",
    {
      version: "1.0",
      checkpoint: checkpoints.find(({ id }) => id === "initializing").checkpoint,
      response: replay.exactReplays.find(({ id }) => id === "clock-response")
        .firstResponse,
      currentContext: lifecycle.fixture.basePayload.context,
      currentSession: provider.providerSessions.sessionA,
    },
    "Core resume input",
  );
  validate(
    "integration.schema.json#/$defs/resumeInput",
    {
      version: "1.0",
      checkpoint: checkpoints.find(({ id }) => id === "validating").checkpoint,
      currentContext: lifecycle.fixture.basePayload.context,
      currentSession: lifecycle.fixture.basePayload.session,
    },
    "Core continuation resume input",
  );

  function validateReplayCall(call, label) {
    validate("integration.schema.json#/$defs/portCall", call, `${label} call`);
    validate(
      operationRoutes.get(call.operation).params.schema,
      call.params,
      `${label} params`,
    );
  }
  function validateReplayResponse(call, response, label) {
    validate(
      "integration.schema.json#/$defs/portResponse",
      response,
      `${label} response`,
    );
    if (response.result !== undefined) {
      validate(
        operationRoutes.get(call.operation).result.schema,
        response.result,
        `${label} result`,
      );
    }
  }
  replay.exactReplays.forEach((scenario) => {
    scenario.attempts.forEach((call, index) =>
      validateReplayCall(call, `replay ${scenario.id} ${index}`),
    );
    validateReplayResponse(
      scenario.attempts[0],
      scenario.firstResponse,
      `replay ${scenario.id}`,
    );
  });
  replay.payloadCollision.attempts.forEach((call, index) =>
    validateReplayCall(call, `replay collision ${index}`),
  );
  validateReplayResponse(
    replay.payloadCollision.attempts[0],
    replay.payloadCollision.firstResponse,
    "replay collision first",
  );
  validateReplayCall(replay.broadcastCall, "replay broadcast");
  replay.nonAdvancingResponses.forEach((entry) =>
    validate(
      "integration.schema.json#/$defs/portResponse",
      entry.response,
      `non-advancing ${entry.kind} response`,
    ),
  );
  for (const vector of readJson(root, "test-vectors/signing.json").vectors) {
    const resultDefinition =
      vector.method === "tbc_signMessage"
        ? "messageSignature"
        : "typedDataSignature";
    validate(
      `signing.schema.json#/$defs/${resultDefinition}`,
      vector.result,
      `signing ${vector.id}`,
    );
  }
  validate(
    "conformance-manifest.schema.json",
    readJson(root, "test-vectors/manifest.json"),
    "wallet manifest",
  );

  const closure = readJson(root, "test-vectors/core-closure.json");
  validate(
    "integration.schema.json#/$defs/trustedContext",
    closure.authorityBase.context,
    "closure authority context",
  );
  validate(
    "provider.schema.json#/$defs/providerSessionSnapshot",
    closure.authorityBase.session,
    "closure authority session",
  );
  closure.pendingCheckpoint.payload.pendingCalls.forEach((call, index) =>
    validate(
      "integration.schema.json#/$defs/portCall",
      call,
      `closure pending call ${index}`,
    ),
  );
  Object.entries(closure.pendingResponses).forEach(([name, response]) =>
    validate(
      "integration.schema.json#/$defs/portResponse",
      response,
      `closure pending response ${name}`,
    ),
  );

  const integration = readJson(root, "test-vectors/integration.json");
  validate(
    "integration.schema.json#/$defs/chainSwitchProposal",
    integration.hashFixtures.chainSwitchProposal,
    "chain switch proposal",
  );
  const hashBindingByName = new Map(
    hashBindingRegistry.bindings.map((binding) => [binding.name, binding]),
  );
  integration.hashKnownAnswers.forEach((vector) => {
    const binding = hashBindingByName.get(vector.name);
    if (!binding) throw new Error(`Unknown hash known answer: ${vector.name}`);
    validate(
      binding.inputSchema,
      resolveHashKnownAnswerSource(root, vector),
      `hash known answer ${vector.name}`,
    );
  });
  for (const field of integration.restrictedDataPolicy.fields) {
    for (const reference of field.allowedSchemas) validator(reference);
  }
  validate(
    "conformance-manifest.schema.json",
    integration.coreLibraryManifest,
    "core library manifest",
  );
  integration.schemaAssertions.forEach((assertion, index) =>
    validate(
      assertion.schema,
      resolvePointer(integration, assertion.pointer),
      `integration assertion ${index}`,
    ),
  );
  integration.portExamples.forEach((example, index) => {
    validate(
      example.paramsSchema,
      resolvePointer(integration, example.paramsPointer),
      `port params ${index}`,
    );
    validate(
      example.resultSchema,
      resolvePointer(integration, example.resultPointer),
      `port result ${index}`,
    );
  });
  validate(
    "integration.schema.json#/$defs/portCall",
    integration.portEnvelopeExamples.call,
    "port call",
  );
  validate(
    "integration.schema.json#/$defs/portResponse",
    integration.portEnvelopeExamples.success,
    "port response",
  );
  integration.portFailureExamples.forEach((example, index) =>
    validate(
      "integration.schema.json#/$defs/portFailure",
      example.response,
      `port failure ${index}`,
    ),
  );
  integration.coreExamples.forEach((example, index) => {
    validate(
      example.paramsSchema,
      resolveReferenceTemplates(example.paramsTemplate, integration),
      `core params ${index}`,
    );
    validate(
      example.resultSchema,
      resolveReferenceTemplates(example.resultTemplate, integration),
      `core result ${index}`,
    );
  });

  const draft3DefinitionCases = [
    [
      "providerSessionSnapshot",
      "provider.schema.json#/$defs/providerSessionSnapshot",
      provider.providerSessions.sessionA,
    ],
    [
      "permissionLoadArtifact",
      "integration.schema.json#/$defs/permissionLoadArtifact",
      lifecycle.fixture.memoryArtifacts.permissionLoads[0],
    ],
    [
      "accountResolutionArtifact",
      "integration.schema.json#/$defs/accountResolutionArtifact",
      lifecycle.fixture.memoryArtifacts.accountResolutions[0],
    ],
    [
      "permissionCommitArtifact",
      "integration.schema.json#/$defs/permissionCommitArtifact",
      permissions.commit,
    ],
    [
      "broadcastAttempt",
      "integration.schema.json#/$defs/broadcastAttempt",
      lifecycle.fixture.memoryArtifacts.broadcastProgress.attempts[0],
    ],
    [
      "broadcastProgress",
      "integration.schema.json#/$defs/broadcastProgress",
      lifecycle.fixture.memoryArtifacts.broadcastProgress,
    ],
    [
      "workflowStepProgress",
      "workflow.schema.json#/$defs/workflowStepProgress",
      workflow.progress.steps[0],
    ],
    [
      "workflowProgress",
      "workflow.schema.json#/$defs/workflowProgress",
      workflow.progress,
    ],
    [
      "operationMemory",
      "integration.schema.json#/$defs/operationMemory",
      checkpoints.find(({ id }) => id === "broadcasting").checkpoint.payload.memory,
    ],
    [
      "chainSwitchProposal",
      "integration.schema.json#/$defs/chainSwitchProposal",
      integration.hashFixtures.chainSwitchProposal,
    ],
    [
      "continueTransition",
      "integration.schema.json#/$defs/continueTransition",
      transitions.find(({ id }) => id === "continue-validating").transition,
    ],
    [
      "permissionStoreCommittingCheckpointData",
      "integration.schema.json#/$defs/permissionStoreCommittingCheckpointData",
      lifecycle.fixture.artifacts.permissionCommitting,
    ],
    [
      "providerSessionCommittingCheckpointData",
      "integration.schema.json#/$defs/providerSessionCommittingCheckpointData",
      lifecycle.fixture.artifacts.committing,
    ],
  ];
  for (const [name, reference, value] of draft3DefinitionCases) {
    validate(reference, value, `Draft.3 definition ${name}`);
    validateRejects(
      reference,
      { ...structuredClone(value), __unexpected: true },
      `Draft.3 definition ${name}`,
      "additionalProperties",
    );
  }

  for (const vector of readJson(root, "test-vectors/invalid.json").vectors) {
    const compiled = validator(vector.schema);
    let instance = vector.instance;
    if (vector.checkpointId) {
      instance = checkpoints.find(
        (checkpoint) => checkpoint.id === vector.checkpointId,
      ).checkpoint;
    } else if (vector.transitionId) {
      instance = transitions.find(
        (transition) => transition.id === vector.transitionId,
      ).transition;
    }
    if (vector.mutation) instance = mutateJsonPointer(instance, vector.mutation);
    if (compiled(instance)) {
      throw new Error(`Invalid vector was accepted: ${vector.id}`);
    }
    if (!compiled.errors.some((error) => error.keyword === vector.expectedKeyword)) {
      throw new Error(
        `Invalid vector ${vector.id} did not produce ${vector.expectedKeyword}: ${JSON.stringify(compiled.errors)}`,
      );
    }
    negativeCount += 1;
  }

  return {
    schemas: schemas.length,
    definitions: definitionCount,
    registries: registryCount,
    positive: positiveCount,
    negative: negativeCount,
  };
}
