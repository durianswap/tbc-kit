import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);
const requiredDocuments = [
  "docs/getting-started/dapp-quickstart.md",
  "docs/getting-started/wallet-quickstart.md",
  "docs/guides/send-tbc.md",
  "docs/guides/permissions-events-errors.md",
  "docs/guides/crash-recovery.md",
  "docs/reference/provider-api.md",
  "docs/reference/wallet-standard.md",
  "docs/reference/transport-contract.md",
];

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function packageImports(source) {
  return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
}

test("ships the complete public SDK documentation set", () => {
  for (const relative of requiredDocuments) {
    assert.equal(fs.existsSync(path.join(root, relative)), true, relative);
  }
  const readme = read("README.md");
  assert.match(readme, /docs\/reference\/module-index\.md/);
  const moduleIndex = read("docs/reference/module-index.md");
  for (const relative of [
    "getting-started/dapp-quickstart.md",
    "getting-started/wallet-quickstart.md",
    "examples/third-party-wallet-minimal/README.md",
    "packages/provider/README.md",
    "packages/wallet-standard/README.md",
  ]) {
    assert.match(moduleIndex, new RegExp(relative.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(
    readme,
    /Provider、Wallet Standard、Transport、\s*真实 testnet 广播与产品 UI 仍属于后续阶段/,
  );
});

test("Quickstarts copy only public package boundaries", () => {
  const dapp = read("docs/getting-started/dapp-quickstart.md");
  assert.deepEqual(
    new Set(packageImports(dapp)),
    new Set(["@tbc-wallet/wallet-standard", "@tbc/kit"]),
  );
  assert.doesNotMatch(dapp, /@tbc-wallet\/(?:core|host|tbc-engine)/);
  assert.doesNotMatch(dapp, /\b(?:Authority|Host Port|checkpoint|signer\.sign)\b/);

  const wallet = read("docs/getting-started/wallet-quickstart.md");
  const allowed = new Set([
    "@tbc-wallet/core",
    "@tbc-wallet/host",
    "@tbc-wallet/provider",
    "@tbc-wallet/provider/in-memory",
    "@tbc-wallet/tbc-engine",
    "@tbc-wallet/wallet-standard",
  ]);
  for (const specifier of packageImports(wallet)) {
    assert.equal(allowed.has(specifier), true, specifier);
  }
  assert.match(wallet, /normalize.*plan.*approval binding.*signer\.sign.*finalize/s);
  assert.match(wallet, /九个|nine/i);
  assert.doesNotMatch(wallet, /wallet-vault\/1.*(?:public|公开).*(?:API|接口)/i);
});

test("marked Quickstart snippets compile against declared public exports", () => {
  const directory = fs.mkdtempSync(path.join(root, ".tmp-tws-docs-"));
  try {
    const snippets = requiredDocuments.slice(0, 2).flatMap((relative) =>
      [...read(relative).matchAll(/```ts compile=([^\n]+)\n([\s\S]*?)```/g)]
        .map((match) => ({ name: match[1], source: match[2] })),
    );
    assert.deepEqual(
      snippets.map(({ name }) => name),
      [
        "dapp-discovery",
        "dapp-send",
        "wallet-host",
        "wallet-transport",
        "wallet-discovery",
      ],
    );
    for (const { name, source } of snippets) {
      const file = path.join(directory, `${name}.ts`);
      fs.writeFileSync(file, source);
      const compiled = spawnSync(
        path.join(root, "node_modules/.bin/tsc"),
        [
          "--noEmit",
          "--strict",
          "--exactOptionalPropertyTypes",
          "--noUncheckedIndexedAccess",
          "--skipLibCheck",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--target",
          "ES2022",
          "--lib",
          "ES2022,DOM",
          file,
        ],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(
        compiled.status,
        0,
        `${name}\n${compiled.stdout}\n${compiled.stderr}`,
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Provider and Wallet Standard references project frozen registries", () => {
  const provider = read("docs/reference/provider-api.md");
  const methods = JSON.parse(read("registry/methods.json")).methods;
  const events = JSON.parse(read("registry/events.json")).events;
  for (const { name } of [...methods, ...events]) {
    assert.match(provider, new RegExp(`\\\\?\`${name}\\\\?\``));
  }
  assert.match(provider, /4 MiB/);
  assert.match(provider, /single-request/);
  assert.match(provider, /request\s*Promise.*事件|Promise.*settle.*event/is);

  const discovery = read("docs/reference/wallet-standard.md");
  assert.match(discovery, /@wallet-standard\/core/);
  assert.match(discovery, /tbc:provider/);
  assert.match(discovery, /不得.*自动选择|never auto-select/i);
  assert.match(discovery, /EIP-6963.*EVM/s);
});

test("Transport and operations guides keep authority and safety boundaries explicit", () => {
  const transport = read("docs/reference/transport-contract.md");
  assert.match(transport, /\{\s*deliveryId,\s*response,\s*events\s*\}/);
  for (const profile of ["WebView", "Extension", "Remote"]) {
    assert.match(transport, new RegExp(profile));
  }
  assert.match(transport, /Trusted Context/);
  assert.match(transport, /DApp.*(?:不得|不能).*origin/is);
  assert.match(transport, /REQUEST_ABORTED/);
  assert.match(transport, /未.*认证|not certified/i);

  const send = read("docs/guides/send-tbc.md");
  assert.match(send, /TBC.*默认|默认.*TBC/i);
  assert.match(send, /amount.*十进制字符串/s);
  assert.match(send, /tbc_signTransaction.*不.*broadcast|sign-only.*不.*广播/is);

  const recovery = read("docs/guides/crash-recovery.md");
  for (const identity of ["callId", "commitId", "deliveryId", "idempotencyKey"]) {
    assert.match(recovery, new RegExp(identity));
  }
  assert.match(recovery, /Memory.*(?:测试|test)/s);
  assert.match(recovery, /IndexedDB/);
});

test("documents permissions, errors, and explicit legacy migration without false certification", () => {
  const guide = read("docs/guides/permissions-events-errors.md");
  for (const code of ["4001", "4100", "4200", "4900", "4901", "-32000"] ) {
    assert.equal(guide.includes(code), true, code);
  }
  assert.match(guide, /permissionsChanged/);
  assert.match(guide, /ProviderRpcError/);

  const walletQuickstart = read("docs/getting-started/wallet-quickstart.md");
  assert.match(walletQuickstart, /window\.Turing/);
  assert.match(walletQuickstart, /显式|explicit/i);
  assert.match(walletQuickstart, /Legacy Adapter/);

  const all = requiredDocuments.map(read).join("\n");
  assert.doesNotMatch(all, /(?:WebView|Extension|Remote).{0,40}(?:已经|已获).{0,20}(?:生产认证|合规认证)/s);
  assert.doesNotMatch(all, /(?:私钥|助记词|WIF).{0,30}(?:Provider|DApp).{0,20}(?:传递|暴露)/s);
});
