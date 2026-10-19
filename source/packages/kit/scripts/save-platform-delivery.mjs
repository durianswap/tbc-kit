// Preserve local derived artifacts and portable evidence, without publication.
import assert from 'node:assert/strict';
import {readFile, writeFile, copyFile, mkdir, constants} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {sha256} from './platform-resources.mjs';
const [candidateArg, evidenceArg, parityArg, repoArg] = process.argv.slice(2);
assert.ok(repoArg, 'CANDIDATE VERIFICATION_REPORT WASM_PARITY_REPORT REPOSITORY');
const candidate = resolve(candidateArg), repo = resolve(repoArg);
const build = JSON.parse(await readFile(join(candidate, 'candidate.json')));
const evidence = JSON.parse(await readFile(resolve(evidenceArg)));
const parity = JSON.parse(await readFile(resolve(parityArg)));
assert.equal(evidence.status, 'PASS_SPLIT_INSTALL_RESOURCES_AND_HOST_NATIVE_PARITY');
assert.equal(parity.status, 'PASS_WASM_SIZE_DIFFERENTIAL');
assert.equal(evidence.identities[1].artifactId, build.artifactId);
assert.equal(parity.identities[1].artifactId, build.artifactId);
const output = join(repo, 'docs/distribution/evidence/kit-size-stage2-2026-10-10');
await mkdir(output); // Keep failed/earlier candidates and receipts immutable.
const artifacts = [{file: build.tarball, sha256: build.tarballSha256},
  ...Object.values(build.platforms).map(p => ({file: p.archive, sha256: p.archiveSha256}))];
for (const entry of artifacts) {
  assert.equal(sha256(await readFile(join(candidate, entry.file))), entry.sha256);
  await copyFile(join(candidate, entry.file), join(repo, 'release', entry.file), constants.COPYFILE_EXCL);
}
await copyFile(resolve(evidenceArg), join(output, 'split-resource-check.json'), constants.COPYFILE_EXCL);
await copyFile(resolve(parityArg), join(output, 'wasm-parity.json'), constants.COPYFILE_EXCL);
await copyFile(join(candidate, 'candidate.json'), join(output, 'build.json'), constants.COPYFILE_EXCL);
await copyFile(join(candidate, 'package/artifacts/platform-resources.json'), join(output, 'platform-resources.json'), constants.COPYFILE_EXCL);
const sources = {};
for (const path of [
  'packages/kit/scripts/platform-resources.mjs', 'packages/kit/scripts/prepare-platform-candidate.mjs',
  'packages/kit/scripts/check-platform-candidate.mjs', 'packages/kit/scripts/save-platform-delivery.mjs',
  'packages/kit/scripts/check-install-candidate.mjs', 'packages/kit/test/platform-resources.test.mjs',
  'packages/kit/test/react-native-engine-template.test.mjs',
  'packages/kit/examples/react-native-engine/module/scripts/sync-native.mjs',
  'native/engine/scripts/prepare-native-engine.mjs', 'native/engine/scripts/prepare-full-native-engine.mjs',
  'native/engine/scripts/check-native-engine-consumers.mjs',
]) sources[path] = sha256(await readFile(join(repo, path)));
await writeFile(join(output, 'delivery.json'), JSON.stringify({status: 'PARTIAL_STAGE2_LOCAL_DELIVERY',
  kitVersion: build.version, artifacts, sources, published: false, realChain: false,
  rnSdkPairingRemaining: evidence.rnTemplate.sdkLockStale,
  note: 'Web/Node clean install and offline resource parity passed. Complete RN SDK handoff remains pending. Flutter stage1 pair is unchanged.'}, null, 2)+'\n', {flag: 'wx'});
console.log(JSON.stringify({output, artifacts}));
