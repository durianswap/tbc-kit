import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const evidenceDir = join(packageRoot, "evidence");
const deliveryDir = join(packageRoot, "delivery");
const publicIntegrationManifest = join(
  repoRoot,
  "release",
  "tws-v1-candidate.json",
);

function run(command, args, cwd = repoRoot) {
  execFileSync(command, args, { cwd, env: process.env, stdio: "inherit" });
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function describe(kind, target, path, extra = {}) {
  const bytes = readFileSync(path);
  return { kind, target, path: relative(packageRoot, path), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), ...extra };
}

rmSync(join(packageRoot, "dist"), { force: true, recursive: true });
rmSync(join(packageRoot, "artifacts"), { force: true, recursive: true });
mkdirSync(deliveryDir, { recursive: true });
run("npm", ["run", "build:host"]);
run("node", ["packages/tbc-engine/scripts/build-rust-native.mjs"]);
run("node", ["packages/tbc-engine/scripts/build-rust-mobile.mjs"]);
run("node", ["packages/tbc-engine/scripts/build-rust-wasm.mjs"]);
run("npx", ["--no-install", "tsc", "-p", "packages/tbc-engine/tsconfig.json"]);
run("npx", ["--no-install", "esbuild", "packages/tbc-engine/src/index.ts", "packages/tbc-engine/src/native.ts", "packages/tbc-engine/src/wasm.ts", "--outdir=packages/tbc-engine/dist/esm", "--bundle", "--external:@tbc-wallet/core", "--format=esm", "--platform=neutral", "--target=es2020", "--sourcemap", "--log-level=error"]);
run("npx", ["--no-install", "esbuild", "packages/tbc-engine/src/index.ts", "packages/tbc-engine/src/native.ts", "packages/tbc-engine/src/wasm.ts", "--outdir=packages/tbc-engine/dist/cjs", "--bundle", "--external:@tbc-wallet/core", "--format=cjs", "--platform=neutral", "--target=es2022", "--out-extension:.js=.cjs", "--sourcemap", "--log-level=error"]);

const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const wasmPath = join(packageRoot, "artifacts", "wasm", "tbc_engine_wasm.wasm");
const artifacts = [
  describe("native-host", "aarch64-apple-darwin", join(packageRoot, "artifacts", "native", "aarch64-apple-darwin", "libtbc_engine_native.dylib")),
  describe("ios-static", "aarch64-apple-ios", join(packageRoot, "artifacts", "native", "ios", "TbcEngineNative.xcframework", "ios-arm64", "libtbc_engine_native.a")),
  describe("ios-static", "aarch64-apple-ios-sim", join(packageRoot, "artifacts", "native", "ios", "TbcEngineNative.xcframework", "ios-arm64-simulator", "libtbc_engine_native.a")),
  describe("android-shared", "aarch64-linux-android", join(packageRoot, "artifacts", "native", "android", "jniLibs", "arm64-v8a", "libtbc_engine_native.so"), { abi: "arm64-v8a", minSdk: 24 }),
  describe("android-shared", "armv7-linux-androideabi", join(packageRoot, "artifacts", "native", "android", "jniLibs", "armeabi-v7a", "libtbc_engine_native.so"), { abi: "armeabi-v7a", minSdk: 24 }),
  describe("android-shared", "x86_64-linux-android", join(packageRoot, "artifacts", "native", "android", "jniLibs", "x86_64", "libtbc_engine_native.so"), { abi: "x86_64", minSdk: 24 }),
  describe("wasm", "wasm32-unknown-unknown", wasmPath, { imports: WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(wasmPath))) }),
];
const artifactManifest = {
  version: "2.0",
  package: packageJson.name,
  packageVersion: packageJson.version,
  sourceCommit,
  sourceCore: "rust/crates/tbc-engine-core",
  toolchain: {
    rustc: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
    cargo: execFileSync("cargo", ["--version"], { encoding: "utf8" }).trim(),
    xcode: execFileSync("xcodebuild", ["-version"], { encoding: "utf8" }).trim().replaceAll("\n", "; "),
  },
  artifacts,
};
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, "artifact-manifest.json"), `${JSON.stringify(artifactManifest, null, 2)}\n`);
run("node", ["packages/tbc-engine/scripts/check-rust-runtime-artifacts.mjs"]);

const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", deliveryDir], { cwd: packageRoot, encoding: "utf8" }))[0];
const tarball = join(deliveryDir, packed.filename);
const firstDigest = sha256(tarball);
const temp = mkdtempSync(join(tmpdir(), "tbc-engine-pack-"));
try {
  const second = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], { cwd: packageRoot, encoding: "utf8" }))[0];
  if (sha256(join(temp, second.filename)) !== firstDigest) throw new Error("npm package is not byte-reproducible across consecutive packs");
} finally {
  rmSync(temp, { force: true, recursive: true });
}

const packageDirs = { core: "core", host: "host", provider: "provider", "tbc-engine": "tbc-engine", "wallet-standard": "wallet-standard" };
const compatiblePackages = Object.fromEntries(Object.entries(packageDirs).map(([name, dir]) => [
  `@tbc-wallet/${name}`,
  JSON.parse(readFileSync(join(repoRoot, "packages", dir, "package.json"), "utf8")).version,
]));
const runtimeReport = join(evidenceDir, "runtime-artifact-report.json");
const deliveryManifest = {
  version: "1.0",
  package: packageJson.name,
  packageVersion: packageJson.version,
  sourceCommit,
  compatiblePackages,
  releaseFingerprint: { manifestSha256: sha256(publicIntegrationManifest) },
  publicIntegrationPatch: {
    path: relative(repoRoot, publicIntegrationManifest),
    sha256: sha256(publicIntegrationManifest),
    ...JSON.parse(readFileSync(publicIntegrationManifest, "utf8")),
  },
  packageTarball: { path: relative(packageRoot, tarball), bytes: readFileSync(tarball).length, sha256: firstDigest, integrity: packed.integrity, reproducibleConsecutivePack: true },
  artifactManifestSha256: sha256(join(evidenceDir, "artifact-manifest.json")),
  runtimeArtifactReportSha256: sha256(runtimeReport),
  rebuildCommand: "npm --prefix packages/tbc-engine run build:fixed-delivery",
  knownExternalBlocker: "The repository-wide build:core generator guard is blocked by pre-existing registry/schema drift; this package-local delivery does not bypass or rewrite it.",
};
writeFileSync(join(evidenceDir, "delivery-manifest.json"), `${JSON.stringify(deliveryManifest, null, 2)}\n`);
console.log(JSON.stringify(deliveryManifest, null, 2));
