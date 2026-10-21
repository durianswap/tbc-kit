import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { repositoryRoot } from "../scripts/lib/repository.mjs";
const root = repositoryRoot(import.meta.url);
const read = p => fs.readFileSync(path.join(root, p), "utf8");
const guides = ["README", "dapp", "wallet", "api-and-backend", "native", "legacy", "examples", "api-reference"];
test("current integration documentation is complete and linked", () => {
  const index = read("../docs/README.md");
  for (const name of guides) {
    const text = read(`../docs/${name}.md`);
    assert.ok(text.length > 100, name);
    if (name !== "README") assert.ok(index.includes(`${name}.md`), name);
  }
  assert.ok(read("../README.md").includes("docs/"));
});
test("public quickstarts use the single Kit package boundary", () => {
  const text = guides.map(name => read(`../docs/${name}.md`)).join("\n");
  const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map(m => m[1]);
  assert.ok(imports.includes("@tbc/kit"));
  assert.ok(imports.includes("@tbc/kit/api"));
  for (const specifier of imports) assert.match(specifier, /^@tbc\/kit(?:\/|$)/);
  assert.doesNotMatch(text, /from ["']@tbc-wallet\//);
});
test("DApp and API guide snippets compile against the current public declarations", () => {
  const directory = fs.mkdtempSync(path.join(root, ".tmp-kit-docs-"));
  try {
    for (const name of ["dapp", "api-and-backend"]) {
      const blocks = [...read(`../docs/${name}.md`).matchAll(/```ts\n([\s\S]*?)```/g)];
      assert.equal(blocks.length, 1);
      const file = path.join(directory, `${name}.ts`);
      fs.writeFileSync(file, 'declare const recipientAddress: string;\n' + blocks[0][1]);
      const result = spawnSync(path.join(root, "node_modules/.bin/tsc"), [
        "--noEmit", "--strict", "--skipLibCheck", "--exactOptionalPropertyTypes",
        "--noUncheckedIndexedAccess", "--module", "NodeNext", "--moduleResolution", "NodeNext",
        "--target", "ES2022", "--lib", "ES2022,DOM", file,
      ], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test("Provider and discovery normative documentation covers every current registered method and event", () => {
  const provider = read("standards/TWS-001-provider.md");
  for (const file of ["methods", "events"])
    for (const { name } of JSON.parse(read(`registry/${file}.json`))[file])
      assert.ok(provider.includes(name), name);
  const discovery = read("standards/TWS-007-discovery-transports.md");
  assert.match(discovery, /tbc:provider/);
  assert.match(discovery, /EIP-6963.*EVM/);
  assert.match(read("../docs/dapp.md"), /用户选择/);
});
test("wallet integration preserves platform authority, Vault and approval binding boundaries", () => {
  const wallet = read("../docs/wallet.md");
  for (const text of ["origin", "Signer/Vault", "预取", "绑定检查", "session.close()", "审批"])
    assert.ok(wallet.includes(text), text);
  const backend = read("../docs/api-and-backend.md");
  assert.match(backend, /安全 Signer.*服务授权/);
  assert.match(backend, /txid.*已到账/);
  assert.match(read("../docs/dapp.md"), /不能将任意页面 digest/);
});
test("Legacy is an adapter to shared execution, not a separate signing bypass", () => {
  const legacy = read("../docs/legacy.md");
  assert.match(legacy, /window\.Turing/);
  assert.match(legacy, /审批/);
  assert.match(legacy, /校验/);
  assert.doesNotMatch(guides.map(name => read(`../docs/${name}.md`)).join("\n"),
    /(?:WebView|Extension|Remote).{0,40}(?:已经|已获).{0,20}(?:生产认证|合规认证)/s);
});
