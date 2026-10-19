import fs from "node:fs";
import path from "node:path";

const ignoredDirectories = new Set([".git", ".worktrees", "node_modules"]);

function walkFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) walkFiles(absolutePath, files);
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files.sort();
}

function localLinkTarget(rawTarget) {
  const trimmed = rawTarget.trim();
  const target = trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1)
    : trimmed;
  if (!target || /^(?:https?:|mailto:|#)/.test(target)) return undefined;
  return decodeURIComponent(target.split("#", 1)[0]);
}

function readRepositoryJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function readStandard(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assertCodeMentions(source, values, label) {
  const missing = values.filter((value) => !source.includes(`\`${value}\``));
  if (missing.length !== 0) {
    throw new Error(`${label} missing normative names: ${missing.join(", ")}`);
  }
  return values.length;
}

function readJsonFenceByKind(source, kind, label) {
  for (const match of source.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
    const value = JSON.parse(match[1]);
    if (value.kind === kind) return value;
  }
  throw new Error(`${label} missing normative JSON contract: ${kind}`);
}

function assertExactArray(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the machine-readable exact set`);
  }
  return actual.length;
}

export function runDocumentConformance(root) {
  const allFiles = walkFiles(root);
  const markdownFiles = allFiles.filter((file) => file.endsWith(".md"));
  const jsonFiles = allFiles.filter((file) => file.endsWith(".json"));
  let localLinks = 0;
  let jsonBlocks = 0;

  for (const markdownPath of markdownFiles) {
    const source = fs.readFileSync(markdownPath, "utf8");
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = localLinkTarget(match[1]);
      if (!target) continue;
      const resolved = path.resolve(path.dirname(markdownPath), target);
      if (!fs.existsSync(resolved)) {
        throw new Error(
          `${path.relative(root, markdownPath)} has a missing local link: ${target}`,
        );
      }
      localLinks += 1;
    }
    for (const match of source.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
      try {
        JSON.parse(match[1]);
      } catch (error) {
        throw new Error(
          `${path.relative(root, markdownPath)} has invalid fenced JSON: ${error.message}`,
        );
      }
      jsonBlocks += 1;
    }
  }

  for (const jsonPath of jsonFiles) {
    try {
      JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    } catch (error) {
      throw new Error(
        `${path.relative(root, jsonPath)} is invalid JSON: ${error.message}`,
      );
    }
  }

  const hashRegistry = readRepositoryJson(root, "registry/hash-bindings.json");
  const stateRegistry = readRepositoryJson(
    root,
    "registry/operation-states.json",
  );
  const portRegistry = readRepositoryJson(
    root,
    "registry/integration-ports.json",
  );
  const methodRegistry = readRepositoryJson(root, "registry/methods.json");
  const integrationSchema = readRepositoryJson(
    root,
    "schemas/integration.schema.json",
  );
  const identifiers = readStandard(root, "standards/TWS-002-identifiers.md");
  const provider = readStandard(root, "standards/TWS-001-provider.md");
  const signing = readStandard(root, "standards/TWS-005-signing.md");
  const integration = readStandard(
    root,
    "standards/TWS-011-wallet-integration.md",
  );
  const legacy = readStandard(
    root,
    "standards/TWS-008-legacy-compatibility.md",
  );
  const readme = readStandard(root, "README.md");

  const normativeHashBindings = assertCodeMentions(
    identifiers,
    hashRegistry.bindings.map(({ name }) => name),
    "TWS-002",
  );
  const normativeStates = assertCodeMentions(
    integration,
    stateRegistry.states.map(({ name }) => name),
    "TWS-011 operation states",
  );
  const normativeCancellationReasons = assertCodeMentions(
    provider,
    stateRegistry.cancellationReasons.map(({ reason }) => reason),
    "TWS-001 cancellation reasons",
  );
  const hostPorts = assertCodeMentions(
    integration,
    portRegistry.ports.map(({ name }) => name),
    "TWS-011 Host Ports",
  );
  const hostOperations = assertCodeMentions(
    integration,
    portRegistry.ports.flatMap((port) =>
      port.operations.map(({ name }) => name),
    ),
    "TWS-011 Host Port operations",
  );
  const coreContract = readJsonFenceByKind(
    integration,
    "tws-draft3-core-contract",
    "TWS-011",
  );
  const coreMethods = assertExactArray(
    coreContract.coreMethods,
    integrationSchema.$defs.coreMethodName.enum,
    "TWS-011 Core methods",
  );
  const coreTransitions = assertExactArray(
    coreContract.coreTransitions,
    integrationSchema.$defs.coreTransition.oneOf.map(
      ({ $ref }) => integrationSchema.$defs[$ref.split("/").at(-1)]
        .properties.kind.const,
    ),
    "TWS-011 Core transitions",
  );
  const methodCategories = assertExactArray(
    coreContract.methodCategories,
    stateRegistry.methodPaths.map(({ category }) => category),
    "TWS-011 method categories",
  );
  const authorityInputs = assertExactArray(
    coreContract.providerAuthorityInputs,
    integrationSchema.$defs.coreMethodName.enum.map((method) =>
      `${method}Input.currentSession`),
    "TWS-011 Provider authority inputs",
  );
  const committingKinds = assertExactArray(
    coreContract.committingKinds,
    integrationSchema.$defs.committingCheckpointData.oneOf.map(
      ({ $ref }) => integrationSchema.$defs[$ref.split("/").at(-1)]
        .properties.kind.const,
    ),
    "TWS-011 committing kinds",
  );
  const transactionEngineFacades = assertCodeMentions(
    integration,
    ["normalizeRequest", "plan", "validate", "finalize"],
    "TWS-011 Transaction Engine facade",
  );

  const approvalMethods = methodRegistry.methods.filter(
    ({ approval }) => approval !== "none",
  );
  for (const method of approvalMethods) {
    const tableRow = `| \`${method.name}\` | \`${method.operationKind}\` |`;
    if (!signing.includes(tableRow)) {
      throw new Error(`TWS-005 approval mapping missing: ${method.name}`);
    }
  }
  const approvalPreviewKinds = integrationSchema.$defs.approvalPreview.oneOf.map(
    ({ $ref }) => {
      const definition = $ref.split("/").at(-1);
      return integrationSchema.$defs[definition].properties.operationKind.const;
    },
  );
  const approvalPreviews = assertCodeMentions(
    signing,
    approvalPreviewKinds,
    "TWS-005 Approval Preview",
  );

  const compatibilityPhrases = [
    "EIP-1193 Provider、错误和事件语义",
    "严格 EIP-2255 permissions",
    "Wallet Standard 用于 TBC discovery",
    "EIP-6963 仅用于 EVM",
    "JSON-RPC 2.0 strict single-request profile",
    "`tbc:` 是 TWS 本地 CAIP-compatible namespace，外部注册待完成",
    "JCS 即 RFC 8785",
  ];
  // Product navigation belongs in README; protocol claims have one linked home.
  const compatibilityPath = "docs/reference/protocol-compatibility.md";
  if (!readme.includes(`](${compatibilityPath})`)) {
    throw new Error("README must link the normative protocol compatibility scope");
  }
  const compatibility = readStandard(root, compatibilityPath);
  for (const phrase of compatibilityPhrases) {
    if (!compatibility.includes(phrase)) {
      throw new Error(`Protocol compatibility claim missing: ${phrase}`);
    }
  }
  const normativeText = markdownFiles
    .filter((file) => file.includes(`${path.sep}standards${path.sep}`))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  const forbiddenClaims = [
    /TBC 使用 EIP-6963/,
    /EIP-6963 用于 TBC/,
    /(?:^|[^不])支持 JSON-RPC batch/m,
    /(?:^|[^不])支持 JSON-RPC notification/m,
  ];
  for (const pattern of forbiddenClaims) {
    if (pattern.test(normativeText)) {
      throw new Error(`Forbidden compatibility claim: ${pattern}`);
    }
  }
  if (/tbc[^\n。]{0,64}已注册[^\n。]{0,32}CAIP/i.test(normativeText)) {
    throw new Error("TWS documents claim external CAIP registration");
  }
  for (const boundary of [
    "`execute(request)` 不属于 TWS 公共 Core 接口",
    "`wallet-vault/1` 只能存在于某个 Wallet Host 的受信任实现内部，不得成为 TWS 公共接口",
  ]) {
    if (!legacy.includes(boundary)) {
      throw new Error(`Legacy public boundary missing: ${boundary}`);
    }
  }

  return {
    markdown: markdownFiles.length,
    localLinks,
    jsonBlocks,
    jsonFiles: jsonFiles.length,
    normativeHashBindings,
    normativeStates,
    normativeCancellationReasons,
    hostPorts,
    hostOperations,
    coreMethods,
    coreTransitions,
    methodCategories,
    authorityInputs,
    committingKinds,
    transactionEngineFacades,
    approvalMappings: approvalMethods.length,
    approvalPreviews,
    compatibilityClaims: compatibilityPhrases.length,
  };
}
