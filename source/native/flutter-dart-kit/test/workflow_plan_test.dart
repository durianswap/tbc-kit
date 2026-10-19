import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_reviewer.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';
import 'package:tbc_kit_flutter_dart/src/internal/workflow_request.dart';
import 'package:tbc_kit_flutter_dart/src/internal/workflow_plan.dart';

late ComputeProbe native;
late Map oracle;
Map load(String name) =>
    jsonDecode(File('test/fixtures/$name.json').readAsStringSync());
Map<String, dynamic> keyless(String m, Map<String, dynamic> p) =>
    copied(jsonDecode(native.call('keyless', m, canonical(p))));

final class Harness {
  Harness(Map s) : sample = copied(s) {
    time = protocolTime(sample['now']);
  }
  final Map<String, dynamic> sample;
  late DateTime time;
  bool current = true;
  int materialCalls = 0,
      reviewCalls = 0,
      normalizes = 0,
      plans = 0,
      validates = 0;
  Future<void> Function(String)? duringMaterial;
  void Function(Map)? mutateMaterial;
  void Function(String, Map)? mutateEngine;
  Map get request => sample['request'];
  void fresh() => need(current, 'TEST_REVOKED');
  Map<String, dynamic> engine(String operation, Map<String, dynamic> params) {
    if (operation == 'normalizeRequest') normalizes++;
    if (operation == 'plan') plans++;
    if (operation == 'validate') validates++;
    final r = jsonDecode(native.call('engine', operation, canonical(params)));
    need(r['ok'] == true, 'TEST_ENGINE_REJECTED');
    final result = copied(r['result']);
    mutateEngine?.call(operation, result);
    return result;
  }

  Future<WorkflowPreparation> run() => prepareWorkflow(
    method: sample['method'],
    input: request,
    context: sample['context'],
    account: sample['account'],
    additionalAccounts:
        (sample['accounts'] as List).skip(1).map((a) => copied(a)).toList(),
    expiresAt: sample['operationExpiresAt'] ?? '2026-10-13T00:02:00.123Z',
    now: () => time,
    requireCurrent: fresh,
    engine: engine,
    keyless: keyless,
    prepareMaterial: (id, r, roles) async {
      materialCalls++;
      await duringMaterial?.call(id);
      final value = copied(sample['materials'][id]);
      mutateMaterial?.call(value);
      return value;
    },
    prepareReviewed: (id, r, a, fresh) async {
      reviewCalls++;
      final s = (load('reviewed-material-b')['cases'] as List).singleWhere(
        (s) => s['name'] == 'associated-two-dependent',
      );
      final review = await ReviewedTransactionReviewer(
        chainId: a['chainId'],
        now: () => time,
        keyless: keyless,
        read: (p) async {
          expect(s['replies'].containsKey(p), true);
          return copied(s['replies'][p]);
        },
        readHistory: (_) async => throw StateError('No history read'),
        status:
            (points) async => {
              'txos': [
                for (final p in points)
                  copied(
                    (s['statuses'] as List).singleWhere(
                      (u) =>
                          u['txid'] == p['txid'] &&
                          u['index'] == '${p['index']}',
                    ),
                  ),
              ],
            },
      ).review(request: r, account: a, requireCurrent: fresh);
      expect(canonical(review.artifact), canonical(sample['reviews'][id]));
      return review;
    },
  );
}

