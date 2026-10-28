import 'dart:async';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/txo_status_batches.dart';

List<Map<String, dynamic>> points(int n) => [
  for (var i = 0; i < n; i++) {'txid': 'ab' * 32, 'index': i},
];
Map<String, dynamic> reply(List<Map<String, dynamic>> batch) => {'txos': [
  for (final p in batch.reversed)
    {...p, 'value': '100', 'spent': false, 'scriptPubKey': '51'},
]};

void main() {
  for (final n in [1, 25, 26, 100, 101, 128, 4095, 10000]) {
    test('$n outputs: exact-once, 25 per request, at most four in flight', () async {
      final sent = <int>[];
      var active = 0, peak = 0;
      final result = await readTxoStatusBatches((batch) async {
        expect(batch.length, lessThanOrEqualTo(25));
        sent.addAll(batch.map((p) => p['index'] as int));
        active++;
        if (active > peak) peak = active;
        await Future<void>.delayed(Duration.zero);
        active--;
        return reply(batch);
      }, points(n));
      expect(sent, List.generate(n, (i) => i));
      expect(result['txos'], hasLength(n));
      expect(peak, lessThanOrEqualTo(4));
      expect(active, 0);
    });
  }
  test('bad requests do no IO, including a late invalid point', () async {
    var calls = 0;
    for (final input in [<Map<String, dynamic>>[], points(10001),
      [...points(26), points(1).single],
      [...points(100), {'txid': 'ab' * 32, 'index': -1}],
    ]) {
      await expectLater(readTxoStatusBatches((p) async {calls++; return reply(p);}, input), throwsStateError);
    }
    expect(calls, 0);
  });
  test('synchronous failure drains siblings and does not start next window', () async {
    var calls = 0, completed = 0;
    final gate = Completer<void>();
    final future = readTxoStatusBatches((p) {
      calls++;
      if (calls == 1) throw StateError('offline');
      return gate.future.then((_) {completed++; return reply(p);});
    }, points(128));
    var settled = false;
    final checked = expectLater(future, throwsStateError).then((_) => settled = true);
    await Future<void>.delayed(Duration.zero);
    expect(calls, 4);
    expect(settled, false);
    gate.complete();
    await checked;
    expect(completed, 3);
    expect(calls, 4);
  });
  for (final mode in ['missing', 'duplicate', 'unrequested', 'invalid']) {
    test('$mode reply fails instead of returning partial material', () async {
      await expectLater(readTxoStatusBatches((p) async {
        final value = reply(p), rows = value['txos'] as List;
        if (mode == 'missing') rows.removeLast();
        if (mode == 'duplicate') rows[0] = rows[1];
        if (mode == 'unrequested') rows[0]['txid'] = 'cd' * 32;
        if (mode == 'invalid') rows[0]['spent'] = 'false';
        return value;
      }, points(26)), throwsStateError);
    });
  }
  test('owns request before awaiting custom transport', () async {
    final input = points(26), gate = Completer<void>();
    final result = readTxoStatusBatches((p) async {
      await gate.future;
      return reply(p);
    }, input);
    input[0]['txid'] = 'cd' * 32;
    input.clear();
    gate.complete();
    expect((await result)['txos'], hasLength(26));
  });
}
