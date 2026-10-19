import assert from "node:assert/strict";
import test from "node:test";
import { resolvePreparedInputDependencies } from "../dist/esm/index.js";

const known = new Set(["parent-a", "parent-b"]);
const zero = [{ inputIndex: 0, sourceOutputIndex: 0 }, { inputIndex: 2, sourceOutputIndex: 2 }];
const edges = zero.map((input) => ({ ...input, sourceTransactionId: "parent-a" }));

test("Prepared explicit input edges share one parent without losing exact vouts", () => {
  assert.deepEqual(resolvePreparedInputDependencies(zero, ["parent-a"], known, edges), edges);
  assert.deepEqual(resolvePreparedInputDependencies(zero, ["parent-a", "parent-b"], known), [
    edges[0], { ...edges[1], sourceTransactionId: "parent-b" },
  ]);
  assert.deepEqual(resolvePreparedInputDependencies([], [], known), []);
});

test("Prepared ambiguous, duplicate, moved and undeclared edges fail closed", () => {
  const invalid = (inputs, deps, mapping) => assert.throws(
    () => resolvePreparedInputDependencies(inputs, deps, known, mapping),
    (error) => error.code === "ENGINE_ARTIFACT_MISMATCH");
  invalid(zero, ["parent-a"]);
  invalid(zero, ["parent-a"], edges.slice(0, 1));
  invalid(zero, ["parent-a"], [edges[1], edges[0]]);
  invalid(zero, ["parent-a"], [edges[0], { ...edges[1], sourceOutputIndex: 1 }]);
  invalid(zero, ["parent-a"], [edges[0], { ...edges[1], sourceTransactionId: "parent-b" }]);
  invalid(zero, ["parent-a", "parent-b"], edges);
  invalid(zero, ["parent-a", "parent-a"], edges);
  invalid(zero, ["unknown"], edges);
  invalid([zero[0], { ...zero[1], sourceOutputIndex: 0 }], ["parent-a"], [edges[0], { ...edges[1], sourceOutputIndex: 0 }]);
});
