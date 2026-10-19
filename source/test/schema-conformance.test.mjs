import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cp, rm, writeFile } from "node:fs/promises";
import { repositoryRoot } from "../scripts/lib/repository.mjs";
import { runSchemaConformance } from "../scripts/lib/schema-conformance.mjs";

const root = repositoryRoot(import.meta.url);

test("validates every root schema, definition, registry and declared vector", () => {
  assert.deepEqual(runSchemaConformance(root), {
    schemas: 19,
    definitions: 408,
    registries: 7,
    positive: 277,
    negative: 72,
  });
});

test("rejects a registry operation whose result schema reference cannot resolve", async (context) => {
  const copyRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "tws-schema-"),
  );
  context.after(() => rm(copyRoot, { recursive: true, force: true }));
  for (const directory of ["schemas", "registry", "test-vectors"]) {
    await cp(path.join(root, directory), path.join(copyRoot, directory), {
      recursive: true,
    });
  }
  const registryPath = path.join(
    copyRoot,
    "registry/integration-ports.json",
  );
  const registry = JSON.parse(
    await fs.promises.readFile(registryPath, "utf8"),
  );
  registry.ports[0].operations[0].result.schema =
    "integration.schema.json#/$defs/notPresent";
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

  assert.throws(() => runSchemaConformance(copyRoot), /notPresent/);
});

test("rejects a hash binding whose input schema reference cannot resolve", async (context) => {
  const copyRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "tws-hash-schema-"),
  );
  context.after(() => rm(copyRoot, { recursive: true, force: true }));
  for (const directory of ["schemas", "registry", "test-vectors"]) {
    await cp(path.join(root, directory), path.join(copyRoot, directory), {
      recursive: true,
    });
  }
  const registryPath = path.join(copyRoot, "registry/hash-bindings.json");
  const registry = JSON.parse(
    await fs.promises.readFile(registryPath, "utf8"),
  );
  registry.bindings[0].inputSchema =
    "integration.schema.json#/$defs/notPresent";
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

  assert.throws(() => runSchemaConformance(copyRoot), /notPresent/);
});
