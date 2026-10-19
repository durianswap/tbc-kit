import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_reviewer.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_token.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';

const _account = {
  'chainId': 'tbc:testnet',
  'address': '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
  'publicKey':
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'accountId': 'tbc:testnet:1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
};
List<Map> samples(String name) =>
    (jsonDecode(File('test/fixtures/$name.json').readAsStringSync())['cases']
            as List)
        .cast<Map>();

void main() {
  final cases = <Map>[
    ...samples('reviewed-preview').where(
      (s) => (s['defaultReview']['preview']['transactions'] as List).every(
        (t) => {
          'tbc',
          'tbc-timelock',
          'tbc-htlc',
        }.contains(t['classification']['protocol']),
      ),
    ),
    ...samples('reviewed-native-lock'),
    ...samples('reviewed-current'),
    ...samples('reviewed-historical-fungible'),
    ...samples('reviewed-nft'),
    ...samples('reviewed-lop'),
    ...samples('reviewed-htlc-token'),
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
  Map<String, dynamic> keyless(String m, Map<String, dynamic> args) =>
      copied(jsonDecode(engine.call('keyless', m, canonical(args))));
  ReviewedTransactionReviewer reviewer(
    Map s,
    List<Map> calls, {
    void Function()? onStatus,
  }) => ReviewedTransactionReviewer(
    chainId: 'tbc:testnet',
    now: () => DateTime.parse('2026-10-13T00:00:00.123Z'),
    keyless: keyless,
    status: (points) async {
      calls.add({
        'path': '/api/tbc/txo/status',
        'body': {'txos': points},
      });
      onStatus?.call();
      return {
        'txos': [
          for (final p in points)
            copied(
              (s['statuses'] as List).singleWhere(
                (v) => v['txid'] == p['txid'] && v['index'] == '${p['index']}',
              ),
            ),
        ],
      };
    },
    read: (path) async {
      calls.add({'path': path});
      expect(s['replies'].containsKey(path), true);
      return copied(s['replies'][path]);
    },
    readHistory: (id) async {
      calls.add({'path': '/api/tbc/txraw/txid/$id'});
      return inspectTransaction(s['parents'][id], id);
    },
  );

  for (final s in cases) {
    test(
      'shared review ${s['name']} retains artifact/identity and read budget',
      () async {
        final calls = <Map>[];
        final result = await reviewer(s, calls).review(
          request: s['request'],
          account: s['account'] ?? _account,
          requireCurrent: () {},
        );
        if (s['review'] != null) {
          expect(canonical(result.artifact), canonical(s['review']));
          expect(
            canonical(result.policyMaterial),
            canonical(s['defaultReview']['policyMaterial']),
          );
          expect(canonical(calls), canonical(s['reads']));
        } else if (s['expectedIdentity'] != null) {
          final tx = result.preview['transactions'][0],
              asset = tx['groups'][0]['asset'];
          for (final field in ['contractId', 'collectionId', 'tokenId']) {
            expect(asset[field], s['expectedIdentity'][field]);
          }
          expect(tx['feeSatoshis'], s['originalEnginePreview']['totalFee']);
          expect(calls.length, 4);
        } else {
          final outputs = result.policyMaterial['resolvedOutputs'];
          expect(
            canonical(
              keyless('inspectTokenMaterial', {
                ...copied(s['policyInput']),
                'resolvedOutputs': outputs,
              }),
            ),
            canonical(s['policyResult']),
          );
          expect(calls.length, 4);
          expect(result.preview['transactions'], hasLength(1));
        }
        expect(() => result.preview.clear(), throwsUnsupportedError);
        expect(() => result.artifact.clear(), throwsUnsupportedError);
      },
    );
  }

  test(
    'mixed five-family batch uses one primary and one dependency read',
    () async {
      final chosen = <Map>[], used = <String>{};
      for (final name in [
        'reviewed-preview',
        'reviewed-nft',
        'reviewed-current',
        'reviewed-lop',
        'reviewed-htlc-token',
      ]) {
        final s = samples(name).firstWhere((s) {
          if (name == 'reviewed-current' &&
              s['name'] != 'raw-current-merge-token-only')
            return false;
          if (s['request']['payload']['format'] != 'raw' ||
              (s['request']['payload']['transactions'] as List).length != 1 ||
              (s['account']?['address'] ?? _account['address']) !=
                  _account['address']) {
            return false;
          }
          final plan = ReviewedRawPlan.fromMaterial(
            normalizeReviewedMaterial(s['request']),
          );
          final points = [
            for (final tx in plan.transactions)
              for (final i in tx['inputs']) '${i['txid']}:${i['vout']}',
          ];
          if (points.any(used.contains)) return false;
          used.addAll(points);
          return true;
        });
        chosen.add(s);
      }
      final statuses = <String, Map>{},
          replies = <String, dynamic>{},
          parents = <String, dynamic>{};
      for (final s in chosen) {
        for (final row in s['statuses']) {
          final k = '${row['txid']}:${row['index']}';
          if (statuses.containsKey(k))
            expect(canonical(row), canonical(statuses[k]));
          statuses[k] = row;
        }
        for (final e in (s['replies'] as Map? ?? {}).entries) {
          if (replies.containsKey(e.key)) {
            // Frozen scenarios used different valid holders in the same
            // contract's info response. Reuse one authenticated Code response;
            // the controller is deliberately not an immutable asset identity.
            if (e.value['code_script'] != null) {
              final codes = ReviewedTokenCodec(
                keyless,
              ).codes([e.value['code_script'], replies[e.key]['code_script']]);
              for (final field in [
                'codeIdentity',
                'standardId',
                'protocolVersion',
              ]) {
                expect(codes[0]![field], codes[1]![field]);
              }
            } else {
              expect(canonical(e.value), canonical(replies[e.key]));
            }
          } else {
            replies[e.key] = e.value;
          }
        }
        parents.addAll(Map<String, dynamic>.from(s['parents'] ?? {}));
      }
      final combined = {
        'request': {
          'payload': {
            'format': 'raw',
            'transactions': [
              for (final s in chosen)
                ...s['request']['payload']['transactions'],
            ],
          },
        },
        'statuses': statuses.values.toList(),
        'replies': replies,
        'parents': parents,
      };
      final calls = <Map>[],
          result = await reviewer(combined, calls).review(
            request: combined['request'] as Map,
            account: _account,
            requireCurrent: () {},
          );
      expect(result.preview['transactions'], hasLength(5));
      expect(
        calls.where((c) => c['path'] == '/api/tbc/txo/status'),
        hasLength(2),
      );
      final getPaths =
          calls.where((c) => c['body'] == null).map((c) => c['path']).toList();
      expect(getPaths.toSet().length, getPaths.length);
      for (var i = 0; i < chosen.length; i++) {
        final independent = await reviewer(chosen[i], []).review(
          request: chosen[i]['request'],
          account: _account,
          requireCurrent: () {},
        );
        final expected = copied(independent.preview['transactions'][0]);
        expected['index'] = i;
        expect(
          canonical(result.preview['transactions'][i]),
          canonical(expected),
        );
      }
    },
  );

  test('per-review code cache reuses only complete immutable script results', () {
    final calls = <List>[], source = samples('reviewed-current').first;
    final script =
        source['request']['payload']['transactions'][0]['inputs'][0]['scriptPubKey']
            as String;
    final codec = ReviewedTokenCodec((m, args) {
      calls.add(args['scripts']);
      return keyless(m, args);
    });
    final expected = codec.codes([script, '51', script]);
    final warm = codec.codes(['51', script]);
    expect(canonical(warm), canonical([null, expected.first]));
    expect(calls.length, 1);
    expect(calls.single, [script, '51']);
    expect(() => warm[1]!['controller'] = 'forged', throwsUnsupportedError);
  });
  test('malformed code batch cannot cache a partially validated result', () {
    final source = samples('reviewed-current').first,
        script =
            source['request']['payload']['transactions'][0]['inputs'][0]['scriptPubKey']
                as String;
    final calls = <List>[];
    var corrupt = true;
    final codec = ReviewedTokenCodec((m, args) {
      calls.add(args['scripts']);
      final result = keyless(m, args);
      if (corrupt) result['codes'][1] = {'standardId': 'forged'};
      return result;
    });
    expect(() => codec.codes([script, '51']), throwsStateError);
    corrupt = false;
    expect(codec.codes([script, '51']).first, isNotNull);
    expect(calls, [
      [script, '51'],
      [script, '51'],
    ]);
  });
  test(
    'shared reviewer rejects wrong network before any source access',
    () async {
      final calls = <Map>[], s = cases.first;
      await expectLater(
        reviewer(s, calls).review(
          request: s['request'],
          account: {..._account, 'chainId': 'tbc:mainnet'},
          requireCurrent: () {},
        ),
        throwsStateError,
      );
      expect(calls, isEmpty);
    },
  );
  test(
    'shared reviewer revocation at status cannot produce approval artifact',
    () async {
      final calls = <Map>[], s = cases.first;
      var revoked = false;
      await expectLater(
        reviewer(s, calls, onStatus: () => revoked = true).review(
          request: s['request'],
          account: _account,
          requireCurrent: () {
            if (revoked) throw StateError('SESSION_REVOKED');
          },
        ),
        throwsStateError,
      );
      expect(calls, hasLength(1));
    },
  );
}
