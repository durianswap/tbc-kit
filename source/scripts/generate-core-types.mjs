import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaDirectory = path.join(root, "schemas");
const defaultOutput = path.join(
  root,
  "packages/core/src/generated/protocol-types.ts",
);

const CORE_ROOTS = Object.freeze({
  transactionRequest: "transaction-request.schema.json#/$defs/transactionRequest",
  preparedTransactionRequest:
    "prepared-transaction.schema.json#/$defs/preparedTransactionRequest",
  preparedWorkflowRequest: "prepared-workflow.schema.json#/$defs/request",
  workflowResult: "workflow.schema.json#/$defs/result",
  workflowSendResult: "workflow.schema.json#/$defs/sendResult",
  signedTransactionBundle:
    "transaction-request.schema.json#/$defs/signedTransactionBundle",
  operationCheckpoint: "integration.schema.json#/$defs/operationCheckpoint",
  coreTransition: "integration.schema.json#/$defs/coreTransition",
  startInput: "integration.schema.json#/$defs/startInput",
  resumeInput: "integration.schema.json#/$defs/resumeInput",
  commitAckInput: "integration.schema.json#/$defs/commitAckInput",
  cancelInput: "integration.schema.json#/$defs/cancelInput",
  portError: "integration.schema.json#/$defs/portError",
  normalizeRequestParams: "integration.schema.json#/$defs/normalizeRequestParams",
  normalizeRequestResult: "integration.schema.json#/$defs/normalizeRequestResult",
  planParams: "integration.schema.json#/$defs/planParams",
  planResult: "integration.schema.json#/$defs/planResult",
  validateParams: "integration.schema.json#/$defs/validateParams",
  validationResult: "integration.schema.json#/$defs/validationResult",
  finalizeParams: "integration.schema.json#/$defs/finalizeParams",
  finalizeResult: "integration.schema.json#/$defs/finalizeResult",
  accountsResolveParams: "integration.schema.json#/$defs/accountsResolveParams",
  accountsResolveResult: "integration.schema.json#/$defs/accountsResolveResult",
  chainDataResolveParams: "integration.schema.json#/$defs/chainDataResolveParams",
  chainDataResolveResult: "integration.schema.json#/$defs/chainDataResolveResult",
  policyResolveParams: "integration.schema.json#/$defs/policyResolveParams",
  policyResolveResult: "integration.schema.json#/$defs/policyResolveResult",
  permissionStoreLoadParams:
    "integration.schema.json#/$defs/permissionStoreLoadParams",
  permissionStoreLoadResult:
    "integration.schema.json#/$defs/permissionStoreLoadResult",
  permissionStoreCommitParams:
    "integration.schema.json#/$defs/permissionStoreCommitParams",
  permissionStoreCommitResult:
    "integration.schema.json#/$defs/permissionStoreCommitResult",
  approvalRequestParams: "integration.schema.json#/$defs/approvalRequestParams",
  approvalRequestResult: "integration.schema.json#/$defs/approvalRequestResult",
  signerSignParams: "integration.schema.json#/$defs/signerSignParams",
  signerSignResult: "integration.schema.json#/$defs/signerSignResult",
  cryptoExecuteParams: "integration.schema.json#/$defs/cryptoExecuteParams",
  cryptoExecuteResult: "integration.schema.json#/$defs/cryptoExecuteResult",
  reviewedTransactionReviewParams:
    "integration.schema.json#/$defs/reviewedTransactionReviewParams",
  reviewedTransactionReviewResult:
    "integration.schema.json#/$defs/reviewedTransactionReviewResult",
  reviewedTransactionExecuteParams:
    "integration.schema.json#/$defs/reviewedTransactionExecuteParams",
  reviewedTransactionExecuteResult:
    "integration.schema.json#/$defs/reviewedTransactionExecuteResult",
  broadcastSubmitParams: "integration.schema.json#/$defs/broadcastSubmitParams",
  broadcastSubmitResult: "integration.schema.json#/$defs/broadcastSubmitResult",
  broadcastSubmitBatchParams:
    "integration.schema.json#/$defs/broadcastSubmitBatchParams",
  broadcastSubmitBatchResult:
    "integration.schema.json#/$defs/broadcastSubmitBatchResult",
  broadcastReconcileParams:
    "integration.schema.json#/$defs/broadcastReconcileParams",
  broadcastReconcileResult:
    "integration.schema.json#/$defs/broadcastReconcileResult",
  clockNowParams: "integration.schema.json#/$defs/clockNowParams",
  clockNowResult: "integration.schema.json#/$defs/clockNowResult",
  entropyRandomBytesParams:
    "integration.schema.json#/$defs/entropyRandomBytesParams",
  entropyRandomBytesResult:
    "integration.schema.json#/$defs/entropyRandomBytesResult",
});

