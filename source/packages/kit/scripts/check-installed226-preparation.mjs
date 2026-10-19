// Run existing focused tests against immutable installed226, not workspace dist.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const repo = resolve(import.meta.dirname, '../../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const testRoot = join(repo, 'packages/kit/test');
const tests = ['request-preparation.test.mjs', 'session-execution.test.mjs'];
const hookMode = process.env.TBC226_PREPARATION_HOOK === '1';
const consumer = hookMode ? process.env.TBC226_PREPARATION_CONSUMER : process.argv[2];
assert.ok(consumer, 'Pass exact installed226 consumer');
const installed = join(resolve(consumer), 'node_modules/@tbc/kit');
const installedUrl = pathToFileURL(installed + '/').href;
assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'))).version, '0.1.0-candidate.226');

if (hookMode) {
  globalThis.fetch = async () => { throw Error('Real HTTP forbidden in preparation gate'); };
  const testUrls = tests.map(name => pathToFileURL(join(testRoot, name)).href);
  const wasmNeedle = 'new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url)';
  registerHooks({
    resolve(specifier, context, next) {
      if (testUrls.includes(context.parentURL)) {
        if (specifier.startsWith('../dist/esm/')) return { shortCircuit: true,
          url: new URL(specifier.slice(3), installedUrl).href };
        if (specifier === '@tbc-wallet/core') return { shortCircuit: true,
          url: new URL('dist/esm/wallet.js', installedUrl).href };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      const result = next(url, context);
      if (url === testUrls[0]) {
        const source = String(result.source);
        assert.equal(source.split(wasmNeedle).length, 2);
        return { ...result, source: source.replace(wasmNeedle,
          `new URL(${JSON.stringify(new URL('artifacts/wasm/tbc_engine_wasm.wasm', installedUrl).href)})`) };
      }
      return result;
    },
  });
} else {
  const out = mkdtempSync(join(tmpdir(), 'tbc-preparation226-'));
  const archive = join(repo, 'native/engine/delivery/candidate226-complete/tbc-kit-0.1.0-candidate.226.tgz');
  const archiveSha256 = sha(readFileSync(archive));
  assert.equal(archiveSha256, '1fb39857b8326fdcbf2af2fa43d46a5d3a87d7daad81d8e012d2d69a6d5e53a4');
  assert.equal(spawnSync('tar', ['-xzf', archive, '-C', out]).status, 0);
  function hashes(root, relative = '', rows = {}) {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) hashes(root, path, rows);
      else { assert.ok(entry.isFile()); rows[path] = sha(readFileSync(join(root, path))); }
    }
    return rows;
  }
  const files = hashes(installed);
  assert.deepEqual(files, hashes(join(out, 'package')));
  assert.equal(Object.keys(files).length, 922);
  const cases = [
    { file: tests[0], pattern: '.*' },
    { file: tests[1], pattern: '^(bounded early consent|Legacy-off direct Standard workflow|generic approval preparation|Legacy generic workflow|generic dynamic-binding consent|shared approval preparation covers a Standard LP|early consent expiry|identical concurrent Standard workflows|an approvalPreparation handle)' },
  ];
  const results = [];
  for (const item of cases) {
    const path = join(testRoot, item.file);
    const result = spawnSync(process.execPath, ['--import', import.meta.filename, '--test',
      '--test-reporter=tap', `--test-name-pattern=${item.pattern}`, path], {
      cwd: repo, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, TBC226_PREPARATION_HOOK: '1', TBC226_PREPARATION_CONSUMER: resolve(consumer) },
    });
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    const log = join(out, item.file + '.tap');
    writeFileSync(log, output, { flag: 'wx' });
    results.push({ ...item, testSha256: sha(readFileSync(path)), exit: result.status,
      error: result.error?.code, log, logSha256: sha(output) });
    console.log(JSON.stringify(results.at(-1)));
  }
  const report = { candidate: '0.1.0-candidate.226', archiveSha256, installedFiles: 922,
    verifierSha256: sha(readFileSync(import.meta.filename)),
    wasmSha256: files['artifacts/wasm/tbc_engine_wasm.wasm'], results,
    testAdaptation: 'Only test import routing and WASM URL; no assertion, fixture or production-code changes',
    scope: 'Synthetic Host and public test Signer. No real HTTP, device, funds or chain broadcasting.' };
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ out, passed: results.every(r => r.exit === 0) }));
  if (results.some(r => r.exit !== 0)) process.exitCode = 1;
}
