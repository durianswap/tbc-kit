import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = (name) => new URL(`../src/${name}`, import.meta.url);

test("Legacy secure consumers use the Standard workflow with no direct fallback", async () => {
  const names = (await readdir(new URL("../src/", import.meta.url)))
    .filter((name) => name.endsWith(".ts"));
  const sources = new Map(await Promise.all(names.map(async (name) => [
    name,
    await readFile(sourceUrl(name), "utf8"),
  ])));
  const native = sources.get("legacy-webview-native.ts");
  const workflow = sources.get("legacy-standard-workflow.ts");
  const mapper = sources.get("legacy-mapper.ts");
  assert.ok(native);
  assert.ok(workflow);
  assert.ok(mapper);

  // The reusable Standard adapter owns all secure request mapping and
  // approvalPreparation/executeWorkflow wiring.
  for (const method of [
    "signTransaction",
    "signAssociatedTransaction",
    "encrypt",
    "decrypt",
  ]) {
    assert.equal(workflow.includes(`"${method}"`), true, `workflow must map ${method}`);
  }
  assert.match(workflow, /beginApprovalPreparation/);
  assert.doesNotMatch(workflow, /beginWorkflowPreparation/);
  assert.match(workflow, /executeWorkflow/);

  // The WebView controller has one Standard workflow route. The migrated
  // private services and their fallback audit path are no longer present.
  const dispatch = native.slice(native.indexOf("async function handleRequest("));
  const genericIndex = dispatch.indexOf("sendStandaloneStandardWorkflow(");
  assert.ok(genericIndex >= 0);
  for (const marker of [
    "signRawTransaction(requestId, params)",
    "signAssociatedTransaction(requestId, params)",
    "crypt(requestId, method, params)",
    "auditLegacySecureFallback(",
    "generic-workflow-unavailable",
    "generic-capability-unsupported",
  ]) {
    assert.equal(native.includes(marker), false, `native controller retains ${marker}`);
  }

  // No other Kit source may directly invoke the old service implementations.
  for (const [name, text] of sources) {
    if (name === "legacy-webview-native.ts") continue;
    for (const marker of [
      "options.rawTransactions.sign(",
      "options.associatedTransactions.sign(",
      "options.crypto[method](",
    ]) {
      assert.equal(text.includes(marker), false, `${name} directly consumes ${marker}`);
    }
  }

  // The public Legacy facade remains a provider compatibility surface; it
  // does not own raw/associated/crypto services or bypass the adapter.
  for (const marker of [
    "options.rawTransactions",
    "options.associatedTransactions",
    "options.crypto",
    "LegacyCryptoService",
    "cryptoAdapter",
  ]) {
    assert.equal(mapper.includes(marker), false, `legacy-mapper must not own ${marker}`);
  }
});
