// Collect declarations from the exact frozen Kit and local dependency sources.
// Does not rebuild, relabel licenses, fetch dependencies, or edit a delivery.
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join, resolve, relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';

const repo = resolve(import.meta.dirname, '../../..');
const [tarArg, expectedHash, outputArg] = process.argv.slice(2);
assert.ok(tarArg && /^[a-f0-9]{64}$/.test(expectedHash ?? '') && outputArg,
  'Usage: collect-js-distribution-notices.mjs KIT_TAR EXPECTED_SHA256 NEW_OUTPUT_DIRECTORY');
const tar = resolve(tarArg), output = resolve(outputArg);
assert.ok(!existsSync(output), 'Never overwrite an existing notice draft');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = p => JSON.parse(readFileSync(p, 'utf8'));
assert.equal(sha(readFileSync(tar)), expectedHash);
const entries = execFileSync('tar', ['-tzf', tar], {encoding: 'utf8'}).trim().split('\n');
for (const p of entries) assert.ok(p.startsWith('package/') && !p.split('/').includes('..'), 'Unsafe archive path');
const temporary = mkdtempSync(join(tmpdir(), 'tbc-js-notices-'));
execFileSync('tar', ['-xzf', tar, '-C', temporary]);
const kit = join(temporary, 'package'), manifest = json(join(kit, 'package.json'));
function files(root, prefix = '') {
  return readdirSync(join(root, prefix), {withFileTypes: true}).flatMap(entry => {
    assert.ok(!entry.isSymbolicLink(), 'Symlinks are not accepted in a notice source');
    const p = join(prefix, entry.name);
    return entry.isDirectory() ? files(root, p) : [p];
  }).sort();
}
const treeHash = root => sha(files(root).map(p => `${p}\0${sha(readFileSync(join(root,p)))}\n`).join(''));
const sourceMaps = new Map();
for (const p of files(join(kit, 'dist')).filter(p => p.endsWith('.map'))) {
  for (const source of json(join(kit, 'dist', p)).sources ?? []) {
    if (!source.includes('node_modules/')) continue;
    const tail = source.split('node_modules/').at(-1);
    const name = tail.split('/').slice(0, tail.startsWith('@') ? 2 : 1).join('/');
    if (!sourceMaps.has(name)) sourceMaps.set(name, new Set());
    sourceMaps.get(name).add(`dist/${p}`);
  }
}
const texts = {}, components = [];
const packageRequire = createRequire(join(repo, 'packages/kit/package.json'));
const names = [...new Set([...sourceMaps.keys(), 'tbc-tx-parser', 'tbc-lib-js', 'tbc-contract', ...Object.keys(manifest.dependencies)])].sort();
for (const name of names) {
  // Read package metadata directly after normal lookup; package exports may hide it.
  const roots = packageRequire.resolve.paths(`${name}/package.json`)
    .map(p => join(p,name)).filter(p => existsSync(join(p,'package.json')));
  assert.ok(roots.length, `Dependency source is unavailable: ${name}`);
  const root = roots[0], p = json(join(root, 'package.json'));
  const externalVersion = manifest.dependencies[name];
  if (externalVersion) assert.equal(p.version, externalVersion, `Local dependency differs from frozen manifest: ${name}`);
  const notices = readdirSync(root, {withFileTypes: true})
    .filter(e => e.isFile() && /^(licen[sc]e|notice|copying)([._-]|$)/i.test(e.name))
    .map(e => {
      const bytes = readFileSync(join(root, e.name)), text = bytes.toString('utf8');
      assert.ok(Buffer.from(text).equals(bytes));
      const sha256 = sha(bytes); texts[sha256] = text;
      return {path: e.name, sha256, bytes: bytes.length};
    });
  const roles = [];
  if (externalVersion) roles.push('external-npm-dependency');
  if (sourceMaps.has(name)) roles.push('embedded-bundle-source-map-label');
  if (name === 'tbc-tx-parser') roles.push('modified-private-copy');
  if (name === 'tbc-lib-js') roles.push('modified-portable-subset');
  if (name === 'tbc-contract') roles.push('historical-script-template-extraction');
  components.push({name, localVersion: p.version, frozenExternalVersion: externalVersion ?? null,
    versionEvidence: externalVersion ? 'Exact external manifest declaration; not proof of every copied source byte' : 'Local source metadata; source-map label alone does not pin a bundled version',
    roles, sourcePackagePath: relative(repo,root), declaredLicense: p.license ?? null, packageJsonSha256: sha(readFileSync(join(root, 'package.json'))),
    sourceMapReferences: [...(sourceMaps.get(name) ?? [])].sort(), notices});
}
const copies = ['dist/esm/vendor/tbc-tx-parser', 'dist/cjs/vendor/tbc-tx-parser'].map(p => ({
  path: p, fileCount: files(join(kit, p)).length, treeSha256: treeHash(join(kit, p)),
  definition: 'SHA256 of sorted relative path + NUL + file SHA256 + newline',
}));
const inventory = {
  status: 'JS_NOTICES_DRAFT_WITH_EXPLICIT_AUTHORIZATION_GAPS',
  generator: {path: relative(repo, import.meta.filename), sha256: sha(readFileSync(import.meta.filename))},
  kit: {version: manifest.version, tar: relative(repo, tar), sha256: expectedHash, archiveEntries: entries.length},
  localLock: {path: 'package-lock.json', sha256: sha(readFileSync(join(repo, 'package-lock.json')))},
  buildRecipe: {path: 'packages/kit/scripts/build.mjs', sha256: sha(readFileSync(join(repo, 'packages/kit/scripts/build.mjs')))},
  components, privateCopies: copies, textCount: Object.keys(texts).length,
  unresolved: components.filter(c => c.notices.length === 0).map(c => ({name: c.name, version: c.localVersion, declaredLicense: c.declaredLicense,
    state: c.declaredLicense ? 'No root notice text in inspected package; obtain applicable upstream terms' : 'No license declaration or root notice text in inspected package; obtain explicit terms'})),
  limitations: ['Not legal clearance or an OR-license selection', 'Local package version does not alone prove the version of every historical embedded source',
    'Portable source modifications are recorded by the hashed build recipe and frozen subtree, not reproduced here',
    'External dependency transitive notices remain with their separately installed packages; they are not all bundled into Kit',
    'Inline third-party fragments inside upstream tbc-lib-js need upstream attribution confirmation',
    'Latest contract 1.7.0 templates in Rust have a separate provenance/authorization report'],
  effects: {builds: 0, networkRequests: 0, signatures: 0, broadcasts: 0, runtimeChanges: 0, deletions: 0, publishing: 0},
};
mkdirSync(output); mkdirSync(join(output, 'texts'));
for (const [h,text] of Object.entries(texts)) {
  const p = join(output, 'texts', `${h}.txt`);
  writeFileSync(p, text, {flag:'wx'}); assert.equal(sha(readFileSync(p)), h);
}
writeFileSync(join(output, 'inventory.json'), `${JSON.stringify(inventory,null,2)}\n`, {flag:'wx'});
console.log(JSON.stringify({status:inventory.status,output,kit:manifest.version,components:components.length,
  textCount:inventory.textCount,privateCopies:copies.map(c=>({path:c.path,fileCount:c.fileCount})),unresolved:inventory.unresolved}));
