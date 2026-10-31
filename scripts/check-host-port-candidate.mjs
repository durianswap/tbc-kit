// Clean-installed offline verification; never signs a real account or POSTs.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { schnorr } from '../source/node_modules/@noble/curves/secp256k1.js';
import { sha256, platformCatalog } from '../source/packages/kit/scripts/platform-resources.mjs';
import { syncNative } from '../source/packages/kit/examples/react-native-engine/module/scripts/sync-native.mjs';

const repo = resolve(import.meta.dirname, '..');
const [outArg, baselineArg] = process.argv.slice(2);
assert(baselineArg, 'CANDIDATE_DIR BASELINE_REPOSITORY');
const out = resolve(outArg), baseline = resolve(baselineArg);
const lock = JSON.parse(await readFile(join(out, 'delivery-lock.json')));
assert.equal(sha256(await readFile(join(out, 'tbc-kit.tgz'))), lock.kit.sha256);
const scratch = await mkdtemp(join(repo, '.verify/host-port-check-'));
const run = (cwd, command, args, extra = {}) => execFileSync(command, args,
  { cwd, encoding: 'utf8', maxBuffer: 16e6, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], ...extra });
const roots = [];
for (const [name, archive] of [['baseline', join(baseline, lock.baseline.kit.file)], ['candidate', join(out, 'tbc-kit.tgz')]]) {
  const dir = join(scratch, name); await mkdir(dir);
  await writeFile(join(dir, 'package.json'), '{"name":"offline-kit-consumer","private":true,"type":"module"}');
  run(dir, 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive]);
  roots.push({ dir, kit: join(dir, 'node_modules/@tbc/kit') });
}
const [before, after] = roots;
// Reproduce the actual published adapter omission, not just an invented error.
const oldPlatform = await import(pathToFileURL(join(before.kit, 'examples/independent-wallet/controlled-platform.mjs')));
const publicTask = { taskId: 'reported-profile-reproduction', digest: '00'.repeat(32),
  algorithm: 'secp256k1-schnorr-bip340', signatureEncoding: 'schnorr64' };
