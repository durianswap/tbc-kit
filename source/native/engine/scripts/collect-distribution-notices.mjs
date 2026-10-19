// Read-only inventory of target-specific dependencies and original notice texts.
// Emits a draft: never changes licensing, builds assets, publishes, or edits packages.
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname, join, relative, resolve} from 'node:path';

const repo = resolve(import.meta.dirname, '../../..');
const outputFlag = process.argv.indexOf('--output');
const output = outputFlag < 0 ? undefined : resolve(process.argv[outputFlag + 1] ?? '');
if (output) assert.ok(process.argv[outputFlag + 1] && !existsSync(output), 'Output must be a new explicit directory; never overwrite a draft');
const hash = value => createHash('sha256').update(value).digest('hex');
const read = file => readFileSync(file, 'utf8');
const texts = {};
const groups = [];
const nativeTargets = ['aarch64-apple-darwin', 'aarch64-apple-ios', 'aarch64-apple-ios-sim',
  'aarch64-linux-android', 'armv7-linux-androideabi', 'x86_64-linux-android'];
const configs = [
  {name: 'engine', directory: 'packages/tbc-engine/rust', flags: [],
    builds: [['tbc-engine-native', nativeTargets], ['tbc-keyless-native', nativeTargets],
      ['tbc-engine-wasm', ['wasm32-unknown-unknown']], ['tbc-keyless-wasm', ['wasm32-unknown-unknown']]]},
  {name: 'signer', directory: 'native/signer/kernel', flags: ['--features', 'musig'],
    builds: [['tbc-signer-kernel', [...nativeTargets, 'wasm32-unknown-unknown']]]},
];

function noticeFiles(directory, prefix = '') {
  const result = [];
  for (const entry of readdirSync(join(directory, prefix), {withFileTypes: true})) {
    if (['.git', 'target', 'node_modules'].includes(entry.name) || entry.isSymbolicLink()) continue;
    const p = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...noticeFiles(directory, p));
    else if (entry.isFile() && /(?:^|[_.-])(licen[sc]e|copying|notice|copyright)(?:$|[_.-])/i.test(entry.name)) result.push(p);
  }
  return result.sort();
}
function collectText(directory, p) {
  const bytes = readFileSync(join(directory, p));
  const text = bytes.toString('utf8');
  assert.ok(Buffer.from(text).equals(bytes), `Notice is not UTF-8: ${p}`);
  const sha256 = hash(bytes);
  texts[sha256] = text;
  return {path: p, sha256, bytes: bytes.length};
}

for (const config of configs) {
  const cwd = join(repo, config.directory), lockBefore = hash(readFileSync(join(cwd, 'Cargo.lock')));
  const run = args => execFileSync('cargo', args, {cwd, encoding: 'utf8', maxBuffer: 24 * 1024 * 1024, timeout: 45000});
  const metadata = JSON.parse(run(['metadata', '--locked', '--offline', '--format-version', '1', ...config.flags]));
  const profiles = [], selected = new Set();
  for (const [root, targets] of config.builds) for (const target of targets) {
    const output = run(['tree', '--locked', '--offline', '-p', root, '--target', target,
      '-e', 'normal,build', '--prefix', 'none', '--format', '{p}', ...config.flags]);
    const packages = [...new Set(output.trim().split('\n').map(line => {
      const match = line.match(/^([^ ]+) v([^ ]+)/);
      assert.ok(match, `Unexpected cargo tree row: ${line}`);
      return `${match[1]}@${match[2]}`;
    }))].sort();
    packages.forEach(p => selected.add(p));
    profiles.push({root, target, features: config.flags, packages});
  }
  const packages = [...selected].sort().map(key => {
    const matches = metadata.packages.filter(p => `${p.name}@${p.version}` === key);
    assert.equal(matches.length, 1, `Ambiguous package identity: ${key}`);
    const p = matches[0], directory = dirname(p.manifest_path);
    const firstParty = config.name === 'engine'
      ? relative(cwd, p.manifest_path).startsWith('crates/')
      : p.name === 'tbc-signer-kernel';
    const paths = firstParty ? [] : noticeFiles(directory);
    if (!firstParty && p.license_file) {
      const f = relative(directory, p.license_file);
      assert.ok(!f.startsWith('..') && existsSync(p.license_file), `External/missing license_file: ${key}`);
      if (!paths.includes(f)) paths.push(f);
    }
    return {name: p.name, version: p.version, firstParty, source: p.source ?? 'local',
      declaredLicense: p.license, manifestSha256: hash(readFileSync(p.manifest_path)),
      notices: paths.sort().map(f => collectText(directory, f))};
  });
  assert.equal(hash(readFileSync(join(cwd, 'Cargo.lock'))), lockBefore, 'Cargo changed the lockfile');
  groups.push({name: config.name, lockfile: {path: `${config.directory}/Cargo.lock`, sha256: lockBefore},
    profiles, packages, missingThirdPartyNoticeText: packages.filter(p => !p.firstParty && !p.notices.length).map(p => `${p.name}@${p.version}`)});
}

const inventory = {
  status: 'TARGET_SPECIFIC_NOTICES_DRAFT_NOT_RELEASE_CLEARANCE',
  generator: {path: relative(repo, import.meta.filename), sha256: hash(readFileSync(import.meta.filename))},
  scope: 'Cargo target-specific normal/build graphs, no dev edges. Includes compiler/proc-macro dependencies; not per-binary linker attribution.',
  limitations: ['Current locked source, not an independent reconstruction of every frozen build environment',
    'Original nested notices retained conservatively, including notices for auxiliary source within selected packages',
    'No legal interpretation or OR-license choice; first-party licensing and OpenTBC authorization are separate',
    'JS bundled dependencies and external npm packages are not included in this Native draft'],
  groups, textCount: Object.keys(texts).length,
  effects: {builds: 0, networkRequests: 0, signatures: 0, broadcasts: 0, runtimeChanges: 0, deletions: 0, publishing: 0},
};
if (output) {
  mkdirSync(output);
  mkdirSync(join(output, 'texts'));
  for (const [sha256, text] of Object.entries(texts)) {
    const file = join(output, 'texts', `${sha256}.txt`);
    writeFileSync(file, text, {flag: 'wx'});
    assert.equal(hash(readFileSync(file)), sha256, 'Notice text changed during export');
  }
  writeFileSync(join(output, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`, {flag: 'wx'});
  console.log(JSON.stringify({status: inventory.status, output, textCount: inventory.textCount,
    textBytes: Object.values(texts).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    groups: groups.map(g => ({name: g.name, profiles: g.profiles.length, packages: g.packages.length,
      missingThirdPartyNoticeText: g.missingThirdPartyNoticeText}))}));
} else console.log(JSON.stringify(process.argv.includes('--include-texts') ? {inventory, texts} : inventory));
