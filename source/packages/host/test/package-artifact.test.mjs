import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const expectedEntries = new Set(["LICENSE", "README.md", "package.json"]);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
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

test("packed Host ships only public artifacts and all declared entry points load", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "tws-host-pack-"));
  try {
    const hostPack = await pack("./packages/host", temporary);
    const corePack = await pack("./packages/core", temporary);
    const packagedPaths = hostPack.manifest.files.map(({ path: file }) => file);
    for (const file of packagedPaths) {
      assert.equal(
        expectedEntries.has(file) || file.startsWith("dist/"),
        true,
        `unexpected Host package artifact: ${file}`,
      );
    }
    assert.equal(packagedPaths.includes("README.md"), true);
    assert.equal(packagedPaths.includes("LICENSE"), true);
    assert.equal(packagedPaths.some((file) => file.startsWith("test/")), false);
    assert.equal(packagedPaths.some((file) => file.startsWith("src/")), false);

    const modules = path.join(temporary, "consumer", "node_modules");
    const hostDirectory = path.join(modules, "@tbc-wallet", "host");
    const coreDirectory = path.join(modules, "@tbc-wallet", "core");
    await extract(hostPack.tarball, hostDirectory);
    await extract(corePack.tarball, coreDirectory);
    await mkdir(path.join(modules, "@noble"), { recursive: true });
    for (const dependency of ["curves", "hashes"]) {
      await symlink(
        path.join(root, "node_modules", "@noble", dependency),
        path.join(modules, "@noble", dependency),
        "dir",
      );
    }

    const manifest = JSON.parse(
      await readFile(path.join(hostDirectory, "package.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(manifest.exports).sort(), [
      ".",
      "./indexeddb",
      "./sqlite",
    ]);
    const consumerDirectory = path.join(temporary, "consumer");
    await writeFile(
      path.join(consumerDirectory, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
    await writeFile(
      path.join(consumerDirectory, "esm.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import * as host from "@tbc-wallet/host";',
        'import * as indexeddb from "@tbc-wallet/host/indexeddb";',
        'import * as sqlite from "@tbc-wallet/host/sqlite";',
        'assert.equal(typeof host.createTwsHost, "function");',
        'assert.equal("createIndexedDbTwsHostStore" in host, false);',
        'assert.equal("createSqliteTwsHostStore" in host, false);',
        'assert.equal(typeof indexeddb.createIndexedDbTwsHostStore, "function");',
        'assert.equal(typeof sqlite.createSqliteTwsHostStore, "function");',
        'assert.equal(sqlite.TWS_HOST_SQLITE_MAX_CANONICAL_JSON_BYTES, 4 * 1024 * 1024);',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(consumerDirectory, "cjs.cjs"),
      [
        'const assert = require("node:assert/strict");',
        'const host = require("@tbc-wallet/host");',
        'const indexeddb = require("@tbc-wallet/host/indexeddb");',
        'const sqlite = require("@tbc-wallet/host/sqlite");',
        'assert.equal(typeof host.createTwsHost, "function");',
        'assert.equal("createIndexedDbTwsHostStore" in host, false);',
        'assert.equal("createSqliteTwsHostStore" in host, false);',
        'assert.equal(typeof indexeddb.createIndexedDbTwsHostStore, "function");',
        'assert.equal(typeof sqlite.createSqliteTwsHostStore, "function");',
        'assert.equal(sqlite.TWS_HOST_SQLITE_MAX_CANONICAL_JSON_BYTES, 4 * 1024 * 1024);',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(consumerDirectory, "consumer.ts"),
      [
        'import { createTwsHost, type TwsHostStore } from "@tbc-wallet/host";',
        'import { createIndexedDbTwsHostStore } from "@tbc-wallet/host/indexeddb";',
        'import { createSqliteTwsHostStore } from "@tbc-wallet/host/sqlite";',
        "const hostFactory: typeof createTwsHost = createTwsHost;",
        "const storeFactory: typeof createIndexedDbTwsHostStore = createIndexedDbTwsHostStore;",
        "const sqliteFactory: typeof createSqliteTwsHostStore = createSqliteTwsHostStore;",
        "let store: TwsHostStore | undefined;",
        "void hostFactory; void storeFactory; void sqliteFactory; void store;",
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
