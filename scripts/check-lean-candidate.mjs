// Paired installed-consumer checks; no real chain calls or device mutations.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile, mkdtemp, cp, readdir, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {build} from '../source/node_modules/esbuild/lib/main.js';
import {sha256, fileInventory, platformCatalog, verifiedResourceRoot} from '../source/packages/kit/scripts/platform-resources.mjs';
import {syncNative} from '../source/packages/kit/examples/react-native-engine/module/scripts/sync-native.mjs';

const [candidateArg, consumerArg, baselineArchiveArg] = process.argv.slice(2);
assert(baselineArchiveArg, 'CANDIDATE_DIR INSTALLED_CONSUMER FROZEN_BASELINE_TAR');
const repo = resolve(import.meta.dirname, '..'), out = resolve(candidateArg), consumer = resolve(consumerArg);
const kit = join(consumer, 'node_modules/@tbc/kit');
const lock = JSON.parse(await readFile(join(out, 'delivery-lock.json')));
const scratch = await mkdtemp(join(repo, '.verify/lean-check-'));
const baseline = join(scratch, 'baseline'); await mkdir(baseline);
await writeFile(join(baseline, 'package.json'), '{"name":"kit-baseline-check","private":true,"type":"module"}');
assert.equal(sha256(await readFile(resolve(baselineArchiveArg))), lock.baseline['tbc-kit.tgz'].sha256);
execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', resolve(baselineArchiveArg)], {cwd: baseline, stdio: 'pipe', timeout: 120000});
const baseKit = join(baseline, 'node_modules/@tbc/kit');
const runtime = JSON.parse(await readFile(join(out, 'evidence/runtime-identity.json')));
const installed = await fileInventory(kit);
for (const [path, file] of Object.entries(runtime.files)) {
  if (/^artifacts\/(native|keyless-native)\//.test(path)) assert(!installed[path]);
  else assert.deepEqual(installed[path], file, path);
}
const installedLock = JSON.parse(await readFile(join(consumer, 'package-lock.json')));
for (const name of ['tbc-contract', 'tbc-lib-js', 'tbc-tx-parser', 'axios', 'secp256k1'])
  assert(!Object.keys(installedLock.packages).some(path => path.endsWith('/' + name)), `Dead dependency returned: ${name}`);
const sum = inventory => Object.values(inventory).reduce((n, f) => n + f.bytes, 0);
// npm creates .bin symlinks. Count actual files once, not linked copies;
// distribution/archive verification above continues to reject symlinks.
async function installedBytes(root) {
  let bytes = 0;
  for (const e of await readdir(root, {withFileTypes: true})) {
    if (e.isSymbolicLink()) continue;
    const path = join(root, e.name);
    if (e.isDirectory()) bytes += await installedBytes(path);
    else if (e.isFile()) bytes += (await stat(path)).size;
  }
  return bytes;
}
const sizes = {baselineKit: sum(await fileInventory(baseKit)), candidateKit: sum(installed),
  baselineDependencies: await installedBytes(join(baseline, 'node_modules')),
  candidateDependencies: await installedBytes(join(consumer, 'node_modules'))};
const cases = {api: `export {createTbcOfficialApi} from '@tbc/kit/api'`,
  rpc: `export * from '@tbc/kit/rpc'`,
  connect: `export {createTbcClient,getTbcWallets} from '@tbc/kit'`,
  wallet: `export {createTbcWallet} from '@tbc/kit/wallet'`,
  prepared: `export {prepareTbcTransaction} from '@tbc/kit'`};
const bundles = [];
for (const [name, contents] of Object.entries(cases)) {
  const results = [];
  for (const directory of [baseline, consumer]) {
    const b = await build({stdin: {contents, resolveDir: directory}, bundle: true, write: false,
      minify: true, format: 'esm', platform: 'browser', target: 'es2020', metafile: true, logLevel: 'silent'});
    const bytes = b.outputFiles[0].contents;
    assert(!Object.keys(b.metafile.inputs).some(path => /node_modules\/(?:tbc-contract|tbc-lib-js|tbc-tx-parser)\//.test(path)));
    results.push({sha256: sha256(bytes), bytes: bytes.length, gzipBytes: gzipSync(bytes).length});
  }
  assert.deepEqual(results[0], results[1], `${name} browser execution changed`);
  bundles.push({name, ...results[1], byteIdentical: true});
}
// Construction cannot fetch data or instantiate a WASM module.
const browser = await build({stdin: {contents: `export {createTbcClient,createLazyBundledWasmTbcKeylessEngine,createNativeTbcKeylessEngine} from '@tbc/kit'; export {createTbcEngine,createLazyBundledWasmTbcEngineBackend} from '@tbc/kit/engine';`, resolveDir: consumer},
  bundle: true, write: false, minify: true, format: 'esm', platform: 'browser', target: 'es2020', logLevel: 'silent'});
const browserPath = join(scratch, 'browser.mjs'); await writeFile(browserPath, browser.outputFiles[0].contents);
const old = {fetch: globalThis.fetch, compile: WebAssembly.compile, instantiate: WebAssembly.instantiate};
let eagerCalls = 0;
const forbidden = async () => {eagerCalls++; throw new Error('Unexpected eager network/WASM access');};
let api;
try {
  globalThis.fetch = forbidden; WebAssembly.compile = forbidden; WebAssembly.instantiate = forbidden;
  api = await import(pathToFileURL(browserPath));
  api.createTbcClient({network: 'testnet', provider: {request: async () => null, on(){}, removeListener(){}, destroy(){}}});
  api.createTbcEngine();
  api.createLazyBundledWasmTbcKeylessEngine();
  assert.equal(eagerCalls, 0);
} finally {globalThis.fetch = old.fetch; WebAssembly.compile = old.compile; WebAssembly.instantiate = old.instantiate;}
const loads = {engine: 0, keyless: 0};
const urls = {engine: 'https://assets.invalid/engine.wasm', keyless: 'https://assets.invalid/keyless.wasm'};
const bytes = {engine: await readFile(join(kit, 'artifacts/wasm/tbc_engine_wasm.wasm')),
  keyless: await readFile(join(kit, 'artifacts/wasm/tbc_keyless_wasm.wasm'))};
const fetch = async url => {const kind = Object.keys(urls).find(k => urls[k] === String(url)); assert(kind); loads[kind]++;
  return {ok: true, arrayBuffer: async () => Uint8Array.from(bytes[kind]).buffer};};
const engine = api.createLazyBundledWasmTbcEngineBackend({url: urls.engine, fetch});
const keyless = api.createLazyBundledWasmTbcKeylessEngine({url: urls.keyless, fetch});
await Promise.all(Array.from({length: 8}, () => engine.call('normalizeRequest', '{}')));
await engine.call('normalizeRequest', '{}');
assert.deepEqual(loads, {engine: 1, keyless: 0});
await Promise.all(Array.from({length: 8}, () => keyless.protocolInfo()));
await keyless.protocolInfo(); assert.deepEqual(loads, {engine: 1, keyless: 1});
let nativeCalls = 0;
try {
  globalThis.fetch = forbidden; WebAssembly.compile = forbidden; WebAssembly.instantiate = forbidden;
  api.createTbcEngine({backend: {call(){nativeCalls++; return '{}';}}});
  const native = api.createNativeTbcKeylessEngine(async () => {nativeCalls++; return '{}';});
  await native.protocolInfo(); assert.equal(nativeCalls, 0);
  await native.execute('inspectTokenMaterial', '{}'); assert.equal(nativeCalls, 1);
  assert.equal(eagerCalls, 0);
} finally {globalThis.fetch = old.fetch; WebAssembly.compile = old.compile; WebAssembly.instantiate = old.instantiate;}

// Reuse the real pinned SDK archives, and only copy the requested platform.
const catalog = await platformCatalog(kit), sdkResults = [];
for (const platform of ['ios', 'android']) {
  const sdk = join(scratch, platform), app = join(scratch, platform + '-app');
  await mkdir(sdk); await mkdir(app);
  execFileSync('tar', ['-xzf', join(out, `${platform}-sdk.tgz`), '-C', sdk]);
  await mkdir(join(app, 'node_modules/@tbc'), {recursive: true});
  // A real package install uses the same resolver; copying avoids shared mutable module output.
  await cp(kit, join(app, 'node_modules/@tbc/kit'), {recursive: true});
  execFileSync(process.execPath, [join(kit, 'examples/react-native-engine/install.mjs'), app, sdk, '--platform', platform], {stdio: 'pipe', timeout: 60000});
  const moduleRoot = join(app, 'modules/tbc-kit-engine');
  const identity = await syncNative({moduleRoot, kitRoot: kit, check: true, platform});
  assert.equal(identity.kitVersion, lock.kitVersion);
  assert.equal(identity.sdkVersion, lock.sdkVersion);
  const copied = await fileInventory(join(moduleRoot, 'platform-sdk'));
  assert(!Object.keys(copied).some(path => path.startsWith(platform === 'ios' ? 'maven-repository/' : 'apple/')));
  await assert.rejects(syncNative({moduleRoot, kitRoot: kit, check: true, platform: platform === 'ios' ? 'android' : 'ios'}));
  const first = Object.keys(copied).find(path => path !== 'identity.json');
  await writeFile(join(moduleRoot, 'platform-sdk', first), 'tampered-test-copy');
  await assert.rejects(syncNative({moduleRoot, kitRoot: kit, check: true, platform}), /SDK artifact mismatch/);
  sdkResults.push({platform, identity, copiedFiles: Object.keys(copied).length, wrongPlatformRejected: true, tamperRejected: true});
}
for (const platform of Object.keys(catalog.platforms)) {
  const root = join(scratch, 'resources-' + platform); await mkdir(root);
  const group = catalog.platforms[platform];
  assert.equal(sha256(await readFile(join(out, group.archive))), group.archiveSha256);
  execFileSync('tar', ['-xzf', join(out, group.archive), '-C', root]);
  await verifiedResourceRoot(kit, join(root, 'resources'), [platform]);
}

// Controlled existing business example: same output, reads and one approval.
const examples = [];
for (const [name, args] of [['backend-node/run.mjs', []], ['backend-node/run.mjs', ['--send']],
  ['multi-round-merge/run.mjs', []], ['approval-presentation/run.mjs', []], ['multi-wallet/run.mjs', []]]) {
  const outputs = [baseKit, kit].map(path => execFileSync(process.execPath, [join(path, 'examples', name), ...args],
    {encoding: 'utf8', timeout: 60000}));
  assert.equal(outputs[0], outputs[1], `Controlled example drift: ${name}`);
  examples.push({name, args, outputSha256: sha256(outputs[1]), byteIdentical: true});
}
const input = {version: '1.0', request: {version: '1.0', chainId: 'tbc:testnet',
  from: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', intent: {version: '1.0', type: 'tbc.transfer',
    to: '1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP', amount: '1000'}}};
const engines = await Promise.all([baseKit, kit].map(async root => (await import(pathToFileURL(join(root, 'dist/esm/engine.node.js')))).createTbcEngine()));
const timings = [[], []];
for (let i = 0; i < 120; i++) for (const n of i % 2 ? [1, 0] : [0, 1]) {
  const t = performance.now(); const value = await engines[n].normalizeRequest(input);
  const elapsed = performance.now() - t;
  assert.equal(value.request.intent.type, 'tbc.transfer'); if (i >= 20) timings[n].push(elapsed);
}
const stats = values => {const s = values.sort((a,b) => a-b); return {samples: s.length, medianMs: s[50], p95Ms: s[94]};};
const report = {status: 'PASS', sizes, bundles, dependencyCount: Object.keys(installedLock.packages).length - 1,
  eagerCalls, wasmFetches: loads, nativeCalls, sdkResults, resourcesVerified: Object.keys(catalog.platforms), examples,
  localNormalizeTiming: {baseline: stats(timings[0]), candidate: stats(timings[1]), environment: 'Mac Node WASM, warm, interleaved; not device transaction timing'},
  runtimeByteIdentical: true, noBroadcast: true, deviceBuildRun: false, scratch};
await writeFile(join(out, 'evidence/installed-distribution.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
