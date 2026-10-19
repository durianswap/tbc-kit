// Source worker integration only; do not promote its replay backend to native
// custody, installed-provider or chain evidence.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
const base = resolve(import.meta.dirname, '..'), dart = process.argv[2];
assert(dart, 'Dart SDK executable required');
const sha = b => createHash('sha256').update(b).digest('hex');
const tests = ['test/workflow_worker_test.dart', 'test/signing_worker_test.dart',
  'test/workflow_execution_test.dart', 'test/typed_provider_test.dart',
  'test/prepared_provider_test.dart', 'test/reviewed_provider_test.dart'];
const opts = {cwd: base, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024};
const analysis = execFileSync(dart, ['analyze', 'lib', 'test'], opts).trim();
const events = execFileSync(dart, ['test', ...tests, '--reporter=json'], opts)
  .trim().split('\n').map(s => JSON.parse(s));
assert.equal(events.findLast(e => e.type === 'done')?.success, true);
const passed = events.filter(e => e.type === 'testDone' && !e.hidden && !e.skipped && e.result === 'success').length;
const protection = JSON.parse(execFileSync(process.execPath, ['tool/check_protected.mjs'], opts));
const parentPath = 'evidence/f3-workflow-execution-source-a.json';
const parent = await readFile(join(base, parentPath));
assert.equal(sha(parent), '178a5fd16010745265de496a497eb639a7c11708d05277aa88a696cdaead8438');
const paths = [...tests, 'lib/src/internal/signing_worker.dart', 'lib/src/internal/signing_executor.dart',
  'lib/src/internal/signing_stages.dart', 'lib/src/internal/workflow_executor.dart',
  'lib/src/internal/workflow_request.dart', 'lib/src/internal/workflow_plan.dart',
  'lib/src/internal/workflow_json.dart', 'lib/src/signing_backend.dart',
  'lib/src/internal/native_wallet_binding.dart', 'lib/src/internal/provider_session.dart',
  'tool/check_workflow_worker.mjs'];
const sourceHashes = {};
for (const p of paths) sourceHashes[p] = sha(await readFile(join(base, p)));
const report = {status: 'F3_WORKFLOW_WORKER_SOURCE_PASS', recordedAt: new Date().toISOString(),
  parent: {path: parentPath, sha256: sha(parent)}, tests: passed, testFiles: tests, analysis,
  sourceHashes, protection,
  implemented: [
    'Same non-UI isolate/Engine/material readers and native callback channel; workflow backend and live child permission evaluator required before preparation.',
    'Native unlock snapshot is refreshed before testing the initially-locked worker mirror. No default unlock or grant was added.',
    'Identical GET/status reads reuse in-flight/completed immutable replies only within one workflow preparation. Cache clears before binding/cancel; new requests read mutable chain data again.',
    'Only the explicit payload-free signing-unavailable type crosses as a recoverable workflow flag; arbitrary failures stay fatal and sanitized.',
  ],
  observations: {workflowWorkerCases: 11, messageChainReads: 0,
    nativeTransferThenMessageReadsPerRequest: 2, collidingTwoTransferPreparationReads: 2,
    newDeviceAcceptance: false, broadcasts: 0, chainHttp: 0},
  limits: [
    'Native backend is replay in these tests. Actual Swift/Kotlin whole-batch binding, step completion/delivery and Provider routing remain unimplemented.',
    'Executable public Provider methods remain 13 of 22; no installed workflow capability is advertised.',
    'No private Vault, new device/Testnet, matched timing/Release-size or final delivery claim.',
  ], acceptedDeliveryChanged: false, published: false, goalComplete: false};
const bytes = JSON.stringify(report, null, 2) + '\n';
await writeFile(join(base, 'evidence/f3-workflow-worker-source-a.json'), bytes, {flag: 'wx'});
console.log(JSON.stringify({status: report.status, tests: passed, testFiles: tests.length,
  protectedFiles: protection.protectedFiles, sha256: sha(bytes)}));
