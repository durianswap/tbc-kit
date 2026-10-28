// Read-only API fan-out shared by native and injected transports. Callers keep
// their ownership, unspentness and authority checks. No retry or global cache.
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'txo_status_reply.dart';

typedef TxoStatusTransport = Future<Map<String, dynamic>> Function(
  List<Map<String, dynamic>> points,
);

Future<Map<String, dynamic>> readTxoStatusBatches(
  TxoStatusTransport transport,
  List<Map<String, dynamic>> points, {
  bool requireComplete = true,
  bool tolerateTransportFailure = false,
}
) async {
  need(points.isNotEmpty && points.length <= 10000, 'TXO_STATUS_BOUND');
  final seen = <String>{};
  final owned = <Map<String, dynamic>>[];
  // Own and validate the entire request before the first asynchronous callback.
  for (final point in points) {
    need(point.length == 2 && point['index'] is int &&
        point['index'] >= 0 && point['index'] <= 0xffffffff,
        'TXO_STATUS_POINT');
    final id = hash32(point['txid']), index = point['index'] as int;
    need(seen.add('$id:$index'), 'TXO_STATUS_DUPLICATE');
    owned.add(Map.unmodifiable({'txid': id, 'index': index}));
  }
  final rows = <Map<String, dynamic>>[];
  var unavailable = false;
  for (var offset = 0; offset < owned.length; offset += 100) {
    final flights = <Future<List<Map<String, dynamic>>>>[];
    for (var start = offset; start < owned.length && start < offset + 100;
        start += 25) {
      final end = start + 25 < owned.length ? start + 25 : owned.length;
      final batch = List<Map<String, dynamic>>.unmodifiable(
        owned.sublist(start, end),
      );
      flights.add(() async {
        Map<String, dynamic> wire;
        try { wire = await transport(batch); }
        catch (_) {
          if (!tolerateTransportFailure) rethrow;
          unavailable = true;
          return <Map<String, dynamic>>[];
        }
        final reply = normalizeTxoStatusReply(wire);
        final result = (reply['txos'] as List).cast<Map<String, dynamic>>();
        final expected = batch.map((p) => '${p['txid']}:${p['index']}').toSet();
        need(!requireComplete || result.length == expected.length,
            'TXO_STATUS_INCOMPLETE');
        for (final row in result) {
          need(expected.remove('${row['txid']}:${row['index']}'),
              'TXO_STATUS_IDENTITY');
        }
        need(!requireComplete || expected.isEmpty, 'TXO_STATUS_INCOMPLETE');
        return result;
      }());
    }
    // Drain siblings even on a synchronous adapter failure. Never dispatch the
    // next window or expose a partially successful result after failure.
    final window = await Future.wait(flights, eagerError: false);
    for (final result in window) { rows.addAll(result); }
  }
  return {'txos': rows, if (unavailable) 'statusUnavailable': true};
}
