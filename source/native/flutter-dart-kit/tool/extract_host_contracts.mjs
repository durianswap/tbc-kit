// One-time mechanical extraction from the accepted, hash-pinned bridge.
// This adds host interfaces, not a new Provider implementation or a Vault.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
const base = resolve(import.meta.dirname, '..'), root = resolve(base, '../..');
const sha = b => createHash('sha256').update(b).digest('hex');
const archive = join(root, 'release/flutter-native-bridge-20261012-b/tbc-flutter-native-bridge-20261012-b.tgz');
const archiveSha256 = '579e97499b6ca15a53542d19aa0f3e205a44099fb2c0de016cce6ff779d705ad';
assert.equal(sha(await readFile(archive)), archiveSha256);
const sources = ['private_host_channel', 'host_environment', 'approval_preparation',
  'formal_approval', 'permission_approval', 'permission_store', 'session_authority', 'webview_scope'];
const provenance = [];
async function save(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx' });
}
for (const name of sources) {
  const member = `tbc_kit_flutter/lib/src/${name}.dart`;
  const bytes = execFileSync('tar', ['-xOf', archive, member]);
  await save(join(base, 'lib/src', `${name}.dart`), bytes);
  provenance.push({ member, destination: `lib/src/${name}.dart`, sha256: sha(bytes), change: 'none' });
}
// Reuse only the focused transport/consent tests; do not rerun unrelated SDK work.
for (const name of ['private_host_channel', 'approval_preparation', 'formal_approval']) {
  const source = `native/flutter/test/${name}_test.dart`;
  const original = await readFile(join(root, source));
  const bytes = original.toString()
    .replaceAll('package:flutter_test/flutter_test.dart', 'package:test/test.dart')
    .replaceAll('package:tbc_kit_flutter/tbc_kit_flutter.dart', 'package:tbc_kit_flutter_dart/host_adapters.dart')
    .replaceAll('package:tbc_kit_flutter/src/', 'package:tbc_kit_flutter_dart/src/');
  const destination = `test/${name}_test.dart`;
  await save(join(base, destination), bytes);
  provenance.push({ source, sourceSha256: sha(original), destination, sha256: sha(bytes), change: 'test runner and candidate package imports only' });
}
for (const name of ['fixtures.json', 'provenance.json']) {
  const source = `native/flutter/test/fixtures/formal-approval/${name}`;
  const bytes = await readFile(join(root, source));
  const destination = `test/fixtures/formal-approval/${name}`;
  await save(join(base, destination), bytes);
  provenance.push({ source, sourceSha256: sha(bytes), destination, sha256: sha(bytes), change: 'none; existing offline fixture, not new chain evidence' });
}
await save(join(base, 'evidence/f1-host-extraction.json'), JSON.stringify({
  status: 'F1_HOST_CONTRACTS_EXTRACTED_NOT_PROVIDER_ACCEPTANCE',
  archive, archiveSha256, provenance, productionReplacement: false,
  notes: ['Formal approval adapters consume a trusted verified checkpoint; they are not a standalone Core verifier.',
    'No signer, network, durable backend, UI autoapproval or WebView message handler is supplied by this extraction.']
}, null, 2) + '\n');
console.log(JSON.stringify({ extractedContracts: sources.length, inheritedTestFiles: 3, acceptedDeliveryChanged: false }));
