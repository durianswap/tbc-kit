import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { checkIdentity, verifyBuild, run } from '../scripts/check-kit-source-state.mjs';
const state = { developmentVersion: '0.1.0-rc.1' };
const pkg = { name: '@tbc/kit', version: state.developmentVersion, private: true,
  files: ['dist', 'artifacts/provenance.json', 'artifacts/source-build.json', 'artifacts/platform-resources.json'] };
const lock = { packages: { 'packages/kit': { version: pkg.version } } };
test('separate development identity agrees with workspace lock', () => checkIdentity(state, pkg, lock));
test('stale lock and mismatched source identity are rejected', () => {
  assert.throws(() => checkIdentity(state, pkg, { packages: { 'packages/kit': { version: '0.0.0' } } }), /lock version/);
  assert.throws(() => checkIdentity({ developmentVersion: '0.0.0' }, pkg, lock), /Source version/);
});
test('exact source and packaged output identity passes', () => {
  verifyBuild({ version: pkg.version, sourceDigest: 'source', outputDigest: 'output' }, pkg.version, 'source', 'output');
});
test('stale version, changed source and changed output fail independently', () => {
  const record = { version: pkg.version, sourceDigest: 'source', outputDigest: 'output' };
  assert.throws(() => verifyBuild(record, 'old', 'source', 'output'), /version is stale/);
  assert.throws(() => verifyBuild(record, pkg.version, 'new-source', 'output'), /Source changed/);
  assert.throws(() => verifyBuild(record, pkg.version, 'source', 'new-output'), /outputs changed/);
});
test('real packlist binds source and output and rejects source edits during build', t => {
  const root = mkdtempSync(join(tmpdir(), 'tbc-source-state-test-'));
  t.after(() => rmSync(root, { recursive: true }));
  const put = (name, text) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); };
  const putJson = (name, value) => put(name, JSON.stringify(value));
  const sha = name => createHash('sha256').update(readFileSync(join(root, name))).digest('hex');
  for (const p of ['core', 'host', 'provider', 'wallet-standard', 'tbc-engine', 'kit']) {
    put(`packages/${p}/src/index.ts`, 'export {};');
    putJson(`packages/${p}/package.json`, { name: p });
    putJson(`packages/${p}/tsconfig.json`, {});
  }
  for (const d of ['scripts', 'schemas', 'registry', 'packages/kit/scripts', 'packages/tbc-engine/scripts', 'packages/tbc-engine/rust']) mkdirSync(join(root, d), { recursive: true });
  putJson('package.json', { name: 'source-state-test', private: true });
  putJson('package-lock.json', lock);
  putJson('packages/kit/package.json', pkg);
  put('packages/kit/dist/index.js', 'export {};');
  putJson('packages/kit/artifacts/provenance.json', { package: `${pkg.name}@${pkg.version}` });
  putJson('release/kit-source-state.json', state);
  assert.throws(() => run(root, '--record-build'), /Missing build-start/);
  run(root, '--begin-build');
  run(root, '--record-build');
  run(root, '--pack');
  put('packages/kit/src/index.ts', 'export const changed = true;');
  assert.throws(() => run(root, '--pack'), /Source changed/);
  assert.throws(() => run(root, '--record-build'), /Source changed during build/);
  run(root, '--begin-build');
  run(root, '--record-build');
  put('packages/kit/dist/index.js', 'tampered');
  assert.throws(() => run(root, '--pack'), /outputs changed/);
});
