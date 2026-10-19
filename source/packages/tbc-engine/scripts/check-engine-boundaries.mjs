import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const expectedPackages = ["@tbc-wallet/core","@tbc-wallet/tbc-engine","@tbc-wallet/host","@tbc-wallet/provider","@tbc-wallet/wallet-standard"];
const expectedPorts = ["accounts","chainData","policy","permissionStore","approval","signer","crypto","reviewedTransaction","broadcast","clock","entropy"];

const release = JSON.parse(await readFile(path.join(repoRoot, "release/tws-sdk-1.0.0-draft.6.3.config.json"), "utf8"));
if (JSON.stringify(release.packageNames) !== JSON.stringify(expectedPackages)) {
  throw new Error("public package boundary is not exactly five packages");
}
const hostTypes = await readFile(path.join(repoRoot, "packages/host/src/types.ts"), "utf8");
const portBlock = (hostTypes.match(/TWS_HOST_PORT_NAMES = Object\.freeze\(\[([\s\S]*?)\]\s+as const\)/) || [,""])[1];
const actualPorts = Array.from(portBlock.matchAll(/"([^"]+)"/g), (match) => match[1]);
if (JSON.stringify(actualPorts) !== JSON.stringify(expectedPorts)) {
  throw new Error("Host Port boundary mismatch: " + JSON.stringify(actualPorts));
}
const backend = await readFile(path.join(packageRoot, "src/backend.ts"), "utf8");
const methodBlock = (backend.match(/TBC_ENGINE_METHODS = Object\.freeze\(\[([\s\S]*?)\]\s+as const\)/) || [,""])[1];
const methods = Array.from(methodBlock.matchAll(/"([^"]+)"/g), (match) => match[1]);
if (JSON.stringify(methods) !== JSON.stringify(["normalizeRequest","plan","validate","finalize"])) {
  throw new Error("engine facade method mismatch: " + JSON.stringify(methods));
}
const manifest = JSON.parse(await readFile(path.join(packageRoot, "evidence/artifact-manifest.json"), "utf8"));
const expectedArtifactTargets = ["aarch64-apple-darwin","aarch64-apple-ios","aarch64-apple-ios-sim","aarch64-linux-android","armv7-linux-androideabi","x86_64-linux-android","wasm32-unknown-unknown"];
if (JSON.stringify(manifest.artifacts.map((artifact) => artifact.target)) !== JSON.stringify(expectedArtifactTargets)) {
  throw new Error("fixed native/WASM artifact target set is incomplete");
}
for (const artifact of manifest.artifacts) {
  const bytes = await readFile(path.join(packageRoot, artifact.path));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== artifact.bytes || digest !== artifact.sha256) {
    throw new Error("artifact manifest mismatch: " + artifact.path);
  }
  if (artifact.kind === "wasm") {
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes));
    if (imports.length !== 0 || JSON.stringify(artifact.imports) !== "[]") {
      throw new Error("WASM imports are not empty: " + JSON.stringify(imports));
    }
  }
}
const nativeSource = await readFile(path.join(packageRoot, "rust/crates/tbc-engine-native/src/lib.rs"), "utf8");
const wasmSource = await readFile(path.join(packageRoot, "rust/crates/tbc-engine-wasm/src/lib.rs"), "utf8");
for (const pair of [["native", nativeSource], ["wasm", wasmSource]]) {
  if (!pair[1].includes("tbc_engine_core")) throw new Error(pair[0] + " adapter does not delegate to core");
  if (/reqwest|fetch\s*\(|broadcast|mnemonic|PrivateKey/.test(pair[1])) {
    throw new Error(pair[0] + " adapter contains a forbidden responsibility");
  }
}
console.log("boundaries: 5 packages, 9 required + 2 optional Ports, 4 methods, keyless iOS/Android/native/WASM artifacts");
