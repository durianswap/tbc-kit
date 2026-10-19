import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { materializeCheckpoints } from "../scripts/lib/lifecycle-conformance.mjs";
import { repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);
const readJson = (path) => JSON.parse(fs.readFileSync(`${root}/${path}`, "utf8"));
const schemaNames = fs.readdirSync(`${root}/schemas`).filter((name) => name.endsWith(".json"));
const schemas = schemaNames.map((name) => readJson(`schemas/${name}`));
const integration = schemas.find((schema) => schema.$id.endsWith("/integration.schema.json"));
const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
ajv.addFormat("uri", (value) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
});
ajv.addFormat("date-time", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/);
schemas.forEach((schema) => ajv.addSchema(schema));
const validate = ajv.getSchema(`${integration.$id}#/$defs/cancelInput`);

const lifecycle = readJson("test-vectors/checkpoints.json");
const provider = readJson("test-vectors/provider.json");
const vectors = readJson("test-vectors/cancel-authority.json");
const checkpoint = materializeCheckpoints(lifecycle).find(
  (entry) => entry.id === "authorizing",
).checkpoint;
const base = { version: "1.0", checkpoint };
const authority = {
  currentContext: lifecycle.fixture.basePayload.context,
  currentSession: provider.providerSessions.sessionA,
};

test("cancel authority Schema is optional only for self-proving reasons", () => {
  for (const reason of vectors.optionalReasons) {
    assert.equal(validate({ ...base, reason }), true, reason);
    assert.equal(validate({ ...base, reason, ...authority }), true, `${reason} provided`);
    assert.equal(
      validate({ ...base, reason, currentContext: authority.currentContext }),
      false,
      `${reason} partial authority`,
    );
  }
  for (const reason of vectors.requiredReasons) {
    assert.equal(validate({ ...base, reason }), false, reason);
    assert.equal(validate({ ...base, reason, ...authority }), true, `${reason} provided`);
  }
});
