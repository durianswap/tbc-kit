import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_lop.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_lop_terms.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_preview.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_status.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_token.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';

void main() {
  final cases =
      (jsonDecode(
                File('test/fixtures/reviewed-lop.json').readAsStringSync(),
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
  Map<String, dynamic> keyless(String m, Map<String, dynamic> args) =>
      copied(jsonDecode(native.call('keyless', m, canonical(args))));
  Future<Map> review(
    Map s, {
    List<Map>? trace,
    Map? request,
    Map? account,
    void Function(String, Map)? mutateReply,
    void Function(List<Map<String, dynamic>>)? mutateStatus,
    void Function()? requireCurrent,
  }) async {
    final material = normalizeReviewedMaterial(request ?? s['request']),
        plan = ReviewedRawPlan.fromMaterial(material),
        status = ReviewedStatusReader(
          plan: plan,
          requireCurrent: requireCurrent ?? () {},
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
                          (r) =>
                              r['txid'] == p['txid'] &&
                              r['index'] == '${p['index']}',
                        ),
                      ),
                    )
                    .toList();
            mutateStatus?.call(rows);
            return {'txos': rows};
          },
        ),
        verified = await status.readInputs(),
        rows = await reviewLopTransactions(
          plan: plan,
          status: status,
          verifiedInputs: verified,
          material: material,
          account: account ?? s['account'],
          chainId: 'tbc:testnet',
          transactionIndexes: [0],
          codec: ReviewedTokenCodec(keyless),
          keyless: keyless,
          requireCurrent: requireCurrent ?? () {},
          read: (path) async {
            trace?.add({'path': path});
            expect(s['replies'].containsKey(path), true);
            final reply = copied(s['replies'][path]);
            mutateReply?.call(path, reply);
            return reply;
          },
        ),
        policy = status.policyMaterial(),
        structured = {'transactions': rows.values.toList()};
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

  for (final s in cases)
    test(
      '${s['name']} frozen Standard hash, order codec and exact reads',
      () async {
        expect(s.containsKey('refusal'), false);
        final trace = <Map>[], result = await review(s, trace: trace);
        expect(canonical(result['artifact']), canonical(s['review']));
        expect(
          canonical(result['policyMaterial']),
          canonical(s['defaultReview']['policyMaterial']),
        );
        expect(canonical(trace), canonical(s['reads']));
        final input = s['request']['payload']['transactions'][0],
            tx = inspectTransaction(input['rawTransaction']),
            scripts = <String>[
              for (final u in input['inputs']) u['scriptPubKey'],
              for (final o in tx['outputs']) o['scriptPubKey'],
            ],
            actual = keyless('inspectLopMaterial', {
              'phase': 'inspectOrderScripts',
              'scripts': scripts,
            });
        expect(canonical(actual), canonical(s['orders']));
        final decoded = inspectReviewedLopCodes(keyless, scripts);
        for (var i = 0; i < scripts.length; i++) {
          expect(
            canonical(decoded[scripts[i]]?['terms']),
            canonical(s['orders']['orders'][i]),
          );
          expect(
            decoded[scripts[i]]?['controller'],
            s['orders']['controllers'][i],
          );
        }
      },
    );
  final buy = cases.firstWhere(
        (c) => c['name'] == 'raw-lop-native-token-ft-create-buy',
      ),
      coin = cases.firstWhere(
        (c) => c['name'] == 'raw-lop-native-token-coin-create-buy',
      ),
      sell = cases.firstWhere(
        (c) => c['name'] == 'raw-lop-native-token-ft-create-sell',
      );
  test(
    'LOP indexed symbol and balance never change review authority',
    () async {
      final result = await review(
        buy,
        mutateReply: (p, r) {
          r['symbol'] = 'fake';
          r['balance'] = '99999999999999';
          r['decimal'] = 999;
        },
      );
      expect(canonical(result['artifact']), canonical(buy['review']));
    },
  );
  test(
    'LOP wrong indexed Code identity rejects without fallback or ancestry',
    () async {
      final trace = <Map>[];
      await expectLater(
        review(
          buy,
          trace: trace,
          mutateReply:
              (p, r) =>
                  r['code_script'] =
                      '76a914751e76e8199196d454941c45d1b3a323f1433bd688ac',
        ),
        throwsStateError,
      );
      expect(trace.length, 3);
    },
  );
  test('LOP Coin index must name the committed contract', () async {
    await expectLater(
      review(coin, mutateReply: (p, r) => r['stablecoin_id'] = 'ff' * 32),
      throwsStateError,
    );
  });
  test(
    'LOP missing or corrupted input Tape fails before asset metadata',
    () async {
      final trace = <Map>[];
      await expectLater(
        review(
          buy,
          trace: trace,
          mutateStatus: (rows) {
            for (final r in rows)
              if (r['value'] == '0') r['scriptPubKey'] = '006a';
          },
        ),
        throwsStateError,
      );
      expect(trace.every((r) => r['path'] == '/api/tbc/txo/status'), true);
    },
  );
  test(
    'LOP selected fee account mismatch rejects before dependency reads',
    () async {
      final trace = <Map>[],
          other = {
            'chainId': 'tbc:testnet',
            'address': '1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',
            'accountId': 'tbc:testnet:1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',
            'publicKey':
                '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
          };
      await expectLater(
        review(sell, trace: trace, account: other),
        throwsStateError,
      );
      expect(trace.length, 1);
    },
  );
  test(
    'LOP public order terms cannot carry scripts, private data or duplicate positions',
    () async {
      final result = await review(buy),
          original = copied(result['preview']['transactions'][0]['orderTerms']);
      for (final edit in <void Function(Map)>[
        (t) => t['privatePreimage'] = 'never-public',
        (t) =>
            t['outputs'][0]['terms']['unlockingScriptTemplate'] =
                'never-public',
        (t) => t['outputs'].add(copied(t['outputs'][0])),
        (t) => t['outputs'][0]['terms']['feeScale'] = '1',
      ]) {
        final t = copied(original);
        edit(t);
        expect(() => publicReviewedLopOrders(t, 0), throwsStateError);
      }
    },
  );
  Map replaceOutput(Map sample, int index, String Function(String) edit) {
    final request = copied(sample['request']),
        row = request['payload']['transactions'][0],
        raw = row['rawTransaction'] as String,
        script =
            inspectTransaction(raw)['outputs'][index]['scriptPubKey'] as String,
        replacement = edit(script);
    expect(replacement.length, script.length);
    row['rawTransaction'] = raw.replaceFirst(script, replacement);
    return request;
  }

  test(
    'LOP escrow controller cannot be replaced by an ordinary recipient',
    () async {
      final request = replaceOutput(buy, 1, (script) {
        final code = ReviewedTokenCodec(keyless).codes([script]).single!;
        return script.replaceFirst(code['controller'], '${'11' * 20}00');
      });
      await expectLater(review(buy, request: request), throwsStateError);
    },
  );
  test('LOP token amount tampering fails conservation', () async {
    final request = replaceOutput(buy, 2, (script) {
      expect(script.startsWith('006a30'), true);
      final bytes = unhex(script);
      bytes[3] += 1;
      return hex(bytes);
    });
    await expectLater(review(buy, request: request), throwsStateError);
  });
  test('native-only LOP preview cannot hide a foreign payout', () async {
    final tx = inspectTransaction(
      sell['request']['payload']['transactions'][0]['rawTransaction'],
    );
    final request = replaceOutput(
      sell,
      (tx['outputs'] as List).length - 1,
      (script) => '76a914${'11' * 20}88ac',
    );
    await expectLater(review(sell, request: request), throwsStateError);
  });
  test('LOP live status is read anew and spent input never approves', () async {
    final trace = <Map>[];
    await review(sell, trace: trace);
    await expectLater(
      review(
        sell,
        trace: trace,
        mutateStatus: (rows) => rows[0]['spent'] = true,
      ),
      throwsStateError,
    );
    expect(trace.length, 2);
  });
  test(
    'LOP revocation after dependency read prevents metadata and approval',
    () async {
      var live = true;
      final trace = <Map>[];
      await expectLater(
        review(
          buy,
          trace: trace,
          requireCurrent: () {
            if (!live) throw StateError('revoked');
          },
          mutateStatus: (rows) {
            if (rows.any((r) => r['value'] == '0')) live = false;
          },
        ),
        throwsStateError,
      );
      expect(trace.length, 2);
    },
  );
}
