import assert from "node:assert/strict";
import { readFile, mkdtemp, symlink, unlink, rmdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runIndependentWalletExample } from "../examples/independent-wallet/run.mjs";

test("independent wallet uses public Kit defaults for transaction, dependency, message and metadata", async () => {
  const result = await runIndependentWalletExample();
  assert.deepEqual(result, {
    productId: "org.example.independent-wallet",
    dependentStatus: "complete",
    approvals: 2,
    workflowApprovals: 1,
    signerCalls: 2,
    transactionIdBindingVerified: true,
    providerMethods: ["tbc_requestAccounts", "tbc_signWorkflow"],
    transactionGets: 1,
    metadataGets: 2,
    posts: 0,
    nodeDefaultWasm: true,
  });
});

test("independent wallet CLI executes through a symbolic-link path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kit-wallet-cli-"));
  const link = join(directory, "run.mjs");
  await symlink(fileURLToPath(new URL("../examples/independent-wallet/run.mjs", import.meta.url)), link);
  t.after(async () => { await unlink(link); await rmdir(directory); });
  const output = execFileSync(process.execPath, [link], { encoding: "utf8", timeout: 15000 });
  const result = JSON.parse(output.trim());
  assert.equal(result.transactionIdBindingVerified, true);
  assert.equal(result.workflowApprovals, 1);
  assert.equal(result.posts, 0);
});

test("independent wallet example has no Mobile/Turing or private workspace import", async () => {
  const sources = await Promise.all([
    "../examples/independent-wallet/run.mjs",
    "../examples/independent-wallet/controlled-platform.mjs",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const source = sources.join("\n");
  assert.doesNotMatch(source, /tws-mobile-reference|Mobile\/src|Turing Wallet/u);
  assert.doesNotMatch(source, /from\s+["']@tbc-wallet\//u);
  assert.match(source, /org\.example\.independent-wallet/u);
  assert.doesNotMatch(sources[0], /createLegacyAssociatedTransactionService|createLegacyDependentBatchCoordinator|createMemoryAssociatedJournal|POOLNFT_INIT/u);
});
