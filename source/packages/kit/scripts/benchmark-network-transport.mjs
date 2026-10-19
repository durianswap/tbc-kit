// Controlled local comparison only; this does not measure network or iOS latency.
// Usage: node packages/kit/scripts/benchmark-network-transport.mjs /path/to/baseline/dist/esm/api.js
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createTbcHttpTransport as current } from "../dist/esm/api.js";

if (!process.argv[2]) throw new Error("Provide the frozen baseline api.js path");
const { createTbcHttpTransport: baseline } = await import(pathToFileURL(process.argv[2]));
function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}
async function run(factory, bytes, count) {
  const payload = "x".repeat(bytes);
  let requests = 0;
  const client = factory({ baseUrl: "https://controlled.example", fetch: async () => {
    requests += 1;
    return new Response(payload);
  } });
  const start = performance.now();
  for (let i = 0; i < count; i += 1) await client.requestText("GET", String(i));
  assert.equal(requests, count);
  return (performance.now() - start) * 1000 / count;
}
const processing = [];
for (const [bytes, count] of [[512, 1500], [65536, 250]]) {
  await run(baseline, bytes, count);
  await run(current, bytes, count);
  const before = [], after = [];
  for (let round = 0; round < 8; round += 1) {
    const order = round % 2 ? [[current, after], [baseline, before]] : [[baseline, before], [current, after]];
    for (const [factory, results] of order) results.push(await run(factory, bytes, count));
  }
  processing.push({ bytes, requestsPerRound: count, rounds: 8,
    baselineMedianUs: median(before), currentMedianUs: median(after),
    baselineSamplesUs: before, currentSamplesUs: after });
}
async function batch(factory) {
  let requests = 0;
  const client = factory({ baseUrl: "https://controlled.example", fetch: async () => {
    requests += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response('{"ok":true}');
  } });
  const start = performance.now();
  const pending = Array.from({ length: 64 }, (_, i) => client.requestJson("GET", String(i)));
  assert.equal(requests, 64, "independent requests must start in the same turn");
  pending.push(client.requestJson("GET", "0"));
  await Promise.all(pending);
  assert.equal(requests, 64, "one duplicate must share the original read");
  return performance.now() - start;
}
const before = [], after = [];
for (let round = 0; round < 8; round += 1) {
  const order = round % 2 ? [[current, after], [baseline, before]] : [[baseline, before], [current, after]];
  for (const [factory, results] of order) results.push(await batch(factory));
}
console.log(JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version,
  methodology: "Same process, same input, observer disabled, alternating order. No real HTTP, no iOS claim.",
  processing,
  parallel: { independent: 64, duplicate: 1, httpAttempts: 64, controlledDelayMs: 20,
    baselineMedianMs: median(before), currentMedianMs: median(after),
    baselineSamplesMs: before, currentSamplesMs: after },
}, null, 2));
