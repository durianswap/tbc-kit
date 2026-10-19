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
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_historical_token.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';

String _wire(Map tx) {
  List<int> le(BigInt n, int size) => [
    for (var i = 0; i < size; i++) ((n >> (i * 8)) & BigInt.from(255)).toInt(),
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
  final fixture =
          jsonDecode(
                File(
                  'test/fixtures/reviewed-historical-fungible.json',
                ).readAsStringSync(),
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
    List<String>? trace,
    void Function()? authority,
    Future<Map<String, dynamic>> Function(String)? read,
    void Function(List<Map<String, dynamic>>)? mutateStatus,
  }) async {
    final material = normalizeReviewedMaterial(request ?? sample['request']),
        plan = ReviewedRawPlan.fromMaterial(material),
        check = authority ?? () {};
    final status = ReviewedStatusReader(
      plan: plan,
      requireCurrent: check,
      status: (points) async {
        trace?.add('status');
        final result =
            points
                .map(
                  (p) => copied(
                    (sample['statuses'] as List).singleWhere(
                      (s) =>
                          s['txid'] == p['txid'] &&
                          s['index'] == '${p['index']}',
                    ),
                  ),
                )
                .toList();
        mutateStatus?.call(result);
        return {'txos': result};
      },
    );
    final inputs = await status.readInputs();
    final rows = await reviewFungibleHolderTransactions(
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
        trace?.add(path);
        return read != null
            ? await read(path)
            : copied(sample['replies'][path]);
      },
    );
    final policy = status.policyMaterial(),
        preview = {'transactions': rows.values.toList()};
    checkReviewedIssuancePolicy(
      plan: plan,
      policyMaterial: policy,
      keyless: keyless,
    );
    return {
      'preview': preview,
      'policyMaterial': policy,
      'artifact': bindReviewedArtifact(
        plan: plan,
        structuredPreview: preview,
        policyMaterial: policy,
        now: DateTime.parse('2026-10-13T00:00:00.123Z'),
      ),
    };
  }

  Map changed(Map s, void Function(Map) update) {
    final request = copied(s['request']),
        row = request['payload']['transactions'][0],
        tx = inspectTransaction(row['rawTransaction']);
    update(tx);
    row['rawTransaction'] = _wire(tx);
    return request;
  }

  for (final s in samples) {
    test(
      '${s['name']} shares holder review, preserves frozen amount/lock and four reads',
      () async {
        expect(
          canonical(
            keyless('inspectTokenMaterial', copied(s['identityInput'])),
          ),
          canonical(s['identities']),
        );
        expect(
          canonical(keyless('inspectTokenMaterial', copied(s['policyInput']))),
          canonical(s['policyResult']),
        );
        for (final receipt in s['receipts'])
          expect(
            canonical(keyless('inspectTokenReceipt', copied(receipt['input']))),
            canonical(receipt['result']),
          );
        final codec = ReviewedTokenCodec(keyless),
            pairs = codec.historicalPairs(
              (s['identityInput']['pairs'] as List)
                  .map((p) => copied(p))
                  .toList(),
            );
        for (var i = 0; i < pairs.length; i++) {
          final pair = pairs[i], identity = s['identities']['identities'][i];
          expect(pair['balanceRaw'], identity['balanceRaw']);
          expect(pair['code']['codeIdentity'], identity['codeIdentity']);
          expect(
            pair['code']['controller'],
            '751e76e8199196d454941c45d1b3a323f1433bd600',
          );
        }
        final trace = <String>[],
            actual = await review(s, trace: trace),
            tx = actual['preview']['transactions'][0];
        expect(trace, hasLength(4));
        expect(trace.take(2), ['status', 'status']);
        expect(tx['classification']['conformance'], 'standard');
        expect(canonical(actual), isNot(contains('UNTRUSTED_LABEL_NOT_USED')));
        expect(canonical(actual), isNot(contains('999999999999999')));
        final groups = tx['groups'] as List,
            asset = groups.singleWhere(
              (g) => g['asset']['contractId'] == s['intent']['contractId'],
            );
        // The original fixture sends to self; the complete balance is visible,
        // not falsely reported as an external payment or an unknown amount.
        expect(asset['flows'].single['purpose'], 'self');
        final selected =
            (s['policyInput']['resolvedOutputs'] as List)
                .where((u) => u['satoshis'] == '500')
                .length;
        final total = (s['identities']['identities'] as List)
            .take(selected)
            .fold<BigInt>(
              BigInt.zero,
              (sum, p) => sum + BigInt.parse(p['balanceRaw']),
            );
        expect(asset['flows'].single['amount']['raw'], '$total');
        if (s['name'].contains('stablecoin')) {
          final locks = tx['coinLocks'] as List;
          expect(locks.length, pairs.length);
          for (final lock in locks) {
            expect(lock['lockTime'], 500000001);
            expect(lock['chainMaturityChecked'], false);
          }
        } else
          expect(tx.containsKey('coinLocks'), false);
      },
    );
  }
  final ft = samples.first,
      coin = samples.firstWhere(
        (s) => s['name'] == 'historical-stablecoin-transfer',
      );
  test(
    'historical pair dedup and exact template reject marker-only or current pair',
    () {
      final calls = <Map>[],
          codec = ReviewedTokenCodec((m, i) {
            calls.add(copied(i));
            return keyless(m, i);
          }),
          pair = copied(ft['identityInput']['pairs'][0]);
      final values = codec.historicalPairs([pair, pair]);
      expect(values[0], values[1]);
      expect(calls.single['pairs'], hasLength(1));
      final bad = copied(pair);
      bad['codeScript'] = '00' + (bad['codeScript'] as String).substring(2);
      expect(() => codec.historicalPairs([bad]), throwsStateError);
      final current =
          jsonDecode(
                File('test/fixtures/reviewed-current.json').readAsStringSync(),
              )['cases'][0]['inspections']
              as List;
      final p = copied(
        current.firstWhere(
          (r) => r['input']['phase'] == 'inspectPairs',
        )['input']['pairs'][0],
      );
      p.remove('inputLock');
      expect(() => codec.historicalPairs([p]), throwsStateError);
    },
  );
  test(
    'historical external recipient and native collateral are visible',
    () async {
      final request = changed(ft, (tx) {
        final o = (tx['outputs'] as List).firstWhere(
              (o) => o['satoshis'] == '500',
            ),
            b = unhex(o['scriptPubKey']);
        b.setRange(b.length - 27, b.length - 7, List.filled(20, 0x22));
        o['scriptPubKey'] = hex(b);
      });
      final actual = await review(ft, request: request),
          groups = actual['preview']['transactions'][0]['groups'] as List;
      final token = groups.singleWhere((g) => g['asset']['type'] == 'ft');
      expect(
        token['flows'],
        contains(
          containsPair('to', {'address': '147Us9aEq2PvBC5wobBJw1yEpQEbPKzssA'}),
        ),
      );
      final incoming = (token['flows'] as List).singleWhere(
        (f) => f['direction'] == 'in',
      );
      expect(incoming['amount']['raw'], '250000');
      final native = groups.singleWhere((g) => g['asset']['type'] == 'tbc');
      expect(
        (native['flows'] as List).singleWhere(
          (f) => f['direction'] == 'in',
        )['amount']['raw'],
        '500',
      );
    },
  );
  test(
    'historical conservation and altered pair values reject before metadata',
    () async {
      for (final edit in <void Function(Map)>[
        (tx) {
          final o = (tx['outputs'] as List).firstWhere(
            (o) => o['satoshis'] == '0',
          );
          final b = unhex(o['scriptPubKey']);
          b[3] ^= 1;
          o['scriptPubKey'] = hex(b);
        },
        (tx) {
          (tx['outputs'] as List).firstWhere(
                (o) => o['satoshis'] == '500',
              )['satoshis'] =
              '499';
        },
      ]) {
        final trace = <String>[];
        await expectLater(
          review(ft, request: changed(ft, edit), trace: trace),
          throwsStateError,
        );
        expect(trace.every((p) => p == 'status'), true);
      }
    },
  );
  test('historical metadata cannot replace full Code identity', () async {
    for (final s in [ft, coin]) {
      await expectLater(
        review(
          s,
          read: (path) async {
            final r = copied(s['replies'][path]);
            if (path.contains('/info/'))
              r['code_script'] =
                  (s == ft
                      ? coin
                      : ft)['identityInput']['pairs'][0]['codeScript'];
            return r;
          },
        ),
        throwsStateError,
      );
    }
  });
  test(
    'historical full indexed Code permits only a holder-controller difference',
    () async {
      final result = await review(
        ft,
        read: (path) async {
          final r = copied(ft['replies'][path]);
          if (path.contains('/info/')) {
            final code = unhex(r['code_script']);
            code.setRange(
              code.length - 27,
              code.length - 7,
              List.filled(20, 0x22),
            );
            r['code_script'] = hex(code);
          }
          return r;
        },
      );
      expect(canonical(result), canonical(await review(ft)));
      final code = ft['identityInput']['pairs'][0]['codeScript'] as String;
      final bytes = unhex(code);
      bytes[bytes.length - 29] ^= 1;
      expect(
        historicalContractCode(hex(bytes)),
        isNot(historicalContractCode(code)),
      );
    },
  );
  test(
    'historical stablecoin refuses final sequence, earlier lock and wrong domain',
    () async {
      for (final edit in <void Function(Map)>[
        (tx) => tx['inputs'][0]['sequence'] = 0xffffffff,
        (tx) => tx['locktime'] = 500000000,
        (tx) => tx['locktime'] = 499999999,
      ])
        await expectLater(
          review(coin, request: changed(coin, edit)),
          throwsStateError,
        );
      // Lock zero does not claim maturity; height/timestamp domains cannot mix.
      checkHistoricalHolderLock(0, {
        'sequence': 0xfffffffe,
        'transactionLockTime': 0,
      });
      checkHistoricalHolderLock(42, {
        'sequence': 0xfffffffe,
        'transactionLockTime': 42,
      });
      expect(
        () => checkHistoricalHolderLock(42, {
          'sequence': 0xfffffffe,
          'transactionLockTime': 500000000,
        }),
        throwsStateError,
      );
    },
  );
  test(
    'historical raw does not grant contract-controller or admin authority',
    () async {
      final request = changed(coin, (tx) {
        final o = (tx['outputs'] as List).firstWhere(
              (o) => o['satoshis'] == '500',
            ),
            b = unhex(o['scriptPubKey']);
        b[b.length - 7] = 1;
        o['scriptPubKey'] = hex(b);
      });
      await expectLater(review(coin, request: request), throwsStateError);
    },
  );
  test(
    'historical spent Code cannot be reused; unspendable Tape is metadata',
    () async {
      await expectLater(
        review(
          ft,
          mutateStatus: (rows) {
            for (final r in rows) if (r['value'] == '500') r['spent'] = true;
          },
        ),
        throwsStateError,
      );
      await review(
        ft,
        mutateStatus: (rows) {
          for (final r in rows) if (r['value'] == '0') r['spent'] = true;
        },
      );
    },
  );
  test(
    'historical late decode after revocation does not continue to info',
    () async {
      final wait = Completer<Map<String, dynamic>>(),
          started = Completer<String>(),
          trace = <String>[];
      var active = true;
      final pending = review(
        ft,
        trace: trace,
        authority: () => need(active, 'REVOKED'),
        read: (path) {
          started.complete(path);
          return wait.future;
        },
      );
      final assertion = expectLater(pending, throwsStateError),
          path = await started.future;
      active = false;
      wait.complete(copied(ft['replies'][path]));
      await assertion;
      expect(trace.where((p) => p.contains('/info/')), isEmpty);
    },
  );
  test(
    'historical repeated review refreshes status and stays on one path',
    () async {
      final a = <String>[], b = <String>[];
      final first = await review(coin, trace: a),
          second = await review(coin, trace: b);
      expect(a, b);
      expect(a.length, 4);
      expect(canonical(first), canonical(second));
    },
  );
  test(
    'current and historical rows share two status batches without duplicate reads',
    () async {
      final current =
          jsonDecode(
            File('test/fixtures/reviewed-current.json').readAsStringSync(),
          )['cases'][0];
      final combined = copied(ft);
      combined['request']['payload']['transactions'].addAll(
        current['request']['payload']['transactions'],
      );
      final statuses = <String, Map>{};
      for (final s in [...ft['statuses'], ...current['statuses']])
        statuses['${s['txid']}:${s['index']}'] = s;
      combined['statuses'] = statuses.values.toList();
      combined['replies'].addAll(current['replies']);
      final trace = <String>[], actual = await review(combined, trace: trace);
      expect(actual['preview']['transactions'], hasLength(2));
      expect(trace.where((p) => p == 'status'), hasLength(2));
      expect(trace, hasLength(6));
      expect(trace.toSet().length, 5);
    },
  );
  test(
    'historical Coin lock extraction matches frozen receipt at both domains and max',
    () {
      final source = coin['receipts'][0]['input']['rawTransaction'] as String;
      for (final lock in [0, 42, 499999999, 500000000, 0xffffffff]) {
        final tx = inspectTransaction(source);
        for (final o in tx['outputs'])
          if (o['satoshis'] == '0') {
            final b = unhex(o['scriptPubKey']);
            for (var i = 0; i < 4; i++)
              b[b.length - 10 + i] = (lock >> (8 * i)) & 255;
            o['scriptPubKey'] = hex(b);
          }
        final receipt = keyless('inspectTokenReceipt', {
          'rawTransaction': _wire(tx),
        });
        final requests = <Map<String, dynamic>>[];
        for (final r in receipt['outputs'])
          requests.add({
            'codeScript': tx['outputs'][r['codeVout']]['scriptPubKey'],
            'codeSatoshis': 500,
            'tapeScript': tx['outputs'][r['tapeVout']]['scriptPubKey'],
            'tapeSatoshis': 0,
          });
        final actual = ReviewedTokenCodec(keyless).historicalPairs(requests);
        expect(
          actual.map((p) => p['lockTime']).toList(),
          (receipt['outputs'] as List).map((p) => p['lockTime']).toList(),
        );
        expect(actual.every((p) => p['lockTime'] == lock), true);
      }
    },
  );
}
