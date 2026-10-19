import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Run after bundling: preserve emitted JS, hashed chunk names and map links.
// Keep all mapping metadata; only embedded original source is omitted.
export async function omitEmbeddedSources(directory) {
  const pending = [];
  let maps = 0;
  async function visit(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".map")) {
        const original = await readFile(path, "utf8");
        const map = JSON.parse(original);
        if (map.version !== 3 || !Array.isArray(map.sources) || typeof map.mappings !== "string") {
          throw new Error(`Unsupported Kit source map: ${path}`);
        }
        maps += 1;
        if (Object.hasOwn(map, "sourcesContent")) {
          const { sourcesContent: _omitted, ...metadata } = map;
          const replacement = `${JSON.stringify(metadata)}\n`;
          pending.push({ path, replacement, saved: Buffer.byteLength(original) - Buffer.byteLength(replacement) });
        }
      }
    }
  }
  // Validate all maps before changing any file.
  await visit(directory);
  for (const { path, replacement } of pending) await writeFile(path, replacement);
  return { maps, changed: pending.length, bytesSaved: pending.reduce((sum, item) => sum + item.saved, 0) };
}
