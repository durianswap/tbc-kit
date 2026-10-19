import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWasmTbcEngineBackend } from '../dist/esm/engine.js';

const [oldRunner, newRunner, simulator, outputDir] = process.argv.slice(2);
assert.ok(oldRunner && newRunner && simulator && outputDir, 'Expected OLD_RUNNER NEW_RUNNER SIMULATOR SCRATCH_DIRECTORY');
const root = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(root, 'packages/tbc-engine/rust/fixtures');
const mappings = { normalizeInput: 'normalizeRequest', planInput: 'plan', validateInput: 'validate', finalizeInput: 'finalize' };
const vectors = [];
function collect(value, name) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (key in mappings) vectors.push({ name: `${name}.${key}`, method: mappings[key], input: JSON.stringify(nested) });
    else if (nested && typeof nested === 'object') collect(nested, `${name}.${key}`);
  }
}
for (const name of readdirSync(fixtureRoot).filter(name => name.endsWith('.json')).sort()) {
  collect(JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8')), name);
}
for (const method of Object.values(mappings)) vectors.push({ name: `invalid.${method}`, method, input: '{}' });
assert.ok(vectors.length >= 4);
writeFileSync(resolve(outputDir, 'vectors.json'), JSON.stringify(vectors));
for (const [name, runner] of [['old', oldRunner], ['new', newRunner]]) {
  execFileSync('xcrun', ['simctl', 'spawn', simulator, runner, resolve(outputDir, 'vectors.json'), resolve(outputDir, `${name}-results.json`)], { stdio: 'inherit' });
}
const oldResults = JSON.parse(readFileSync(resolve(outputDir, 'old-results.json')));
const newResults = JSON.parse(readFileSync(resolve(outputDir, 'new-results.json')));
assert.deepEqual(newResults, oldResults, 'New iOS native output changed from frozen native');
const wasm = await createWasmTbcEngineBackend(readFileSync(resolve(root, 'packages/kit/artifacts/wasm/tbc_engine_wasm.wasm')));
const successfulMethods = new Set();
const checks = [];
for (let index = 0; index < vectors.length; index++) {
  const vector = vectors[index];
  const output = await wasm.call(vector.method, vector.input);
  assert.equal(newResults[index].output, output, `WASM/native mismatch: ${vector.name}`);
  const ok = JSON.parse(output).ok === true;
  if (ok) successfulMethods.add(vector.method);
  checks.push({ name: vector.name, method: vector.method, ok });
}
assert.deepEqual([...successfulMethods].sort(), Object.values(mappings).sort(), 'Require positive coverage of all four methods');
writeFileSync(resolve(outputDir, 'parity-summary.json'), JSON.stringify({ pass: true, count: checks.length, checks }, null, 2));
console.log(JSON.stringify({ pass: true, count: checks.length, successes: checks.filter(x => x.ok).length, successfulMethods: [...successfulMethods].sort() }));
