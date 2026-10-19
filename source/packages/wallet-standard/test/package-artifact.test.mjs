import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WALLET_STANDARD_PACKAGE_LIMITS } from "../../../scripts/check-wallet-standard-portability.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const expectedEntries = new Set(["LICENSE", "README.md", "package.json"]);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

function npmCli() {
  assert.ok(process.env.npm_execpath, "package artifact test must run under npm");
  return process.env.npm_execpath;
}

async function pack(workspace, destination) {
  const output = run(
    process.execPath,
    [npmCli(), "pack", workspace, "--json", "--pack-destination", destination],
    root,
  );
  const manifest = JSON.parse(output)[0];
  return { manifest, tarball: path.join(destination, manifest.filename) };
}

async function extract(tarball, destination) {
  await mkdir(destination, { recursive: true });
  run("tar", ["-xzf", tarball, "--strip-components=1", "-C", destination], root);
}

test("packed discovery adapter loads and compiles by package name", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "tws-discovery-pack-"));
  try {
    const walletPack = await pack("./packages/wallet-standard", temporary);
    const providerPack = await pack("./packages/provider", temporary);
    const corePack = await pack("./packages/core", temporary);
    assert.ok(walletPack.manifest.size <= WALLET_STANDARD_PACKAGE_LIMITS.maxTarballBytes);
    assert.ok(
      walletPack.manifest.unpackedSize <=
        WALLET_STANDARD_PACKAGE_LIMITS.maxUnpackedBytes,
    );
    const packagedPaths = walletPack.manifest.files.map(({ path: file }) => file);
    for (const file of packagedPaths) {
      assert.equal(
        expectedEntries.has(file) || file.startsWith("dist/"),
        true,
        `unexpected discovery package artifact: ${file}`,
      );
    }
    for (const required of expectedEntries) {
      assert.equal(packagedPaths.includes(required), true, `missing ${required}`);
    }
    assert.equal(packagedPaths.some((file) => file.startsWith("src/")), false);
    assert.equal(packagedPaths.some((file) => file.startsWith("test/")), false);

    const modules = path.join(temporary, "consumer", "node_modules");
    await extract(
      walletPack.tarball,
      path.join(modules, "@tbc-wallet", "wallet-standard"),
    );
    await extract(
      providerPack.tarball,
      path.join(modules, "@tbc-wallet", "provider"),
    );
    await extract(corePack.tarball, path.join(modules, "@tbc-wallet", "core"));
    await mkdir(path.join(modules, "@noble"), { recursive: true });
    for (const dependency of ["curves", "hashes"]) {
      await symlink(
        path.join(root, "node_modules", "@noble", dependency),
        path.join(modules, "@noble", dependency),
        "dir",
      );
    }
    await mkdir(path.join(modules, "@wallet-standard"), { recursive: true });
    for (const dependency of ["app", "base", "core", "errors", "features", "wallet"] ) {
      await symlink(
        path.join(root, "node_modules", "@wallet-standard", dependency),
        path.join(modules, "@wallet-standard", dependency),
        "dir",
      );
    }

    const consumerDirectory = path.join(temporary, "consumer");
    await writeFile(
      path.join(consumerDirectory, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
    await writeFile(
      path.join(consumerDirectory, "esm.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import * as discovery from "@tbc-wallet/wallet-standard";',
        'assert.equal(discovery.TBC_PROVIDER_FEATURE, "tbc:provider");',
        'assert.deepEqual(discovery.getTbcWallets(), []);',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(consumerDirectory, "cjs.cjs"),
      [
        'const assert = require("node:assert/strict");',
        'const discovery = require("@tbc-wallet/wallet-standard");',
        'assert.equal(discovery.TBC_PROVIDER_FEATURE, "tbc:provider");',
        'assert.deepEqual(discovery.getTbcWallets(), []);',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(consumerDirectory, "consumer.ts"),
      [
        'import { getTbcWallets, type TbcWallet } from "@tbc-wallet/wallet-standard";',
        "const wallets: readonly TbcWallet[] = getTbcWallets();",
        "void wallets;",
        "",
      ].join("\n"),
    );

    run(process.execPath, [path.join(consumerDirectory, "esm.mjs")], consumerDirectory);
    run(process.execPath, [path.join(consumerDirectory, "cjs.cjs")], consumerDirectory);
    run(
      process.execPath,
      [
        path.join(root, "node_modules", "typescript", "bin", "tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target", "ES2022",
        "--module", "NodeNext",
        "--moduleResolution", "NodeNext",
        "--lib", "ES2022,DOM",
        path.join(consumerDirectory, "consumer.ts"),
      ],
      consumerDirectory,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