const PROVIDER_ROOTS = Object.freeze({
  signReviewedTransactionRequest: "wallet-actions.schema.json#/$defs/signReviewedTransactionRequest",
  encryptRequest: "wallet-actions.schema.json#/$defs/encryptRequest",
  decryptRequest: "wallet-actions.schema.json#/$defs/decryptRequest",
  encryptResult: "wallet-actions.schema.json#/$defs/encryptResult",
  decryptResult: "wallet-actions.schema.json#/$defs/decryptResult",
  jsonRpcId: "provider.schema.json#/$defs/jsonRpcId",
  request: "provider.schema.json#/$defs/request",
  response: "provider.schema.json#/$defs/response",
  providerError: "provider.schema.json#/$defs/providerError",
  providerEvent: "provider.schema.json#/$defs/providerEvent",
  providerCompletion: "provider.schema.json#/$defs/providerCompletion",
  cancellationReason: "provider.schema.json#/$defs/cancellationReason",
  chainIdResult: "common.schema.json#/$defs/chainId",
  accountsResult: "provider.schema.json#/$defs/addressArray",
  requestAccountsResult: "provider.schema.json#/$defs/nonEmptyAddressArray",
  getAccountParams: "provider.schema.json#/$defs/getAccountParams",
  getAccountResult: "provider.schema.json#/$defs/account",
  getCapabilitiesParams: "provider.schema.json#/$defs/getCapabilitiesParams",
  getCapabilitiesResult: "provider.schema.json#/$defs/capabilities",
  switchChainParams: "provider.schema.json#/$defs/switchChainParams",
  nullResult: "provider.schema.json#/$defs/nullResult",
  messageRequest: "signing.schema.json#/$defs/messageRequest",
  messageSignature: "signing.schema.json#/$defs/messageSignature",
  typedDataRequest: "signing.schema.json#/$defs/typedDataRequest",
  typedDataSignature: "signing.schema.json#/$defs/typedDataSignature",
  transactionRequest:
    "transaction-request.schema.json#/$defs/transactionRequest",
  preparedTransactionRequest:
    "prepared-transaction.schema.json#/$defs/preparedTransactionRequest",
  signedTransactionBundle:
    "transaction-request.schema.json#/$defs/signedTransactionBundle",
  submittedTransactionBundle:
    "transaction-request.schema.json#/$defs/submittedTransactionBundle",
  workflowRequest: "workflow.schema.json#/$defs/request",
  preparedWorkflowRequest: "prepared-workflow.schema.json#/$defs/request",
  workflowResult: "workflow.schema.json#/$defs/result",
  workflowSendResult: "workflow.schema.json#/$defs/sendResult",
  permissionArray: "permissions.schema.json#/$defs/permissionArray",
  nonEmptyPermissionArray:
    "permissions.schema.json#/$defs/nonEmptyPermissionArray",
  requestPermissionsParams:
    "permissions.schema.json#/$defs/requestPermissionsParams",
  connectEvent: "provider.schema.json#/$defs/connectInfo",
  disconnectEvent: "provider.schema.json#/$defs/disconnectError",
  chainChangedEvent: "common.schema.json#/$defs/chainId",
  accountsChangedEvent: "provider.schema.json#/$defs/addressArray",
  permissionsChangedEvent:
    "permissions.schema.json#/$defs/permissionArray",
  capabilitiesChangedEvent: "provider.schema.json#/$defs/capabilities",
});

const SCHEMA_PREFIXES = Object.freeze({
  "common.schema.json": "Common",
  "integration.schema.json": "Integration",
  "permissions.schema.json": "Permissions",
  "prepared-transaction.schema.json": "PreparedTransaction",
  "prepared-workflow.schema.json": "PreparedWorkflow",
  "provider.schema.json": "Provider",
  "reviewed-transaction.schema.json": "ReviewedTransaction",
  "signing.schema.json": "Signing",
  "transaction-request.schema.json": "Transaction",
  "workflow.schema.json": "Workflow",
  "wallet-actions.schema.json": "WalletActions",
});

const SUPPORTED_KEYWORDS = new Set([
  "$comment",
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "$tbcBinding",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "default",
  "dependentRequired",
  "description",
  "else",
  "enum",
  "examples",
  "format",
  "if",
  "items",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "not",
  "oneOf",
  "pattern",
  "prefixItems",
  "properties",
  "propertyNames",
  "required",
  "then",
  "title",
  "type",
  "uniqueItems",
]);

