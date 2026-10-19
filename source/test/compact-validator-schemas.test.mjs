import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { compactValidatorSchemas } from "../scripts/lib/compact-validator-schemas.mjs";

test("schema projection preserves enum errors and additional-property checks", () => {
  const source = `
    const schema1 = {"properties":{"name":{"type":"string","maxLength":12},"size":{"enum":[1,2]}},"unused":{"description":"not needed at runtime"}};
    const own = Object.prototype.hasOwnProperty;
    globalThis.probe = (key) => ({allowed:own.call(schema1.properties,key), values:schema1.properties.size.enum});
  `;
  const compact = compactValidatorSchemas(source);
  assert.doesNotMatch(compact, /not needed at runtime|maxLength/);
  const baseline = {}, optimized = {};
  vm.runInNewContext(source, baseline);
  vm.runInNewContext(compact, optimized);
  for (const key of ["name", "size", "unknown", "__proto__", "constructor", "toString"]) {
    assert.equal(JSON.stringify(optimized.probe(key)), JSON.stringify(baseline.probe(key)));
  }
});

test("dynamic reads, writes, escaping roots and non-JSON constants are retained", () => {
  for (const use of ["schema1[key]", "schema1.a = 2", "delete schema1.a", "schema1.a++", "consume(schema1)"]) {
    const source = `const schema1 = {"a":1}; globalThis.run=()=>{${use};return schema1.a;};`;
    assert.equal(compactValidatorSchemas(source), source);
  }
  const source = 'const schema1 = factory(); globalThis.run=()=>schema1.a;';
  assert.equal(compactValidatorSchemas(source), source);
});

test("repeated reads share one projection and transformation is deterministic", () => {
  const source = 'const schema1 = {"enum":["a","b"]}; globalThis.run=()=>[schema1.enum,schema1.enum];';
  const compact = compactValidatorSchemas(source);
  assert.equal(compactValidatorSchemas(source), compact);
  const context = {}; vm.runInNewContext(compact, context);
  const [first, second] = context.run();
  assert.equal(first, second);
  assert.equal((compact.match(/const twsSchemaProjection/g) ?? []).length, 1);
});
