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
import { fileURLToPath, pathToFileURL } from "node:url";

import { PROVIDER_PACKAGE_LIMITS } from "../../../scripts/check-provider-portability.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const expectedEntries = new Set([
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "package.json",
]);

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

async function writeLegacyCoreFixture(modules) {
  const directory = path.join(modules, "@tbc-wallet", "core");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify({
      name: "@tbc-wallet/core",
      version: "1.0.0-old-registry-test",
      type: "module",
      exports: {
        ".": { import: "./index.js", require: "./index.cjs" },
      },
    }, null, 2)}\n`,
  );
  const runtime = [
    'const { createHash } = require("node:crypto");',
    "function canonicalize(value) {",
    '  if (value === null || typeof value !== "object") return JSON.stringify(value);',
    '  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;',
    '  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;',
    "}",
    'function utf8(value) { return new TextEncoder().encode(value); }',
    'function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }',
    "function getTwsMethod(name) {",
    '  if (name === "tbc_signTypedData") throw new Error("old registry rejects tbc_signTypedData");',
    '  return { paramsKind: "named" };',
    "}",
    "module.exports = { canonicalize, getTwsMethod, sha256Hex, utf8 };",
    "",
  ].join("\n");
  await writeFile(path.join(directory, "index.cjs"), runtime);
  await writeFile(
    path.join(directory, "index.js"),
    [
      'import { createHash } from "node:crypto";',
      "function canonicalize(value) {",
      '  if (value === null || typeof value !== "object") return JSON.stringify(value);',
      '  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;',
      '  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;',
      "}",
      'function utf8(value) { return new TextEncoder().encode(value); }',
      'function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }',
      "function getTwsMethod(name) {",
      '  if (name === "tbc_signTypedData") throw new Error("old registry rejects tbc_signTypedData");',
      '  return { paramsKind: "named" };',
      "}",
      "export { canonicalize, getTwsMethod, sha256Hex, utf8 };",
      "",
    ].join("\n"),
  );
}

test("packed Provider exposes only declared artifacts and works by package name", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "tws-provider-pack-"));
  try {
    const providerPack = await pack("./packages/provider", temporary);
    const corePack = await pack("./packages/core", temporary);
    assert.ok(providerPack.manifest.size <= PROVIDER_PACKAGE_LIMITS.maxTarballBytes);
    assert.ok(
      providerPack.manifest.unpackedSize <=
        PROVIDER_PACKAGE_LIMITS.maxUnpackedBytes,
    );

    const packagedPaths = providerPack.manifest.files.map(({ path: file }) => file);
    for (const file of packagedPaths) {
      assert.equal(
        expectedEntries.has(file) || file.startsWith("dist/"),
        true,
        `unexpected Provider package artifact: ${file}`,
      );
    }
    for (const required of expectedEntries) {
      assert.equal(packagedPaths.includes(required), true, `missing ${required}`);
    }
    assert.equal(packagedPaths.some((file) => file.startsWith("src/")), false);
    assert.equal(packagedPaths.some((file) => file.startsWith("test/")), false);

    const modules = path.join(temporary, "consumer", "node_modules");
    const providerDirectory = path.join(modules, "@tbc-wallet", "provider");
    const coreDirectory = path.join(modules, "@tbc-wallet", "core");
    await extract(providerPack.tarball, providerDirectory);
    await extract(corePack.tarball, coreDirectory);
    for (const format of ["esm", "cjs"]) {
      for (const entry of ["index", "in-memory", "webview"]) {
        const extension = format === "esm" ? "js" : "cjs";
        const map = JSON.parse(await readFile(
          path.join(providerDirectory, `dist/${format}/${entry}.${extension}.map`), "utf8",
        ));
        assert.equal(map.version, 3);
        assert.ok(map.sources.length > 0 && map.mappings.length > 0);
        assert.equal(Object.hasOwn(map, "sourcesContent"), false,
          "published maps retain mappings, not duplicated embedded source");
      }
    }
    for (const relative of ["dist/esm/webview.js", "dist/cjs/webview.cjs"]) {
      const webviewArtifact = await readFile(
        path.join(providerDirectory, relative),
        "utf8",
      );
      assert.doesNotMatch(
        webviewArtifact,
        /@tbc-wallet\/provider/u,
        `${relative} must carry its own exact generated validators`,
      );
      assert.doesNotMatch(
        webviewArtifact,
        /getTwsMethod/u,
        `${relative} must not consult a consumer Core method registry`,
      );
    }
    await mkdir(path.join(modules, "@noble"), { recursive: true });
    for (const dependency of ["curves", "hashes"]) {
      await symlink(
        path.join(root, "node_modules", "@noble", dependency),
        path.join(modules, "@noble", dependency),
        "dir",
      );
    }

    const manifest = JSON.parse(
      await readFile(path.join(providerDirectory, "package.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(manifest.exports), [".", "./in-memory", "./webview"]);
    const consumerDirectory = path.join(temporary, "consumer");
    await writeFile(
      path.join(consumerDirectory, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
    await writeFile(
      path.join(consumerDirectory, "esm.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import * as provider from "@tbc-wallet/provider";',
        'import * as memory from "@tbc-wallet/provider/in-memory";',
        'import * as webview from "@tbc-wallet/provider/webview";',
        'assert.equal(typeof provider.createTbcProvider, "function");',
        'assert.equal("createInMemoryTransport" in provider, false);',
        'assert.equal(typeof memory.createInMemoryTransport, "function");',
        'assert.equal(typeof webview.decodeTbcWebViewPageMessage, "function");',
        'assert.equal(typeof webview.createTbcWebViewPageTransport, "function");',
        'assert.equal(typeof webview.createTbcWebViewNativeController, "function");',
        'assert.equal("createTbcWebViewNativeController" in provider, false);',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(consumerDirectory, "cjs.cjs"),
      [
        'const assert = require("node:assert/strict");',
        'const provider = require("@tbc-wallet/provider");',
        'const memory = require("@tbc-wallet/provider/in-memory");',
        'const webview = require("@tbc-wallet/provider/webview");',
        'assert.equal(typeof provider.createTbcProvider, "function");',
        'assert.equal("createInMemoryTransport" in provider, false);',
        'assert.equal(typeof memory.createInMemoryTransport, "function");',
        'assert.equal(typeof webview.decodeTbcWebViewPageMessage, "function");',
        'assert.equal(typeof webview.createTbcWebViewPageTransport, "function");',
        'assert.equal(typeof webview.createTbcWebViewNativeController, "function");',
        'assert.equal("createTbcWebViewNativeController" in provider, false);',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(consumerDirectory, "consumer.ts"),
      [
        'import { createTbcProvider, ProviderRpcError, type TbcProviderTransport } from "@tbc-wallet/provider";',
        'import { createInMemoryTransport } from "@tbc-wallet/provider/in-memory";',
        'import { decodeTbcWebViewPageMessage, type TbcWebViewStringChannel } from "@tbc-wallet/provider/webview";',
        "declare const transport: TbcProviderTransport;",
        "const provider = createTbcProvider({ transport });",
        "const memory = createInMemoryTransport({ handler: async () => { throw new ProviderRpcError(4200, 'Unsupported'); } });",
        "let channel: TbcWebViewStringChannel | undefined;",
        "void provider; void memory; void channel; void decodeTbcWebViewPageMessage;",
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
        "--lib", "ES2022",
        path.join(consumerDirectory, "consumer.ts"),
      ],
      consumerDirectory,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("packed WebView decoder uses its generated schema under an older consumer Core registry", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "tws-provider-old-core-"));
  try {
    const providerPack = await pack("./packages/provider", temporary);
    const consumerDirectory = path.join(temporary, "consumer");
    const modules = path.join(consumerDirectory, "node_modules");
    await extract(
      providerPack.tarball,
      path.join(modules, "@tbc-wallet", "provider"),
    );
    await writeLegacyCoreFixture(modules);
    await writeFile(
      path.join(consumerDirectory, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
    const kitEsm = pathToFileURL(
      path.join(root, "packages", "kit", "dist", "esm", "index.js"),
    ).href;
    const kitCjs = path.join(
      root,
      "packages",
      "kit",
      "dist",
      "cjs",
      "index.cjs",
    );
    await writeFile(
      path.join(consumerDirectory, "roundtrip.mjs"),
      [
        'import assert from "node:assert/strict";',
        `import { createTbcKitWebViewPageProvider } from ${JSON.stringify(kitEsm)};`,
        'import { decodeTbcWebViewPageMessage, encodeTbcWebViewNativeMessage } from "@tbc-wallet/provider/webview";',
        'const chainId = "tbc:mainnet";',
        "const posted = [];",
        "const page = createTbcKitWebViewPageProvider({ channel: { post(value) { posted.push(value); }, subscribe() { return () => undefined; } }, isTopFrame: () => true, requestIdFactory: () => 'old-core-rpc' });",
        "page.acceptInitialize(encodeTbcWebViewNativeMessage({ channel: 'tws-webview/1', type: 'initialize', sessionId: 'session-1', navigationId: 'navigation-1', messageId: 'init-1', origin: 'https://dapp.example', chainId }));",
        "const abort = new AbortController();",
        "const pending = page.provider.request({ method: 'tbc_signTypedData', params: { version: '1.0', chainId, from: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', clientRequestId: 'typed-1', data: { domain: { name: 'DurianSwap Order', version: '1', chainId, origin: 'https://dapp.example' }, types: { Order: [{ name: 'amount', type: 'uint256' }] }, primaryType: 'Order', message: { amount: '1000000' } } } }, { signal: abort.signal });",
        "const decoded = decodeTbcWebViewPageMessage(posted.find((value) => JSON.parse(value).type === 'request'));",
        "assert.equal(decoded.request.method, 'tbc_signTypedData');",
        "abort.abort();",
        "await assert.rejects(pending);",
        "await page.destroy();",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(consumerDirectory, "roundtrip.cjs"),
      [
        'const assert = require("node:assert/strict");',
        `const { createTbcKitWebViewPageProvider } = require(${JSON.stringify(kitCjs)});`,
        'const { decodeTbcWebViewPageMessage, encodeTbcWebViewNativeMessage } = require("@tbc-wallet/provider/webview");',
        "void (async () => {",
        '  const chainId = "tbc:mainnet";',
        "  const posted = [];",
        "  const page = createTbcKitWebViewPageProvider({ channel: { post(value) { posted.push(value); }, subscribe() { return () => undefined; } }, isTopFrame: () => true, requestIdFactory: () => 'old-core-rpc' });",
        "  page.acceptInitialize(encodeTbcWebViewNativeMessage({ channel: 'tws-webview/1', type: 'initialize', sessionId: 'session-1', navigationId: 'navigation-1', messageId: 'init-1', origin: 'https://dapp.example', chainId }));",
        "  const abort = new AbortController();",
        "  const pending = page.provider.request({ method: 'tbc_signTypedData', params: { version: '1.0', chainId, from: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', clientRequestId: 'typed-1', data: { domain: { name: 'DurianSwap Order', version: '1', chainId, origin: 'https://dapp.example' }, types: { Order: [{ name: 'amount', type: 'uint256' }] }, primaryType: 'Order', message: { amount: '1000000' } } } }, { signal: abort.signal });",
        "  const decoded = decodeTbcWebViewPageMessage(posted.find((value) => JSON.parse(value).type === 'request'));",
        "  assert.equal(decoded.request.method, 'tbc_signTypedData');",
        "  abort.abort();",
        "  await assert.rejects(pending);",
        "  await page.destroy();",
        "})().catch((error) => { console.error(error); process.exitCode = 1; });",
        "",
      ].join("\n"),
    );
    run(
      process.execPath,
      [path.join(consumerDirectory, "roundtrip.mjs")],
      consumerDirectory,
    );
    run(
      process.execPath,
      [path.join(consumerDirectory, "roundtrip.cjs")],
      consumerDirectory,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
