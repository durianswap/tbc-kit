import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, lstatSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const fileHash = p => hash(readFileSync(p));
const digest = rows => hash(JSON.stringify(rows));
function inside(root, name) {
  assert.ok(!isAbsolute(name) && !name.split(/[\\/]/).includes('..'), 'Unsafe relative path');
  return join(root, name);
}
export function checkIdentity(state, pkg, lock) {
  assert.equal(pkg.name, '@tbc/kit');
  assert.equal(pkg.version, state.developmentVersion, 'Source version and release state differ');
  assert.equal(lock.packages['packages/kit'].version, pkg.version, 'Workspace lock version differs');
  assert.equal(pkg.private, true, 'Registry publication must be enabled explicitly');
}
export function verifyBuild(record, version, sourceDigest, outputDigest) {
  assert.equal(record.version, version, 'Built version is stale');
  assert.equal(record.sourceDigest, sourceDigest, 'Source changed after build');
  assert.equal(record.outputDigest, outputDigest, 'Packaged outputs changed after build');
}
function tree(root, names, skip = () => false) {
  const rows = [];
  function visit(name) {
    if (skip(name)) return;
    const p = inside(root, name), st = lstatSync(p);
    assert.ok(!st.isSymbolicLink(), `Source/build identity must not follow symlinks: ${name}`);
    if (st.isDirectory()) for (const child of readdirSync(p).sort()) visit(join(name, child));
    else if (st.isFile()) rows.push([name, fileHash(p)]);
  }
  for (const name of names) visit(name);
  return rows.sort(([a], [b]) => a.localeCompare(b));
}
function sources(root) {
  const packages = ['core', 'host', 'provider', 'wallet-standard', 'tbc-engine', 'kit'];
  const names = ['package.json', 'package-lock.json', 'release/kit-source-state.json',
    'scripts', 'schemas', 'registry', ...packages.flatMap(n => [`packages/${n}/src`, `packages/${n}/package.json`, `packages/${n}/tsconfig.json`]),
    'packages/kit/scripts', 'packages/tbc-engine/scripts', 'packages/tbc-engine/rust'];
  return tree(root, names, name => /(?:^|\/)(?:target|node_modules|\.git)(?:\/|$)/.test(name));
}
function outputs(root, pkg) {
  const dir = join(root, 'packages/kit');
  // Use the actual npm packlist so automatic files, exports, ignores and
  // documentation cannot drift outside the identity check.
  const result = JSON.parse(execFileSync('npm', ['pack', dir, '--dry-run', '--json', '--ignore-scripts'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(result[0].version, pkg.version);
  const names = result[0].files.map(x => x.path).filter(p => p !== 'artifacts/source-build.json');
  return names.sort().map(p => [p, fileHash(inside(dir, p))]);
}
export function run(root = repo, mode = '') {
  assert.ok(['', '--pack', '--begin-build', '--record-build', '--checkpoint'].includes(mode), 'Unknown mode');
  const state = json(join(root, 'release/kit-source-state.json'));
  const pkg = json(join(root, 'packages/kit/package.json'));
  checkIdentity(state, pkg, json(join(root, 'package-lock.json')));
  if (mode === '--checkpoint') {
    const rows = sources(root), dir = join(root, 'release/source-checkpoints', pkg.version, digest(rows));
    assert.ok(!existsSync(dir), 'Source checkpoint already exists; never overwrite it');
    mkdirSync(dir, { recursive: true });
    const archive = join(dir, 'source.tgz'), list = join(dir, 'files.list0');
    writeFileSync(list, rows.map(([p]) => p + '\0').join(''), { mode: 0o600 });
    execFileSync('tar', ['-czf', archive, '-C', root, '--null', '-T', list]);
    const report = { version: pkg.version, kind: 'local-source-checkpoint-not-accepted-build',
      gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      sourceDigest: digest(rows), archiveSha256: fileHash(archive), files: rows };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
    assert.equal(digest(sources(root)), report.sourceDigest, 'Source changed during snapshot');
    return { status: 'SOURCE_CHECKPOINT_SAVED', version: pkg.version, files: rows.length, dir };
  }
  const startPath = join(root, 'packages/kit/artifacts/.source-build-start.json');
  if (mode === '--begin-build') {
    writeFileSync(startPath, JSON.stringify({ version: pkg.version, sourceDigest: digest(sources(root)) }) + '\n');
  } else if (mode) {
    const provenance = json(join(root, 'packages/kit/artifacts/provenance.json'));
    assert.equal(provenance.package, `${pkg.name}@${pkg.version}`, 'Existing artifacts are stale; build before packing');
    const sourceDigest = digest(sources(root)), outputDigest = digest(outputs(root, pkg));
    const recordPath = join(root, 'packages/kit/artifacts/source-build.json');
    if (mode === '--record-build') {
      assert.ok(existsSync(startPath), 'Missing build-start identity; use the build entry point');
      const start = json(startPath);
      assert.equal(start.version, pkg.version, 'Version changed during build');
      assert.equal(start.sourceDigest, sourceDigest, 'Source changed during build; restart it');
      writeFileSync(recordPath, JSON.stringify({ schemaVersion: 1, version: pkg.version, sourceDigest, outputDigest,
        createdAt: new Date().toISOString(), status: 'built-not-device-or-chain-accepted' }, null, 2) + '\n');
    } else {
      assert.ok(existsSync(recordPath), 'Missing source/build record; rebuild before packing');
      verifyBuild(json(recordPath), pkg.version, sourceDigest, outputDigest);
    }
  }
  return { status: 'KIT_SOURCE_STATE_PASS', developmentVersion: pkg.version, mode };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(run(repo, process.argv[2] || ''), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