function parseArguments(argv) {
  let check = false;
  let output;
  let profile = "core";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--output") {
      const value = argv[index + 1];
      if (value === undefined) throw new TypeError("--output requires a path");
      output = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--profile") {
      const value = argv[index + 1];
      if (!['core', 'provider'].includes(value)) {
        throw new TypeError("--profile must be core or provider");
      }
      profile = value;
      index += 1;
      continue;
    }
    throw new TypeError(`unknown argument: ${argument}`);
  }
  return Object.freeze({
    check,
    output: output ?? (profile === "core"
      ? defaultOutput
      : path.join(root, "packages/provider/src/generated/provider-types.ts")),
    profile,
  });
}

function pascalCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
}

function definitionName(filename, definition) {
  const prefix = SCHEMA_PREFIXES[filename];
  if (prefix === undefined) {
    throw new TypeError(`unsupported schema document in public type graph: ${filename}`);
  }
  return `${prefix}${pascalCase(definition)}`;
}

function decodePointerSegment(segment) {
  return decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
}

function literal(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  return "unknown";
}

function meaningfulSchemaKeys(schema, excluded = []) {
  const ignored = new Set([
    "$comment",
    "$defs",
    "$id",
    "$schema",
    "$tbcBinding",
    "default",
    "description",
    "examples",
    "format",
    "maxContains",
    "maxItems",
    "maxLength",
    "maxProperties",
    "maximum",
    "minContains",
    "minItems",
    "minLength",
    "minProperties",
    "minimum",
    "pattern",
    "propertyNames",
    "title",
    "uniqueItems",
    "contains",
    "dependentRequired",
    "if",
    "then",
    "else",
    "not",
    ...excluded,
  ]);
  return Object.keys(schema).filter((key) => !ignored.has(key));
}

