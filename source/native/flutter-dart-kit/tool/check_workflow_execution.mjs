// Source strategy gate only. Signatures replay public frozen fixtures while
// Engine/Reviewed finalization runs the pinned Native Rust implementation.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
const base = resolve(import.meta.dirname, '..'), dart = process.argv[2];
assert(dart, 'Dart SDK executable required');
const sha = b => createHash('sha256').update(b).digest('hex');
const tests = [
  'test/workflow_plan_test.dart', 'test/workflow_execution_test.dart',
  'test/workflow_json_test.dart', 'test/signing_executor_test.dart',
  'test/prepared_signing_test.dart', 'test/reviewed_signing_test.dart',
  'test/typed_signing_test.dart', 'test/staged_signing_test.dart',
  'test/amm_dependent_signing_test.dart', 'test/amm_controller_signing_test.dart',
];
const opts = {cwd: base, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024};
const analysis = execFileSync(dart, ['analyze', 'lib', 'test'], opts).trim();
const events = execFileSync(dart, ['test', ...tests, '--reporter=json'], opts)
  .trim().split('\n').map(s => JSON.parse(s));
assert.equal(events.findLast(e => e.type === 'done')?.success, true);
const passed = events.filter(e => e.type === 'testDone' && !e.hidden && !e.skipped && e.result === 'success').length;
const planning = JSON.parse(await readFile(join(base, 'test/fixtures/workflow-planning.json')));
const signing = JSON.parse(await readFile(join(base, 'test/fixtures/workflow-signing.json')));
const messageJson = JSON.parse(await readFile(join(base, 'test/fixtures/workflow-json.json')));
assert.equal(planning.cases.length, 10);
assert.equal(signing.cases.length, 9);
assert.equal(messageJson.cases.length, 23);
assert.equal(signing.planningSha256, sha(await readFile(join(base, 'test/fixtures/workflow-planning.json'))));
const protection = JSON.parse(execFileSync(process.execPath, ['tool/check_protected.mjs'], opts));
const paths = [...tests,
  'lib/src/signing_backend.dart', 'lib/src/internal/signing_executor.dart',
  'lib/src/internal/signing_stages.dart', 'lib/src/internal/workflow_executor.dart',
  'lib/src/internal/workflow_request.dart', 'lib/src/internal/workflow_plan.dart',
  'lib/src/internal/workflow_json.dart', 'lib/src/internal/transaction_read.dart',
  'lib/src/internal/provider_session.dart', 'lib/src/internal/native_wallet_binding.dart',
  'lib/src/internal/signing_worker.dart', 'tool/workflow_signing_oracle.mjs',
  'tool/workflow_json_oracle.mjs', 'tool/check_workflow_execution.mjs',
  'test/fixtures/workflow-planning.json', 'test/fixtures/workflow-signing.json',
  'test/fixtures/workflow-json.json',
];
const hashes = {};
for (const p of paths) hashes[p] = sha(await readFile(join(base, p)));
const report = {
  status: 'F3_WORKFLOW_EXECUTION_SOURCE_PASS', recordedAt: new Date().toISOString(),
  tests: passed, testFiles: tests, analysis, frozenExecutionCases: 9,
  frozenDeferredReferences: signing.cases.reduce((n, c) => n + c.deferred.length, 0),
  embeddedJsonReferenceCases: 23, protection, sourceHashes: hashes,
  proof: 'Private Dart workflow strategy and refactored single paths use actual pinned Rust finalization/validation with public replay signatures. Nine workflow results and deferred bindings match frozen Core/WASM. JSON message samples separately match Node JSON.parse/stringify.',
  limits: [
    'Native whole-batch custody and worker/Provider routing are not installed; executable public count remains 13 of 22.',
    'BIE1 workflow execution remains an explicit unsupported gate; no crypto bypass was added.',
    'No new device/private-Vault/Testnet/performance/App-size proof; replay is not production signing.',
  ],
  newDeviceAcceptance: false, chainHttp: 0, broadcasts: 0,
  acceptedDeliveryChanged: false, published: false, goalComplete: false,
};
const bytes = JSON.stringify(report, null, 2) + '\n';
await writeFile(join(base, 'evidence/f3-workflow-execution-source-a.json'), bytes, {flag: 'wx'});
console.log(JSON.stringify({status: report.status, tests: passed, testFiles: tests.length,
  executionCases: 9, protectedFiles: protection.protectedFiles, sha256: sha(bytes)}));