void main() {
  setUpAll(() {
    oracle = load('workflow-planning');
    expect(
      oracle['archiveSha256'],
      'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0',
    );
    for (final e in (oracle['provenance'] as Map).entries) {
      expect(
        sha256
            .convert(File('test/fixtures/${e.key}').readAsBytesSync())
            .toString(),
        e.value,
      );
    }
    final lib = load('signing/replay')['library'];
    expect(
      sha256.convert(File(lib['path']).readAsBytesSync()).toString(),
      lib['sha256'],
    );
    native = ComputeProbe(DynamicLibrary.open(lib['path']));
  });
  Map sample(String name) =>
      (oracle['cases'] as List).singleWhere((c) => c['name'] == name);
  test(
    'Reviewed child continuation binds the complete single-call request',
    () async {
      final h = Harness(sample('reviewed-then-message')),
          result = await h.run();
      final step = (h.request['steps'] as List).singleWhere(
        (s) => s['kind'] == 'reviewedTransaction',
      );
      final payload = result.reviewedPrograms[step['id']]!.plan['payload'];
      expect(
        payload['requestHash'],
        hashJson({
          'version': h.request['version'],
          'chainId': h.request['chainId'],
          'from': h.request['from'],
          'request': step['request'],
        }),
      );
      expect(payload['task']['requestHash'], hashJson(step['request']));
      expect(payload['expiresAt'], result.plan['payload']['expiresAt']);
      expect(h.reviewCalls, 1);
    },
  );
  for (var index = 0; index < 10; index++) {
    test(
      'generic planning $index exact frozen WASM/Core plan, preview and binding',
      () async {
        final h = Harness(oracle['cases'][index]), result = await h.run();
        expect(canonical(result.request), canonical(h.request));
        expect(canonical(result.plan), canonical(h.sample['plan']));
        expect(canonical(result.binding), canonical(h.sample['binding']));
        expect(
          canonical(result.plan['payload']['preview']),
          canonical(h.sample['preview']),
        );
        final n =
            (h.request['steps'] as List)
                .where((s) => workflowTransaction(s))
                .length;
        expect(h.normalizes, n);
        expect(h.materialCalls, n);
        expect(h.plans, n);
        expect(h.validates, n);
        expect(
          () => result.plan['payload']['totalFee'] = '1',
          throwsUnsupportedError,
        );
        expect(() => result.materials.clear(), throwsUnsupportedError);
        for (final m in result.materials.values) {
          expect(
            () => m['snapshot']['payload']['chainId'] = 'changed',
            throwsUnsupportedError,
          );
        }
      },
    );
  }
  test('Prepared workflow deadline cannot outlive any child proposal', () async {
    final h = Harness(sample('prepared-typed'));
    final step = (h.request['steps'] as List).firstWhere((s) => s['kind'] == 'preparedTransaction');
    final deadline = h.time.add(const Duration(seconds:10)).toIso8601String();
    step['proposal']['payload']['expiresAt'] = deadline;
    step['proposal']['proposalHash'] = hashJson(step['proposal']['payload']);
    final result = await h.run();
    expect(result.plan['payload']['expiresAt'], deadline);
    expect(result.binding['payload']['expiresAt'], deadline);
    expect(h.materialCalls, 1);
    expect(h.plans, 1);
    expect(h.validates, 1);
  });
  test('Prepared child expiry during reads prevents plan and binding', () async {
    final h = Harness(sample('prepared-typed'));
    final step = (h.request['steps'] as List).firstWhere((s) => s['kind'] == 'preparedTransaction');
    step['proposal']['payload']['expiresAt'] = h.time.add(const Duration(seconds:1)).toIso8601String();
    step['proposal']['proposalHash'] = hashJson(step['proposal']['payload']);
    h.duringMaterial = (_) async { h.time = h.time.add(const Duration(seconds:2)); };
    await expectLater(h.run(), throwsStateError);
    expect(h.materialCalls, 1);
    expect(h.plans, 0);
    expect(h.validates, 0);
  });
  for (var index = 0; index < 14; index++) {
    test('frozen rejected graph or plan $index stays rejected', () async {
      final h = Harness(oracle['invalid'][index]);
      await expectLater(
        h.run(),
        throwsA(anyOf(isA<StateError>(), isA<FormatException>())),
      );
      if (!{'fee-cap', 'duplicate-input'}.contains(h.sample['name'])) {
        expect(h.materialCalls, 0);
        expect(h.reviewCalls, 0);
        expect(h.plans, 0);
      }
    });
  }
  test(
    'independent materials overlap; finish order cannot change approved order',
    () async {
      final h = Harness(sample('native-and-ft')),
          a = Completer<void>(),
          b = Completer<void>();
      h.duringMaterial = (id) => id == 'payment' ? a.future : b.future;
      final result = h.run();
      await Future<void>.delayed(Duration.zero);
      expect(h.materialCalls, 2);
      expect(h.plans, 0);
      b.complete();
      await Future<void>.delayed(Duration.zero);
      expect(h.plans, 0);
      a.complete();
      expect(canonical((await result).plan), canonical(h.sample['plan']));
    },
  );
  test(
    'revocation during parallel reads drains without planning or producing authority',
    () async {
      final h = Harness(sample('native-and-ft')),
          a = Completer<void>(),
          b = Completer<void>();
      h.duringMaterial = (id) => id == 'payment' ? a.future : b.future;
      final result = h.run();
      final check = expectLater(result, throwsStateError);
      await Future<void>.delayed(Duration.zero);
      h.current = false;
      a.complete();
      b.complete();
      await check;
      expect(h.plans, 0);
      expect(h.validates, 0);
    },
  );
  test('expiry while loading is checked before Engine plan', () async {
    final h = Harness(sample('native-message'));
    h.duringMaterial = (_) async {
      h.time = h.time.add(const Duration(minutes: 3));
    };
    await expectLater(h.run(), throwsStateError);
    expect(h.plans, 0);
  });
  for (final which in ['hash', 'account', 'chain', 'time']) {
    test('material $which substitution is not accepted', () async {
      final h = Harness(sample('native-message'));
      h.mutateMaterial = (m) {
        final p = m['snapshot']['payload'];
        if (which == 'hash') m['snapshot']['snapshotHash'] = '0' * 64;
        if (which == 'account')
          p['account']['address'] = '1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP';
        if (which == 'chain') p['chainId'] = 'tbc:mainnet';
        if (which == 'time') p['capturedAt'] = '2026-10-14T00:00:00Z';
        if (which != 'hash') m['snapshot']['snapshotHash'] = hashJson(p);
      };
      await expectLater(h.run(), throwsStateError);
      expect(h.plans, 0);
    });
  }
  test(
    'Engine plan substitution or failed validation is not accepted',
    () async {
      for (final which in ['plan', 'validate']) {
        final h = Harness(sample('native-message'));
        h.mutateEngine = (m, r) {
          if (m == which) {
            if (m == 'plan')
              r['plan']['payload']['accountId'] = 'forged';
            else
              r['valid'] = false;
          }
        };
        await expectLater(h.run(), throwsStateError);
      }
    },
  );
  test('optional fields cannot be present with null or wrong types', () async {
    for (final field in [
      'clientRequestId',
      'failureMode',
      'expiresAt',
      'maxTotalFee',
    ]) {
      final h = Harness(sample('messages-no-chain'));
      h.request[field] = null;
      await expectLater(h.run(), throwsStateError);
      expect(h.normalizes, 0);
      expect(h.materialCalls, 0);
    }
    for (final field in ['bindings', 'message']) {
      final h = Harness(sample('messages-no-chain'));
      h.request['steps'][0][field] = null;
      await expectLater(h.run(), throwsStateError);
    }
  });
  test('ciphertext and message wire bounds are distinct', () {
    final h = Harness(sample('five-mixed-kinds'));
    h.request['steps'][4]['ciphertext'] = base64Encode(List.filled(131136, 0));
    // Maximum encrypted payload is larger than the plaintext message bound.
    expect(
      checkedWorkflowRequest(
        method: h.sample['method'],
        input: h.request,
        origin: h.sample['context']['origin'],
        now: h.time,
      )['steps'],
      hasLength(5),
    );
    h.request['steps'][4]['ciphertext'] = 'AA==';
    expect(
      () => checkedWorkflowRequest(
        method: h.sample['method'],
        input: h.request,
        origin: h.sample['context']['origin'],
        now: h.time,
      ),
      throwsStateError,
    );
  });
  test(
    'unrequested accounts and absent controller are rejected before reads',
    () async {
      final missing = Harness(sample('controller-message'));
      missing.sample['accounts'] = [missing.sample['account']];
      await expectLater(missing.run(), throwsStateError);
      expect(missing.materialCalls, 0);
      final extra = Harness(sample('native-message'));
      extra.sample['accounts'] = sample('controller-message')['accounts'];
      await expectLater(extra.run(), throwsStateError);
      expect(extra.materialCalls, 0);
    },
  );
  test('workflow child permissions remain distinct from the batch grant', () {
    expect(workflowRequiredPermissions(sample('five-mixed-kinds')['request']), {
      'tbc_signWorkflow',
      'tbc_signTransaction',
      'tbc_signMessage',
      'tbc_signTypedData',
      'tbc_crypto',
    });
  });
  test(
    'input-only collision scan agrees with transaction decoder for concrete inputs',
    () {
      for (final c in oracle['cases']) {
        for (final p in c['plan']['payload']['transactionPlans']) {
          for (final tx in p['plan']['payload']['transactions']) {
            final raw = tx['unsignedTransaction'];
            expect(plannedInputOutpoints(raw).toList(), [
              for (final i in inspectTransaction(raw)['inputs'])
                if (i['txid'] != '0' * 64) '${i['txid']}:${i['vout']}',
            ]);
          }
        }
      }
    },
  );
}
