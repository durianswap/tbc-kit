import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = name => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');

test('Legacy uses the canonical transaction and workflow execution paths', async () => {
  const [mapper, native] = await Promise.all([source('legacy-mapper.ts'), source('legacy-webview-native.ts')]);
  assert.match(mapper, /tbc_sendTransaction/);
  assert.match(mapper, /tbc_signTransaction/);
  assert.doesNotMatch(mapper, /rawTransactions\.sign|associatedTransactions\.sign|cryptoAdapter/);
  assert.match(native, /readonly genericBatch\?: LegacyStandardWorkflowBatchAdapter/u);
  assert.match(native, /sendSharedBusinessTransaction/u);
  assert.doesNotMatch(native, /legacy-preparation-fallback|legacy-secure-fallback/u);
});
