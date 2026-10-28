import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

// Share generated code, never skip validation. Ownership must be the same
// private WeakSet used by checkpoint.ts and its validators in each format.
export function sharedValidationPlugin(root, extension) {
  const files = new Map([
    [resolve(root, "packages/core/src/generated/validators.ts"), "shared-core-validation"],
    [resolve(root, "packages/provider/src/generated/validators/bundle.ts"), "shared-provider-validation"],
    [resolve(root, "packages/core/src/checkpoint-ownership.ts"), "shared-checkpoint-ownership"],
  ]);
  return {
    name: "kit-shared-validation",
    setup(context) {
      context.onResolve({ filter: /(?:validators(?:\/bundle)?|checkpoint-ownership)\.(?:js|ts)$/ }, args => {
        if (args.kind === "entry-point" || !args.importer) return;
        const source = resolve(dirname(args.importer), args.path).replace(/\.js$/, ".ts");
        const name = files.get(source);
        if (name) return { path: `./${name}.${extension}`, external: true };
      });
    },
  };
}

// Reused by the normal source build and immutable distribution candidates.
// No native compilation, source edits, schema generation or network access.
export async function buildKitRuntime({ root, packageRoot, minifyWhitespace = false, shared = true, sourceOverrides = new Map() }) {
  const sourceRoot = resolve(root, "packages/kit");
  const entries = ["wallet", "engine", "sqlite", "testing"];
  const aliases = Object.fromEntries([
    ["core", "core/src/index.ts"], ["host/sqlite", "host/src/sqlite.ts"],
    ["host", "host/src/index.ts"], ["provider", "provider/src/index.ts"],
    ["provider/in-memory", "provider/src/in-memory.ts"], ["provider/webview", "provider/src/webview.ts"],
    ["tbc-engine", "tbc-engine/src/index.ts"], ["tbc-engine/native", "tbc-engine/src/native.ts"],
    ["tbc-engine/wasm", "tbc-engine/src/wasm.ts"], ["wallet-standard", "wallet-standard/src/index.ts"],
  ].map(([name, path]) => [`@tbc-wallet/${name}`, resolve(root, "packages", path)]));
  const external = ["@noble/curves/*", "@noble/hashes/*", "@wallet-standard/core", "node:*", "./vendor/tbc-tx-parser/index.js"];
  const common = { bundle: true, target: "es2020", sourcemap: true, alias: aliases, external,
    minifyWhitespace, minifyIdentifiers: false, minifySyntax: false, logLevel: "silent" };
  // Build-time-only source comparison for immutable patch candidates. Never
  // modifies the checkout or changes the default production build.
  const overrides = { name: 'candidate-source-comparison', setup(context) {
    context.onLoad({filter: /\.ts$/}, args => sourceOverrides.has(args.path)
      ? {contents: sourceOverrides.get(args.path), loader: 'ts', resolveDir: dirname(args.path)} : undefined);
  }};
  const plugins = ext => [...(sourceOverrides.size ? [overrides] : []), ...(shared ? [sharedValidationPlugin(root, ext)] : [])];
  const nodeAssets = {
    name: "tbc-kit-node-assets",
    setup(context) {
      context.onResolve({ filter: /^\.\/keyless-wasm-asset\.js$/ }, args => {
        if (args.importer.endsWith("/keyless-wasm-asset.node.ts")) return;
        return { path: resolve(sourceRoot, "src/keyless-wasm-asset.node.ts") };
      });
      context.onResolve({ filter: /^\.\/engine\.js$/ }, args => {
        if (dirname(args.importer) !== resolve(sourceRoot, "src")) return;
        return { path: resolve(sourceRoot, "src/engine.node.ts") };
      });
    },
  };
  const esm = { ...common, format: "esm", platform: "neutral", plugins: plugins("js") };
  // Optional multisig does not join the default/shared CJS runtime or partner
  // page. Loading the wallet/root entry never imports this module.
  for (const [format, extension] of [["esm", "js"], ["cjs", "cjs"]]) {
    await build({ ...common, format, platform: "neutral", plugins: sourceOverrides.size ? [overrides] : [],
      entryPoints: [resolve(sourceRoot, "src/multisig.ts")],
      outfile: resolve(packageRoot, `dist/${format}/multisig.${extension}`) });
  }
  const cjs = { ...common, format: "cjs", platform: "node", target: "es2022", plugins: [...plugins("cjs"), nodeAssets] };
  if (shared) {
    const sources = {
      "shared-core-validation": "core/src/generated/validators.ts",
      "shared-provider-validation": "provider/src/generated/validators/bundle.ts",
      "shared-checkpoint-ownership": "core/src/checkpoint-ownership.ts",
    };
    for (const [format, options, extension] of [["esm", esm, "js"], ["cjs", cjs, "cjs"]]) {
      await build({ ...options, entryPoints: Object.fromEntries(Object.entries(sources).map(([name,p]) => [name, resolve(root,"packages",p)])),
        outdir: resolve(packageRoot, "dist", format), outExtension: { ".js": `.${extension}` } });
    }
  }
  await build({ ...esm, entryPoints: Object.fromEntries(entries.map(e => [e, resolve(sourceRoot, `src/${e}.ts`)])),
    outdir: resolve(packageRoot, "dist/esm"), splitting: true, chunkNames: "chunk-[hash]",
    external: [...external, "./provider-transport.js"] });
  for (const entry of ["protocol-time", "business-capabilities", "contract-identification", "keyless", "amm-fee-policy", "amm-quote", "receipt-verification",
    "timelock-query", "nft-query", "client", "client-browser", "wallet-standard-browser", "wallet-standard-native", "sign-in", "webview", "provider-transport"]) {
    await build({ ...esm, entryPoints: [resolve(sourceRoot, `src/${entry}.ts`)], outfile: resolve(packageRoot, `dist/esm/${entry}.js`) });
  }
  await build({ ...esm, entryPoints: { prepared: resolve(sourceRoot, "src/prepared.ts") },
    outdir: resolve(packageRoot, "dist/esm"), splitting: true, chunkNames: "prepared-[hash]" });
  for (const entry of ["index", "index.native"]) {
    await build({ entryPoints: [resolve(sourceRoot, `src/${entry}.ts`)], outfile: resolve(packageRoot, `dist/esm/${entry}.js`),
      bundle: false, format: "esm", platform: "neutral", target: "es2020", sourcemap: true, minifyWhitespace });
  }
  await build({ ...esm, platform: "node", target: "es2022", plugins: [...plugins("js"), nodeAssets],
    entryPoints: Object.fromEntries(["index", "wallet", "engine"].map(e => [`${e}.node`, resolve(sourceRoot, `src/${e === "engine" ? "engine.node" : e}.ts`)])),
    outdir: resolve(packageRoot, "dist/esm"), splitting: true, chunkNames: "node-[hash]", external: [...external, "./provider-transport.js"] });
  await build({ ...esm, entryPoints: Object.fromEntries(["api", "rpc"].map(e => [e, resolve(sourceRoot, `src/${e}.ts`)])),
    outdir: resolve(packageRoot, "dist/esm"), splitting: true, chunkNames: "network-[hash]" });
  const nodeCjs = { ...cjs, define: { "import.meta.url": "__tbcKitImportMetaUrl" },
    banner: { js: "const __tbcKitImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" } };
  await build({ ...nodeCjs, stdin: { contents: entries.map(e => `import * as ${e} from "./src/${e === "engine" ? "engine.node" : e}.ts";`).join("\n") + `\nexport { ${entries.join(", ")} };\n`,
    resolveDir: sourceRoot, sourcefile: "tbc-kit-cjs-runtime.ts" }, outfile: resolve(packageRoot, "dist/cjs/runtime.cjs") });
  for (const entry of entries) await writeFile(resolve(packageRoot, `dist/cjs/${entry}.cjs`), `module.exports = require("./runtime.cjs").${entry};\n`);
  await build({ ...nodeCjs, entryPoints: [resolve(sourceRoot, "src/index.ts")], outfile: resolve(packageRoot, "dist/cjs/index.cjs") });
  await build({ ...common, format: "cjs", platform: "neutral", plugins: plugins("cjs"),
    entryPoints: Object.fromEntries(["api", "rpc"].map(e => [e, resolve(sourceRoot, `src/${e}.ts`)])),
    outdir: resolve(packageRoot, "dist/cjs"), outExtension: { ".js": ".cjs" } });
}
