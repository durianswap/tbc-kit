// Frozen Core/DApp/WASM oracle replay with actual Native Engine validation.
// No keys, network or broadcasts; native adapter/device promotion is separate.
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/prepared_proposal.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'native_signing_test.dart' show FixtureOperation;

TbcAccount _account(Map a) => TbcAccount(
  network:
      a['chainId'] == 'tbc:mainnet' ? TbcNetwork.mainnet : TbcNetwork.testnet,
  address: a['address'],
  publicKey: a['publicKey'],
);

final class _Operation extends FixtureOperation
    implements TbcTransactionSigningRoles {
  _Operation(super.sample);
  int resolutions = 0;
  @override
  Future<List<TbcAccount>> resolveSigningAccounts(
    TbcBoundedSigningIntent intent,
  ) async {
    await requireCurrent();
    resolutions++;
    expect(canonical(intent.request), canonical(sample['request']));
    return (sample['audit']['material']['snapshot']['payload']['signingAccounts']
            as List)
        .map((a) => _account(a))
        .toList();
  }

  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial value) async {
    await requireCurrent();
    binds++;
    expect(consents, 1);
    expect(canonical(value.binding), canonical(audit['binding']));
    expect(canonical(value.preview), canonical(audit['preview']));
    expect(canonical(value.plan), canonical(audit['plan']));
    expect(value.envelope, null);
    expect(canonical(consent!.request), canonical(sample['request']));
    boundPlanHash = value.plan!['planHash'];
    receipt = TbcSigningReceipt(audit['approval']);
    return receipt!;
  }
}

final class _Harness {
  _Harness(Map s, this.engine) : sample = copied(s) {
    now = protocolTime(s['now']);
  }
  final Map<String, dynamic> sample;
  final ComputeProbe engine;
  late DateTime now;
  bool unlocked = true, authorized = true;
  int preparations = 0;
  final phases = <String>[];
  final preparedRequests = <Map>[];
  Future<void> Function()? duringPrepare;
  late final operation = _Operation(sample);
  Future<Map<String, dynamic>> _prepare(
    Map<String, dynamic> request,
    Map<String, dynamic> account,
  ) async {
    preparations++;
    preparedRequests.add(request);
    expect(request.containsKey('proposal'), false);
    expect(
      canonical(request),
      canonical(sample['audit']['material']['request']),
    );
    expect(canonical(account), canonical(sample['account']));
    await duringPrepare?.call();
    return copied(sample['audit']['material']);
  }

  late final executor = TbcSigningExecutor(
    engine: engine,
    signer: operation,
    authority: TbcOperationAuthority(
      context: sample['context'],
      account: _account(sample['account']),
      requireAuthorized: (method) {
        need(authorized && method == sample['method'], 'TEST_PERMISSION');
      },
      isUnlocked: () => unlocked,
      clock: () => now,
    ),
    prepareMaterial: _prepare,
    prepareRoleMaterial: (r, a, roles) async {
      expect(
        canonical(roles),
        canonical(
          sample['audit']['material']['snapshot']['payload']['signingAccounts'],
        ),
      );
      return _prepare(r, a);
    },
    timing: (phase, _) => phases.add(phase),
  );
  Future<Map<String, dynamic>> execute() =>
      executor.execute(sample['method'], sample['request']);
}

