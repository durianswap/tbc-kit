import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_reviewer.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_keyless.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';

void main() {
  final fixture = jsonDecode(
    File('test/fixtures/reviewed-associated-holder.json').readAsStringSync(),
  );
  final cases = (fixture['cases'] as List).cast<Map>();
  final sources = <String, List>{
    for (final file in [
      'reviewed-nft.json',
      'reviewed-historical-fungible.json',
    ])
      file: jsonDecode(File('test/fixtures/$file').readAsStringSync())['cases'],
  };
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
  Map<String, dynamic> keyless(String method, Map<String, dynamic> args) =>
      copied(jsonDecode(engine.call('keyless', method, canonical(args))));
  Future<ReviewedTransactionResult> review(
    Map s,
    Map request,
    List<String> calls,
  ) {
    final r = sources[s['reviewSource']['file']]!.singleWhere(
      (r) => r['name'] == s['reviewSource']['name'],
    );
    return ReviewedTransactionReviewer(
      chainId: 'tbc:testnet',
      keyless: keyless,
      now: () => DateTime.parse('2026-10-13T00:00:00.123Z'),
      read: (path) async {
        calls.add(path);
        expect(r['replies'].containsKey(path), true);
        return copied(r['replies'][path]);
      },
      readHistory: (id) async {
        calls.add('history:$id');
        return inspectTransaction(r['parents'][id], id);
      },
      status: (points) async {
        calls.add('status:${points.length}');
        return {
          'txos': [
            for (final p in points)
              copied(
                (r['statuses'] as List).singleWhere(
                  (u) =>
                      u['txid'] == p['txid'] && u['index'] == '${p['index']}',
                ),
              ),
          ],
        };
      },
    ).review(request: request, account: s['account'], requireCurrent: () {});
  }

  for (final s in cases) {
    test(
      '${s['name']} shared review and exact frozen Engine/Native/WASM result',
      () async {
        final calls = <String>[], result = await review(s, s['request'], calls);
        final rawSource = sources[s['reviewSource']['file']]!.singleWhere(
          (r) => r['name'] == s['reviewSource']['name'],
        );
        final rawCalls = <String>[],
            raw = await review(s, rawSource['request'], rawCalls);
        // The public impact/fees are identical; unsigned-preview is internal.
        expect(canonical(result.artifact), canonical(raw.artifact));
        expect(canonical(result.policyMaterial), canonical(raw.policyMaterial));
        expect(calls, rawCalls);
        expect(calls, hasLength(4));
        final stage = ReviewedKeylessStage.prepare(
          keyless: keyless,
          material: ReviewedKeylessMaterial(
            result.material,
            result.policyMaterial,
          ),
          publicKey: s['account']['publicKey'],
          transactionIndex: 0,
          previousTransactions: [],
        );
        expect(canonical(stage.value), canonical(s['stage']));
        for (final task in s['expectedDigestTasks']) {
          expect(stage.value['digests'][task['inputIndex']], task['digest']);
        }
        final finalized = stage.finalize(
          keyless,
          (s['signatures'] as List).cast<String>(),
        );
        expect(canonical(finalized), canonical(s['finalized']));
        for (final i in s['request']['payload']['sourceInputs']) {
          if (i['unlockingScriptTemplate'] != null)
            expect(
              canonical(result.artifact),
              isNot(contains(i['unlockingScriptTemplate'])),
            );
        }
      },
    );
  }
  for (final s in [
    cases.first,
    cases.firstWhere((s) => s['name'] == 'associated-historical-transfer'),
    cases.last,
  ]) {
    test(
      '${s['name']} wrong signing profile, key or placeholder is refused',
      () async {
        for (final mutation in <void Function(Map)>[
          (i) {
            i['signingProfile'] = 'p2pkh';
            i.remove('unlockingScriptTemplate');
          },
          (i) =>
              i['unlockingScriptTemplate'] =
                  (i['unlockingScriptTemplate'] as String).replaceAll(
                    s['account']['publicKey'],
                    '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
                  ),
          (i) =>
              i['unlockingScriptTemplate'] +=
                  '097369676e617475726521${s['account']['publicKey']}',
          (i) => i['unlockingScriptTemplate'] = '4c',
          (i) =>
              i['unlockingScriptTemplate'] = (i['unlockingScriptTemplate']
                      as String)
                  .replaceFirst('097369676e6174757265', '097369676e6174757264'),
        ]) {
          final request = copied(s['request']),
              input = (request['payload']['sourceInputs'] as List).firstWhere(
                (i) => i['signingProfile'] == 'contract-template',
              );
          mutation(input);
          await expectLater(review(s, request, []), throwsStateError);
        }
      },
    );
  }
  test(
    'NFT Hold and native fee cannot masquerade as contract template',
    () async {
      final s = cases.first;
      for (final index in [1, 2]) {
        final request = copied(s['request']),
            row = request['payload']['sourceInputs'][index];
        row['signingProfile'] = 'contract-template';
        row['unlockingScriptTemplate'] =
            '097369676e617475726521${s['account']['publicKey']}';
        await expectLater(review(s, request, []), throwsStateError);
      }
    },
  );
}
