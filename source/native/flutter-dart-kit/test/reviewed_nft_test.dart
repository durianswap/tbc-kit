import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_status.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_preview.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_nft.dart';

String _le(BigInt n, int size) => hex([
  for (var i = 0; i < size; i++) ((n >> (8 * i)) & BigInt.from(255)).toInt(),
]);
String _size(int n) =>
    n < 253 ? _le(BigInt.from(n), 1) : 'fd${_le(BigInt.from(n), 2)}';
String _serialize(Map t) =>
    '0a000000${_size(t['inputs'].length)}'
    '${(t['inputs'] as List).map((i) => '${hex(unhex(i['txid']).reversed)}${_le(BigInt.from(i['vout']), 4)}${_size((i['scriptSig'] as String).length ~/ 2)}${i['scriptSig']}${_le(BigInt.from(i['sequence']), 4)}').join()}'
    '${_size(t['outputs'].length)}${(t['outputs'] as List).map((o) => '${_le(BigInt.parse(o['satoshis']), 8)}${_size((o['scriptPubKey'] as String).length ~/ 2)}${o['scriptPubKey']}').join()}'
    '${_le(BigInt.from(t['locktime']), 4)}';

void main() {
  final fixture =
          jsonDecode(File('test/fixtures/reviewed-nft.json').readAsStringSync())
              as Map,
      cases = (fixture['cases'] as List).cast<Map>();
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
  ReviewedNftAssets assets(
    Map s,
    List<String> trace, {
    void Function(Map)? changeIndex,
    Future<Map<String, dynamic>> Function(String)? history,
  }) => ReviewedNftAssets(
    read: (path) async {
      trace.add(path);
      final r = copied(s['replies'][path]);
      changeIndex?.call(r);
      return r;
    },
    readHistory: (id) async {
      trace.add('history:$id');
      return history != null
          ? await history(id)
          : inspectTransaction(s['parents'][id], id);
    },
    keyless: keyless,
  );
  Future<Map<String, dynamic>> review(
    Map s, {
    Map? request,
    ReviewedNftAssets? resolver,
    List<String>? calls,
    void Function()? authority,
    Future<void> Function(List<Map<String, dynamic>>)? holdStatus,
    void Function(Map)? changeStatus,
  }) async {
    final trace = calls ?? <String>[],
        current = authority ?? () {},
        material = normalizeReviewedMaterial(request ?? s['request']),
        plan = ReviewedRawPlan.fromMaterial(material);
    final status = ReviewedStatusReader(
      plan: plan,
      requireCurrent: current,
      status: (points) async {
        trace.add('status:${points.length}');
        await holdStatus?.call(points);
        final result = {
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
        changeStatus?.call(result);
        return result;
      },
    );
    final inputs = await status.readInputs();
    final views = await reviewNftHolderTransactions(
      plan: plan,
      status: status,
      verifiedInputs: inputs,
      material: material,
      account: s['account'],
      chainId: 'tbc:testnet',
      transactionIndexes: List.generate(plan.transactions.length, (i) => i),
      assets: resolver ?? assets(s, trace),
      requireCurrent: current,
    );
    final policy = status.policyMaterial();
    checkReviewedIssuancePolicy(
      plan: plan,
      policyMaterial: policy,
      keyless: keyless,
    );
    final structured = {'transactions': views.values.toList()};
    return {
      'structured': structured,
      'policy': policy,
      'artifact': bindReviewedArtifact(
        plan: plan,
        structuredPreview: structured,
        policyMaterial: policy,
        now: DateTime.parse('2026-10-13T00:00:00.123Z'),
      ),
    };
  }

  for (final s in cases) {
    test(
      'Reviewed ${s['name']} authenticated identity and Native/WASM policy',
      () async {
        expect(
          canonical(keyless('inspectTokenMaterial', copied(s['inspection']))),
          canonical(s['identity']),
        );
        expect(
          canonical(keyless('inspectTokenMaterial', copied(s['policyInput']))),
          canonical(s['policyResult']),
        );
        final calls = <String>[],
            resolver = assets(s, calls),
            r = await review(s, resolver: resolver, calls: calls),
            view = r['structured']['transactions'][0],
            asset = view['groups'][0]['asset'];
        expect(asset['contractId'], s['expectedIdentity']['contractId']);
        expect(asset['collectionId'], s['expectedIdentity']['collectionId']);
        expect(asset['tokenId'], s['expectedIdentity']['tokenId']);
        expect(view['feeSatoshis'], s['originalEnginePreview']['totalFee']);
        expect(r['artifact']['payload']['preview']['assetFlows'], isEmpty);
        expect(calls, hasLength(4));
        expect(calls.where((c) => c.startsWith('status:')).toList(), [
          'status:3',
          'status:1',
        ]);
        calls.clear();
        final warm = await review(s, resolver: resolver, calls: calls);
        expect(canonical(warm), canonical(r));
        expect(calls, ['status:3', 'status:1']);
      },
    );
  }
  final current = cases.first;
  Map changed(Map source, void Function(Map tx, List inputs) change) {
    final r = copied(source['request']),
        row = r['payload']['transactions'][0],
        tx = inspectTransaction(row['rawTransaction']);
    change(tx, row['inputs']);
    row['rawTransaction'] = _serialize(tx);
    return r;
  }

  test(
    'Reviewed NFT external recipient and native payment are both visible',
    () async {
      final r = changed(current, (tx, _) {
        tx['outputs'][1]['scriptPubKey'] = (tx['outputs'][1]['scriptPubKey']
                as String)
            .replaceAll('751e76e8199196d454941c45d1b3a323f1433bd6', '22' * 20);
        tx['outputs'][3]['scriptPubKey'] = '76a914${'33' * 20}88ac';
      });
      final actual = await review(current, request: r),
          flows =
              actual['artifact']['payload']['preview']['assetFlows'] as List;
      expect(flows, hasLength(2));
      expect(flows[0], {
        'kind': 'nft',
        'direction': 'send',
        'amount': '1',
        'contractId': current['expectedIdentity']['contractId'],
        'from': current['account']['address'],
        'to': '147Us9aEq2PvBC5wobBJw1yEpQEbPKzssA',
      });
      expect(flows[1]['kind'], 'native');
      expect(flows[1]['direction'], 'send');
      expect(flows[1]['amount'], '9999853');
    },
  );
  test(
    'Reviewed NFT input order does not change paired Hold ownership',
    () async {
      final r = changed(current, (tx, inputs) {
        final a = tx['inputs'].removeAt(1), b = inputs.removeAt(1);
        tx['inputs'].insert(0, a);
        inputs.insert(0, b);
      });
      final result = await review(current, request: r);
      expect(
        result['structured']['transactions'][0]['groups'][0]['asset']['contractId'],
        current['expectedIdentity']['contractId'],
      );
    },
  );
  test(
    'Reviewed missing or orphan Hold rejects before dependency fetch',
    () async {
      for (final remove in [0, 1]) {
        final r = changed(current, (tx, inputs) {
              // Keep the fee unchanged so this reaches the paired-Hold boundary,
              // rather than failing earlier because removing Code overspends.
              final removed = BigInt.parse(inputs[remove]['satoshis']);
              tx['outputs'].last['satoshis'] =
                  '${BigInt.parse(tx['outputs'].last['satoshis']) - removed}';
              tx['inputs'].removeAt(remove);
              inputs.removeAt(remove);
            }),
            calls = <String>[];
        await expectLater(
          review(current, request: r, calls: calls),
          throwsStateError,
        );
        expect(calls, ['status:2']);
      }
    },
  );
  test(
    'Reviewed NFT changed Code, Tape, Hold, duplicates or burn cannot pass',
    () async {
      for (final change in <void Function(Map, List)>[
        (tx, _) =>
            tx['outputs'][0]['scriptPubKey'] =
                '00${(tx['outputs'][0]['scriptPubKey'] as String).substring(2)}',
        (tx, _) =>
            tx['outputs'][2]['scriptPubKey'] = (tx['outputs'][2]['scriptPubKey']
                    as String)
                .replaceFirst('4e4654', '424144'),
        (tx, _) => tx['outputs'][1]['satoshis'] = '99',
        (tx, _) => tx['outputs'].addAll([
          for (final o in (tx['outputs'] as List).take(3)) copied(o),
        ]),
        (tx, _) => tx['outputs'].removeRange(0, 3),
        (tx, _) => tx['outputs'][1]['scriptPubKey'] = '76a914${'22' * 20}88ac',
      ])
        await expectLater(
          review(current, request: changed(current, change)),
          throwsStateError,
        );
    },
  );
  test(
    'Reviewed NFT index alias, selected point, collection and code are checked',
    () async {
      for (final change in <void Function(Map)>[
        (r) => r['utxos'][0]['nft_id'] = '00' * 32,
        (r) => r['utxos'][0]['txid'] = '00' * 32,
        (r) => r['utxos'][0]['vout'] = 1,
        (r) => r['utxos'][0]['collection_id'] = '00' * 32,
        (r) => r['utxos'][0]['script_pubkey'] = '51',
      ]) {
        final calls = <String>[];
        await expectLater(
          review(
            current,
            resolver: assets(current, calls, changeIndex: change),
          ),
          throwsStateError,
        );
      }
    },
  );
  test(
    'Reviewed NFT complete origin raw is checked, not forged parsed fields',
    () async {
      final calls = <String>[],
          other = cases.singleWhere((s) => s['name'] == 'historical-nft-v2');
      await expectLater(
        review(
          current,
          resolver: assets(
            current,
            calls,
            history: (id) async {
              final p = inspectTransaction(current['parents'][id]);
              p['rawTransaction'] =
                  other['parents'][other['expectedIdentity']['contractId']];
              return p;
            },
          ),
        ),
        throwsStateError,
      );
    },
  );
  test(
    'Reviewed spent or wrong-owner NFT cannot use cached immutable identity',
    () async {
      final calls = <String>[], resolver = assets(current, calls);
      await review(current, resolver: resolver);
      calls.clear();
      await expectLater(
        review(
          current,
          resolver: resolver,
          calls: calls,
          changeStatus: (r) {
            r['txos'][1]['spent'] = true;
          },
        ),
        throwsStateError,
      );
      expect(calls, ['status:3']);
      final wrongOwner = copied(current);
      final input =
          wrongOwner['request']['payload']['transactions'][0]['inputs'][1];
      input['scriptPubKey'] = (input['scriptPubKey'] as String).replaceAll(
        '751e76e8199196d454941c45d1b3a323f1433bd6',
        '22' * 20,
      );
      final first =
          inspectTransaction(
            wrongOwner['request']['payload']['transactions'][0]['rawTransaction'],
          )['inputs'][1];
      final observed = (wrongOwner['statuses'] as List).singleWhere(
        (s) => s['txid'] == first['txid'] && s['index'] == '${first['vout']}',
      );
      observed['scriptPubKey'] = input['scriptPubKey'];
      calls.clear();
      await expectLater(
        review(wrongOwner, resolver: resolver, calls: calls),
        throwsStateError,
      );
      expect(calls, ['status:3']);
    },
  );
  test(
    'Reviewed NFT Tape status and immutable identity reads overlap',
    () async {
      final held = Completer<void>(),
          indexStarted = Completer<void>(),
          calls = <String>[];
      final resolver = ReviewedNftAssets(
        read: (path) async {
          indexStarted.complete();
          return copied(current['replies'][path]);
        },
        readHistory:
            (id) async => inspectTransaction(current['parents'][id], id),
        keyless: keyless,
      );
      final pending = review(
        current,
        resolver: resolver,
        calls: calls,
        holdStatus: (points) async {
          if (points.length == 1) await held.future;
        },
      );
      await indexStarted.future;
      expect(calls, ['status:3', 'status:1']);
      held.complete();
      await pending;
    },
  );
  test(
    'Reviewed NFT revoked authority cancels late origin without new reads',
    () async {
      final started = Completer<void>(),
          resume = Completer<void>(),
          calls = <String>[];
      var alive = true;
      final resolver = assets(
        current,
        calls,
        history: (id) async {
          started.complete();
          await resume.future;
          return inspectTransaction(current['parents'][id], id);
        },
      );
      final pending = review(
        current,
        resolver: resolver,
        calls: calls,
        authority: () {
          if (!alive) throw StateError('revoked');
        },
      );
      final assertion = expectLater(pending, throwsStateError);
      await started.future;
      alive = false;
      resume.complete();
      await assertion;
      expect(calls, hasLength(4));
    },
  );
}
