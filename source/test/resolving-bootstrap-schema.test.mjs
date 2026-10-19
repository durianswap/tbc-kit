import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

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
const validate = ajv.getSchema(`${integration.$id}#/$defs/resolvingCheckpointData`);

test("resolving bootstrap permits only an empty or complete account cursor", () => {
  assert.equal(validate({ resolvedInputs: {} }), true);
  assert.equal(validate({ resolvedInputs: { account: {
    address: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
    accountId: "tbc:mainnet:1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
    chainId: "tbc:mainnet",
    publicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  } } }), true);
  assert.equal(validate({ resolvedInputs: { account: {} } }), false);
  assert.equal(validate({ resolvedInputs: { untrustedAccount: {} } }), false);
});
