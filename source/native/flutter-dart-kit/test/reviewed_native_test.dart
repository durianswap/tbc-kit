import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_native.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_status.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_preview.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_keyless.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_htlc_witness.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';

const address = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
    publicKey =
        '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const account = {
  'chainId': 'tbc:testnet',
  'address': address,
  'publicKey': publicKey,
  'accountId': 'tbc:testnet:$address',
};
String wire(Map tx) {
  List<int> le(BigInt n, int count) => [
    for (var i = 0; i < count; i++) ((n >> (i * 8)) & BigInt.from(255)).toInt(),
  ];
  List<int> script(String s) => [...compactSize(s.length ~/ 2), ...unhex(s)];
  return hex([
    ...le(BigInt.from(10), 4),
    ...compactSize((tx['inputs'] as List).length),
    for (final i in tx['inputs']) ...[
      ...unhex(i['txid']).reversed,
      ...le(BigInt.from(i['vout']), 4),
      ...script(i['scriptSig']),
      ...le(BigInt.from(i['sequence']), 4),
    ],
    ...compactSize((tx['outputs'] as List).length),
    for (final o in tx['outputs']) ...[
      ...le(BigInt.parse(o['satoshis']), 8),
      ...script(o['scriptPubKey']),
    ],
    ...le(BigInt.from(tx['locktime']), 4),
  ]);
}

