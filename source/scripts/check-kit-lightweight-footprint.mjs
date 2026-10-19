// Offline frozen-package measurement, not a runtime latency or chain benchmark.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const receipt227 = process.argv[2] === '--receipt227';
const roots = process.argv.slice(receipt227 ? 3 : 2).map(p => resolve(p));
assert.equal(roots.length, 2, 'Usage: check-kit-lightweight-footprint.mjs BASELINE_CONSUMER_ROOT CURRENT_CONSUMER_ROOT');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const frozen = receipt227 ? [
  {version: '0.1.0-candidate.226', archive: resolve('native/engine/delivery/candidate226-complete/tbc-kit-0.1.0-candidate.226.tgz'), sha256: '1fb39857b8326fdcbf2af2fa43d46a5d3a87d7daad81d8e012d2d69a6d5e53a4'},
  {version: '0.1.0-candidate.227', archive: resolve('native/engine/delivery/candidate227-complete/tbc-kit-0.1.0-candidate.227.tgz'), sha256: '28adf7f9f36590812e0fe864a14b3a326f2c340b5a7f12bb2b6169f10ff64424'},
] : [
  {version: '0.1.0-candidate.217', archive: '/var/folders/3b/09dp91rj013g4w55jfnwsq0c0000gn/T/tbc217-source-dktTY7/pack-final/tbc-kit-0.1.0-candidate.217.tgz', sha256: '3cdc59bde62856736dd684ab7ecce66a06f16850a730e6ec059d6b12536f808a'},
  {version: '0.1.0-candidate.224', archive: resolve('native/engine/delivery/candidate224/tbc-kit-0.1.0-candidate.224.tgz'), sha256: 'aabd2d0506e567ca8773c754d0b1f70614d8c7541f010dd0689bda937cd85079'},
];
const output = await mkdtemp(join(tmpdir(), 'tbc-kit-lightweight-'));
const blocked = {http: 0, wasm: 0};
globalThis.fetch = () => { blocked.http++; throw Error('Unexpected HTTP'); };
for (const method of ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']) {
  WebAssembly[method] = () => { blocked.wasm++; throw Error('Unexpected WASM initialization'); };
}
const results = [];
for (const [index, root] of roots.entries()) {
  const identity = frozen[index];
  assert.equal(sha(await readFile(identity.archive)), identity.sha256);
  const browser = receipt227 ? root : join(root, 'browser');
  const installed = join(browser, 'node_modules/@tbc/kit');
  const extracted = await mkdtemp(join(tmpdir(), 'tbc-kit-footprint-source-'));
  execFileSync('tar', ['-xzf', identity.archive, '-C', extracted, 'package/dist', 'package/package.json']);
  async function verifyTree(relative) {
    for (const item of await readdir(join(extracted, 'package', relative), {withFileTypes: true})) {
      const path = join(relative, item.name);
      if (item.isDirectory()) await verifyTree(path);
      else {
        assert.ok(item.isFile(), 'Frozen JS tree must contain only regular files');
        assert.equal(sha(await readFile(join(installed, path))), sha(await readFile(join(extracted, 'package', path))), path);
      }
    }
  }
  await verifyTree('dist');
  assert.equal(sha(await readFile(join(installed, 'package.json'))), sha(await readFile(join(extracted, 'package/package.json'))));
  assert.equal(JSON.parse(await readFile(join(installed, 'package.json'))).version, identity.version);
  const require = createRequire(receipt227 ? import.meta.url : join(browser, 'package.json'));
  const esbuild = require('esbuild');
  assert.equal(esbuild.version, '0.25.9');
  const entries = [];
  for (const [name, exported, path] of [
    ['client', 'createTbcClient', '@tbc/kit'],
    ['api', 'createTbcOfficialApi', '@tbc/kit/api'],
    ['rpc', 'createTbcReadRpcClient', '@tbc/kit/rpc'],
  ]) {
    const build = await esbuild.build({
      absWorkingDir: browser,
      stdin: {contents: `export { ${exported} } from ${JSON.stringify(path)};`, resolveDir: browser, sourcefile: `${name}.mjs`},
      bundle: true, minify: true, platform: 'browser', format: 'esm', target: 'es2022',
      write: false, metafile: true, logLevel: 'silent',
    });
    const bytes = build.outputFiles[0].contents;
    const retained = Object.entries(Object.values(build.metafile.outputs)[0].inputs)
      .filter(([, value]) => value.bytesInOutput > 0).map(([file]) => file);
    for (const file of retained) {
      assert.doesNotMatch(file, /(?:^|\/)(?:engine|signer|wallet-runtime|approval-material)[^/]*\.(?:js|mjs|cjs)$|\.wasm$/i, `${name}: ${file}`);
    }
    const code = Buffer.from(bytes).toString('utf8');
    const forbidden = code.match(/.{0,70}(?:WebAssembly|tbc_engine\.wasm|\.node["']).{0,100}/gu) ?? [];
    // The client exposes optional receipt verification and intentionally retains
    // its lazy loader. API/RPC have no such dependency. Check actual execution,
    // not the presence of a loader function, for the lightweight client promise.
    if (name !== 'client') assert.deepEqual(forbidden, [], `${name}: retained runtime references`);
    const modulePath = join(output, `${index}-${name}.mjs`);
    await writeFile(modulePath, bytes);
    const imported = await import(pathToFileURL(modulePath));
    if (name === 'client') {
      const calls = [];
      const address = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
      const provider = { async request(call) {
        calls.push(call.method);
        return call.method === 'tbc_requestAccounts' ? [address] : {fixtureOnly: true};
      }, on() {}, removeListener() {}, destroy() {}};
      const wallet = await imported.createTbcClient({network: 'testnet', provider}).connect();
      await wallet.tbc.transfer({to: address, amount: '1', constraints: {maxFee: '10000', expiresAt: '2099-01-01T00:00:00Z'}});
      assert.deepEqual(calls, ['tbc_requestAccounts', 'tbc_sendTransaction']);
    }
    assert.deepEqual(blocked, {http: 0, wasm: 0});
    entries.push({name, minifiedBytes: bytes.length, gzipBytes: gzipSync(bytes, {level: 9}).length, sha256: sha(bytes),
      lazyWasmReferences: forbidden.length, retained});
  }
  if (receipt227) {
    results.push({version: identity.version, tarSha256: identity.sha256, esbuild: esbuild.version, entries,
      controlledCounters: {http: blocked.http, wasm: blocked.wasm, providerMethods: ['tbc_requestAccounts', 'tbc_sendTransaction']}});
  } else {
    const reportBytes = await readFile(join(root, 'report.json'));
    const report = JSON.parse(reportBytes);
    assert.equal(report.tarSha256, identity.sha256);
    results.push({version: identity.version, tarSha256: identity.sha256, consumerReportSha256: sha(reportBytes), esbuild: esbuild.version, entries,
      controlledCounters: report.results.filter(x => x.role !== 'browser').map(({role, evidence}) => ({role, evidence}))});
  }
}
assert.deepEqual(results[1].controlledCounters, results[0].controlledCounters, 'Independent consumer read/sign/approval/submit counts changed');
const changes = results[1].entries.map((entry, i) => ({name: entry.name,
  minifiedBytesDelta: entry.minifiedBytes - results[0].entries[i].minifiedBytes,
  gzipBytesDelta: entry.gzipBytes - results[0].entries[i].gzipBytes}));
const report = {status: 'PASS_LIGHTWEIGHT_LAZY_LOADING_AND_CONTROLLED_COUNTERS', results, changes, blocked,
  counterScope: receipt227 ? 'Light client connect and wallet-delegated transfer; not Host execution or signing' : 'Recorded independent controlled consumers',
  runtimeLatencyMeasured: false, realChainAcceptance: false, sourceSha256: sha(await readFile(new URL(import.meta.url)))};
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({report: join(output, 'report.json'), sha256: sha(await readFile(join(output, 'report.json'))), status: report.status, changes}));
