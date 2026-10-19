import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { materializeCheckpoints } from "../scripts/lib/lifecycle-conformance.mjs";
import { repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);
const readJson = (path) => JSON.parse(fs.readFileSync(`${root}/${path}`, "utf8"));
const schemas = fs.readdirSync(`${root}/schemas`)
  .filter((name) => name.endsWith(".json"))
  .map((name) => readJson(`schemas/${name}`));
const integration = schemas.find((schema) => schema.$id.endsWith("/integration.schema.json"));
const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
ajv.addFormat("uri", () => true);
ajv.addFormat("date-time", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/);
schemas.forEach((schema) => ajv.addSchema(schema));
const validate = ajv.getSchema(`${integration.$id}#/$defs/operationCheckpoint`);

const vectors = readJson("test-vectors/checkpoints.json");
const permissions = readJson("test-vectors/permissions.json");
const materialized = materializeCheckpoints(vectors);
const committed = materialized.find(({ id }) => id === "committing").checkpoint;
const clockCall = structuredClone(
  materialized.find(({ id }) => id === "initializing").checkpoint.payload.pendingCalls[0],
);

function checkpointWith(changes) {
  return {
    payload: {
      ...structuredClone(committed.payload),
      pendingCalls: [clockCall],
      ...changes,
    },
    checkpointHash: "a".repeat(64),
  };
}

test("committing permits one fresh clock before either discriminated commit path", () => {
  const providerClock = checkpointWith({});
  assert.equal(validate(providerClock), true, JSON.stringify(validate.errors));

  const permissionCommit = { params: permissions.commit.params };
  const permissionClock = checkpointWith({
    memory: {
      ...structuredClone(committed.payload.memory),
      permissionCommit,
    },
    data: { kind: "permission-store", permissionCommit },
  });
  delete permissionClock.payload.memory.providerSessionMutation;
  assert.equal(validate(permissionClock), true, JSON.stringify(validate.errors));

  const wrongProviderEffect = structuredClone(providerClock);
  wrongProviderEffect.payload.pendingCalls[0].operation = "permissionStore.commit";
  assert.equal(validate(wrongProviderEffect), false);
});
