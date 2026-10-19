import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { repositoryRoot } from "./lib/repository.mjs";

const root = repositoryRoot(import.meta.url);
const packagePaths = Object.freeze([
  "packages/core",
  "packages/tbc-engine",
  "packages/host",
  "packages/provider",
  "packages/wallet-standard",
]);

function run(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function runNpm(args, cwd, label) {
  const npmCli = process.env.npm_execpath;
  return npmCli === undefined
    ? run("npm", args, cwd, label)
    : run(process.execPath, [npmCli, ...args], cwd, label);
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tws-sdk-consumer-"));
try {
  const tarballDirectory = path.join(directory, "tarballs");
  fs.mkdirSync(tarballDirectory, { recursive: true });
  const tarballs = new Map();
  for (const packagePath of packagePaths) {
    const output = runNpm(
      [
        "pack",
        path.join(root, packagePath),
        "--json",
        "--pack-destination",
        tarballDirectory,
      ],
      root,
      `npm pack ${packagePath}`,
    );
    const packed = JSON.parse(output);
    assert.equal(packed.length, 1, packagePath);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, packagePath, "package.json"), "utf8"),
    );
    tarballs.set(manifest.name, path.join(tarballDirectory, packed[0].filename));
  }

  const dependencies = Object.fromEntries(
    [...tarballs.entries()].map(([name, tarball]) => [name, `file:${tarball}`]),
  );
  dependencies["@noble/curves"] = "1.9.7";
  fs.writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify({
      name: "tws-clean-sdk-consumer",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies,
    }, null, 2)}\n`,
  );
  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    directory,
    "npm install packed SDK consumer",
  );

  const exampleRoot = path.join(
    directory,
    "examples",
    "third-party-wallet-minimal",
  );
  fs.mkdirSync(path.join(exampleRoot, "test"), { recursive: true });
  fs.cpSync(
    path.join(root, "examples/third-party-wallet-minimal/src"),
    path.join(exampleRoot, "src"),
    { recursive: true },
  );
  fs.copyFileSync(
    path.join(root, "examples/third-party-wallet-minimal/tsconfig.json"),
    path.join(exampleRoot, "tsconfig.json"),
  );
  fs.cpSync(
    path.join(root, "examples/third-party-wallet-minimal/test"),
    path.join(exampleRoot, "test"),
    { recursive: true },
  );
  const consumerScripts = path.join(directory, "scripts");
  fs.mkdirSync(consumerScripts, { recursive: true });
  fs.copyFileSync(
    path.join(root, "scripts/check-testnet-preflight.mjs"),
    path.join(consumerScripts, "check-testnet-preflight.mjs"),
  );
  fs.copyFileSync(
    path.join(root, "scripts/run-testnet-acceptance.mjs"),
    path.join(consumerScripts, "run-testnet-acceptance.mjs"),
  );

  run(
    path.join(root, "node_modules/.bin/tsc"),
    ["-p", path.join(exampleRoot, "tsconfig.json")],
    directory,
    "compile example declarations against packed packages",
  );
  run(
    path.join(root, "node_modules/.bin/esbuild"),
    [
      path.join(exampleRoot, "src/dapp.ts"),
      path.join(exampleRoot, "src/fixtures.ts"),
      path.join(exampleRoot, "src/wallet.ts"),
      path.join(exampleRoot, "src/testnet-adapter.ts"),
      `--outdir=${path.join(exampleRoot, "dist/esm")}`,
      "--bundle",
      "--external:@tbc-wallet/*",
      "--format=esm",
      "--platform=neutral",
      "--target=es2022",
    ],
    directory,
    "bundle example against packed packages",
  );

  const smokePath = path.join(directory, "package-smoke.mjs");
  fs.writeFileSync(
    smokePath,
    `import assert from "node:assert/strict";\n` +
      `import { createRequire } from "node:module";\n` +
      `const entries = ${JSON.stringify([
        "@tbc-wallet/core",
        "@tbc-wallet/core/release",
        "@tbc-wallet/tbc-engine",
        "@tbc-wallet/host",
        "@tbc-wallet/host/indexeddb",
        "@tbc-wallet/host/sqlite",
        "@tbc-wallet/provider",
        "@tbc-wallet/provider/in-memory",
        "@tbc-wallet/provider/webview",
        "@tbc-wallet/wallet-standard",
      ])};\n` +
      `for (const entry of entries) assert.equal(typeof await import(entry), "object", entry);\n` +
      `const require = createRequire(import.meta.url);\n` +
      `for (const entry of entries) assert.equal(typeof require(entry), "object", entry);\n` +
      `process.stdout.write(JSON.stringify({ status: "pass", entries: entries.length }) + "\\n");\n`,
  );
  run(process.execPath, [smokePath], directory, "load packed SDK exports");
  run(
    process.execPath,
    [
      "--test",
      "--test-name-pattern=^(DApp requests|covers mainnet|correlates concurrent|handles close|scopes duplicate|pending Provider close|same-tick|dry-runs|requires an exact|normalizes the official|keeps an accepted|rechecks trusted|probes the live|uses an injected|prints one|runs dry|rejects caller-supplied|rejects an acceptance result|rejects a non-boolean|requires the exact in-process|rejects a mistyped|keeps an unconfirmed|parses only|maps arbitrary|loads an external|rejects in-repository)",
      path.join(exampleRoot, "test/e2e.test.mjs"),
      path.join(exampleRoot, "test/testnet-adapter.test.mjs"),
      path.join(exampleRoot, "test/testnet-preflight.test.mjs"),
      path.join(exampleRoot, "test/testnet-acceptance-command.test.mjs"),
    ],
    directory,
    "run packed third-party-wallet-minimal/test/e2e.test.mjs and testnet tests",
  );

  process.stdout.write(
    `${JSON.stringify({
      status: "pass",
      packages: tarballs.size,
      esmAndCjsEntries: 10,
      example: "third-party-wallet-minimal",
    })}\n`,
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
