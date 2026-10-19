// Acceptance-only loader: real execution modules come solely from the installed
// immutable package. Private projection helpers are fixture oracles, not patches
// to Core/Host/Kit. Their frozen source inputs are explicitly recorded.
import assert from 'node:assert/strict';
import {readFile, readdir, mkdtemp} from 'node:fs/promises';
import {join, resolve, relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

export async function loadFrozenCoinHarness({consumer, archive, source, signerWasm, expectedVersion='0.1.0-candidate.213'}) {
  assert.ok(consumer && archive && source && signerWasm, 'Installed mode requires all four explicit paths');
  const sha = v => createHash('sha256').update(v).digest('hex');
  const installed = join(resolve(consumer), 'node_modules/@tbc/kit');
  const tarSha256 = sha(await readFile(archive));
  const archives={
    '0.1.0-candidate.213':'7e22e1f110ca045c2a9f9be9f0aeaf10955107770f556aa38fff210b59fa99e9',
    '0.1.0-candidate.216':'5ba6f188d98cff322882a72fb93e786f94b330f03da2227711af24d614182622',
    '0.1.0-candidate.217':'3cdc59bde62856736dd684ab7ecce66a06f16850a730e6ec059d6b12536f808a',
    '0.1.0-candidate.224':'aabd2d0506e567ca8773c754d0b1f70614d8c7541f010dd0689bda937cd85079',
  };
  assert.ok(Object.hasOwn(archives,expectedVersion),'Unpinned candidate');
  assert.equal(tarSha256, archives[expectedVersion]);
  const directory = await mkdtemp(join(tmpdir(), 'tbc-coin213-archive-'));
  execFileSync('tar', ['-xzf', resolve(archive), '-C', directory, 'package/dist', 'package/package.json', 'package/artifacts/provenance.json']);
  const files = ['package.json', 'artifacts/provenance.json'];
  async function walk(dir) {
    for (const e of await readdir(join(directory, 'package', dir), {withFileTypes: true})) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else { assert.ok(e.isFile()); files.push(p); }
    }
  }
  await walk('dist');
  for (const p of files) assert.equal(sha(await readFile(join(installed, p))), sha(await readFile(join(directory, 'package', p))), p);
  const pkg = JSON.parse(await readFile(join(installed, 'package.json')));
  assert.equal(pkg.version, expectedVersion);
  const provenance = JSON.parse(await readFile(join(installed, 'artifacts/provenance.json')));
  for (const a of provenance.artifacts) assert.equal(sha(await readFile(join(installed, a.path))), a.sha256, a.path);
  const snapshotBytes = await readFile(join(source, 'source-snapshot.json'));
  const snapshotSha256 = sha(snapshotBytes);
  assert.equal(snapshotSha256, '4801a0578eae12ed3440ed32dc25d26bf4c4960dfe34748ea82d5e409a77c967');
  const snapshot = JSON.parse(snapshotBytes);
  const fixtureSources = {};
  async function checkSource(p) {
    const hash = sha(await readFile(join(source, p)));
    assert.equal(hash, snapshot.hashes[p], p); fixtureSources[p] = hash;
  }
  for (const file of ['coin-proof.json', 'coin-admin-proof.json']) await checkSource('packages/tbc-engine/rust/fixtures/' + file);
  // No public API exposes these two internal requirement projectors. Preserve
  // their old fixture/cache checks using exact frozen source; they are never
  // injected into the installed runtime, wallet, Engine or Prepared builder.
  const oracle = await build({stdin: {contents: `
    export {chainDataRequirement} from './packages/core/src/reducers/chain-data-requirements.ts';
    export {preparedChainDataRequirement} from './packages/kit/src/prepared-chain-data.ts';
  `, resolveDir: resolve(source), loader: 'ts'},
    alias: {'@tbc-wallet/core': join(resolve(source), 'packages/core/src/reducers/chain-data-requirements.ts')},
    bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', logLevel: 'silent'});
  for (const file of Object.keys(oracle.metafile.inputs)) {
    if (file === '<stdin>') continue;
    const p = relative(resolve(source), resolve(file));
    assert.ok(!p.startsWith('..'), 'Oracle must not load mutable workspace code');
    await checkSource(p);
  }
  const projections = await import('data:text/javascript;base64,' + Buffer.from(oracle.outputFiles[0].contents).toString('base64'));
  assert.deepEqual(Object.keys(projections).sort(), ['chainDataRequirement', 'preparedChainDataRequirement']);
  const imports = {};
  for (const [name, entry] of Object.entries({client: '.', wallet: './wallet', engine: './engine', api: './api'})) {
    const options = pkg.exports[entry], file = options.node?.import ?? options.import;
    imports[name] = await import(pathToFileURL(join(installed, file)));
  }
  assert.equal(imports.wallet.TWS_RELEASE_FINGERPRINT, provenance.protocolFingerprint);
  const signerSha256 = sha(await readFile(signerWasm));
  assert.equal(signerSha256, 'fde7b3c63a0a9a1a585b7d62de6d9f39cac0646fa7892bab1892d9b6f73ec580');
  const runtime = {...imports.client, ...imports.wallet, ...imports.engine, ...imports.api};
  assert.ok(!('preparedChainDataRequirement' in runtime));
  const installedProjection=['0.1.0-candidate.217','0.1.0-candidate.224'].includes(expectedVersion);
  if(installedProjection)assert.equal(typeof runtime.chainDataRequirement,'function');
  else assert.ok(!('chainDataRequirement' in runtime));
  // 217 exposes its real projector: never overwrite it with a fixture oracle.
  const kit = Object.freeze({...projections, ...runtime});
  return {kit, wasm: join(installed, 'artifacts/wasm/tbc_engine_wasm.wasm'),
    keyless: join(installed, 'artifacts/wasm/tbc_keyless_wasm.wasm'),
    evidence: {candidate: pkg.version, tarSha256, comparedFiles: files.length, protocolFingerprint: provenance.protocolFingerprint,
      snapshotSha256, fixtureSources, signer: 'local.5', signerSha256,
      fixtureOracleOnly: installedProjection?['preparedChainDataRequirement']:['chainDataRequirement', 'preparedChainDataRequirement'], executionFromInstalledPackage: true}};
}
