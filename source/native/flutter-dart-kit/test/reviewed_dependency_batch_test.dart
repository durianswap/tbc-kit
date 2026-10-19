import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_status.dart';

void main() {
  final s =
      jsonDecode(
        File('test/fixtures/reviewed-preview.json').readAsStringSync(),
      )['cases'][0];
  final a = <String, dynamic>{'txid': 'aa' * 32, 'vout': 0},
      b = <String, dynamic>{'txid': 'bb' * 32, 'vout': 1},
      c = <String, dynamic>{'txid': 'cc' * 32, 'vout': 2};
  ReviewedStatusReader reader(
    List<List<Map>> calls, {
    Future<void> Function()? wait,
    void Function()? current,
    bool bad = false,
  }) => ReviewedStatusReader(
    plan: ReviewedRawPlan.fromMaterial(normalizeReviewedMaterial(s['request'])),
    requireCurrent: current ?? () {},
    status: (points) async {
      calls.add(points);
      if (calls.length == 1) return {'txos': s['statuses']};
      await wait?.call();
      return {
        'txos':
            bad
                ? []
                : [
                  for (final p in points)
                    {
                      'txid': p['txid'],
                      'index': '${p['index']}',
                      'value': '0',
                      'scriptPubKey': '006a00',
                      'spent': true,
                    },
                ],
      };
    },
  );

  test(
    'parallel Tape requests coalesce and preserve each caller order',
    () async {
      final calls = <List<Map>>[], r = reader(calls);
      await r.readInputs();
      final results = await Future.wait([
        r.readDependencies([a, b]),
        r.readDependencies([b, c, a]),
      ]);
      expect(calls.length, 2);
      expect(calls.last.map((p) => p['txid']), [
        a['txid'],
        b['txid'],
        c['txid'],
      ]);
      expect(results[1].map((p) => p['txid']), [
        b['txid'],
        c['txid'],
        a['txid'],
      ]);
      expect(r.policyMaterial()['resolvedOutputs'], hasLength(4));
      await r.readDependencies([a, b, c]);
      expect(calls.length, 2);
    },
  );
  test(
    'late request shares in-flight response and fetches only missing points',
    () async {
      final calls = <List<Map>>[],
          started = Completer<void>(),
          finish = Completer<void>();
      final r = reader(
        calls,
        wait: () async {
          if (!started.isCompleted) started.complete();
          await finish.future;
        },
      );
      await r.readInputs();
      final first = r.readDependencies([a, b]);
      expect(r.policyMaterial, throwsStateError);
      await started.future;
      final late = r.readDependencies([b, c]);
      expect(r.policyMaterial, throwsStateError);
      finish.complete();
      await Future.wait([first, late]);
      expect(calls.length, 3);
      expect(calls.last, [
        {'txid': c['txid'], 'index': c['vout']},
      ]);
      expect(r.policyMaterial()['resolvedOutputs'], hasLength(4));
    },
  );
  test(
    'shared transport failure drains all waiters and never retries',
    () async {
      final calls = <List<Map>>[], r = reader(calls, bad: true);
      await r.readInputs();
      await expectLater(
        Future.wait([
          r.readDependencies([a]),
          r.readDependencies([b]),
        ]),
        throwsStateError,
      );
      expect(calls.length, 2);
      expect(r.policyMaterial, throwsStateError);
      await expectLater(r.readDependencies([c]), throwsStateError);
      expect(calls.length, 2);
    },
  );
  test('revoked coalesced reply never becomes usable policy', () async {
    final calls = <List<Map>>[];
    var revoked = false;
    final r = reader(
      calls,
      wait: () async {
        revoked = true;
      },
      current: () {
        if (revoked) throw StateError('REVOKED');
      },
    );
    await r.readInputs();
    await expectLater(
      Future.wait([
        r.readDependencies([a]),
        r.readDependencies([b]),
      ]),
      throwsStateError,
    );
    expect(r.policyMaterial, throwsStateError);
    expect(calls.length, 2);
  });
  test(
    'invalid dependency point is rejected without sending any read',
    () async {
      final calls = <List<Map>>[], r = reader(calls);
      await r.readInputs();
      await expectLater(
        r.readDependencies([
          {'txid': a['txid'], 'vout': -1},
        ]),
        throwsStateError,
      );
      expect(calls.length, 1);
    },
  );
}