void main() {
  final preview = jsonDecode(
        File('test/fixtures/reviewed-preview.json').readAsStringSync(),
      ),
      extra = jsonDecode(
        File('test/fixtures/reviewed-native-lock.json').readAsStringSync(),
      ),
      samples = <Map>[
        ...(preview['cases'] as List).cast<Map>().where(
          (s) => (s['defaultReview']['preview']['transactions'] as List).every(
            (t) => {
              'tbc',
              'tbc-timelock',
              'tbc-htlc',
            }.contains(t['classification']['protocol']),
          ),
        ),
        ...(extra['cases'] as List).cast<Map>(),
      ];
  late ComputeProbe engine;
  setUpAll(() {
    final lib =
        jsonDecode(
          File('test/fixtures/signing/replay.json').readAsStringSync(),
        )['library'];
    expect(
      sha256.convert(File(lib['path']).readAsBytesSync()).toString(),
      lib['sha256'],
    );
    engine = ComputeProbe(DynamicLibrary.open(lib['path']));
  });
  Map<String, dynamic> keyless(String method, Map<String, dynamic> input) =>
      copied(jsonDecode(engine.call('keyless', method, canonical(input))));
  Future<Map<String, dynamic>> review(
    Map s, {
    Map? request,
    Map selectedAccount = account,
    List<Map>? trace,
    void Function(List<Map<String, dynamic>>)? mutateStatus,
  }) async {
    final material = normalizeReviewedMaterial(request ?? s['request']),
        plan = ReviewedRawPlan.fromMaterial(material),
        status = ReviewedStatusReader(
          plan: plan,
          requireCurrent: () {},
          status: (points) async {
            trace?.add({
              'path': '/api/tbc/txo/status',
              'body': {'txos': points},
            });
            final rows =
                points
                    .map(
                      (p) => copied(
                        (s['statuses'] as List).singleWhere(
                          (v) =>
                              v['txid'] == p['txid'] &&
                              v['index'] == '${p['index']}',
                        ),
                      ),
                    )
                    .toList();
            mutateStatus?.call(rows);
            return {'txos': rows};
          },
        );
    final verified = await status.readInputs(),
        rows = reviewNativeTransactions(
          plan: plan,
          status: status,
          verifiedInputs: verified,
          material: material,
          account: selectedAccount,
          chainId: 'tbc:testnet',
          transactionIndexes: List.generate(plan.transactions.length, (i) => i),
        ),
        structured = {'transactions': rows.values.toList()},
        policy = status.policyMaterial();
    checkReviewedIssuancePolicy(
      plan: plan,
      policyMaterial: policy,
      keyless: keyless,
    );
    return {
      'preview': structured,
      'policyMaterial': policy,
      'artifact': bindReviewedArtifact(
        plan: plan,
        structuredPreview: structured,
        policyMaterial: policy,
        now: DateTime.parse('2026-10-13T00:00:00.123Z'),
      ),
    };
  }

  Map changed(Map s, void Function(Map) change) {
    final request = copied(s['request']);
    final tx = inspectTransaction(
      request['payload']['transactions'][0]['rawTransaction'],
    );
    change(tx);
    request['payload']['transactions'][0]['rawTransaction'] = wire(tx);
    return request;
  }

  for (final s in samples)
    test(
      '${s['name']} full Standard review hash and one-read parity',
      () async {
        final trace = <Map>[], actual = await review(s, trace: trace);
        expect(canonical(actual['artifact']), canonical(s['review']));
        expect(
          canonical(actual['policyMaterial']),
          canonical(s['defaultReview']['policyMaterial']),
        );
        expect(canonical(trace), canonical(s['reads']));
        expect(trace, hasLength(1));
        if ((s['name'] as String).contains('timelock') ||
            (s['name'] as String).contains('htlc'))
          expect(
            canonical(actual['preview']),
            canonical(s['defaultReview']['preview']),
          );
        final secret = s['publicFixturePreimage'];
        if (secret != null)
          expect(canonical(actual['artifact']), isNot(contains(secret)));
        if (s['stages'] != null) {
          final material = ReviewedKeylessMaterial(
                normalizeReviewedMaterial(s['request']),
                actual['policyMaterial'],
              ),
              parents = <String>[];
          for (var i = 0; i < (s['stages'] as List).length; i++) {
            final recorded = s['stages'][i],
                stage = ReviewedKeylessStage.prepare(
                  keyless: keyless,
                  material: material,
                  publicKey: publicKey,
                  transactionIndex: i,
                  previousTransactions: parents,
                );
            expect(canonical(stage.value), canonical(recorded['stage']));
            final finalResult = stage.finalize(
              keyless,
              (recorded['signatures'] as List).cast<String>(),
            );
            expect(canonical(finalResult), canonical(recorded['finalized']));
            parents.add(finalResult['txraw']);
          }
        }
      },
    );
  final native = samples.firstWhere((s) => s['name'] == 'raw-transfer-single'),
      time = samples.firstWhere((s) => s['name'] == 'raw-timelock-unlock-one'),
      htlc = samples.firstWhere(
        (s) => s['name'] == 'raw-htlc-native-claim-before-refund-height',
      ),
      claim = samples.firstWhere(
        (s) => s['name'] == 'associated-htlc-native-claim-before-refund-height',
      ),
      refund = samples.firstWhere(
        (s) => s['name'] == 'associated-htlc-native-refund-height-equality',
      );
  test(
    'native fee owner is required; foreign account cannot authorize unsigned raw',
    () async {
      final other = {
        'chainId': 'tbc:testnet',
        'address': '1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',
        'accountId': 'tbc:testnet:1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',
        'publicKey':
            '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
      };
      for (final s in [native, time])
        await expectLater(review(s, selectedAccount: other), throwsStateError);
    },
  );
  test(
    'native unknown output never falls through to ordinary transfer',
    () async {
      for (final script in ['51', '6a', '76a914${'22' * 20}88ad'])
        await expectLater(
          review(
            native,
            request: changed(
              native,
              (tx) => tx['outputs'][0]['scriptPubKey'] = script,
            ),
          ),
          throwsStateError,
        );
    },
  );
  test(
    'TimeLock review requires lock height and nonfinal sequence, not just script marker',
    () async {
      for (final edit in <void Function(Map)>[
        (tx) => tx['locktime'] = 0,
        (tx) => tx['locktime'] = 500000000,
        (tx) => tx['inputs'][0]['sequence'] = 0xffffffff,
        (tx) => tx['inputs'][0]['scriptSig'] = '00',
      ])
        await expectLater(
          review(time, request: changed(time, edit)),
          throwsStateError,
        );
    },
  );
  test(
    'HTLC raw terms remain unresolved without inventing claim or refund',
    () async {
      final actual = await review(htlc),
          terms = actual['artifact']['payload']['preview']['htlcLocks'] as List;
      expect(terms.single['branch'], 'unresolved');
      expect(terms.single['preimageVerified'], false);
      expect(terms.single['chainMaturityChecked'], false);
      expect(terms.single['scriptExecutionVerified'], false);
    },
  );
  Map associatedTime(String profile, {String? template}) {
    final row = time['request']['payload']['transactions'][0],
        tx = inspectTransaction(row['rawTransaction']);
    return {
      'payload': {
        'format': 'associated',
        'sourceTransaction': row['rawTransaction'],
        'sourceInputs': [
          for (var i = 0; i < (tx['inputs'] as List).length; i++)
            {
              'txid': tx['inputs'][i]['txid'],
              'outputIndex': tx['inputs'][i]['vout'],
              ...copied(row['inputs'][i]),
              'signingProfile': profile,
              if (template != null) 'unlockingScriptTemplate': template,
            },
        ],
        'children': [],
      },
    };
  }

  for (final profile in ['p2pkh', 'contract-template'])
    test(
      'TimeLock associated $profile preserves bound review and digest',
      () async {
        final request = associatedTime(
              profile,
              template:
                  profile == 'contract-template'
                      ? '097369676e617475726521$publicKey'
                      : null,
            ),
            actual = await review(time, request: request),
            raw = await review(time);
        expect(canonical(actual['artifact']), canonical(raw['artifact']));
        final stage = ReviewedKeylessStage.prepare(
              keyless: keyless,
              material: ReviewedKeylessMaterial(
                normalizeReviewedMaterial(request),
                actual['policyMaterial'],
              ),
              publicKey: publicKey,
              transactionIndex: 0,
              previousTransactions: [],
            ),
            rawStage = ReviewedKeylessStage.prepare(
              keyless: keyless,
              material: ReviewedKeylessMaterial(
                normalizeReviewedMaterial(time['request']),
                raw['policyMaterial'],
              ),
              publicKey: publicKey,
              transactionIndex: 0,
              previousTransactions: [],
            );
        expect(
          canonical(stage.value['digests']),
          canonical(rawStage.value['digests']),
        );
      },
    );
  test('TimeLock associated template cannot append hidden opcodes', () async {
    await expectLater(
      review(
        time,
        request: associatedTime(
          'contract-template',
          template: '097369676e617475726521${publicKey}51',
        ),
      ),
      throwsStateError,
    );
  });
  test(
    'HTLC associated claim warning reveals no secret in public artifact',
    () async {
      final actual = await review(claim),
          p = actual['artifact']['payload']['preview'];
      expect(
        p['warnings'],
        contains('HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE'),
      );
      expect(p['htlcLocks'][0]['branch'], 'claim');
      expect(p['htlcLocks'][0]['preimageVerified'], true);
      expect(canonical(p), isNot(contains(claim['publicFixturePreimage'])));
      expect(canonical(p), isNot(contains('unfinishedScriptSig')));
    },
  );
  test(
    'associated witness mutation rejects locally and in unchanged Native',
    () async {
      final source =
          claim['request']['payload']['sourceInputs'][0]['unlockingScriptTemplate']
              as String;
      final templates = [
        source + '51',
        source.substring(0, 88) + '4c20' + source.substring(90),
        source.replaceFirst(claim['publicFixturePreimage'], '34' * 32),
        source.substring(0, 88) + '00',
        '097369676e6174757265',
      ];
      for (final template in templates) {
        final request = copied(claim['request']);
        request['payload']['sourceInputs'][0]['unlockingScriptTemplate'] =
            template;
        try {
          await review(claim, request: request);
          fail('accepted invalid witness');
        } on StateError catch (e) {
          expect(e.toString(), isNot(contains(claim['publicFixturePreimage'])));
        }
        final material = normalizeReviewedMaterial(request),
            result = keyless('prepareReviewedStage', {
              'format': 'associated',
              'request': material['request'],
              'publicKey': publicKey,
              'transactionIndex': 0,
              'previousTransactions': [],
              'resolvedOutputs':
                  claim['defaultReview']['policyMaterial']['resolvedOutputs'],
            });
        expect(result.containsKey('error'), true);
      }
    },
  );
  test(
    'associated refund refuses final sequence and earlier/different-domain lock',
    () async {
      for (final mutate in <void Function(Map)>[
        (tx) => tx['locktime'] = 0,
        (tx) => tx['locktime'] = 500000000,
        (tx) => tx['inputs'][0]['sequence'] = 0xffffffff,
      ]) {
        final request = copied(refund['request']),
            tx = inspectTransaction(request['payload']['sourceTransaction']);
        mutate(tx);
        request['payload']['sourceTransaction'] = wire(tx);
        await expectLater(review(refund, request: request), throwsStateError);
      }
    },
  );
  test(
    'dependent native lock and refund reuses local parent without extra status',
    () async {
      final s = samples.firstWhere(
            (s) => s['name'] == 'associated-native-lock-then-refund',
          ),
          trace = <Map>[];
      final result = await review(s, trace: trace);
      expect(trace, hasLength(1));
      expect(result['artifact']['payload']['preview']['transactionCount'], 2);
      expect(
        result['artifact']['payload']['preview']['htlcLocks'].last['branch'],
        'refund',
      );
    },
  );
  test(
    'associated P2PKH cannot hide arbitrary contract-template execution',
    () async {
      final s = samples.firstWhere(
            (s) => s['name'] == 'associated-source-only',
          ),
          request = copied(s['request']);
      request['payload']['sourceInputs'][0]['signingProfile'] =
          'contract-template';
      request['payload']['sourceInputs'][0]['unlockingScriptTemplate'] =
          '097369676e617475726521${publicKey}51';
      await expectLater(review(s, request: request), throwsStateError);
    },
  );
  test('HTLC minimal preimage push boundaries agree with frozen Native', () {
    final witness = claim['witnessCheck'] as Map;
    for (final bytes in <List<int>>[
      [],
      [1],
      [0x81],
      [0],
      List.filled(75, 0x22),
      List.filled(76, 0x22),
      List.filled(255, 0x22),
      List.filled(256, 0x22),
      List.filled(65535 - 111, 0x22),
    ]) {
      final n = bytes.length;
      final push =
          n == 0
              ? '00'
              : n == 1 && (bytes[0] == 0x81 || bytes[0] >= 1 && bytes[0] <= 16)
              ? hex([bytes[0] == 0x81 ? 0x4f : 0x50 + bytes[0]])
              : hex([
                if (n <= 75)
                  n
                else if (n <= 255) ...[
                  76,
                  n,
                ] else ...[
                  77,
                  n & 255,
                  n >> 8,
                ],
                ...bytes,
              ]);
      final hash = sha256.convert(bytes).toString(),
          script = (witness['script'] as String).replaceRange(6, 70, hash),
          template = '097369676e617475726521$publicKey${push}51';
      final actual = inspectAssociatedHtlcWitness(
        script: script,
        template: template,
        accountAddress: address,
        sequence: witness['sequence'],
        transactionLockTime: witness['transactionLockTime'],
      );
      expect(actual, {'branch': 'claim', 'preimageVerified': true});
      final material = normalizeReviewedMaterial(claim['request']),
          input = material['request']['sourceUtxos'][0];
      final request = copied(material['request']);
      request['sourceUtxos'][0] = {
        ...input,
        'script': script,
        'unfinishedScriptSig': template,
      };
      final result = keyless('prepareReviewedStage', {
        'format': 'associated',
        'request': request,
        'publicKey': publicKey,
        'transactionIndex': 0,
        'previousTransactions': [],
        'resolvedOutputs': [],
      });
      expect(result.containsKey('digests'), true, reason: 'boundary $n');
    }
  });
  test('HTLC oversized or extra-opcode witness errors do not echo payload', () {
    final w = claim['witnessCheck'] as Map;
    for (final t in [
      '${w['template']}00',
      '097369676e617475726521$publicKey${'22' * 65535}51',
    ]) {
      try {
        inspectAssociatedHtlcWitness(
          script: w['script'],
          template: t,
          accountAddress: address,
          sequence: w['sequence'],
          transactionLockTime: w['transactionLockTime'],
        );
        fail('accepted invalid witness');
      } on StateError catch (e) {
        expect(e.message, 'REVIEWED_HTLC_WITNESS');
      }
    }
  });
}
