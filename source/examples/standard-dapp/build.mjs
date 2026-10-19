import { build } from "esbuild";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
const app = await build({ entryPoints: ["src/app.ts"], outfile: "dist/app.js", bundle: true,
  format: "esm", platform: "browser", target: "es2022", external: ["@wallet-standard/core"], metafile: true });
await build({ stdin: { contents: 'export * from "@wallet-standard/core";', resolveDir: process.cwd() },
  outfile: "dist/wallet-standard-core.js", bundle: true, format: "esm", platform: "browser", target: "es2022" });
await copyFile("index.html", "dist/index.html");
await copyFile("style.css", "dist/style.css");
const files = ["app.js", "wallet-standard-core.js", "index.html", "style.css"];
const hashes = {};
for (const file of files) hashes[file] = createHash("sha256").update(await readFile(`dist/${file}`)).digest("hex");
await writeFile("dist/build-identity.json", JSON.stringify({ app: "tbc-standard-dapp", version: "0.1.0", nativeDecimals: 6,
  sdkVersion: "1.0.0-draft.6.3", files: hashes }, null, 2) + "\n");
await writeFile("dist/build-inputs.json", JSON.stringify(Object.keys(app.metafile.inputs), null, 2) + "\n");
console.log("Built standard DApp; external Wallet Standard singleton and public SDK only.");
