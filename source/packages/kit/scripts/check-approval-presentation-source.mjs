// Run the existing focused presentation tests against current source; never rebuild dist.
import { build } from "esbuild";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const result = await build({
  entryPoints: [root + "packages/kit/test/approval-presentation.test.mjs"],
  alias: { "@tbc-wallet/core": root + "packages/core/src/index.ts", "@tbc-wallet/host": root + "packages/host/src/index.ts" },
  plugins: [{ name: "source-wallet", setup(build) {
    build.onResolve({ filter: /dist\/esm\/wallet\.js$/ }, () => ({ path: "presentation", namespace: "source-gate" }));
    build.onLoad({ filter: /.*/, namespace: "source-gate" }, () => ({ contents: `
      export { ApprovalHostEvidenceConflictError } from './packages/kit/src/approval-host-evidence.ts';
      export { projectTbcApprovalPreparation, projectTbcApprovalPresentation } from './packages/kit/src/approval-presentation.ts';
    `, loader: "ts", resolveDir: root }));
  } }],
  bundle: true, write: false, platform: "node", format: "esm", target: "node22", logLevel: "silent",
});
const url = new URL("../src/.presentation-source-check.mjs", import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, next) { return specifier === url ? { url, shortCircuit: true } : next(specifier, context); },
  load(candidate, context, next) { return candidate === url ? { source: result.outputFiles[0].text, format: "module", shortCircuit: true } : next(candidate, context); },
});
await import(url); hook.deregister();
