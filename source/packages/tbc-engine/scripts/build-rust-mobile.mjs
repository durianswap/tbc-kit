import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { iosBuildEnvironment, assertIosDeployment } from "./ios-deployment.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = join(packageRoot, "rust");
const headers = join(workspace, "crates", "tbc-engine-native", "include");
const artifacts = join(packageRoot, "artifacts", "native");
const iosTargets = ["aarch64-apple-ios", "aarch64-apple-ios-sim"];
const androidTargets = [
  { rust: "aarch64-linux-android", abi: "arm64-v8a", clang: "aarch64-linux-android" },
  { rust: "armv7-linux-androideabi", abi: "armeabi-v7a", clang: "armv7a-linux-androideabi" },
  { rust: "x86_64-linux-android", abi: "x86_64", clang: "x86_64-linux-android" },
];
const androidApi = process.env.TBC_ENGINE_ANDROID_API ?? "24";

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function cargoBuild(target, env = process.env) {
  execFileSync("cargo", ["build", "--locked", "--release", "-p", "tbc-engine-native", "--target", target], {
    cwd: workspace,
    env,
    stdio: "inherit",
  });
}

function findNdk() {
  const explicit = [process.env.ANDROID_NDK_HOME, process.env.ANDROID_NDK_ROOT].filter(Boolean);
  const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
  const installed = sdk && existsSync(join(sdk, "ndk"))
    ? readdirSync(join(sdk, "ndk"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(sdk, "ndk", entry.name))
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    : [];
  const ndk = [...explicit, ...installed].find((candidate) => existsSync(join(candidate, "toolchains", "llvm", "prebuilt")));
  if (!ndk) throw new Error("Android NDK not found; set ANDROID_NDK_HOME or ANDROID_SDK_ROOT");
  return ndk;
}

for (const target of iosTargets) {
  const sdk = target.endsWith("-sim") ? "iphonesimulator" : "iphoneos";
  const sdkRoot = execFileSync("xcrun", ["--sdk", sdk, "--show-sdk-path"], { encoding: "utf8" }).trim();
  cargoBuild(target, iosBuildEnvironment(target, sdkRoot));
  // A successful link alone does not prove minimum OS compatibility.
  const library = join(workspace, "target", target, "release", "libtbc_engine_native.a");
  assertIosDeployment(execFileSync("xcrun", ["otool", "-l", library], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  }));
}

const xcframework = join(artifacts, "ios", "TbcEngineNative.xcframework");
rmSync(xcframework, { force: true, recursive: true });
mkdirSync(dirname(xcframework), { recursive: true });
const iosLibraries = iosTargets.map((target) => join(workspace, "target", target, "release", "libtbc_engine_native.a"));
execFileSync("xcodebuild", [
  "-create-xcframework",
  "-library", iosLibraries[0], "-headers", headers,
  "-library", iosLibraries[1], "-headers", headers,
  "-output", xcframework,
], { stdio: "inherit" });

const ndk = findNdk();
const prebuiltRoot = join(ndk, "toolchains", "llvm", "prebuilt");
const prebuilt = readdirSync(prebuiltRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("darwin"))
  .map((entry) => join(prebuiltRoot, entry.name))[0];
if (!prebuilt) throw new Error(`macOS NDK LLVM prebuilt not found under ${prebuiltRoot}`);
const bin = join(prebuilt, "bin");

for (const target of androidTargets) {
  const clang = join(bin, `${target.clang}${androidApi}-clang`);
  if (!existsSync(clang)) throw new Error(`Android linker missing: ${clang}`);
  const cargoKey = target.rust.toUpperCase().replaceAll("-", "_");
  const ccKey = target.rust.replaceAll("-", "_");
  const env = {
    ...process.env,
    [`CARGO_TARGET_${cargoKey}_LINKER`]: clang,
    [`CC_${ccKey}`]: clang,
    [`AR_${ccKey}`]: join(bin, "llvm-ar"),
  };
  cargoBuild(target.rust, env);
  const source = join(workspace, "target", target.rust, "release", "libtbc_engine_native.so");
  const destination = join(artifacts, "android", "jniLibs", target.abi, "libtbc_engine_native.so");
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

const outputs = [
  ...iosLibraries.map((path, index) => ({ target: iosTargets[index], source: path, sha256: hash(path) })),
  ...androidTargets.map((target) => {
    const path = join(artifacts, "android", "jniLibs", target.abi, "libtbc_engine_native.so");
    return { target: target.rust, abi: target.abi, artifact: path, sha256: hash(path) };
  }),
];
console.log(JSON.stringify({ xcframework, androidApi, ndk, outputs }, null, 2));
