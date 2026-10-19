// Follow only explicit cursors. No extra GET on unpaged indexes, raw-parent
// reads, retries, mutable cache or changes to the caller's selection bound.
import 'protocol_codec.dart';
import 'transaction_read.dart';

Future<Map<String, dynamic>> collectUtxoPages(
  Future<Map<String, dynamic>> Function(String path) read,
  String path, {
  required int maxRows,
  int maxPages = 16,
  bool allowNull = false,
}) async {
  need(
    maxRows >= 1 &&
        maxRows <= 10000 &&
        maxPages >= 1 &&
        maxPages <= 64 &&
        !path.contains('?') &&
        !path.contains('#'),
    'UTXO_PAGE_BOUNDS',
  );
  final seen = <String>{},
      cursors = <String>{},
      rows = <Map<String, dynamic>>[];
  String? cursor;
  for (var page = 0; page < maxPages; page++) {
    final data = await read(
      cursor == null ? path : '$path?after=${Uri.encodeQueryComponent(cursor)}',
    );
    final values =
        allowNull && data.containsKey('utxos') && data['utxos'] == null
            ? []
            : data['utxos'];
    need(values is List && values.length <= 10000, 'UTXO_PAGE');
    final current = <String>{};
    for (final row in values) {
      need(row is Map, 'UTXO_ROW');
      final id = hash32(row['txid']),
          vout = uintString(row['index'] ?? row['vout']);
      need(BigInt.parse(vout) <= BigInt.from(0xffffffff), 'VOUT_RANGE');
      final point = '$id:$vout';
      need(current.add(point), 'DUPLICATE_UTXO');
      if (!seen.add(point)) continue;
      rows.add(Map<String, dynamic>.from(row));
      need(rows.length <= maxRows, 'UTXO_SELECTION_BOUND');
    }
    final next = data['next_cursor'];
    if (!data.containsKey('next_cursor') || next == '') return {'utxos': rows};
    need(
      next is String &&
          next.isNotEmpty &&
          next.length <= 2048 &&
          cursors.add(next),
      'UTXO_CURSOR',
    );
    cursor = next;
  }
  throw StateError('UTXO_PAGE_BOUND');
}
