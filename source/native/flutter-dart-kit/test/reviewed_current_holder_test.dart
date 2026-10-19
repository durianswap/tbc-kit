import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_status.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_preview.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_token.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_current_holder.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_address.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_keyless.dart';

void main() {
  final fixture =
          jsonDecode(
                File('test/fixtures/reviewed-current.json').readAsStringSync(),
              )
              as Map,
      samples = (fixture['cases'] as List).cast<Map>();
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
    Map sample, {
    Map? request,
    Map? account,
    void Function()? authority,
    Future<Map<String, dynamic>> Function(String)? read,
    List<Map<String, dynamic>>? trace,
  }) async {
    final material = normalizeReviewedMaterial(request ?? sample['request']),
        plan = ReviewedRawPlan.fromMaterial(material);
    final check = authority ?? () {};
    final status = ReviewedStatusReader(
      plan: plan,
      requireCurrent: check,
      status: (points) async {
        trace?.add({
          'path': '/api/tbc/txo/status',
          'body': {'txos': points},
        });
        return {
          'txos':
              points
                  .map(
                    (p) => (sample['statuses'] as List).singleWhere(
                      (s) =>
                          s['txid'] == p['txid'] &&
                          s['index'] == '${p['index']}',
                    ),
                  )
                  .toList(),
        };
      },
    );
    final inputs = await status.readInputs();
    final previews = await reviewFungibleHolderTransactions(
      plan: plan,
      status: status,
      verifiedInputs: inputs,
      material: material,
      account: account ?? sample['account'],
      chainId: 'tbc:testnet',
      transactionIndexes: List.generate(plan.transactions.length, (i) => i),
      codec: ReviewedTokenCodec(keyless),
      requireCurrent: check,
      read: (path) async {
        trace?.add({'path': path});
        return read != null
            ? await read(path)
            : copied(sample['replies'][path]);
      },
    );
    final policy = status.policyMaterial();
    checkReviewedIssuancePolicy(
      plan: plan,
      policyMaterial: policy,
      keyless: keyless,
    );
    verifyReviewedAssociatedPreview(
      plan: plan,
      material: ReviewedKeylessMaterial(material, policy),
      publicKey: (account ?? sample['account'])['publicKey'],
      keyless: keyless,
    );
    final structured = {'transactions': previews.values.toList()};
    return {
      'preview': structured,
      'policyMaterial': policy,
      'verifiedInputs': inputs,
      'artifact': bindReviewedArtifact(
        plan: plan,
        structuredPreview: structured,
        policyMaterial: policy,
        now: DateTime.parse('2026-10-13T00:00:00.123Z'),
      ),
    };
  }

  for (final s in samples) {
    test(
      'Reviewed ${s['name']} exact native holder review four-read parity',
      () async {
        final trace = <Map<String, dynamic>>[],
            actual = await review(s, trace: trace);
        expect(
          canonical(actual['preview']),
          canonical(s['defaultReview']['preview']),
        );
        expect(
          canonical(actual['policyMaterial']),
          canonical(s['defaultReview']['policyMaterial']),
        );
        expect(
          canonical(actual['verifiedInputs']),
          canonical(s['defaultReview']['verifiedInputs']),
        );
        expect(canonical(actual['artifact']), canonical(s['review']));
        expect(canonical(trace), canonical(s['reads']));
        expect(trace.length, 4);
        expect(canonical(actual), isNot(contains('UNTRUSTED_LABEL_NOT_USED')));
        expect(canonical(actual), isNot(contains('999999999999999')));
        // Same actual Native codec validates every recorded frozen WASM result.
        for (final inspection in s['inspections'])
          expect(
            canonical(
              keyless(inspection['method'], copied(inspection['input'])),
            ),
            canonical(inspection['result']),
          );
      },
    );
  }
  final token = samples.first,
      coin = samples.singleWhere(
        (s) => s['name'] == 'raw-current-coin-transfer',
      );
  for (final s in samples.where(
    (s) => s['material']['format'] == 'associated',
  )) {
    test(
      'Reviewed ${s['name']} invalid ancestors fail frozen Rust preflight',
      () async {
        for (final change in <void Function(Map)>[
          (i) => i['ancestorTransactions'] = [],
          (i) => i['previousTransaction'] = i['ancestorTransactions'][0],
        ]) {
          final request = copied(s['request']);
          final input = (request['payload']['sourceInputs'] as List).firstWhere(
            (i) => i['signingProfile'] != 'p2pkh',
          );
          change(input);
          await expectLater(review(s, request: request), throwsStateError);
        }
      },
    );
  }
  test(
    'Reviewed token descriptor and pair batches deduplicate exact inputs',
    () {
      final calls = <Map>[],
          codec = ReviewedTokenCodec((m, i) {
            calls.add(copied(i));
            return keyless(m, i);
          });
      final inspection = (token['inspections'] as List).firstWhere(
        (x) => x['input']['phase'] == 'inspectCodes',
      );
      final script = inspection['input']['scripts'][0] as String;
      final result = codec.codes([script, script]);
      expect(result[0], result[1]);
      expect(calls.single['scripts'], hasLength(1));
      calls.clear();
      final pairs =
          (token['inspections'] as List).firstWhere(
            (x) => x['input']['phase'] == 'inspectPairs',
          )['input']['pairs'];
      final pair = copied(pairs[0]);
      final verified = codec.pairs([pair, pair]);
      expect(canonical(verified[0]), canonical(verified[1]));
      expect(calls.single['pairs'], hasLength(1));
    },
  );
  test(
    'Reviewed metadata hint must bind exact selected txid and output',
    () async {
      for (final change in <void Function(Map)>[
        (d) => d['txid'] = '00' * 32,
        (d) => d['contract_id'] = 'not-a-hash',
        (d) => d['output'] = [],
        (d) =>
            d['output'] = [
              {'txid': '00' * 32, 'vout': 0},
            ],
        (d) =>
            d['output'] = [
              {'txid': d['txid'], 'vout': 999},
            ],
      ]) {
        final trace = <Map<String, dynamic>>[];
        await expectLater(
          review(
            token,
            trace: trace,
            read: (path) async {
              final d = copied(token['replies'][path]);
              change(d);
              return d;
            },
          ),
          throwsStateError,
        );
        expect(
          trace.where((r) => (r['path'] as String).contains('/info/')),
          isEmpty,
        );
      }
    },
  );
  test(
    'Reviewed FT and Coin metadata Code identity cannot be replaced',
    () async {
      for (final s in [token, coin])
        for (final replacement in [null, '76a914${'11' * 20}88ac']) {
          await expectLater(
            review(
              s,
              read: (path) async {
                final d = copied(s['replies'][path]);
                if (path.contains('/info/')) d['code_script'] = replacement;
                return d;
              },
            ),
            throwsStateError,
          );
        }
      await expectLater(
        review(
          coin,
          read: (path) async {
            final d = copied(coin['replies'][path]);
            if (path.contains('/info/')) d['stablecoin_id'] = '11' * 32;
            return d;
          },
        ),
        throwsStateError,
      );
    },
  );
  test(
    'Reviewed different holder fails before dependency or metadata reads',
    () async {
      final other = {
        'chainId': 'tbc:testnet',
        'address': '1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',
        'accountId': 'tbc:testnet:1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',
        'publicKey':
            '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
      };
      final trace = <Map<String, dynamic>>[];
      await expectLater(
        review(token, account: other, trace: trace),
        throwsStateError,
      );
      expect(trace, hasLength(1));
    },
  );
  test('Reviewed associated holders require current proof profile', () async {
    final s = samples.singleWhere(
          (s) => s['name'] == 'associated-current-transfer-multiple-inputs',
        ),
        request = copied(s['request']);
    final first = request['payload']['sourceInputs'][0] as Map;
    first['signingProfile'] = 'p2pkh';
    first.remove('previousTransaction');
    first.remove('ancestorTransactions');
    final trace = <Map<String, dynamic>>[];
    await expectLater(
      review(s, request: request, trace: trace),
      throwsStateError,
    );
    expect(trace, hasLength(1));
  });
  test(
    'Reviewed current token conservation rejects before metadata fetch',
    () async {
      final request = copied(token['request']);
      final pairs =
          (token['inspections'] as List).firstWhere(
                (x) => x['input']['phase'] == 'inspectPairs',
              )['input']['pairs']
              as List;
      final raw =
          request['payload']['transactions'][0]['rawTransaction'] as String;
      final tape = pairs
              .map((p) => p['tapeScript'] as String)
              .firstWhere(raw.contains),
          b = unhex(tape);
      b[3] = (b[3] + 1) & 255;
      request['payload']['transactions'][0]['rawTransaction'] = raw
          .replaceFirst(tape, hex(b));
      final trace = <Map<String, dynamic>>[];
      await expectLater(
        review(token, request: request, trace: trace),
        throwsStateError,
      );
      expect(trace.every((r) => r['path'] == '/api/tbc/txo/status'), true);
    },
  );
  test('Reviewed revoked authority suppresses metadata continuation', () async {
    final wait = Completer<Map<String, dynamic>>(), started = Completer<void>();
    var active = true;
    final trace = <Map<String, dynamic>>[];
    final result = review(
      token,
      trace: trace,
      authority: () {
        need(active, 'REVOKED');
      },
      read: (path) {
        started.complete();
        return wait.future;
      },
    );
    final assertion = expectLater(result, throwsStateError);
    await started.future;
    active = false;
    wait.complete(copied(token['replies'][(trace.last['path'])]));
    await assertion;
    expect(
      trace.where((r) => (r['path'] as String).contains('/info/')),
      isEmpty,
    );
  });
  test('Reviewed operations do not persist mutable status snapshots', () async {
    final first = <Map<String, dynamic>>[], second = <Map<String, dynamic>>[];
    await review(token, trace: first);
    await review(token, trace: second);
    expect(canonical(first), canonical(second));
    expect(second, hasLength(4));
  });
  test(
    'Reviewed Coin public terms retain lock domain and refuse admin override',
    () async {
      final result = await review(coin), preview = copied(result['preview']);
      final material = normalizeReviewedMaterial(coin['request']),
          plan = ReviewedRawPlan.fromMaterial(material);
      for (final change in <void Function(Map)>[
        (r) => r['authorization'] = 'administrator',
        (r) => r['chainMaturityChecked'] = true,
        (r) => r['scriptLockChecked'] = false,
        (r) => r['domain'] = 'timestamp',
        (r) => r['owner'] = 'invalid-address',
        (r) => r['preimage'] = 'public-negative-marker',
      ]) {
        final bad = copied(preview);
        change(bad['transactions'][0]['coinLocks'][0]);
        expect(() => projectReviewedPreview(plan, bad), throwsStateError);
      }
    },
  );
  test(
    'Reviewed NFT policy diagnostic requires adjacent current Tape, not Rust changes',
    () {
      final rows = fixture['nftDiagnostic'] as List;
      expect(rows.first['name'], 'primary-only');
      expect(keyless('inspectTokenMaterial', copied(rows.first['input'])), {
        'error': rows.first['refusal'],
      });
      for (final row in rows.skip(1))
        expect(
          canonical(keyless('inspectTokenMaterial', copied(row['input']))),
          canonical(row['result']),
        );
      final minimal = rows[1]['input']['resolvedOutputs'] as List,
          full = rows[2]['input']['resolvedOutputs'] as List;
      expect(
        minimal.length,
        (rows.first['input']['resolvedOutputs'] as List).length + 1,
      );
      expect(minimal.length, lessThan(full.length));
    },
  );
  test(
    'Reviewed address utility matches known TBC account, no network inference',
    () {
      expect(
        reviewedAddress('751e76e8199196d454941c45d1b3a323f1433bd6'),
        '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
      );
      expect(reviewedAddress('22' * 20), '147Us9aEq2PvBC5wobBJw1yEpQEbPKzssA');
      expect(() => reviewedAddress('00'), throwsStateError);
    },
  );
}
