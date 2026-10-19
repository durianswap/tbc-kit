import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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

const SHA256 = /^[0-9a-f]{64}$/;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageTargetPrefix = "packages/tbc-engine/";
const rustRoot = path.join(packageRoot, "rust");
const vendorRoot = path.join(rustRoot, "vendor/tbc-sdk");
const provenanceRoot = path.join(rustRoot, "provenance");

async function fileDigest(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ))) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, absolutePath));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolutePath).split(path.sep).join("/"));
    }
  }
  return files;
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fail(message) {
  throw new Error(message);
}

function isAbsoluteManifestPath(value) {
  return path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /^[A-Za-z]:[\\/]/.test(value);
}

function assertNoAbsolutePaths(value, location) {
  if (typeof value === "string") {
    if (isAbsoluteManifestPath(value)) fail(`${location} contains an absolute path: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoAbsolutePaths(entry, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertNoAbsolutePaths(entry, `${location}.${key}`);
    }
  }
}

async function readCanonicalJson(name) {
  const text = await readFile(path.join(provenanceRoot, name), "utf8");
  const value = JSON.parse(text);
  if (text !== canonicalJson(value)) fail(`${name} is not canonical JSON with a trailing newline`);
  assertNoAbsolutePaths(value, name);
  return value;
}

function assertDigest(value, location) {
  if (!SHA256.test(value)) fail(`${location} must be a lowercase SHA-256 digest`);
}

function assertRelativePath(value, location) {
  if (typeof value !== "string" || value.length === 0 || isAbsoluteManifestPath(value)) {
    fail(`${location} must be a non-empty relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || value === ".." || value.startsWith("../")) {
    fail(`${location} must be a normalized repository-relative path`);
  }
}

function sameStringList(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index]);
}

function cargoPackageMetadata(text) {
  const match = text.match(/(?:^|\n)\[package\]\n([\s\S]*?)(?=\n\[|$)/);
  if (!match) fail("vendored Cargo.toml is missing [package]");
  const value = (name) => {
    const field = match[1].match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"\\s*$`, "m"));
    if (!field) fail(`vendored Cargo.toml is missing package.${name}`);
    return field[1];
  };
  return {
    name: value("name"),
    version: value("version"),
    license: value("license"),
    repository: value("repository"),
  };
}

function rawStringOpening(source, index) {
  if (index > 0 && /[A-Za-z0-9_]/.test(source[index - 1])) return undefined;
  const prefixes = ["br", "cr", "r"];
  const prefix = prefixes.find((candidate) => source.startsWith(candidate, index));
  if (!prefix) return undefined;
  let cursor = index + prefix.length;
  let hashes = 0;
  while (source[cursor] === "#") {
    hashes += 1;
    cursor += 1;
  }
  if (source[cursor] !== '"') return undefined;
  return { hashes, quote: cursor };
}

function charLiteralEnd(source, index) {
  let escaped = false;
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === "\n" || character === "\r") return -1;
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "'") {
      return cursor;
    }
  }
  return -1;
}

function rustCodeOnly(source) {
  let code = "";
  let index = 0;
  const mask = (character) => character === "\n" ? "\n" : " ";
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      while (index < source.length && source[index] !== "\n") {
        code += " ";
        index += 1;
      }
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 0;
      while (index < source.length) {
        if (source.startsWith("/*", index)) {
          code += "  ";
          index += 2;
          depth += 1;
        } else if (source.startsWith("*/", index)) {
          code += "  ";
          index += 2;
          depth -= 1;
          if (depth === 0) break;
        } else {
          code += mask(source[index]);
          index += 1;
        }
      }
      continue;
    }

    const raw = rawStringOpening(source, index);
    if (raw) {
      const terminator = `"${"#".repeat(raw.hashes)}`;
      while (index <= raw.quote) {
        code += mask(source[index]);
        index += 1;
      }
      while (index < source.length && !source.startsWith(terminator, index)) {
        code += mask(source[index]);
        index += 1;
      }
      if (index < source.length) {
        for (let offset = 0; offset < terminator.length; offset += 1) {
          code += mask(source[index + offset]);
        }
        index += terminator.length;
      }
      continue;
    }

    if (source[index] === '"') {
      code += " ";
      index += 1;
      while (index < source.length) {
        const character = source[index];
        code += mask(character);
        index += 1;
        if (character === "\\" && index < source.length) {
          code += mask(source[index]);
          index += 1;
        } else if (character === '"') {
          break;
        }
      }
      continue;
    }

    if (source[index] === "'") {
      const end = charLiteralEnd(source, index);
      if (end !== -1) {
        while (index <= end) {
          code += mask(source[index]);
          index += 1;
        }
        continue;
      }
    }

    code += source[index];
    index += 1;
  }
  return code;
}

