import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { repositoryRoot } from "./lib/repository.mjs";

const root = repositoryRoot(import.meta.url);
const exampleRoot = path.join(root, "examples", "third-party-wallet-minimal");
const sourceRoot = path.join(exampleRoot, "src");
const allowedPackages = new Set([
  "@tbc-wallet/core",
  "@tbc-wallet/host",
  "@tbc-wallet/provider",
  "@tbc-wallet/provider/in-memory",
  "@tbc-wallet/tbc-engine",
  "@tbc-wallet/wallet-standard",
]);

function list(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return list(absolute);
    return entry.isFile() ? [absolute] : [];
  });
}

function fail(message) {
  throw new Error(`Example boundary violation: ${message}`);
}

for (const file of list(sourceRoot).filter((candidate) => candidate.endsWith(".ts"))) {
  const source = fs.readFileSync(file, "utf8");
  const relative = path.relative(root, file);
  for (const match of source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier.startsWith(".")) {
      if (specifier.includes("../..")) fail(`${relative} escapes the example`);
    } else if (!allowedPackages.has(specifier)) {
      fail(`${relative} imports non-public dependency ${specifier}`);
    }
  }
  if (
    /turing-wallet-plugin|wallet-vault\/1|\b(?:keyring|vaultHandle|vaultToken|privateKey|mnemonic|seedPhrase|privateKeyWif)\b/i.test(source)
  ) {
    fail(`${relative} contains a private wallet or secret capability`);
  }
}

const dappSource = fs.readFileSync(path.join(sourceRoot, "dapp.ts"), "utf8");
if (
  /@tbc-wallet\/(?:core|host|tbc-engine|wallet-standard)|\b(?:signer|authority|checkpoint|HostPort)\b/i.test(dappSource)
) {
  fail("the DApp side crosses the Provider boundary");
}

for (const file of list(exampleRoot)) {
  if (!/\.(?:ts|mjs|js)$/.test(file)) continue;
  const source = fs.readFileSync(file, "utf8");
  if (/PRIVATE_KEY_HEX/.test(source) && !file.includes(`${path.sep}test${path.sep}`)) {
    fail("the deterministic test key escaped the example test directory");
  }
}

for (const packageName of ["core", "host", "provider", "tbc-engine", "wallet-standard"]) {
  const directory = path.join(root, "packages", packageName, "dist");
  for (const file of list(directory)) {
    if (!/\.(?:js|cjs|d\.ts)$/.test(file)) continue;
    if (/PRIVATE_KEY_HEX|wallet-vault\/1/.test(fs.readFileSync(file, "utf8"))) {
      fail(`published ${packageName} artifact contains fixture or private state`);
    }
  }
}

export const EXAMPLE_BOUNDARY_STATUS = "pass";

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  process.stdout.write('{"status":"pass"}\n');
}
