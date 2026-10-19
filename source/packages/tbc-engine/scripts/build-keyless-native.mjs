import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = join(packageRoot, "rust");
const targetFlag = process.argv.findIndex((value) => value === "-t" || value === "--target");
const target = targetFlag >= 0
  ? process.argv[targetFlag + 1]
  : execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
if (!target) throw new Error("native target is missing; pass -t <rust-target>");

execFileSync(
  "cargo",
  ["build", "--locked", "--release", "--offline", "-p", "tbc-keyless-native", "--target", target],
  { cwd: workspace, stdio: "inherit" },
);
const file = target.includes("windows")
  ? "tbc_keyless_native.dll"
  : target.includes("apple")
    ? "libtbc_keyless_native.dylib"
    : "libtbc_keyless_native.so";
const source = join(workspace, "target", target, "release", file);
const artifactRoot = join(packageRoot, "artifacts", "keyless-native", target);
const destination = join(artifactRoot, file);
mkdirSync(artifactRoot, { recursive: true });
copyFileSync(source, destination);
copyFileSync(
  join(workspace, "crates", "tbc-keyless-native", "include", "tbc_keyless.h"),
  join(artifactRoot, "tbc_keyless.h"),
);
copyFileSync(
  join(workspace, "crates", "tbc-keyless-native", "include", "module.modulemap"),
  join(artifactRoot, "module.modulemap"),
);
console.log(JSON.stringify({
  artifact: destination,
  target,
  sha256: createHash("sha256").update(readFileSync(destination)).digest("hex"),
  rustc: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
}));
