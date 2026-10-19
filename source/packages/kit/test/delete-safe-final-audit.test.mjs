import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const sourceRoot = new URL("../src/", import.meta.url);

async function sourceFiles() {
  const names = (await readdir(sourceRoot)).filter((name) => name.endsWith(".ts"));
  return new Map(await Promise.all(names.map(async (name) => [name, await readFile(new URL(name, sourceRoot), "utf8")])));
}

function occurrences(text, name) {
  return text.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
}

test("deletion audit keeps only compatibility boundaries with current consumers", async () => {
  const sources = await sourceFiles();
  const all = [...sources.values()].join("\n");

  // The deprecated reviewer wrapper module had no production consumers. The
  // canonical reviewers are now the only source and public wallet exports.
  assert.equal(sources.has("legacy-raw-transaction-reviewer.ts"), false);
  assert.match(sources.get("wallet.ts"), /createTbcDefaultRawTransactionReviewer/);
  assert.match(sources.get("wallet.ts"), /createTbcDefaultAssociatedTransactionReviewer/);

  assert.doesNotMatch(sources.get("pool-signing-loader.ts"), /createLegacyPoolSigningLoader/);

  assert.doesNotMatch(sources.get("wallet-runtime.ts"), /beginWorkflowPreparation/);
  assert.doesNotMatch(sources.get("legacy-webview-native.ts"), /auditLegacySecureFallback/);

  // Conservative local dead-function check. Any non-exported function
  // declaration must have a source consumer besides its declaration. This is
  // deliberately narrow so it cannot classify public APIs or dynamic routes
  // as deletion-safe by accident.
  for (const [file, text] of sources) {
    for (const match of text.matchAll(/^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
      const name = match[1];
      const declaration = match[0];
      if (/\bexport\b/.test(declaration)) continue;
      assert.ok(occurrences(all, name) > 1, `${file} has an unconsumed private function ${name}`);
    }
  }
});
