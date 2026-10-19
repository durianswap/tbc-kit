import 'dart:async';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/private_host_channel.dart';

Map<Object?, Object?> call(
  int n, {
  String runtime = 'native_A',
  String method = 'accounts.current',
  String input = 'null',
}) => {
  'runtimeId': runtime,
  'callId': '$runtime:$n',
  'method': method,
  'input': input,
};

void main() {
  test(
    'parallel callbacks resolve out of order, once, without copying signed input',
    () async {
      final pending = <int, Completer<String>>{},
          replies = <Map<String, Object>>[],
          seen = <TbcPrivateHostCall>[];
      final d = TbcPrivateHostDispatcher(
        runtimeId: 'native_A',
        reply: replies.add,
        handle: (c) {
          seen.add(c);
          final id = int.parse(c.callId.split(':').last);
          return (pending[id] = Completer<String>()).future;
        },
      );
      final a = d.receive(
        call(1, input: '{"issuedAt":"2026-10-07T00:00:00Z"}'),
      );
      final b = d.receive(call(2, method: 'clock.now'));
      expect(d.pendingCount, 2);
      expect(seen[0].input, '{"issuedAt":"2026-10-07T00:00:00Z"}');
      pending[2]!.complete('"clock"');
      expect(await b, true);
      pending[1]!.complete('[]');
      expect(await a, true);
      expect(replies.map((r) => r['callId']).toList(), [
        'native_A:2',
        'native_A:1',
      ]);
      expect(await d.receive(call(1)), false);
      expect(seen.length, 2);
      expect(d.pendingCount, 0);
    },
  );
  test(
    'close invalidates call before delayed unlock continuation and suppresses response',
    () async {
      final unlock = Completer<void>(), replies = <Map<String, Object>>[];
      var signs = 0;
      late TbcPrivateHostCall captured;
      final d = TbcPrivateHostDispatcher(
        runtimeId: 'native_A',
        reply: replies.add,
        handle: (c) async {
          captured = c;
          await unlock.future;
          c.requireActive();
          signs++;
          return '{}';
        },
      );
      final result = d.receive(call(1, method: 'signer.sign'));
      expect(captured.isActive, true);
      d.close();
      d.close();
      unlock.complete();
      expect(await result, false);
      expect(captured.isActive, false);
      expect(signs, 0);
      expect(replies, isEmpty);
      expect(await d.receive(call(2)), false);
      // This is a same-isolate mock, not a real Vault atomicity proof.
    },
  );
  test('wrong scope and unknown methods cannot reach a handler', () async {
    var count = 0;
    final d = TbcPrivateHostDispatcher(
      runtimeId: 'native_A',
      reply: (_) {},
      handle: (_) {
        count++;
        return '{}';
      },
    );
    expect(await d.receive(call(1, runtime: 'old')), false);
    await expectLater(
      d.receive(call(1, method: 'engine.plan')),
      throwsFormatException,
    );
    await expectLater(
      d.receive(call(1, method: 'signAnything')),
      throwsFormatException,
    );
    expect(count, 0);
  });
  test(
    'capacity rejects before handler, malformed or oversized values fail closed',
    () async {
      final held = Completer<String>(), replies = <Map<String, Object>>[];
      var count = 0;
      final d = TbcPrivateHostDispatcher(
        runtimeId: 'native_A',
        maxPending: 1,
        maxWireCodeUnits: 8,
        reply: replies.add,
        handle: (_) {
          count++;
          return held.future;
        },
      );
      final a = d.receive(call(1));
      expect(await d.receive(call(2)), true);
      expect(replies.single['status'], 'error');
      expect(count, 1);
      await expectLater(
        d.receive(call(3, input: 'x' * 9)),
        throwsFormatException,
      );
      held.complete('x' * 9);
      expect(await a, true);
      expect(replies.last['status'], 'error');
    },
  );
  test(
    'exception details and payloads are redacted; delivery failure is never retried',
    () async {
      final replies = <Map<String, Object>>[];
      final d = TbcPrivateHostDispatcher(
        runtimeId: 'native_A',
        reply: replies.add,
        handle: (c) {
          expect(c.toString(), isNot(contains('private-data')));
          throw StateError('private-data');
        },
      );
      expect(
        await d.receive(
          call(1, method: 'crypto.execute', input: 'private-data'),
        ),
        true,
      );
      expect(replies.single, {
        'runtimeId': 'native_A',
        'callId': 'native_A:1',
        'status': 'error',
      });
      var count = 0;
      final failed = TbcPrivateHostDispatcher(
        runtimeId: 'native_B',
        handle: (_) => '{}',
        reply: (_) {
          count++;
          throw StateError('secret');
        },
      );
      await expectLater(
        failed.receive(call(1, runtime: 'native_B')),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'message',
            'Private Host delivery failed',
          ),
        ),
      );
      expect(await failed.receive(call(1, runtime: 'native_B')), false);
      expect(count, 1);
    },
  );
}
