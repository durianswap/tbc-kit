import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = join(packageRoot, "rust");
execFileSync("cargo", ["build", "--locked", "--release", "-p", "tbc-engine-wasm", "--target", "wasm32-unknown-unknown"], {
  cwd: workspace,
  env: { ...process.env, RUSTFLAGS: '--cfg getrandom_backend="unsupported"' },
  stdio: "inherit",
});
const source = join(workspace, "target", "wasm32-unknown-unknown", "release", "tbc_engine_wasm.wasm");
const destination = join(packageRoot, "artifacts", "wasm", "tbc_engine_wasm.wasm");
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
const sha256 = createHash("sha256").update(readFileSync(destination)).digest("hex");
console.log(JSON.stringify({ artifact: destination, target: "wasm32-unknown-unknown", sha256, rustc: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim() }));