void main() {
  final fixture =
      jsonDecode(File('test/fixtures/prepared-signing.json').readAsStringSync())
          as Map;
  final cases = fixture['cases'] as List;
  late ComputeProbe engine;
  setUpAll(() {
    final library =
        jsonDecode(
          File('test/fixtures/signing/replay.json').readAsStringSync(),
        )['library'];
    expect(
      sha256.convert(File(library['path']).readAsBytesSync()).toString(),
      library['sha256'],
    );
    engine = ComputeProbe(DynamicLibrary.open(library['path']));
  });
  _Harness h([int i = 0]) => _Harness(cases[i], engine);
  for (var i = 0; i < cases.length; i++) {
    test(
      'Prepared ${cases[i]['name']} exact frozen Core binding, Native/WASM bytes and one shared lifecycle',
      () async {
        final test = h(i), result = await test.execute(), op = test.operation;
        expect(canonical(result), canonical(cases[i]['result']));
        expect(
          [test.preparations, op.consents, op.binds, op.closes],
          [1, 1, 1, 1],
        );
        expect(op.signs, cases[i]['audit']['tasks'].length);
        expect(op.advances, cases[i]['audit']['stages'].length - 1);
        expect(
          op.resolutions,
          cases[i]['request']['signingRoles'] == null ? 0 : 1,
        );
        expect(test.phases.where((p) => p == 'plan'), hasLength(1));
        expect(test.phases.where((p) => p == 'validate:plan'), hasLength(1));
        expect(
          test.phases.where((p) => p == 'validate:pre-sign'),
          hasLength(1),
        );
        expect(
          test.phases.where((p) => p == 'validate:finalized'),
          hasLength(op.advances + 1),
        );
        expect(
          canonical(
            preparedProposalTransactions(
              cases[i]['audit']['plan']['payload']['transactions'],
            ),
          ),
          canonical(cases[i]['request']['proposal']['payload']['transactions']),
        );
      },
    );
  }
  for (final invalid in fixture['invalid'] as List) {
    test('Prepared ${invalid['name']} cannot bind or sign', () async {
      final test = h();
      test.sample['request'] = copied(invalid['request']);
      await expectLater(test.execute(), throwsA(isA<TbcPreparedRefused>()));
      expect(
        [test.operation.binds, test.operation.signs, test.operation.closes],
        [0, 0, 1],
      );
      if (invalid['schema'] == false ||
          [
            'hash-mismatch',
            'expired',
            'reversed-window',
          ].contains(invalid['name'])) {
        expect(test.operation.consents, 0);
        expect(test.preparations, 0);
      }
    });
  }
  test(
    'Prepared prefetch starts before consent and shares one pending result',
    () async {
      final test = h(),
          entered = Completer<void>(),
          release = Completer<void>();
      test.duringPrepare = () async {
        entered.complete();
        await release.future;
      };
      test.operation.duringConsent = () async {
        await entered.future;
        expect(test.operation.signs, 0);
        release.complete();
      };
      await test.execute();
      expect(test.preparations, 1);
      expect(test.operation.consents, 1);
    },
  );
  test('Prepared rejection never binds or signs', () async {
    final test = h();
    test.operation.approve = false;
    await expectLater(test.execute(), throwsA(isA<TbcSigningRejected>()));
    expect(
      [test.operation.binds, test.operation.signs, test.operation.closes],
      [0, 0, 1],
    );
  });
  test('Prepared cancellation during consent cannot sign', () async {
    final test = h();
    test.operation.duringConsent = () async {
      test.operation.active = false;
    };
    await expectLater(test.execute(), throwsA(isA<StateError>()));
    expect(test.operation.signs, 0);
  });
  test('Prepared expiry while preparing cannot bind', () async {
    final test = h();
    test.operation.duringConsent = () async {
      test.now = protocolTime(
        test.sample['request']['proposal']['payload']['expiresAt'],
      );
    };
    await expectLater(test.execute(), throwsA(isA<StateError>()));
    expect(test.operation.binds, 0);
    expect(test.operation.signs, 0);
  });
  test(
    'Prepared bound controller identity is not implicitly primary',
    () async {
      final test = h(
        cases.indexWhere((c) => c['request']['signingRoles'] != null),
      );
      test.operation.duringConsent = () async {
        test.authorized = false;
      };
      await expectLater(test.execute(), throwsA(isA<StateError>()));
      expect(test.operation.resolutions, 1);
      expect(test.operation.signs, 0);
    },
  );
  test(
    'Prepared child signing stops when native authority is revoked',
    () async {
      final test = h(cases.indexWhere((c) => c['audit']['stages'].length > 1));
      test.operation.duringAdvance = () async {
        test.operation.active = false;
      };
      await expectLater(test.execute(), throwsA(isA<StateError>()));
      expect(
        test.operation.signs,
        test.sample['audit']['stages'][0]['tasks'].length,
      );
      expect(test.operation.consents, 1);
      expect(test.preparations, 1);
    },
  );
  test(
    'Prepared returned signature mutation fails actual Engine verification',
    () async {
      final test = h();
      test.operation.alterSignature = (s) {
        s['signature'] = '00' * 64;
      };
      await expectLater(test.execute(), throwsA(isA<StateError>()));
      expect(test.operation.signs, 1);
    },
  );
  test(
    'Prepared original input mutation after capture cannot change binding',
    () async {
      final test = h();
      final request = test.sample['request'];
      // Restore only the assertion harness view; the actual caller-owned map is
      // left mutated. The captured request in consent/binding must stay original.
      final expected = copied(test.sample['request']);
      test.operation.duringConsent = () async {
        request['proposal']['payload']['estimatedTotalFee'] = '0';
        test.sample['request'] = expected;
      };
      expect(canonical(await test.execute()), canonical(test.sample['result']));
      expect(request['proposal']['payload']['estimatedTotalFee'], '0');
    },
  );
  test(
    'Prepared independently observed wallet timestamp need not equal DApp timestamp',
    () {
      final s = cases[0], snapshot = copied(s['audit']['material']['snapshot']);
      snapshot['payload']['capturedAt'] = '2026-10-12T12:00:01.123Z';
      snapshot['snapshotHash'] = hashJson(snapshot['payload']);
      assertPreparedProposalForPlan(s['request'], snapshot, s['audit']['plan']);
    },
  );
  test(
    'Prepared plan structural parser rejects malformed canonical framing',
    () {
      final plan = cases[0]['audit']['plan']['payload']['transactions'] as List;
      for (final raw in [
        '00',
        '${plan[0]['unsignedTransaction']}00',
        (plan[0]['unsignedTransaction'] as String).replaceRange(
          8,
          10,
          'fd0100',
        ),
        (plan[0]['unsignedTransaction'] as String).replaceRange(
          0,
          8,
          '01000000',
        ),
      ]) {
        final bad = copied(plan[0]);
        bad['unsignedTransaction'] = raw;
        expect(
          () => preparedProposalTransactions([bad]),
          throwsA(isA<StateError>()),
        );
      }
    },
  );
  test(
    'Prepared deferred edges cannot be reordered, duplicated or forward-referenced',
    () {
      final s = cases.firstWhere((c) => c['audit']['stages'].length > 1);
      final originals = s['audit']['plan']['payload']['transactions'] as List;
      final transactions = originals.map((t) => copied(t)).toList();
      final i = transactions.indexWhere(
        (t) => (t['dependsOn'] as List).isNotEmpty,
      );
      final projected = preparedProposalTransactions(originals);
      transactions[i]['deferredInputs'] = [...projected[i]['deferredInputs']];
      expect(
        canonical(preparedProposalTransactions(transactions)),
        canonical(projected),
      );
      final edge = copied(transactions[i]['deferredInputs'][0]);
      edge['sourceOutputIndex']++;
      transactions[i]['deferredInputs'][0] = edge;
      expect(
        () => preparedProposalTransactions(transactions),
        throwsA(isA<StateError>()),
      );
      transactions[i] = copied(originals[i]);
      transactions[i]['dependsOn'] = ['missing'];
      expect(
        () => preparedProposalTransactions(transactions),
        throwsA(isA<StateError>()),
      );
    },
  );
  test(
    'Prepared boundary projection is immutable and does not carry evidence to readers',
    () {
      final request = copied(cases[0]['request']);
      final projected = checkedPreparedRequest(
        request,
        protocolTime(cases[0]['now']),
      );
      request['intent']['amount'] = '999';
      expect(projected.containsKey('proposal'), false);
      expect(
        projected['intent']['amount'],
        cases[0]['request']['intent']['amount'],
      );
      expect(() => projected['from'] = 'changed', throwsUnsupportedError);
    },
  );
  test(
    'Two zero placeholders can target different parents at the same vout, never the same output twice',
    () {
      String raw(List<String> ids) =>
          '0a000000${ids.length.toRadixString(16).padLeft(2, '0')}'
          '${ids.map((id) => '${id}0000000000ffffffff').join()}010100000000000000015100000000';
      Map<String, dynamic> tx(
        String id,
        List<String> parents,
        List<String> inputs,
      ) => {
        'id': id,
        'role': 'primary',
        'dependsOn': parents,
        'fee': '1',
        'unsignedTransaction': raw(inputs),
      };
      final transactions = [
        tx('a', [], ['11' * 32]),
        tx('b', [], ['22' * 32]),
        tx('child', ['a', 'b'], ['00' * 32, '00' * 32]),
      ];
      final projected = preparedProposalTransactions(transactions);
      expect(projected[2]['deferredInputs'], [
        {'inputIndex': 0, 'sourceTransactionId': 'a', 'sourceOutputIndex': 0},
        {'inputIndex': 1, 'sourceTransactionId': 'b', 'sourceOutputIndex': 0},
      ]);
      transactions[2]['deferredInputs'] = [
        ...projected[2]['deferredInputs'].reversed,
      ];
      expect(
        () => preparedProposalTransactions(transactions),
        throwsA(isA<StateError>()),
      );
      transactions[2]['deferredInputs'] = [
        {'inputIndex': 0, 'sourceTransactionId': 'a', 'sourceOutputIndex': 0},
        {'inputIndex': 1, 'sourceTransactionId': 'a', 'sourceOutputIndex': 0},
      ];
      expect(
        () => preparedProposalTransactions(transactions),
        throwsA(isA<StateError>()),
      );
    },
  );
  test(
    'Prepared contract identity tuple and bounds cannot be partially asserted',
    () {
      final s = cases.firstWhere(
        (c) => c['request']['proposal']['payload']['evidence']['contracts'].any(
          (x) => x['standardId'] != null,
        ),
      );
      for (final change in <void Function(Map)>[
        (r) =>
            r['proposal']['payload']['transactions'] = List.filled(
              33,
              r['proposal']['payload']['transactions'][0],
            ),
        (r) =>
            r['proposal']['payload']['evidence']['contracts'][0]['protocolVersion'] =
                'wrong',
        (r) => r['proposal']['payload']['evidence']['contracts'][0].remove(
          'standardId',
        ),
        (r) =>
            r['proposal']['payload']['evidence']['contracts'][0]['genesisOutpoint']['vout'] =
                1,
        (r) =>
            r['proposal']['payload']['evidence']['contracts'][0]['templateRevision'] =
                '00' * 32,
        (r) =>
            r['proposal']['payload']['transactions'][0]['role'] = 'primary\n',
      ]) {
        final request = copied(s['request']);
        change(request);
        request['proposal']['proposalHash'] = hashJson(
          request['proposal']['payload'],
        );
        expect(
          () => checkedPreparedRequest(request, protocolTime(s['now'])),
          throwsA(isA<TbcPreparedRefused>()),
        );
      }
    },
  );
}
