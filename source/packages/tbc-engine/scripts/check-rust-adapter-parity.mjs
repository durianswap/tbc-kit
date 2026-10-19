import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../rust");
execFileSync("cargo", ["test", "--locked", "--offline", "-p", "tbc-engine-adapter-parity", "--test", "cross_adapter"], { cwd: workspace, stdio: "inherit" });
console.log("native/wasm/core response-byte parity passed");
