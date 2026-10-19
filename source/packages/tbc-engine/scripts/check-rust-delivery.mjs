import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const steps = [
  ["node", ["packages/tbc-engine/scripts/build-fixed-delivery.mjs"]],
  ["node", ["packages/tbc-engine/scripts/check-capability-matrix.mjs"]],
  ["node", ["packages/tbc-engine/scripts/check-engine-boundaries.mjs"]],
  ["node", ["packages/tbc-engine/scripts/verify-rust-provenance.mjs"]],
  ["node", ["packages/tbc-engine/scripts/check-rust-adapter-parity.mjs"]],
  ["node", ["packages/tbc-engine/scripts/check-rust-runtime-artifacts.mjs"]],
  ["cargo", ["test","--manifest-path","packages/tbc-engine/rust/Cargo.toml","-p","tbc-engine-core","--offline"]],
  ["npx", ["--no-install","tsc","-p","packages/tbc-engine/tsconfig.json"]],
  ["npx", ["--no-install","esbuild","packages/tbc-engine/src/index.ts","packages/tbc-engine/src/native.ts","packages/tbc-engine/src/wasm.ts","--outdir=packages/tbc-engine/dist/esm","--bundle","--external:@tbc-wallet/core","--format=esm","--platform=neutral","--target=es2020","--log-level=error"]],
  ["npx", ["--no-install","esbuild","packages/tbc-engine/src/index.ts","packages/tbc-engine/src/native.ts","packages/tbc-engine/src/wasm.ts","--outdir=packages/tbc-engine/dist/cjs","--bundle","--external:@tbc-wallet/core","--format=cjs","--platform=neutral","--target=es2022","--out-extension:.js=.cjs","--log-level=error"]],
  ["node", ["--test","packages/tbc-engine/test/rust-facade.test.mjs","packages/tbc-engine/test/repository-invariants.test.mjs"]]
];
for (const step of steps) {
  console.log("\\n> " + step[0] + " " + step[1].join(" "));
  const result = spawnSync(step[0], step[1], { cwd: repoRoot, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log("\\nRust TBC engine delivery checks passed");
