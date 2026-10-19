// Source-only: do not replace frozen package artifacts to test a draft schema.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const built = await build({
  stdin: { contents: "export { assertValidTws } from './packages/core/src/validation.ts';", resolveDir: root, loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "node", target: "node22", logLevel: "silent",
});
const url = new URL("../src/.schnorr-source-validator.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) { return specifier === url ? { url, shortCircuit: true } : next(specifier, context); },
  load(specifier, context, next) { return specifier === url ? { source: built.outputFiles[0].text, format: "module", shortCircuit: true } : next(specifier, context); },
});
const { assertValidTws } = await import(url);
hooks.deregister();
const fixture = JSON.parse(readFileSync(`${root}test-vectors/integration.json`, "utf8")).canonicalTransfer;
const ecdsa = fixture.plan.payload.signingTasks[0];
const schnorr = { ...ecdsa, algorithm: "secp256k1-schnorr-bip340", signatureEncoding: "schnorr64", publicKey: ecdsa.publicKey.slice(2) };
const validate = task => assertValidTws("planResult", {
  plan: { ...fixture.plan, payload: { ...fixture.plan.payload, signingTasks: [task] } },
});

test("transaction wire pairs algorithm, encoding and key; Schnorr cannot impersonate message signing", () => {
  validate(ecdsa); validate(schnorr);
  for (const bad of [
    { ...schnorr, signatureEncoding: "compact64" }, { ...ecdsa, signatureEncoding: "schnorr64" },
    { ...schnorr, publicKey: ecdsa.publicKey }, { ...ecdsa, publicKey: schnorr.publicKey },
    { ...schnorr, publicKey: schnorr.publicKey.toUpperCase() }, { ...schnorr, sighashType: 1 },
    { ...schnorr, algorithm: "secp256k1-schnorr" }, { ...schnorr, purpose: "message" },
  ]) assert.throws(() => validate(bad));
});

test("Schnorr result has exactly 64 canonical bytes and never includes the sighash suffix", () => {
  const result = { taskId: schnorr.taskId, signatureEncoding: "schnorr64", signature: "ab".repeat(64) };
  assertValidTws("signerSignResult", result);
  for (const signature of [result.signature + "41", result.signature.slice(2), result.signature.toUpperCase(), "zz".repeat(64)]) {
    assert.throws(() => assertValidTws("signerSignResult", { ...result, signature }));
  }
});
