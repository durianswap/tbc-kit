import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function loadInternals(modules) {
  const directory = mkdtempSync(path.join(tmpdir(), "tbc-engine-internals-"));
  const outfile = path.join(directory, "internals.mjs");
  const contents = modules
    .map(
      (module) =>
        `export * from ${JSON.stringify(path.join(packageDirectory, "src", `${module}.ts`))};`,
    )
    .join("\n");
  try {
    await build({
      bundle: true,
      format: "esm",
      logLevel: "silent",
      outfile,
      platform: "neutral",
      stdin: {
        contents,
        loader: "ts",
        resolveDir: packageDirectory,
        sourcefile: "test-internals.ts",
      },
      target: "es2022",
    });
    const runtime = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
    return Object.freeze({
      runtime,
      cleanup() {
        rmSync(directory, { recursive: true, force: true });
      },
    });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
