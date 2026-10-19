// Execute the repository's focused assertions against the INSTALLED examples
// and public library, never repository dist. Controlled providers only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [consumer, version] = process.argv.slice(2);
assert.ok(consumer && version, "usage: check-installed-public-examples.mjs CONSUMER VERSION");
const pkg = resolve(consumer, "node_modules/@tbc/kit");
assert.equal(JSON.parse(readFileSync(resolve(pkg, "package.json"))).version, version);
const wallet = pathToFileURL(resolve(pkg, "dist/esm/wallet.node.js")).href;
const seen = new Set();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@tbc-wallet/core" || specifier === "@tbc/kit/wallet") {
      return { url: wallet, shortCircuit: true };
    }
    if (specifier.startsWith("../examples/") && context.parentURL?.includes("/packages/kit/test/")) {
      const relative = specifier.slice(3);
      seen.add(relative);
      return { url: pathToFileURL(resolve(pkg, relative)).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
await import("../test/nft-public-example.test.mjs");
await import("../test/maintenance-public-examples.test.mjs");
await import("../test/legacy-associated-metadata-example.test.mjs");
assert.deepEqual([...seen].sort(), [
  "examples/ftlp-burn/run.mjs", "examples/legacy-associated-metadata/wallet.mjs",
  "examples/merge-maintenance/run.mjs", "examples/nft-three-step/run.mjs",
]);
