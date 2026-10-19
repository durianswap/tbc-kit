import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_htlc_token.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_preview.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_status.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_token.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';

void main() {
  final cases =
      (jsonDecode(
                File(
                  'test/fixtures/reviewed-htlc-token.json',
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
        rows = await reviewHtlcTokenTransactions(
          plan: plan,
          status: status,
          verifiedInputs: verified,
          material: material,
          account: account ?? s['account'],
          chainId: 'tbc:testnet',
          transactionIndexes: [0],
          codec: ReviewedTokenCodec(keyless),
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
      'plan': plan,
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
      '${s['name']} frozen full preview/hash and four-read parity',
      () async {
        final trace = <Map>[], result = await review(s, trace: trace);
        expect(
          canonical(result['preview']),
          canonical(s['defaultReview']['preview']),
        );
        expect(
          canonical(result['policyMaterial']),
          canonical(s['defaultReview']['policyMaterial']),
        );
        expect(canonical(result['artifact']), canonical(s['review']));
        expect(canonical(trace), canonical(s['reads']));
        expect(trace.length, 4);
        for (final term
            in result['artifact']['payload']['preview']['htlcLocks']) {
          expect(term['branch'], 'unresolved');
          expect(term['preimageVerified'], false);
          expect(term['chainMaturityChecked'], false);
          expect(term['scriptExecutionVerified'], false);
        }
      },
    );
  final lock = cases.firstWhere(
        (s) => s['name'] == 'raw-htlc-token-tbc20-standard-lock-height',
      ),
      claim = cases.firstWhere(
        (s) => s['name'] == 'raw-htlc-token-tbc20-standard-claim-before-refund',
      ),
      coin = cases.firstWhere(
        (s) => s['name'] == 'raw-htlc-token-tbc20-stablecoin-lock-height',
      );
  Map replaceOutput(Map s, int index, String Function(String) edit) {
    final request = copied(s['request']),
        row = request['payload']['transactions'][0],
        raw = row['rawTransaction'] as String,
        script =
            inspectTransaction(raw)['outputs'][index]['scriptPubKey'] as String,
        replacement = edit(script);
    expect(script.length, replacement.length);
    row['rawTransaction'] = raw.replaceFirst(script, replacement);
    return request;
  }

  test('Token HTLC controller binds the exact hashlock script', () async {
    final request = replaceOutput(
      lock,
      0,
      (script) => script.replaceRange(6, 70, '23' * 32),
    );
    await expectLater(review(lock, request: request), throwsStateError);
  });
  test(
    'Token HTLC address controller cannot replace escrow controller',
    () async {
      final request = replaceOutput(lock, 1, (script) {
        final code = ReviewedTokenCodec(keyless).codes([script]).single!;
        return script.replaceFirst(code['controller'], '${'11' * 20}00');
      });
      await expectLater(review(lock, request: request), throwsStateError);
    },
  );
  test('Token HTLC output balance tampering fails conservation', () async {
    final request = replaceOutput(lock, 2, (script) {
      expect(script.startsWith('006a30'), true);
      final b = unhex(script);
      b[3] += 1;
      return hex(b);
    });
    await expectLater(review(lock, request: request), throwsStateError);
  });
  test(
    'Token HTLC index labels never supply amount or trusted identity',
    () async {
      final result = await review(
        lock,
        mutateReply: (p, r) {
          r['balance'] = '99999999999999';
          r['decimal'] = 100;
          r['symbol'] = 'fake';
        },
      );
      expect(canonical(result['artifact']), canonical(lock['review']));
      await expectLater(
        review(
          lock,
          mutateReply: (p, r) {
            if (p.contains('/info/'))
              r['code_script'] = '76a914${'11' * 20}88ac';
          },
        ),
        throwsStateError,
      );
    },
  );
  test(
    'Token HTLC public escrow terms cannot carry preimage or claim unsupported proofs',
    () async {
      final result = await review(coin);
      for (final edit in <void Function(Map)>[
        (t) => t['escrowToken']['preimage'] = 'never-public',
        (t) => t['escrowToken']['amount'] = '0',
        (t) => t['escrowToken']['coinLockTime'] = 500000001,
        (t) => t['escrowToken']['coinInputLockChecked'] = true,
        (t) => t['scriptExecutionVerified'] = true,
        (t) => t['branch'] = 'claim',
      ]) {
        final preview = copied(result['preview']),
            term = preview['transactions'][0]['htlcLocks'][0];
        edit(term);
        expect(
          () => projectReviewedPreview(result['plan'], preview),
          throwsStateError,
        );
      }
    },
  );
  test(
    'Token HTLC wrong selected account stops before dependency reads',
    () async {
      final other = {
            'chainId': 'tbc:testnet',
            'address': '1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',
            'accountId': 'tbc:testnet:1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',
            'publicKey':
                '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
          },
          trace = <Map>[];
      await expectLater(
        review(claim, account: other, trace: trace),
        throwsStateError,
      );
      expect(trace.length, 1);
    },
  );
  test('Token HTLC mutable spent state is checked on every review', () async {
    final trace = <Map>[];
    await review(claim, trace: trace);
    await expectLater(
      review(
        claim,
        trace: trace,
        mutateStatus: (rows) => rows[0]['spent'] = true,
      ),
      throwsStateError,
    );
    expect(trace.length, 5);
  });
  test(
    'Token HTLC revocation after read never emits an approval artifact',
    () async {
      var live = true;
      final trace = <Map>[];
      await expectLater(
        review(
          lock,
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
