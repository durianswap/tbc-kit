// Finalize an already-tested JS-only candidate; no compilation or broadcasting.
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const [outArg, baselineArg, protectedArg] = process.argv.slice(2);
assert(protectedArg, 'CANDIDATE_DIR BASELINE_REPOSITORY PROTECTED_MANIFEST');
const out = resolve(outArg), baseline = resolve(baselineArg);
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const hash = b => createHash('sha256').update(b).digest('hex');
const writeJson = (p, x) => writeFile(p, JSON.stringify(x, null, 2) + '\n');
const lock = await json(join(out, 'delivery-lock.json'));
const build = await json(join(out, 'evidence/build.json'));
const installed = await json(join(out, 'evidence/installed-check.json'));
assert.equal(installed.status, 'PASS');
assert.equal(hash(await readFile(join(out, lock.kit.file))), lock.kit.sha256);
for (const [p, sha] of Object.entries(build.sourceFiles)) {
  assert.equal(hash(await readFile(join(repo, p))), sha, `Source changed after packaging: ${p}`);
}
const protectedFiles = await json(resolve(protectedArg));
for (const [p, sha] of Object.entries(protectedFiles)) assert.equal(hash(await readFile(p)), sha, p);
for (const v of Object.values(lock.baseline)) assert.equal(hash(await readFile(join(baseline, v.file))), v.sha256, v.file);
assert.match(await readFile(join(out, 'evidence/core-targeted.tap'), 'utf8'), /# pass 80\n# fail 0/);
assert.match(await readFile(join(out, 'evidence/rust-signer-compatibility.txt'), 'utf8'), /6 passed; 0 failed/);
await writeJson(join(out, 'evidence/protected-after.json'), {
  status: 'PASS', protectedFiles: Object.keys(protectedFiles).length,
  frozenArchives: Object.keys(lock.baseline).length, sourceFiles: Object.keys(build.sourceFiles).length,
  currentReleaseChanged: false, partnerDeliveryChanged: false,
});

// Only source, instructions and tools, never cached artifacts or git history.
const listed = execFileSync('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], { cwd: repo }).toString().split('\0').filter(Boolean);
const files = [...new Set(listed)].filter(p =>
  /^(source|packages|scripts|docs)\//.test(p) ||
  /^(README\.md|LICENSE|CONTRIBUTING\.md|SUPPORT\.md|package(-lock)?\.json|\.gitignore)$/.test(p)
).sort();
const manifest = {};
for (const p of files) {
  assert(!/(^|\/)(node_modules|\.git|\.verify|target)(\/|$)/.test(p), p);
  assert(!(await lstat(join(repo, p))).isSymbolicLink(), `Unexpected source symlink: ${p}`);
  manifest[p] = hash(await readFile(join(repo, p)));
}
await writeJson(join(out, 'source-manifest.json'), { schema: 1, kitVersion: lock.kitVersion,
  baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  sourceBuildDigest: build.sourceDigest, files: manifest,
});
const scratch = await mkdtemp(join(repo, '.verify/host-port-source-'));
const list = join(scratch, 'source-files.txt');
await writeFile(list, files.join('\n') + '\n');
const archive = 'tbc-kit-source.tgz';
execFileSync('tar', ['--no-mac-metadata', '-czf', join(out, archive), '-T', list],
  { cwd: repo, env: { ...process.env, COPYFILE_DISABLE: '1' } });
const archiveFiles = execFileSync('tar', ['-tzf', join(out, archive)], { encoding: 'utf8' }).trim().split('\n').sort();
assert.deepEqual(archiveFiles, files);
const data = await readFile(join(out, archive));
await writeJson(join(out, 'source-archive.json'), { file: archive, bytes: data.length, sha256: hash(data), files: files.length });
const downloads = ['tbc-kit.tgz', archive, 'delivery-lock.json', 'native-sdk-lock.json',
  'source-manifest.json', 'source-archive.json', 'README.md', 'REPORT.md'];
const lines = [];
for (const p of downloads) lines.push(`${hash(await readFile(join(out, p)))}  ${p}`);
await writeFile(join(out, 'DOWNLOADS.SHA256'), lines.join('\n') + '\n');
console.log(JSON.stringify({ status: 'PASS', kit: lock.kit, sourceBytes: data.length,
  sourceFiles: files.length, protectedUnchanged: Object.keys(protectedFiles).length, downloads }));
