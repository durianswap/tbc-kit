import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_preview.dart';

void main() {
  final oracle =
      jsonDecode(File('test/fixtures/reviewed-preview.json').readAsStringSync())
          as Map;
  final samples = (oracle['cases'] as List).cast<Map>();
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
  ReviewedRawPlan plan(Map sample) => ReviewedRawPlan.fromMaterial(
    normalizeReviewedMaterial(sample['request']),
  );
  Map<String, dynamic> bind(Map sample, {Map? structured, Map? policy}) =>
      bindReviewedArtifact(
        plan: plan(sample),
        structuredPreview: structured ?? sample['defaultReview']['preview'],
        policyMaterial: policy ?? sample['review']['payload']['policyMaterial'],
        now: DateTime.parse('2026-10-13T00:00:00.123Z'),
      );
  for (final s in samples) {
    test('Reviewed ${s['name']} preview and policy evidence boundary', () {
      final complete = (s['defaultReview']['preview']['transactions'] as List)
          .every((t) => t['classification']['conformance'] == 'standard');
      if (complete) {
        final actual = bind(s);
        expect(canonical(actual), canonical(s['review']));
        expect(
          () => actual['payload']['preview']['totalFee'] = '0',
          throwsUnsupportedError,
        );
      } else {
        // The frozen historical FT parser reports missing amount evidence.
        // Preserve that oracle, but do not promote it to trustworthy approval.
        expect(s['name'], 'raw-historical-transfer');
        expect(() => bind(s), throwsStateError);
      }
      var calls = 0;
      checkReviewedIssuancePolicy(
        plan: plan(s),
        policyMaterial: s['review']['payload']['policyMaterial'],
        keyless: (method, input) {
          calls++;
          expect(method, 'inspectTokenMaterial');
          return keyless(method, input);
        },
      );
      expect(calls, 1);
    });
  }
  final native = samples.first,
      htlc = samples.singleWhere(
        (s) => s['name'] == 'raw-htlc-native-lock-height',
      );
  final time = samples.singleWhere(
    (s) => s['name'] == 'raw-timelock-unlock-one',
  );
  test(
    'Reviewed preview cannot replace transaction identity or unknown impact',
    () {
      for (final change in <void Function(Map)>[
        (p) => p['transactions'] = [],
        (p) => p['transactions'][0]['index'] = 1,
        (p) => p['transactions'][0]['txid'] = '00' * 32,
        (p) =>
            p['transactions'][0]['classification']['conformance'] =
                'nonstandard',
        (p) =>
            p['transactions'][0]['groups'][0]['flows'][0]['recognized'] = false,
        (p) => p['transactions'][0]['groups'][0]['asset']['type'] = 'unknown',
        (p) => p['transactions'][0]['orderTerms'] = {},
        (p) => p['transactions'][0]['coinLocks'] = [],
      ]) {
        final p = copied(native['defaultReview']['preview']);
        change(p);
        expect(() => bind(native, structured: p), throwsStateError);
      }
    },
  );
  test(
    'Reviewed public lock fields reject preimage and false maturity claims',
    () {
      for (final change in <void Function(Map)>[
        (r) => r['preimage'] = 'public-negative-marker',
        (r) => r['unlockingScriptTemplate'] = '00',
        (r) => r['chainMaturityChecked'] = true,
        (r) => r['scriptExecutionVerified'] = true,
        (r) => r['branch'] = 'claim',
        (r) => r['domain'] = 'timestamp',
        (r) => r['lockTime'] = 0,
        (r) => r['sequence'] = 0xfffffffe,
        (r) => r['index'] = -1,
      ]) {
        final p = copied(htlc['defaultReview']['preview']);
        change(p['transactions'][0]['htlcLocks'][0]);
        try {
          bind(htlc, structured: p);
          fail('accepted invalid public lock');
        } on StateError catch (e) {
          expect(e.toString(), isNot(contains('public-negative-marker')));
        }
      }
    },
  );
  test(
    'Reviewed TimeLock display keeps actual transaction lock conditions',
    () {
      for (final change in <void Function(Map)>[
        (r) => r['scriptLockChecked'] = false,
        (r) => r['sequence'] = 0xffffffff,
        (r) => r['transactionLockTime'] = 0,
        (r) => r['lockHeight'] = 500000000,
        (r) => r.remove('owner'),
      ]) {
        final p = copied(time['defaultReview']['preview']);
        change(p['transactions'][0]['timeLocks'][0]);
        expect(() => bind(time, structured: p), throwsStateError);
      }
    },
  );
  test(
    'Reviewed whole artifact owns preview and policy and binds all changes',
    () {
      final p = copied(htlc['defaultReview']['preview']),
          policy = copied(htlc['review']['payload']['policyMaterial']);
      final bound = bind(htlc, structured: p, policy: policy),
          before = canonical(bound);
      p.clear();
      policy.clear();
      expect(canonical(bound), before);
      final changed = copied(htlc['defaultReview']['preview']);
      changed['transactions'][0]['htlcLocks'][0]['hashlock'] = '11' * 32;
      expect(
        bind(htlc, structured: changed)['reviewHash'],
        isNot(bound['reviewHash']),
      );
      final changedPolicy = copied(htlc['review']['payload']['policyMaterial']);
      changedPolicy['resolvedOutputs'][0]['satoshis'] = '12345';
      expect(
        bind(htlc, policy: changedPolicy)['reviewHash'],
        isNot(bound['reviewHash']),
      );
    },
  );
  test(
    'Reviewed policy rejects supplement replacing bound inputs before Rust',
    () {
      for (final change in <void Function(Map)>[
        (p) => p['resolvedOutputs'][0]['satoshis'] = '20001',
        (p) => p['resolvedOutputs'][0]['scriptPubKey'] = '51',
      ]) {
        final p = copied(native['review']['payload']['policyMaterial']);
        change(p);
        var calls = 0;
        expect(
          () => checkReviewedIssuancePolicy(
            plan: plan(native),
            policyMaterial: p,
            keyless: (m, v) {
              calls++;
              return keyless(m, v);
            },
          ),
          throwsStateError,
        );
        expect(calls, 0);
      }
    },
  );
  test(
    'Reviewed local parent cannot be shadowed and is excluded from external policy',
    () {
      final s = samples.singleWhere(
            (s) => s['name'] == 'associated-two-dependent',
          ),
          p = plan(s);
      final local = p.localPrevouts.values.first as Map;
      final policy = copied(s['review']['payload']['policyMaterial']);
      final extra = {
        'txid': local['txid'],
        'vout': int.parse(local['index']),
        'satoshis': local['value'],
        'scriptPubKey': local['scriptPubKey'],
      };
      policy['resolvedOutputs'].add(extra);
      checkReviewedIssuancePolicy(
        plan: p,
        policyMaterial: policy,
        keyless: (m, v) {
          expect(
            (v['resolvedOutputs'] as List).any(
              (x) => p.transactionIds.contains(x['txid']),
            ),
            false,
          );
          return keyless(m, v);
        },
      );
      extra['satoshis'] = '1';
      expect(
        () => checkReviewedIssuancePolicy(
          plan: p,
          policyMaterial: policy,
          keyless: keyless,
        ),
        throwsStateError,
      );
    },
  );
  test('Reviewed policy rejects duplicate operations and unsafe amounts', () {
    final request = copied(native['request']);
    request['payload']['transactions'].add(
      copied(request['payload']['transactions'][0]),
    );
    expect(
      () => checkReviewedIssuancePolicy(
        plan: ReviewedRawPlan.fromMaterial(normalizeReviewedMaterial(request)),
        policyMaterial: native['review']['payload']['policyMaterial'],
        keyless: keyless,
      ),
      throwsStateError,
    );
    final policy = copied(native['review']['payload']['policyMaterial']);
    policy['resolvedOutputs'].add({
      'txid': '99' * 32,
      'vout': 0,
      'satoshis': '9007199254740992',
      'scriptPubKey': '51',
    });
    expect(
      () => checkReviewedIssuancePolicy(
        plan: plan(native),
        policyMaterial: policy,
        keyless: keyless,
      ),
      throwsStateError,
    );
  });
  test(
    'Reviewed policy validates exact Rust response and sanitizes raw bridge errors',
    () {
      final p = plan(native),
          policy = native['review']['payload']['policyMaterial'];
      for (final value in [
        {},
        {
          'verification': 'historical-issuance-policy',
          'assetIdentityVerified': true,
          'transactionIds': p.transactionIds,
        },
        {
          'verification': 'historical-issuance-policy',
          'assetIdentityVerified': false,
          'transactionIds': ['00' * 32],
        },
        {
          'verification': 'historical-issuance-policy',
          'assetIdentityVerified': false,
          'transactionIds': p.transactionIds,
          'extra': true,
        },
      ]) {
        expect(
          () => checkReviewedIssuancePolicy(
            plan: p,
            policyMaterial: policy,
            keyless: (m, v) => Map<String, dynamic>.from(value),
          ),
          throwsStateError,
        );
      }
      try {
        checkReviewedIssuancePolicy(
          plan: p,
          policyMaterial: policy,
          keyless: (m, v) => throw StateError('private-raw-witness'),
        );
        fail('accepted bridge failure');
      } on StateError catch (e) {
        expect(e.toString(), contains('REVIEWED_ISSUANCE_POLICY_REJECTED'));
        expect(e.toString(), isNot(contains('private-raw-witness')));
      }
    },
  );
  test(
    'Reviewed projection preserves exact millisecond expiry without rounding',
    () {
      final s = native;
      for (final stamp in [
        '2026-10-13T00:00:00Z',
        '2026-10-13T00:00:00.001Z',
        '2026-10-13T00:00:00.999Z',
        '2026-10-13T00:00:00.123456Z',
      ]) {
        final now = DateTime.parse(stamp),
            a = bindReviewedArtifact(
              plan: plan(s),
              structuredPreview: s['defaultReview']['preview'],
              policyMaterial: s['review']['payload']['policyMaterial'],
              now: now,
            );
        expect(
          protocolTime(a['payload']['expiresAt']).difference(
            DateTime.fromMillisecondsSinceEpoch(
              now.millisecondsSinceEpoch,
              isUtc: true,
            ),
          ),
          const Duration(minutes: 2),
        );
      }
    },
  );
}