async function generatedSource({ roots, interfaceName }) {
  const documents = new Map();
  const queuedDefinitions = new Map();
  const renderedDefinitions = new Map();

  async function document(filename) {
    const existing = documents.get(filename);
    if (existing !== undefined) return existing;
    const parsed = JSON.parse(
      await readFile(path.join(schemaDirectory, filename), "utf8"),
    );
    documents.set(filename, parsed);
    return parsed;
  }

  async function reference(ref, currentFilename) {
    const [filePart, fragment = ""] = ref.split("#", 2);
    const filename = filePart === "" ? currentFilename : path.basename(filePart);
    const segments = fragment
      .split("/")
      .filter(Boolean)
      .map(decodePointerSegment);
    if (segments.length !== 2 || segments[0] !== "$defs") {
      throw new TypeError(`public type generator only supports $defs refs: ${ref}`);
    }
    const definition = segments[1];
    const name = definitionName(filename, definition);
    const key = `${filename}#/$defs/${definition}`;
    if (!queuedDefinitions.has(key)) {
      const target = await document(filename);
      const schema = target.$defs?.[definition];
      if (schema === undefined) throw new TypeError(`unresolved Schema ref: ${key}`);
      queuedDefinitions.set(key, { filename, name, schema });
    }
    return name;
  }

  function assertSupportedKeywords(schema, location) {
    for (const key of Object.keys(schema)) {
      if (!SUPPORTED_KEYWORDS.has(key)) {
        throw new TypeError(`unsupported structural keyword ${key} at ${location}`);
      }
    }
  }

  async function renderObject(schema, filename, location) {
    const required = new Set(schema.required ?? []);
    const properties = schema.properties ?? {};
    const lines = [];
    for (const name of Object.keys(properties).sort()) {
      const optional = required.has(name) ? "" : "?";
      const value = await render(
        properties[name],
        filename,
        `${location}/properties/${name}`,
      );
      lines.push(`  readonly ${JSON.stringify(name)}${optional}: ${value};`);
    }
    if (schema.additionalProperties !== false) {
      let value = "unknown";
      if (
        Object.keys(properties).length === 0 &&
        typeof schema.additionalProperties === "object"
      ) {
        value = await render(
          schema.additionalProperties,
          filename,
          `${location}/additionalProperties`,
        );
      }
      lines.push(`  readonly [key: string]: ${value};`);
    }
    return lines.length === 0 ? "Record<string, never>" : `{\n${lines.join("\n")}\n}`;
  }

  async function renderArray(schema, filename, location) {
    if (Array.isArray(schema.prefixItems)) {
      const tuple = await Promise.all(
        schema.prefixItems.map((item, index) =>
          render(item, filename, `${location}/prefixItems/${index}`),
        ),
      );
      if (schema.items === false || schema.items === undefined) {
        return `readonly [${tuple.join(", ")}]`;
      }
      const rest = await render(schema.items, filename, `${location}/items`);
      return `readonly [${tuple.join(", ")}, ...${rest}[]]`;
    }
    const item =
      schema.items === undefined
        ? "unknown"
        : await render(schema.items, filename, `${location}/items`);
    return `readonly (${item})[]`;
  }

  async function render(schema, filename, location) {
    if (schema === true) return "unknown";
    if (schema === false) return "never";
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
      throw new TypeError(`invalid Schema node at ${location}`);
    }
    assertSupportedKeywords(schema, location);

    const pieces = [];
    if (schema.$ref !== undefined) {
      pieces.push(await reference(schema.$ref, filename));
    }
    if (schema.const !== undefined) pieces.push(literal(schema.const));
    if (Array.isArray(schema.enum)) {
      pieces.push(schema.enum.map(literal).join(" | ") || "never");
    }
    for (const keyword of ["oneOf", "anyOf"]) {
      if (Array.isArray(schema[keyword])) {
        const members = await Promise.all(
          schema[keyword].map((item, index) =>
            render(item, filename, `${location}/${keyword}/${index}`),
          ),
        );
        pieces.push(`(${members.join(" | ")})`);
      }
    }
    if (Array.isArray(schema.allOf)) {
      const members = await Promise.all(
        schema.allOf.map((item, index) =>
          render(item, filename, `${location}/allOf/${index}`),
        ),
      );
      pieces.push(...members.map((member) => `(${member})`));
    }

    const ownKeys = meaningfulSchemaKeys(schema, [
      "$ref",
      "allOf",
      "anyOf",
      "const",
      "enum",
      "oneOf",
    ]);
    if (ownKeys.length > 0) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const ownTypes = [];
      for (const type of types) {
        switch (type) {
          case "array":
            ownTypes.push(await renderArray(schema, filename, location));
            break;
          case "boolean":
            ownTypes.push("boolean");
            break;
          case "integer":
          case "number":
            ownTypes.push("number");
            break;
          case "null":
            ownTypes.push("null");
            break;
          case "object":
            ownTypes.push(await renderObject(schema, filename, location));
            break;
          case "string":
            ownTypes.push("string");
            break;
          case undefined:
            if (schema.properties !== undefined) {
              ownTypes.push(await renderObject(schema, filename, location));
            }
            break;
          default:
            throw new TypeError(`unsupported Schema type ${String(type)} at ${location}`);
        }
      }
      if (ownTypes.length > 0) pieces.push(`(${ownTypes.join(" | ")})`);
    }
    return pieces.length === 0 ? "unknown" : pieces.join(" & ");
  }

  const rootProperties = [];
  for (const [property, ref] of Object.entries(roots)) {
    rootProperties.push(
      `  readonly ${JSON.stringify(property)}: ${await reference(
        ref,
        "integration.schema.json",
      )};`,
    );
  }

  while (renderedDefinitions.size < queuedDefinitions.size) {
    const pending = [...queuedDefinitions.entries()].find(
      ([key]) => !renderedDefinitions.has(key),
    );
    if (pending === undefined) break;
    const [key, entry] = pending;
    renderedDefinitions.set(
      key,
      await render(entry.schema, entry.filename, key),
    );
  }

  const definitions = [...queuedDefinitions.entries()]
    .map(([key, entry]) => ({ name: entry.name, source: renderedDefinitions.get(key) }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, source }) => `type ${name} = ${source};`)
    .join("\n\n");

  return [
    "/* This file is generated from the TWS v1 Candidate JSON Schemas. Do not edit by hand. */",
    "",
    definitions,
    "",
    `export interface ${interfaceName} {`,
    ...rootProperties,
    "}",
    "",
  ].join("\n");
}

async function main() {
  const { check, output, profile } = parseArguments(process.argv.slice(2));
  const source = await generatedSource({
    roots: profile === "core" ? CORE_ROOTS : PROVIDER_ROOTS,
    interfaceName: profile === "core" ? "TwsProtocolSchema" : "TwsProviderSchema",
  });
  if (check) {
    const current = await readFile(output, "utf8").catch(() => undefined);
    if (current !== source) {
      const profileName = profile === "core" ? "Core" : "Provider";
      process.stderr.write(
        `generated ${profileName} types are stale; run npm run generate:${profile}-types\n`,
      );
      process.exitCode = 1;
    }
    return;
  }
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, source, "utf8");
    await rename(temporary, output);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

await main();
