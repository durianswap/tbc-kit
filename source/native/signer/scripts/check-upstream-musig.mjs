import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const kernel = resolve(process.argv[2] ?? join(root, 'kernel'));
const source = join(kernel, 'vendor/secp256k1-sys/depend/secp256k1');
const output = await mkdtemp(join(tmpdir(), 'tbc-musig-upstream-'));
execFileSync('node', [join(kernel, 'scripts/check-musig-vendor.mjs')], {timeout: 30000, stdio: 'pipe'});
execFileSync('cc', ['-include', 'stdio.h', '-mmacosx-version-min=15.0', '-O2', '-DVERIFY=1', '-DENABLE_MODULE_EXTRAKEYS=1',
  '-DENABLE_MODULE_SCHNORRSIG=1', '-DENABLE_MODULE_MUSIG=1', '-DECMULT_WINDOW_SIZE=15', '-DECMULT_GEN_PREC_BITS=4',
  '-I'+source, '-I'+join(source, 'include'), join(root, 'consumers/UpstreamMuSigProbe.c'),
  join(source, 'src/precomputed_ecmult.c'), join(source, 'src/precomputed_ecmult_gen.c'), '-o', join(output, 'probe')],
  {timeout: 120000, maxBuffer: 2*1024*1024});
const report = JSON.parse(execFileSync(join(output, 'probe'), [], {encoding: 'utf8', timeout: 60000}));
assert.equal(report.status, 'PASS'); assert.equal(report.vectorCases, 42);
assert.equal(report.upstreamSkippedCases, 1);
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
Object.assign(report, {scope: 'Pinned secp256k1-sys 0.11.0 upstream module tests; not a claim of all BIP327 or wallet API features',
  publicFixturesOnly: true, networkRequests: 0, productionChanged: false,
  vectorGroups: ['key aggregation','nonce generation','nonce aggregation','sign/verify','tweaks','signature aggregation'],
  skippedReason: 'Upstream skips sign_error_case[0]: signer key not in group. The TBC Rust wrapper separately rejects nonmembers.',
  notPublicWalletFeatures: ['tweaks','duplicate keys','arbitrary key order','arbitrary threshold'],
  vectorSha256: await sha(join(source, 'src/modules/musig/vectors.h')),
  upstreamTestsSha256: await sha(join(source, 'src/modules/musig/tests_impl.h')),
  harnessSha256: await sha(join(root, 'consumers/UpstreamMuSigProbe.c'))});
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)+'\n', {flag: 'wx'});
console.log(JSON.stringify({status: report.status, vectorCases: report.vectorCases, upstreamSkippedCases: 1, output}));