const oldResult = await oldPlatform.createControlledPlatform().signer.sign({ task: publicTask });
assert.equal(oldResult.signatureEncoding, 'compact64');
const scalar = Uint8Array.from({ length: 32 }, (_, i) => i === 31 ? 1 : 0);
assert.equal(schnorr.verify(oldResult.signature, publicTask.digest, schnorr.getPublicKey(scalar)), false);
const { signControlledTask } = await import(pathToFileURL(join(after.kit, 'examples/shared/controlled-signer.mjs')));
const fixedResult = signControlledTask(publicTask, scalar);
assert.equal(fixedResult.signatureEncoding, 'schnorr64');
assert(schnorr.verify(fixedResult.signature, publicTask.digest, schnorr.getPublicKey(scalar)));
const entrypoints = ['', '/wallet', '/engine', '/api', '/rpc', '/sqlite', '/testing', '/multisig'];
for (const mode of ['esm', 'cjs']) run(after.dir, process.execPath, [
  ...(mode === 'esm' ? ['--input-type=module'] : []), '-e',
  `for(const x of ${JSON.stringify(entrypoints)}){const v=${mode === 'esm' ? "await import('@tbc/kit'+x)" : "require('@tbc/kit'+x)"};if(!Object.keys(v).length)throw Error(x);}`,
]);
const examples = [];
for (const [name, args] of [['independent-wallet/run.mjs', []], ['backend-node/run.mjs', []],
  ['backend-node/run.mjs', ['--send']], ['sign-in/run.mjs', []], ['approval-presentation/run.mjs', []],
  ['multi-wallet/run.mjs', []], ['multi-round-merge/run.mjs', []]]) {
  const outputs = roots.map(r => run(r.dir, process.execPath, [join(r.kit, 'examples', name), ...args]));
  assert.equal(outputs[0], outputs[1], `Existing business example changed: ${name}`);
  examples.push({ name, args, status: 'PASS', outputSha256: sha256(outputs[1]), identicalToBaseline: true });
}
const profiles = run(after.dir, process.execPath, [join(after.kit, 'examples/shared/check-signer.mjs')]);
const focused = run(join(repo, 'source'), process.execPath, ['--test', 'packages/kit/test/host-port-business-errors.test.mjs'], {
  env: { ...process.env, TBC_TEST_INSTALLED_KIT: after.kit, TBC_TEST_WASM_DIR: join(after.kit, 'artifacts/wasm') },
});
await writeFile(join(out, 'evidence/installed-business-tests.tap'), focused);
assert.match(focused, /# fail 0/);
// Interleaved cold-process comparison. Each sample is TWO complete controlled
// Coin creations with real frozen WASM, one approval each and a mock broadcaster.
// This is not an iOS/Android or live-API speed claim.
const timings = [[], []];
for (let i = 0; i < 7; i++) for (const which of i % 2 ? [1, 0] : [0, 1]) {
  const r = roots[which];
  const tap = run(join(repo, 'source'), process.execPath,
    ['--test', '--test-name-pattern=Coin create 0/6', 'packages/kit/test/host-port-business-errors.test.mjs'],
    { env: { ...process.env, TBC_TEST_INSTALLED_KIT: r.kit, TBC_TEST_WASM_DIR: join(r.kit, 'artifacts/wasm') } });
  assert.match(tap, /# fail 0/);
  if (i > 0) timings[which].push(Number(tap.match(/duration_ms: ([\d.]+)/)[1]));
}
const stats = rows => { const sorted = [...rows].sort((a,b)=>a-b); return { samples: rows, medianMs: (sorted[2]+sorted[3])/2, minMs: sorted[0], maxMs: sorted.at(-1) }; };
const timing = { baseline: stats(timings[0]), candidate: stats(timings[1]),
  scope: 'Mac Node; two synthetic Coin creations per sample; excludes module import; no device or live API claim' };
timing.medianChangePercent = (timing.candidate.medianMs/timing.baseline.medianMs-1)*100;
const sdkChecks = [];
await platformCatalog(after.kit);
for (const platform of ['ios', 'android']) {
  const item = lock.pairedNative[platform];
  assert.equal(sha256(await readFile(join(baseline, item.file))), item.sha256);
  const sdk = join(scratch, `${platform}-sdk`), app = join(scratch, `${platform}-app`);
  await mkdir(sdk); await mkdir(join(app, 'node_modules/@tbc'), { recursive: true });
  await writeFile(join(app, 'package.json'), '{"name":"native-adapter-consumer","private":true}');
  run(repo, 'tar', ['-xzf', join(baseline, item.file), '-C', sdk]);
  await cp(after.kit, join(app, 'node_modules/@tbc/kit'), { recursive: true });
  run(repo, process.execPath, [join(after.kit, 'examples/react-native-engine/install.mjs'), app, sdk, '--platform', platform]);
  const identity = await syncNative({ moduleRoot: join(app, 'modules/tbc-kit-engine'), kitRoot: after.kit, check: true, platform });
  assert.equal(identity.kitVersion, lock.kitVersion); assert.equal(identity.sdkVersion, lock.sdkVersion);
  sdkChecks.push({ platform, status: 'PASS', identity, deviceBuild: false });
}
const report = { status: 'PASS', scratch, consumer: after, kit: lock.kit,
  publishedRc20SignerGap: { reproduced: true, originalEncoding: oldResult.signatureEncoding,
    originalSchnorrVerification: false, candidateSchnorrVerification: true },
  esmEntrypoints: 8, cjsEntrypoints: 8, examples, profiles: JSON.parse(profiles),
  installedBusinessTests: 6, timing, sdkChecks, networkBusinessReads: 0, realBroadcasts: 0 };
await writeFile(join(out, 'evidence/installed-check.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
