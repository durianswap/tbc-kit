import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPROVED_SOURCE_MAP,
  SDK_LICENSE,
  SDK_LICENSE_SHA256,
  SDK_NAME,
  SDK_REPOSITORY,
  SDK_VERSION,
  SOURCE_COMMIT,
  SOURCE_REPOSITORY,
  SOURCE_SUBTREE,
} from "./rust-provenance-config.mjs";
import {
  listGitTree,
  readGitObject,
  resolveGitHead,
} from "./git-object-reader.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultPackageRoot = path.resolve(path.dirname(modulePath), "..");

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const PRODUCTION_POLICY = deepFreeze({
  sourceCommit: SOURCE_COMMIT,
  sourceRepository: SOURCE_REPOSITORY,
  sourceSubtree: SOURCE_SUBTREE,
  sdk: {
    name: SDK_NAME,
    version: SDK_VERSION,
    license: SDK_LICENSE,
    repository: SDK_REPOSITORY,
    licenseSha256: SDK_LICENSE_SHA256,
  },
  sourceMap: APPROVED_SOURCE_MAP,
});

export async function fileDigest(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export function provenanceEntry(relativePath, sha256, status = "unchanged") {
  return Object.freeze({ path: relativePath, sha256, status });
}

function bufferDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sourceArgument(argv) {
  if (argv.length !== 2 || argv[0] !== "--source" || !argv[1]) {
    throw new Error("usage: import-rust-sdk.mjs --source <wallet-checkout>");
  }
  return path.resolve(argv[1]);
}

function assertImmutable(value, location = "policy") {
  if (!value || typeof value !== "object" || !Object.isFrozen(value)) {
    throw new Error(`${location} must be deeply immutable`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (entry && typeof entry === "object") assertImmutable(entry, `${location}.${key}`);
  }
}

function destinationPaths(destinationPackageRoot) {
  const rustRoot = path.join(destinationPackageRoot, "rust");
  const provenanceRoot = path.join(rustRoot, "provenance");
  const licensesRoot = path.join(rustRoot, "LICENSES");
  return {
    vendorRoot: path.join(rustRoot, "vendor/tbc-sdk"),
    upstreamPath: path.join(provenanceRoot, "upstream.json"),
    sourceMapPath: path.join(provenanceRoot, "source-map.json"),
    patchLedgerPath: path.join(provenanceRoot, "patch-ledger.json"),
    retainedLicensePath: path.join(licensesRoot, "tbc-sdk-MIT.txt"),
    provenanceRoot,
    licensesRoot,
  };
}

function rustFunctionExists(source, functionName) {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bfn\\s+${escaped}\\s*\\(`).test(source);
}

async function existingPath(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertOneShotDestination(paths, destinationPackageRoot) {
  const guarded = [
    paths.vendorRoot,
    paths.upstreamPath,
    paths.sourceMapPath,
    paths.patchLedgerPath,
    paths.retainedLicensePath,
  ];
  for (const filePath of guarded) {
    if (await existingPath(filePath)) {
      throw new Error(`import destination already exists: ${path.relative(destinationPackageRoot, filePath)}`);
    }
  }
}

export async function importRustSdk({ sourceRoot, destinationPackageRoot, policy }) {
  assertImmutable(policy);
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedDestination = path.resolve(destinationPackageRoot);
  const paths = destinationPaths(resolvedDestination);
  await assertOneShotDestination(paths, resolvedDestination);

  const actualCommit = resolveGitHead(resolvedSourceRoot);
  if (actualCommit !== policy.sourceCommit) {
    throw new Error(`source checkout must be ${policy.sourceCommit}, got ${actualCommit}`);
  }

  const repositoryPaths = listGitTree(
    resolvedSourceRoot,
    policy.sourceCommit,
    policy.sourceSubtree,
  );
  if (repositoryPaths.length === 0) {
    throw new Error(`source Git tree is empty: ${policy.sourceCommit}:${policy.sourceSubtree}`);
  }

  const copiedFiles = repositoryPaths.map((repositoryPath) => {
    const prefix = `${policy.sourceSubtree}/`;
    if (!repositoryPath.startsWith(prefix)) {
      throw new Error(`source Git path is outside subtree: ${repositoryPath}`);
    }
    const relativePath = repositoryPath.slice(prefix.length);
    const bytes = readGitObject(resolvedSourceRoot, policy.sourceCommit, repositoryPath);
    return {
      relativePath,
      bytes,
      provenance: provenanceEntry(relativePath, bufferDigest(bytes)),
    };
  });

  const sourceCache = new Map();
  for (const mapping of policy.sourceMap) {
    for (const source of mapping.sources) {
      let bytes = sourceCache.get(source.path);
      if (!bytes) {
        bytes = readGitObject(resolvedSourceRoot, policy.sourceCommit, source.path);
        sourceCache.set(source.path, bytes);
      }
      if (
        source.repository !== policy.sourceRepository
        || source.commit !== policy.sourceCommit
        || bufferDigest(bytes) !== source.sha256
      ) {
        throw new Error(`pinned source differs from immutable policy: ${source.path}`);
      }
      const text = bytes.toString("utf8");
      for (const functionName of source.sourceFunctions) {
        if (!rustFunctionExists(text, functionName)) {
          throw new Error(`policy source function is absent from pinned object: ${source.path}#${functionName}`);
        }
      }
    }
  }

  const license = copiedFiles.find((entry) => entry.relativePath === "LICENSE");
  if (!license) throw new Error("pinned SDK tree does not contain LICENSE");
  if (bufferDigest(license.bytes) !== policy.sdk.licenseSha256) {
    throw new Error("pinned SDK license differs from immutable policy");
  }

  const upstream = {
    repository: policy.sourceRepository,
    walletCommit: policy.sourceCommit,
    subtree: policy.sourceSubtree,
    crate: {
      name: policy.sdk.name,
      version: policy.sdk.version,
      license: policy.sdk.license,
      repository: policy.sdk.repository,
    },
    files: copiedFiles.map((entry) => entry.provenance),
  };

  await mkdir(paths.vendorRoot, { recursive: true });
  for (const entry of copiedFiles) {
    const destinationPath = path.join(paths.vendorRoot, entry.relativePath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, entry.bytes);
  }
  await mkdir(paths.licensesRoot, { recursive: true });
  await writeFile(paths.retainedLicensePath, license.bytes);
  await mkdir(paths.provenanceRoot, { recursive: true });
  await writeFile(paths.upstreamPath, canonicalJson(upstream));
  await writeFile(paths.sourceMapPath, canonicalJson(policy.sourceMap));
  await writeFile(paths.patchLedgerPath, canonicalJson([]));
}

const invokedPath = process.argv[1]
  ? await realpath(path.resolve(process.argv[1])).catch(() => path.resolve(process.argv[1]))
  : undefined;
const importedPath = await realpath(modulePath).catch(() => modulePath);

if (invokedPath === importedPath) {
  try {
    await importRustSdk({
      sourceRoot: sourceArgument(process.argv.slice(2)),
      destinationPackageRoot: defaultPackageRoot,
      policy: PRODUCTION_POLICY,
    });
    console.log(`Imported ${SDK_NAME} ${SDK_VERSION} from wallet commit ${SOURCE_COMMIT}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
