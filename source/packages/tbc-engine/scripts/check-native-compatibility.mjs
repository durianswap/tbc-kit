import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { hashCanonical, canonicalize } from "@tbc-wallet/core";
const [packagePath, vectorsPath, reportPath] = process.argv.slice(2);
assert(packagePath && vectorsPath && reportPath, "PACKAGE VECTORS REPORT are required");
globalThis.fetch = async () => { throw new Error("network disabled"); };
const root = resolve(packagePath);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const wasmPath = join(root, "artifacts/wasm/tbc_engine_wasm.wasm");
const nativePath = join(root, "artifacts/native/aarch64-apple-darwin/libtbc_engine_native.dylib");
const { createWasmTbcEngineBackend } = await import(pathToFileURL(join(root, "dist/esm/wasm.js")).href);
const wasm = await createWasmTbcEngineBackend(readFileSync(wasmPath));
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8"));
const cases = [];
for (const [name, vector] of Object.entries(vectors)) {
  const common = structuredClone(vector.finalizeInput);
  const preSign = structuredClone(common); delete preSign.signatures;
  for (const [method, input, phase] of [
    ["normalizeRequest", { version: "1.0", request: vector.planInput.request }, "normalize"],
    ["plan", vector.planInput, "plan"],
    ["validate", { ...vector.planInput, phase: "plan", plan: common.plan }, "validate-plan"],
    ["validate", { ...preSign, phase: "pre-sign" }, "validate-pre-sign"],
    ["finalize", common, "finalize"],
    ["validate", { ...common, phase: "finalized", bundle: vector.complete.bundle }, "validate-finalized"],
  ]) cases.push({ name, method, phase, input: canonicalize(input), valid: true });
  const missing = structuredClone(vector.planInput);
  missing.snapshot.payload.parents = [];
  missing.snapshot.snapshotHash = hashCanonical(missing.snapshot.payload);
  if (name !== "nativePrevoutOnly") cases.push({ name, method: "plan", phase: "missing-asset-ancestry", input: canonicalize(missing), valid: false });
}
const invalidNative = structuredClone(vectors.nativePrevoutOnly.planInput);
invalidNative.snapshot.payload.utxos[0].scriptPubKey = "51";
invalidNative.snapshot.snapshotHash = hashCanonical(invalidNative.snapshot.payload);
cases.push({ name: "nativePrevoutOnly", method: "plan", phase: "wrong-ownership", input: canonicalize(invalidNative), valid: false });
const iterations = 15;
const python = `import ctypes,json,sys,time,statistics
class Buffer(ctypes.Structure):
 _fields_=[("ptr",ctypes.POINTER(ctypes.c_ubyte)),("len",ctypes.c_size_t),("cap",ctypes.c_size_t)]
lib=ctypes.CDLL(sys.argv[1])
lib.tbc_engine_call.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_void_p,ctypes.c_size_t]
lib.tbc_engine_call.restype=Buffer
lib.tbc_engine_free.argtypes=[Buffer]
lib.tbc_engine_free.restype=None
payload=json.load(sys.stdin);results=[]
for case in payload["cases"]:
 method=case["method"].encode();data=case["input"].encode()
 method_buf=ctypes.create_string_buffer(method);input_buf=ctypes.create_string_buffer(data)
 samples=[];first=None
 for n in range(payload["iterations"]+2):
  start=time.perf_counter()
  result=lib.tbc_engine_call(method_buf,len(method),input_buf,len(data))
  try: raw=ctypes.string_at(result.ptr,result.len).decode()
  finally: lib.tbc_engine_free(result)
  elapsed=(time.perf_counter()-start)*1000
  if first is None:first=raw
  if raw!=first:raise RuntimeError("nondeterministic response")
  if n>=2:samples.append(elapsed)
 results.append({"raw":first,"medianMs":statistics.median(samples)})
json.dump(results,sys.stdout,separators=(",",":"))
`;
const nativeResults = JSON.parse(execFileSync("python3", ["-c", python, nativePath], { input: JSON.stringify({ cases, iterations }), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
const checks = [];
for (const [index, item] of cases.entries()) {
  const times = []; let first;
  for (let n = 0; n < iterations + 2; n++) {
    const started = performance.now();
    const raw = wasm.call(item.method, item.input);
    if (n >= 2) times.push(performance.now() - started);
    first ??= raw;
    assert.equal(sha(raw), sha(first), "WASM result must be deterministic");
  }
  const parsed = JSON.parse(first);
  assert.deepEqual(JSON.parse(nativeResults[index].raw), parsed, "native/WASM envelopes must agree");
  assert.equal(parsed.ok, item.valid, item.name + " " + item.phase);
  if (item.valid && item.method === "validate") assert.deepEqual(parsed.result, { valid: true, violations: [] });
  if (item.valid && item.method === "plan") assert.deepEqual(parsed.result, vectors[item.name].planned);
  if (item.valid && item.method === "finalize") assert.deepEqual(parsed.result, vectors[item.name].complete);
  times.sort((a, b) => a - b);
  checks.push({ name: item.name, method: item.method, phase: item.phase, expectedAccepted: item.valid, resultSha256: sha(canonicalize(parsed)), nativeMedianMs: nativeResults[index].medianMs, wasmMedianMs: times[Math.floor(times.length / 2)] });
}
const report = { version: "1.0", packageVersion: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, nativeSha256: sha(readFileSync(nativePath)), wasmSha256: sha(readFileSync(wasmPath)), publicVectorsSha256: sha(readFileSync(vectorsPath)), iterations, warmupIterations: 2, checks, boundary: "Desktop in-process native C ABI and WASM timing using public fixed-key fixtures; excludes JSON transport, facade, Host, Store, mobile bridge and network. Not Android latency or real sell acceptance.", networkRequests: 0, realSignaturesCreated: 0, broadcasts: 0 };
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ packageVersion: report.packageVersion, checksPassed: checks.length, nativeSha256: report.nativeSha256, wasmSha256: report.wasmSha256, phaseTimings: checks.filter(c => c.expectedAccepted && ["plan", "finalize", "validate-finalized"].includes(c.phase)).map(({ name, phase, nativeMedianMs, wasmMedianMs }) => ({ name, phase, nativeMedianMs, wasmMedianMs })) }));
