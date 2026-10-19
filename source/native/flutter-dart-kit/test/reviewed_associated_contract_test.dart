import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_reviewer.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_keyless.dart';

void main() {
  final cases =
      (jsonDecode(
                File(
                  'test/fixtures/reviewed-associated-contract.json',
                ).readAsStringSync(),
              )['cases']
              as List)
          .cast<Map>();
  late ComputeProbe native;
  setUpAll(() {
    final lib =
        jsonDecode(
          File('test/fixtures/signing/replay.json').readAsStringSync(),
        )['library'];
    expect(
      sha256.convert(File(lib['path']).readAsBytesSync()).toString(),
      lib['sha256'],
    );
    native = ComputeProbe(DynamicLibrary.open(lib['path']));
  });
  Map<String, dynamic> keyless(String method, Map<String, dynamic> args) =>
      copied(jsonDecode(native.call('keyless', method, canonical(args))));
  Future<ReviewedTransactionResult> review(
    Map s, {
    Map? request,
    List<Map>? reads,
  }) {
    final reviewer = ReviewedTransactionReviewer(
      chainId: 'tbc:testnet',
      keyless: keyless,
      now: () => DateTime.parse('2026-10-13T00:00:00.123Z'),
      readHistory: (_) async => throw StateError('Unexpected history read'),
      status: (points) async {
        reads?.add({
          'path': '/api/tbc/txo/status',
          'body': {'txos': points},
        });
        return {
          'txos': [
            for (final p in points)
              copied(
                (s['statuses'] as List).singleWhere(
                  (u) =>
                      u['txid'] == p['txid'] && u['index'] == '${p['index']}',
                ),
              ),
          ],
        };
      },
      read: (path) async {
        reads?.add({'path': path});
        expect(s['replies'].containsKey(path), true);
        return copied(s['replies'][path]);
      },
    );
    return reviewer.review(
      request: request ?? s['request'],
      account: s['account'],
      requireCurrent: () {},
    );
  }

  for (final s in cases) {
    test(
      '${s['name']} exact review, witness, Native/WASM stage and final bytes',
      () async {
        expect(s['stageFailure'], isNull);
        final reads = <Map>[], r = await review(s, reads: reads);
        expect(canonical(r.artifact), canonical(s['review']));
        // Native-only order parser uses display descriptions/numeric satoshis
        // internally; Dart uses normalized rows. Public Standard hash above is
        // exact, as with the existing raw LOP checkpoint.
        final expectedRows =
            s['defaultReview']['preview']['transactions'] as List;
        if (expectedRows.every(
          (t) => t['classification']['description'] == null,
        )) {
          expect(
            canonical(r.preview),
            canonical(s['defaultReview']['preview']),
          );
        } else {
          for (var i = 0; i < expectedRows.length; i++) {
            final actual = r.preview['transactions'][i],
                expected = expectedRows[i];
            expect(actual['txid'], expected['txid']);
            expect(actual['txidKind'], expected['txidKind']);
            expect(actual['feeSatoshis'], '${expected['feeSatoshis']}');
            expect(
              canonical(actual['orderTerms']),
              canonical(expected['orderTerms']),
            );
          }
        }
        expect(
          canonical(r.policyMaterial),
          canonical(s['defaultReview']['policyMaterial']),
        );
        expect(canonical(reads), canonical(s['reads']));
        final owned = ReviewedKeylessMaterial(r.material, r.policyMaterial),
            previous = <String>[];
        for (var i = 0; i < (s['stages'] as List).length; i++) {
          final stage = ReviewedKeylessStage.prepare(
            keyless: keyless,
            material: owned,
            publicKey: s['account']['publicKey'],
            transactionIndex: i,
            previousTransactions: previous,
          );
          expect(canonical(stage.value), canonical(s['stages'][i]['stage']));
          final signed = stage.finalize(
            keyless,
            (s['stages'][i]['signatures'] as List).cast<String>(),
          );
          expect(canonical(signed), canonical(s['stages'][i]['finalized']));
          previous.add(signed['txraw']);
        }
        for (final input in s['request']['payload']['sourceInputs']) {
          final witness = input['unlockingScriptTemplate'];
          if (witness != null)
            expect(canonical(r.artifact), isNot(contains(witness)));
        }
      },
    );
  }
  final claim = cases.firstWhere(
        (s) =>
            s['name'] ==
            'associated-htlc-token-tbc20-standard-claim-before-refund',
      ),
      cancel = cases.firstWhere(
        (s) => s['name'] == 'associated-lop-native-token-ft-cancel-buy',
      ),
      match = cases.firstWhere(
        (s) => s['name'] == 'associated-lop-native-token-ft-match',
      );
  for (final entry
      in <String, Map>{
        'claim': claim,
        'cancel': cancel,
        'match': match,
      }.entries) {
    test(
      '${entry.key} associated fee and token signing profiles cannot be relabelled',
      () async {
        for (final type in ['p2pkh', 'tbc20-standard']) {
          final r = copied(entry.value['request']),
              row = (r['payload']['sourceInputs'] as List).firstWhere(
                (i) => i['signingProfile'] == type,
              );
          row['signingProfile'] = type == 'p2pkh' ? 'ft' : 'p2pkh';
          row.remove('ancestorTransactions');
          await expectLater(review(entry.value, request: r), throwsStateError);
        }
      },
    );
  }
  test('token HTLC bad preimage is refused with payload-free error', () async {
    final r = copied(claim['request']),
        input = (r['payload']['sourceInputs'] as List).firstWhere(
          (i) => i['signingProfile'] == 'contract-template',
        );
    final witness = input['unlockingScriptTemplate'] as String;
    input['unlockingScriptTemplate'] = witness.replaceRange(
      witness.length - 66,
      witness.length - 2,
      '99' * 32,
    );
    try {
      await review(claim, request: r);
      fail('bad preimage accepted');
    } on StateError catch (e) {
      expect(e.toString(), isNot(contains('99' * 32)));
    }
  });
  test('LOP cancellation cannot switch owner branch or public key', () async {
    for (final tail in ['51', '00', '5251']) {
      final r = copied(cancel['request']),
          input = (r['payload']['sourceInputs'] as List).firstWhere(
            (i) => i['signingProfile'] == 'contract-template',
          );
      final w = input['unlockingScriptTemplate'] as String;
      input['unlockingScriptTemplate'] = w.substring(0, w.length - 2) + tail;
      await expectLater(review(cancel, request: r), throwsStateError);
    }
    final r = copied(cancel['request']),
        input = (r['payload']['sourceInputs'] as List).firstWhere(
          (i) => i['signingProfile'] == 'contract-template',
        );
    input['unlockingScriptTemplate'] =
        (input['unlockingScriptTemplate'] as String).replaceFirst(
          cancel['account']['publicKey'],
          '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
        );
    await expectLater(review(cancel, request: r), throwsStateError);
  });
  test('LOP permissionless match rejects private arbitrary template', () async {
    final r = copied(match['request']),
        input = (r['payload']['sourceInputs'] as List).firstWhere(
          (i) => i['signingProfile'] == 'tbc-lop-match',
        );
    input['unlockingScriptTemplate'] = '097369676e617475726551';
    await expectLater(review(match, request: r), throwsStateError);
  });
  test('current associated proof cannot borrow a different parent', () async {
    final r = copied(claim['request']),
        rows = r['payload']['sourceInputs'] as List,
        token = rows.firstWhere((i) => i['signingProfile'] == 'tbc20-standard');
    token['previousTransaction'] =
        cases.first['request']['payload']['sourceTransaction'];
    await expectLater(review(claim, request: r), throwsStateError);
  });
  test('every signing input is covered without inventing a LOP owner task', () {
    final s = match, expected = s['stages'][0]['stage'] as Map;
    final owned = ReviewedKeylessMaterial(
      s['material'],
      s['defaultReview']['policyMaterial'],
    );
    for (final addPermissionless in [false, true]) {
      expect(
        () => ReviewedKeylessStage.prepare(
          keyless: (_, __) {
            final result = copied(expected),
                indexes = result['signingInputIndexes'] as List,
                digests = result['digests'] as List;
            result.remove('signingTasks');
            if (addPermissionless) {
              indexes.add(
                (result['inputs'] as List).indexWhere(
                  (i) => i['scriptSigType'] == 'tbc_lop_match',
                ),
              );
              digests.add(digests.first);
            } else {
              indexes.removeLast();
              digests.removeLast();
            }
            return result;
          },
          material: owned,
          publicKey: s['account']['publicKey'],
          transactionIndex: 0,
          previousTransactions: [],
        ),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'boundary',
            'REVIEWED_SIGNING_INPUT_COVERAGE',
          ),
        ),
      );
    }
  });
  test(
    'LOP finalized signatures must match actual tasks, neither extra nor missing',
    () {
      final s = match,
          sample = s['stages'][0],
          owned = ReviewedKeylessMaterial(
            s['material'],
            s['defaultReview']['policyMaterial'],
          );
      final stage = ReviewedKeylessStage.prepare(
        keyless: keyless,
        material: owned,
        publicKey: s['account']['publicKey'],
        transactionIndex: 0,
        previousTransactions: [],
      );
      for (final extra in [false, true]) {
        expect(
          () => stage.finalize((_, __) {
            final result = copied(sample['finalized']),
                sigs = result['sigs'] as List;
            if (extra) {
              sigs.add(sigs.first);
            } else {
              sigs.removeLast();
            }
            return result;
          }, (sample['signatures'] as List).cast<String>()),
          throwsA(
            isA<StateError>().having(
              (e) => e.message,
              'boundary',
              'REVIEWED_DETACHED_SHAPE',
            ),
          ),
        );
      }
    },
  );
}
