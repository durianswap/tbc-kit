import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, cp, mkdtemp, readdir, stat} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileInventory, sha256} from '../source/packages/kit/scripts/platform-resources.mjs';
const repo = resolve(import.meta.dirname, '..');
const [outArg, consumerArg, protectedArg] = process.argv.slice(2);
assert(protectedArg, 'CANDIDATE_DIR INSTALLED_CONSUMER PROTECTED_MANIFEST');
const out = resolve(outArg), consumer = resolve(consumerArg);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const put = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const lock = await json(join(out, 'delivery-lock.json'));
const report = await json(join(out, 'evidence/installed-distribution.json'));
assert.equal(report.status, 'PASS');
assert.equal(sha256(await readFile(join(out, lock.kit.file))), lock.kit.sha256);
for (const [name, expected] of Object.entries(lock.sdk)) assert.equal(sha256(await readFile(join(out, name))), expected.sha256);
const protectedFiles = await json(resolve(protectedArg));
for (const [path, hash] of Object.entries(protectedFiles)) assert.equal(sha256(await readFile(path)), hash, `Protected file changed: ${path}`);
await put(join(out, 'evidence/protected-after.json'), {files: Object.keys(protectedFiles).length, allMatch: true,
  manifestSha256: sha256(await readFile(resolve(protectedArg)))});
const tests = ['source/test/kit-source-state.test.mjs', 'source/packages/kit/test/distribution-policy.test.mjs',
  'source/packages/kit/test/platform-resources.test.mjs', 'source/packages/kit/test/react-native-engine-template.test.mjs'];
const tap = execFileSync(process.execPath, ['--test', ...tests], {cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','pipe']});
await writeFile(join(out, 'evidence/focused-tests.tap'), tap);
assert.match(tap, /# fail 0/);
const auditRun = spawnSync('npm', ['audit', '--omit=dev', '--json'], {cwd: consumer, encoding: 'utf8', timeout: 60000});
const audit = JSON.parse(auditRun.stdout);
assert(audit.metadata?.vulnerabilities, 'Dependency audit unavailable; report separately');
await put(join(out, 'evidence/dependency-audit.json'), audit);

// Archive tracked source plus this isolated branch's new source/docs/scripts,
// excluding caches, binaries, current downloads and the candidate itself.
const names = [...new Set(execFileSync('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], {cwd: repo, encoding: 'utf8'}).split('\0').filter(Boolean))]
  .filter(path => !path.startsWith('release/candidates/') && !path.startsWith('evidence/') && !path.startsWith('packages/'))
  .filter(path => /^(source\/|docs\/|scripts\/|release\/|README\.md$|LICENSE$|CONTRIBUTING\.md$|SECURITY\.md$|SUPPORT\.md$|package(?:-lock)?\.json$|\.gitignore$)/.test(path)).sort();
const files = {};
for (const path of names) {
  if (!(await stat(join(repo, path))).isFile()) continue;
  assert(!/(?:^|\/)(?:node_modules|target|\.verify)(?:\/|$)/.test(path));
  files[path] = sha256(await readFile(join(repo, path)));
}
const scratch = await mkdtemp(join(repo, '.verify/lean-finalize-'));
const list = join(scratch, 'files.list0');
await writeFile(list, Object.keys(files).map(path => path + '\0').join(''));
execFileSync('tar', ['-czf', join(out, 'source.tgz'), '-C', repo, '--null', '-T', list]);
await put(join(out, 'source-manifest.json'), {schema: 1, kind: 'distribution-source-snapshot',
  baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repo, encoding: 'utf8'}).trim(),
  version: lock.kitVersion, sourceDigest: sha256(JSON.stringify(files)),
  archiveSha256: sha256(await readFile(join(out, 'source.tgz'))), files});
await put(join(out, 'evidence/check-summary.json'), {focusedTests: Number(tap.match(/# tests (\d+)/)[1]), failures: 0,
  pairedConsumerCheck: 'installed-distribution.json', audit: audit.metadata.vulnerabilities,
  frozenPartnerFiles: Object.keys(protectedFiles).length, frozenPartnerFilesMatch: true,
  runtimeRecompiled: false, realDeviceRun: false, realNetworkBusinessRun: false, broadcast: false});
const inventory = await fileInventory(out);
await writeFile(join(out, 'SHA256SUMS'), Object.entries(inventory).filter(([path]) => path !== 'SHA256SUMS')
  .map(([path, item]) => `${item.sha256}  ${path}\n`).join(''));
console.log(JSON.stringify({out, sourceFiles: Object.keys(files).length, focusedTests: tap.match(/# tests (\d+)/)[1],
  audit: audit.metadata.vulnerabilities, protectedFiles: Object.keys(protectedFiles).length}));