function targetFunctionDeclared(code, functionName) {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(
    `^[ \\t]*(?:pub(?:\\([^)]*\\))?\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]+"\\s+)?fn\\s+${escaped}\\s*(?:<[^>{}]*>)?\\s*\\(`,
    "m",
  );
  return declaration.test(code);
}

function matchingBrace(code, openingBrace) {
  let depth = 0;
  for (let index = openingBrace; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    if (code[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function rustImplRanges(code) {
  const declaration = /^[ \t]*impl(?:\s*<[^>{}\n]*>)?\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*<[^>{}\n]*>)?[^\n{]*\{/gm;
  const ranges = [];
  for (const match of code.matchAll(declaration)) {
    const openingBrace = code.indexOf("{", match.index);
    const closingBrace = matchingBrace(code, openingBrace);
    if (closingBrace !== -1) {
      ranges.push({ owner: match[1], openingBrace, closingBrace });
    }
  }
  return ranges;
}

function sourceFunctionStatus(code, symbol) {
  const parts = symbol.split("::");
  if (
    parts.length > 2
    || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
  ) {
    return "absent";
  }
  const functionName = parts.at(-1);
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(
    `^[ \\t]*(?:pub(?:\\([^)]*\\))?\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]+"\\s+)?fn\\s+${escaped}\\s*(?:<[^>{}]*>)?\\s*\\(`,
    "gm",
  );
  const positions = [...code.matchAll(declaration)].map((match) => match.index);
  const implementations = rustImplRanges(code);
  if (parts.length === 2) {
    return positions.some((position) => implementations.some((implementation) => (
      implementation.owner === parts[0]
      && position > implementation.openingBrace
      && position < implementation.closingBrace
    ))) ? "declared" : "absent";
  }
  const free = positions.some((position) => !implementations.some((implementation) => (
    position > implementation.openingBrace && position < implementation.closingBrace
  )));
  if (free) return "declared";
  return positions.length > 0 ? "unqualified-associated" : "absent";
}

async function verifyAuthenticatedVendorSource(source) {
  const prefix = `${SOURCE_SUBTREE}/`;
  if (!source.path.startsWith(prefix)) {
    fail(`authenticated vendor source is outside the pinned subtree: ${source.path}`);
  }
  const relativePath = source.path.slice(prefix.length);
  assertRelativePath(relativePath, `authenticated source path for ${source.path}`);
  const sourcePath = path.resolve(vendorRoot, relativePath);
  if (!sourcePath.startsWith(`${vendorRoot}${path.sep}`)) {
    fail(`authenticated vendor source escapes the pinned subtree: ${source.path}`);
  }
  let sourceText;
  try {
    sourceText = await readFile(sourcePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") fail(`authenticated source blob is absent: ${source.path}`);
    throw error;
  }
  if (await fileDigest(sourcePath) !== source.sha256) {
    fail(`authenticated source blob digest mismatch: ${source.path}`);
  }
  const sourceCode = rustCodeOnly(sourceText);
  for (const functionName of source.sourceFunctions) {
    const status = sourceFunctionStatus(sourceCode, functionName);
    if (status === "unqualified-associated") {
      fail(`associated source function must be qualified: ${source.path}#${functionName}`);
    }
    if (status !== "declared") {
      fail(`source function is absent: ${source.path}#${functionName}`);
    }
  }
}

async function verifySourceMap(sourceMap) {
  if (!Array.isArray(sourceMap) || sourceMap.length !== APPROVED_SOURCE_MAP.length) {
    fail(`source-map.json must contain exactly ${APPROVED_SOURCE_MAP.length} mappings`);
  }
  const approved = new Map(APPROVED_SOURCE_MAP.map((entry) => [entry.target, entry]));
  const seen = new Set();
  for (const [index, mapping] of sourceMap.entries()) {
    assertRelativePath(mapping.target, `sourceMap[${index}].target`);
    const expected = approved.get(mapping.target);
    if (!expected || seen.has(mapping.target)) fail(`sourceMap[${index}].target is not uniquely approved`);
    seen.add(mapping.target);
    if (mapping.status !== "planned" && mapping.status !== "implemented") {
      fail(`sourceMap[${index}].status must be planned or implemented`);
    }
    if (mapping.status !== expected.status) {
      fail(`sourceMap[${index}].status does not match approved provenance`);
    }
    const engineSpecificFunctions = mapping.engineSpecificFunctions ?? [];
    const expectedEngineSpecificFunctions = expected.engineSpecificFunctions ?? [];
    if (
      !Array.isArray(engineSpecificFunctions)
      || !sameStringList(engineSpecificFunctions, expectedEngineSpecificFunctions)
      || new Set(engineSpecificFunctions).size !== engineSpecificFunctions.length
    ) {
      fail(`sourceMap[${index}].engineSpecificFunctions does not match approved provenance`);
    }
    if (!Array.isArray(mapping.sources) || mapping.sources.length !== expected.sources.length) {
      fail(`sourceMap[${index}].sources does not match approved provenance`);
    }
    for (const [sourceIndex, source] of mapping.sources.entries()) {
      const expectedSource = expected.sources[sourceIndex];
      const location = `sourceMap[${index}].sources[${sourceIndex}]`;
      assertRelativePath(source.path, `${location}.path`);
      assertDigest(source.sha256, `${location}.sha256`);
      if (
        source.repository !== SOURCE_REPOSITORY
        || source.commit !== SOURCE_COMMIT
        || source.path !== expectedSource.path
        || source.sha256 !== expectedSource.sha256
        || !sameStringList(source.sourceFunctions, expectedSource.sourceFunctions)
        || !sameStringList(source.targetFunctions, expectedSource.targetFunctions)
        || source.verification !== expectedSource.verification
      ) {
        fail(`${location} does not match the approved pinned source object and functions`);
      }
      if (source.verification !== undefined && source.verification !== "authenticated-vendor") {
        fail(`${location}.verification is not an approved source verification mode`);
      }
      if (source.verification === "authenticated-vendor") {
        await verifyAuthenticatedVendorSource(source);
      }
    }
    const sourceDerivedFunctions = new Set(
      mapping.sources.flatMap((source) => source.targetFunctions),
    );
    if (engineSpecificFunctions.some((functionName) => sourceDerivedFunctions.has(functionName))) {
      fail(`sourceMap[${index}] assigns one target as both source-derived and Engine-specific`);
    }
    if (mapping.status === "implemented") {
      const targetPath = path.resolve(packageRoot, mapping.target.slice(packageTargetPrefix.length));
      let targetSource;
      try {
        targetSource = await readFile(targetPath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") fail(`implemented source-map target is absent: ${mapping.target}`);
        throw error;
      }
      const targetCode = rustCodeOnly(targetSource);
      const targetFunctions = new Set([...sourceDerivedFunctions, ...engineSpecificFunctions]);
      for (const functionName of targetFunctions) {
        if (!targetFunctionDeclared(targetCode, functionName)) {
          fail(`implemented target function is absent: ${mapping.target}#${functionName}`);
        }
      }
    }
  }
}

async function verify() {
  const upstream = await readCanonicalJson("upstream.json");
  const patchLedger = await readCanonicalJson("patch-ledger.json");
  const sourceMap = await readCanonicalJson("source-map.json");

  if (
    upstream.repository !== SOURCE_REPOSITORY
    || upstream.walletCommit !== SOURCE_COMMIT
    || upstream.subtree !== SOURCE_SUBTREE
    || upstream.crate?.name !== SDK_NAME
    || upstream.crate?.version !== SDK_VERSION
    || upstream.crate?.license !== SDK_LICENSE
    || upstream.crate?.repository !== SDK_REPOSITORY
  ) {
    fail("upstream metadata does not match the approved source and SDK identity");
  }
  if (!Array.isArray(upstream.files) || upstream.files.length === 0) {
    fail("upstream files must be a non-empty array");
  }
  if (!Array.isArray(patchLedger)) fail("patch-ledger.json must contain an array");
  await verifySourceMap(sourceMap);

  const baseline = new Map();
  let previousPath = "";
  for (const [index, entry] of upstream.files.entries()) {
    assertRelativePath(entry.path, `upstream.files[${index}].path`);
    assertDigest(entry.sha256, `upstream.files[${index}].sha256`);
    if (entry.status !== "unchanged") fail(`upstream.files[${index}].status must be unchanged`);
    if (entry.path <= previousPath || baseline.has(entry.path)) {
      fail("upstream files must have unique paths in sorted order");
    }
    previousPath = entry.path;
    baseline.set(entry.path, entry);
  }

  const classified = new Map(baseline);
  const patched = new Set();
  for (const [index, entry] of patchLedger.entries()) {
    assertRelativePath(entry.path, `patchLedger[${index}].path`);
    assertDigest(entry.sha256, `patchLedger[${index}].sha256`);
    if (entry.status !== "modified" && entry.status !== "added") {
      fail(`patchLedger[${index}].status must be modified or added`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      fail(`patchLedger[${index}].reason must be non-empty`);
    }
    if (patched.has(entry.path)) fail(`patch ledger contains duplicate path: ${entry.path}`);
    if (entry.status === "modified" && !baseline.has(entry.path)) {
      fail(`modified file is absent from upstream baseline: ${entry.path}`);
    }
    if (entry.status === "added" && baseline.has(entry.path)) {
      fail(`added file already exists in upstream baseline: ${entry.path}`);
    }
    patched.add(entry.path);
    classified.set(entry.path, entry);
  }

  const targetFiles = await listFiles(vendorRoot);
  const targetSet = new Set(targetFiles);
  for (const relativePath of classified.keys()) {
    if (!targetSet.has(relativePath)) fail(`classified vendor file is absent: ${relativePath}`);
  }
  for (const relativePath of targetFiles) {
    const entry = classified.get(relativePath);
    if (!entry) fail(`vendor file is unclassified: ${relativePath}`);
    const actual = await fileDigest(path.join(vendorRoot, relativePath));
    if (actual !== entry.sha256) fail(`vendor file digest mismatch: ${relativePath}`);
  }

  const cargo = cargoPackageMetadata(await readFile(path.join(vendorRoot, "Cargo.toml"), "utf8"));
  if (
    cargo.name !== SDK_NAME
    || cargo.version !== SDK_VERSION
    || cargo.license !== SDK_LICENSE
    || cargo.repository !== SDK_REPOSITORY
  ) {
    fail("vendored Cargo.toml package identity does not match approved SDK metadata");
  }

  const vendoredLicensePath = path.join(vendorRoot, "LICENSE");
  if (await fileDigest(vendoredLicensePath) !== SDK_LICENSE_SHA256) {
    fail("vendored tbc-sdk MIT license differs from the pinned Git object");
  }
  const vendoredLicense = await readFile(vendoredLicensePath);
  const retainedLicense = await readFile(path.join(rustRoot, "LICENSES/tbc-sdk-MIT.txt"));
  if (!vendoredLicense.equals(retainedLicense)) {
    fail("retained tbc-sdk MIT license differs from the vendored license");
  }

  console.log(`Verified ${targetFiles.length} classified ${SDK_NAME} files.`);
}

try {
  await verify();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
