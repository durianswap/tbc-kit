// Host Swift runtime + independent pinned SDK verification. No wallet/network.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const root = resolve(import.meta.dirname, '..'), output = await mkdtemp(join(tmpdir(), 'tbc-musig-swift-'));
const kernel = join(root, 'kernel'), require = createRequire(import.meta.url), tbc = require('tbc-lib-js');
assert.equal(require('tbc-lib-js/package.json').version, '1.0.31');
execFileSync('cargo', ['build', '--locked', '--offline', '--release', '--features', 'musig'],
  {cwd: kernel, timeout: 120000, stdio: 'pipe', env: {...process.env, MACOSX_DEPLOYMENT_TARGET: '15.0'}});
const sources = ['TbcDigestSigner.swift', 'TbcMuSigSession.swift'].map(f => join(root, 'apple/Sources/TbcSigner', f));
execFileSync('xcrun', ['swiftc', '-target', 'arm64-apple-macos15.0', '-swift-version', '6', '-D', 'TBC_SIGNER_MUSIG', '-parse-as-library',
  '-I', join(kernel, 'include'), ...sources, join(root, 'consumers/SwiftMuSigProbe.swift'),
  join(kernel, 'target/release/libtbc_signer_kernel.a'), '-o', join(output, 'probe')], {timeout: 120000});
const report = JSON.parse(execFileSync(join(output, 'probe'), [], {encoding: 'utf8', timeout: 30000}));
assert.equal(report.status, 'PASS'); assert.equal(report.checks, 18);
assert.equal(report.publicGroupDerivation, true);
const bytes = hex => Buffer.from(hex, 'hex'), group = tbc.crypto.MuSig2.keyAgg(report.publicKeys.map(bytes));
assert.equal(tbc.crypto.MuSig2.getAggPubkey(group).toString('hex'), report.aggregateKey);
const session = tbc.crypto.MuSig2.buildSession(group, tbc.crypto.MuSig2.nonceAgg(report.publicNonces.map(bytes)), bytes(report.digest));
for (let i = 0; i < 2; i++) assert.equal(tbc.crypto.MuSig2.partialVerify(bytes(report.partialSignatures[i]), bytes(report.publicNonces[i]), bytes(report.publicKeys[i]), session), true);
assert.equal(tbc.crypto.Schnorr.verify(bytes(report.digest), bytes(report.signature), bytes(report.aggregateKey)), true);
// Default compilation must not acquire any optional MuSig linker references.
execFileSync('xcrun', ['swiftc', '-target', 'arm64-apple-macos15.0', '-swift-version', '6', '-emit-library', '-I', join(kernel, 'include'), ...sources,
  '-o', join(output, 'default.dylib'), '-Xlinker', '-undefined', '-Xlinker', 'dynamic_lookup'], {timeout: 120000});
assert.doesNotMatch(execFileSync('nm', ['-u', join(output, 'default.dylib')], {encoding: 'utf8'}), /tbc_signer_musig/);
const sha = file => readFile(file).then(b => createHash('sha256').update(b).digest('hex'));
Object.assign(report, {sdkPartialAndFinalVerification: true, defaultHasNoMuSigReferences: true,
  hostDeploymentTarget: '15.0',
  scope: 'macOS Swift runtime, not device approval/custody or chain acceptance', networkRequests: 0,
  sourceSha256: await sha(sources[1]), kernelSha256: await sha(join(kernel, 'target/release/libtbc_signer_kernel.a'))});
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({status: 'PASS', checks: report.checks, sdkPartialAndFinalVerification: true, output}));
