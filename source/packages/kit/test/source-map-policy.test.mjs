import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { omitEmbeddedSources } from "../scripts/source-map-policy.mjs";

test("map policy preserves runtime and mapping metadata, and is idempotent", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "kit-map-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = 'export const value = 1;\n//# sourceMappingURL=entry.js.map\n';
  const metadata = { version: 3, sources: ["../src/entry.ts"], names: ["value"], mappings: "AAAA", file: "entry.js", sourceRoot: "", x_google_ignoreList: [] };
  await writeFile(resolve(directory, "entry.js"), runtime);
  await writeFile(resolve(directory, "entry.js.map"), JSON.stringify({ ...metadata, sourcesContent: ["export const value: number = 1;"] }));
  const result = await omitEmbeddedSources(directory);
  assert.equal(result.maps, 1);
  assert.equal(result.changed, 1);
  assert.ok(result.bytesSaved > 0);
  assert.deepEqual(JSON.parse(await readFile(resolve(directory, "entry.js.map"), "utf8")), metadata);
  assert.equal(await readFile(resolve(directory, "entry.js"), "utf8"), runtime);
  assert.deepEqual(await omitEmbeddedSources(directory), { maps: 1, changed: 0, bytesSaved: 0 });
});

test("unsupported map aborts before applying changes", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "kit-map-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = JSON.stringify({ version: 3, sources: ["a.ts"], mappings: "AAAA", sourcesContent: ["a"] });
  await writeFile(resolve(directory, "a.map"), original);
  await writeFile(resolve(directory, "z.map"), JSON.stringify({ version: 3, sections: [] }));
  await assert.rejects(omitEmbeddedSources(directory), /Unsupported Kit source map/);
  assert.equal(await readFile(resolve(directory, "a.map"), "utf8"), original);
});
