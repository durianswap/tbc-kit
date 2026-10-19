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
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_keyless.dart';

void main() {
  final fixture =
      jsonDecode(
            File('test/fixtures/reviewed-material-b.json').readAsStringSync(),
          )
          as Map;
  final samples = (fixture['cases'] as List).cast<Map>();
  const publicKey =
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  late ComputeProbe engine;
  setUpAll(() {
    final library =
        jsonDecode(
          File('test/fixtures/signing/replay.json').readAsStringSync(),
        )['library'];
    expect(
      sha256.convert(File(library['path']).readAsBytesSync()).toString(),
      library['sha256'],
    );
    engine = ComputeProbe(DynamicLibrary.open(library['path']));
  });
  Map<String, dynamic> keyless(String method, Map<String, dynamic> input) =>
      copied(jsonDecode(engine.call('keyless', method, canonical(input))));
  Map<String, dynamic> material(Map sample) =>
      normalizeReviewedMaterial(sample['request']);
  for (final s in samples) {
    test('Reviewed ${s['name']} exact frozen normalization', () {
      final input = copied(s['request']),
          normalized = normalizeReviewedMaterial(input);
      expect(canonical(normalized), canonical(s['material']));
      input.clear();
      expect(canonical(normalized), canonical(s['material']));
      expect(
        () => normalized['request']['override'] = true,
        throwsUnsupportedError,
      );
    });
    if (s['stages'] != null)
      test(
        'Reviewed ${s['name']} Native/WASM stage digest and finalized-byte parity',
        () {
          final normalized = material(s), parents = <String>[];
          final owned = ReviewedKeylessMaterial(normalized, {
            'resolvedOutputs': s['resolvedOutputs'],
          });
          for (var i = 0; i < (s['stages'] as List).length; i++) {
            final expected = s['stages'][i];
            final stage = ReviewedKeylessStage.prepare(
              keyless: keyless,
              material: owned,
              publicKey: publicKey,
              transactionIndex: i,
              previousTransactions:
                  normalized['format'] == 'raw' ? [] : parents,
            );
            expect(canonical(stage.value), canonical(expected['stage']));
            final result = stage.finalize(
              keyless,
              (expected['signatures'] as List).cast<String>(),
            );
            expect(canonical(result), canonical(expected['finalized']));
            parents.add(result['txraw']);
          }
        },
      );
    if (s['review'] != null)
      test(
        'Reviewed ${s['name']} fee and one trusted batched read match frozen reviewer',
        () async {
          final plan = ReviewedRawPlan.fromMaterial(material(s)),
              queries = <List>[];
          expect(plan.totalFee, s['review']['payload']['totalFee']);
          final reader = ReviewedStatusReader(
            plan: plan,
            requireCurrent: () {},
            status: (points) async {
              queries.add(points);
              return {
                'txos':
                    points
                        .map(
                          (p) => (s['statuses'] as List).singleWhere(
                            (v) =>
                                v['txid'] == p['txid'] &&
                                v['index'] == '${p['index']}',
                          ),
                        )
                        .toList(),
              };
            },
          );
          final inputs = await reader.readInputs();
          expect(queries, hasLength(1));
          expect(
            canonical({'txos': queries[0]}),
            canonical(s['statusQueries'][0]),
          );
          expect(inputs.length, plan.transactionIds.length);
          expect(
            canonical(reader.policyMaterial()),
            canonical(s['review']['payload']['policyMaterial']),
          );
          final point = inputs[0][0];
          await reader.readDependencies([
            {'txid': point['txid'], 'vout': point['vout']},
          ]);
          expect(queries, hasLength(1));
          await expectLater(reader.readInputs(), throwsStateError);
        },
      );
  }
  for (final bad in fixture['invalid'] as List)
    test('Reviewed ${bad['name']} rejected before material or key use', () {
      expect(() => normalizeReviewedMaterial(bad['request']), throwsStateError);
    });
  test(
    'Reviewed safe amount, row bound, role and current-proof constraints',
    () {
      final original = samples[0]['request'];
      for (final mutate in <void Function(Map)>[
        (r) =>
            r['payload']['transactions'][0]['inputs'][0]['satoshis'] =
                '9007199254740992',
        (r) =>
            r['payload']['transactions'][0]['inputs'][0]['signingRole'] =
                'coin-admin',
        (r) =>
            r['payload']['transactions'] = List.filled(
              33,
              r['payload']['transactions'][0],
            ),
        (r) => r['payload']['transactions'][0]['inputs'] = [],
      ]) {
        final r = copied(original);
        mutate(r);
        expect(() => normalizeReviewedMaterial(r), throwsStateError);
      }
      final current = samples.singleWhere(
        (s) => s['name'] == 'mapping-tbc20-standard',
      );
      for (final field in [
        'previousTransaction',
        'ancestorTransactions',
        'satoshis',
        'scriptPubKey',
      ]) {
        final r = copied(current['request']);
        r['payload']['sourceInputs'][0].remove(field);
        expect(() => normalizeReviewedMaterial(r), throwsStateError);
      }
      final r = copied(current['request']);
      r['payload']['sourceInputs'][0]['unlockingScriptTemplate'] = '00';
      expect(() => normalizeReviewedMaterial(r), throwsStateError);
    },
  );
  test('Reviewed parent index, source mismatch and negative fee refuse', () {
    final source = samples.singleWhere(
      (s) => s['name'] == 'associated-two-dependent',
    );
    for (final mutate in <void Function(Map)>[
      (r) => r['payload']['sourceInputs'][0]['outputIndex'] = 1,
      (r) => r['payload']['children'][0]['inputs'][0]['outputIndex'] = 999,
      (r) => r['payload']['children'][0]['inputs'][0]['satoshis'] = '1',
      (r) => r['payload']['children'][0]['inputs'][0]['scriptPubKey'] = '51',
      (r) =>
          r['payload']['children'][0]['outputs'][0]['satoshis'] = '999999999',
    ]) {
      final r = copied(source['request']);
      mutate(r);
      expect(
        () => ReviewedRawPlan.fromMaterial(normalizeReviewedMaterial(r)),
        throwsStateError,
      );
    }
  });
  test(
    'Reviewed 512 inputs use one status batch rather than per-input queries',
    () async {
      final source = samples[0]['request']['payload']['transactions'][0];
      final points = [
        for (var i = 0; i < 512; i++) i.toRadixString(16).padLeft(64, '0'),
      ];
      final raw =
          '0a000000fd0002${points.map((id) => '${hex(unhex(id).reversed)}0000000000ffffffff').join()}'
          '${(source['rawTransaction'] as String).substring(92)}';
      final request = {
        'payload': {
          'format': 'raw',
          'transactions': [
            {
              'rawTransaction': raw,
              'inputs': List.generate(
                512,
                (_) => {
                  'satoshis': '20000',
                  'scriptPubKey': source['inputs'][0]['scriptPubKey'],
                },
              ),
            },
          ],
        },
      };
      final plan = ReviewedRawPlan.fromMaterial(
        normalizeReviewedMaterial(request),
      );
      var reads = 0;
      final reader = ReviewedStatusReader(
        plan: plan,
        requireCurrent: () {},
        status: (rows) async {
          reads++;
          expect(rows, hasLength(512));
          return {
            'txos':
                rows
                    .map(
                      (p) => {
                        'txid': p['txid'],
                        'index': '${p['index']}',
                        'spent': false,
                        'value': '20000',
                        'scriptPubKey': source['inputs'][0]['scriptPubKey'],
                      },
                    )
                    .toList(),
          };
        },
      );
      expect((await reader.readInputs()).single, hasLength(512));
      expect(reads, 1);
    },
  );
  test(
    'Reviewed trusted status missing, duplicate, spent, amount/script/identity mismatch fail closed',
    () async {
      final s = samples[0], plan = ReviewedRawPlan.fromMaterial(material(s));
      for (final mutate in <void Function(List)>[
        (rows) => rows.clear(),
        (rows) => rows.add(copied(rows[0])),
        (rows) => rows[0]['spent'] = true,
        (rows) => rows[0]['value'] = '19999',
        (rows) => rows[0]['scriptPubKey'] = '51',
        (rows) => rows[0]['txid'] = '00' * 32,
      ]) {
        final reader = ReviewedStatusReader(
          plan: plan,
          requireCurrent: () {},
          status: (points) async {
            final rows = (s['statuses'] as List).map((r) => copied(r)).toList();
            mutate(rows);
            return {'txos': rows};
          },
        );
        await expectLater(reader.readInputs(), throwsStateError);
        expect(reader.policyMaterial, throwsStateError);
        await expectLater(reader.readDependencies([]), throwsStateError);
      }
    },
  );
  test(
    'Reviewed status never survives authority change or another operation',
    () async {
      final s = samples[0],
          plan = ReviewedRawPlan.fromMaterial(material(s)),
          gate = Completer<void>();
      var live = true, reads = 0;
      Future<Map<String, dynamic>> status(List<Map<String, dynamic>> _) async {
        reads++;
        await gate.future;
        return {'txos': s['statuses']};
      }

      final reader = ReviewedStatusReader(
        plan: plan,
        requireCurrent: () => need(live, 'CANCELED'),
        status: status,
      );
      final pending = reader.readInputs();
      live = false;
      gate.complete();
      await expectLater(pending, throwsStateError);
      expect(reader.policyMaterial, throwsStateError);
      live = true;
      final fresh = ReviewedStatusReader(
        plan: plan,
        requireCurrent: () => need(live, 'CANCELED'),
        status: status,
      );
      await fresh.readInputs();
      expect(reads, 2);
    },
  );
  test(
    'Reviewed dependencies share an operation snapshot and never pollute policy with unrequested rows',
    () async {
      final s = samples[0], plan = ReviewedRawPlan.fromMaterial(material(s));
      var reads = 0;
      final reader = ReviewedStatusReader(
        plan: plan,
        requireCurrent: () {},
        status: (points) async {
          reads++;
          if (reads == 1) return {'txos': s['statuses']};
          return {
            'txos': [
              {
                'txid': '77' * 32,
                'index': '1',
                'spent': false,
                'value': '0',
                'scriptPubKey': '006a',
              },
            ],
          };
        },
      );
      await reader.readInputs();
      await expectLater(
        reader.readDependencies([
          {'txid': '66' * 32, 'vout': 1},
        ]),
        throwsStateError,
      );
      expect(reader.policyMaterial, throwsStateError);
      expect(reads, 2);
    },
  );
  test(
    'Reviewed policy sorts exact outputs and refuses conflicting duplicate/out-of-range data',
    () {
      final rows =
          (samples[1]['resolvedOutputs'] as List)
              .map((r) => copied(r))
              .toList();
      final a = normalizeReviewedPolicy({'resolvedOutputs': rows});
      expect(
        canonical(a),
        canonical(
          normalizeReviewedPolicy({'resolvedOutputs': rows.reversed.toList()}),
        ),
      );
      expect(
        () => normalizeReviewedPolicy({
          'resolvedOutputs': [rows[0], rows[0]],
        }),
        throwsStateError,
      );
      final bad = copied(rows[0])..['satoshis'] = '18446744073709551616';
      expect(
        () => normalizeReviewedPolicy({
          'resolvedOutputs': [bad],
        }),
        throwsStateError,
      );
    },
  );
  test(
    'Reviewed keyless stage refuses altered identity, incorrect previous count and altered final outputs',
    () {
      final s = samples[0], m = material(s);
      ReviewedKeylessStage prepare({
        int index = 0,
        List<String> parents = const [],
        bool corrupt = false,
      }) => ReviewedKeylessStage.prepare(
        keyless: (method, input) {
          final result = keyless(method, input);
          if (corrupt) result['publicKey'] = '02' + '00' * 32;
          return result;
        },
        material: ReviewedKeylessMaterial(m, {
          'resolvedOutputs': s['resolvedOutputs'],
        }),
        publicKey: publicKey,
        transactionIndex: index,
        previousTransactions: parents,
      );
      expect(() => prepare(index: 1), throwsStateError);
      expect(
        () => prepare(parents: [s['stages'][0]['finalized']['txraw']]),
        throwsStateError,
      );
      expect(() => prepare(corrupt: true), throwsStateError);
      final stage = prepare(),
          sigs = (s['stages'][0]['signatures'] as List).cast<String>();
      expect(() => stage.finalize(keyless, []), throwsStateError);
      expect(() => stage.finalize(keyless, ['00' * 64]), throwsStateError);
      expect(
        () => stage.finalize(
          (method, input) => {
            'txraw': s['stages'][0]['stage']['txraw'],
            'txid': '00' * 32,
            'sigs': ['01'],
          },
          sigs,
        ),
        throwsStateError,
      );
    },
  );
}
