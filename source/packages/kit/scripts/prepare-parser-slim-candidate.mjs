import assert from 'node:assert/strict';
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {fileInventory, platformCatalog, sha256} from './platform-resources.mjs';
import {closePortableParserDependencies, parserRuntimeDependencies} from './portable-parser-dependencies.mjs';
import {verifiedKitCandidate} from '../../../native/flutter/scripts/candidate-inputs.mjs';

const [baseArg, outArg, version] = process.argv.slice(2);
assert.ok(version, 'FROZEN_KIT NEW_OUTPUT NEW_VERSION');
assert.match(version, /^0\.1\.0-platform-slim\.\d{8}\.\d+$/);
const base = resolve(baseArg), out = resolve(outArg), kit = join(out, 'package');
const baseline = await verifiedKitCandidate(base), before = await fileInventory(base);
assert.notEqual(version, baseline.version);
await mkdir(out); await cp(base, kit, {recursive: true, force: false, errorOnExist: true});
const parser = {};
for (const format of ['esm', 'cjs']) parser[format] = await closePortableParserDependencies(join(kit, `dist/${format}/vendor/tbc-tx-parser`));
const pkg = JSON.parse(await readFile(join(kit, 'package.json')));
assert.equal(pkg.dependencies['tbc-lib-js'], '1.0.31');
delete pkg.dependencies['tbc-lib-js'];
Object.assign(pkg.dependencies, parserRuntimeDependencies);
pkg.version = version;
await writeFile(join(kit, 'package.json'), JSON.stringify(pkg, null, 2)+'\n');
const provenance = JSON.parse(await readFile(join(kit, 'artifacts/provenance.json')));
provenance.package = `@tbc/kit@${version}`;
provenance.parserDependencyClosure = {baseline, parser, upstream: {name: 'tbc-lib-js', version: '1.0.31', license: 'OpenTBC',
  repository: 'https://github.com/TuringBitChain/tbc-lib-js.git'}, algorithmChanged: false, validationChanged: false,
  note: 'Existing private read-only copy retained with source notices; external full package no longer required.'};
const catalog = await platformCatalog(base); catalog.package = provenance.package;
const catalogBytes = JSON.stringify(catalog, null, 2)+'\n';
await writeFile(join(kit, 'artifacts/platform-resources.json'), catalogBytes);
provenance.platformResources.sha256 = sha256(catalogBytes);
await writeFile(join(kit, 'artifacts/provenance.json'), JSON.stringify(provenance, null, 2)+'\n');
const after = await fileInventory(kit);
assert.deepEqual(Object.keys(after), Object.keys(before), 'Unexpected file addition or removal');
const changed = Object.keys(before).filter(p => before[p].sha256 !== after[p].sha256);
assert.deepEqual(changed.sort(), ['package.json', 'artifacts/provenance.json', 'artifacts/platform-resources.json',
  ...['esm','cjs'].map(f=>`dist/${f}/vendor/tbc-tx-parser/adapters/partial-sha256.js`)].sort());
const identity = {schema: 1, version, sourceVersion: baseline.version, protocolFingerprint: baseline.protocolFingerprint,
  rustSourceSha256: baseline.rustSourceSha256, files: Object.fromEntries(Object.entries(after)
    .filter(([p])=>p!=='artifacts/flutter-kit-candidate.json').map(([p,v])=>[p,v.sha256]))};
await writeFile(join(kit, 'artifacts/flutter-kit-candidate.json'), JSON.stringify({artifactId: sha256(JSON.stringify(identity)), ...identity}, null, 2)+'\n');
await verifiedKitCandidate(kit); await platformCatalog(kit);
const [packed] = JSON.parse(execFileSync('npm', ['pack','--ignore-scripts','--json','--pack-destination',out], {cwd: kit, encoding:'utf8', maxBuffer:4*1024*1024}));
const report = {status:'BUILT_NOT_ACCEPTED', baseline, version, tarball:packed.filename,
  tarballSha256:sha256(await readFile(join(out, packed.filename))), compressedBytes:packed.size,
  unpackedBytes:packed.unpackedSize, changed, parser, nativeAndWasmChanged:false, realChain:false, published:false};
await writeFile(join(out, 'candidate.json'), JSON.stringify(report, null, 2)+'\n');
console.log(JSON.stringify(report, null, 2));
