import 'protocol_codec.dart';
import 'transaction_read.dart';

/// Same wire-to-DTO boundary as TS official-api.ts: deployed results/status and
/// an already normalized txos reply both become the existing reader contract.
/// Identity, requested set, ownership and unspentness remain reader checks.
Map<String, dynamic> normalizeTxoStatusReply(Map value) {
  List<Map<String, dynamic>> rows(Object? source, bool canonicalShape) {
    need(source is List && source.length <= 10000, 'TXO_STATUS_LIST');
    return [
      for (final item in source as List)
        () {
          need(item is Map, 'TXO_STATUS_ROW');
          final row = item as Map;
          final state = canonicalShape ? row : row['status'];
          need(state is Map && state['spent'] is bool, 'TXO_STATUS_STATE');
          final script =
              canonicalShape ? row['scriptPubKey'] : row['scriptpubkey'];
          need(
            script == null ||
                (script is String &&
                    RegExp(r'^(?:[0-9a-f]{2})*$').hasMatch(script)),
            'TXO_STATUS_SCRIPT',
          );
          final height = row['height'];
          return <String, dynamic>{
            'txid': hash32(row['txid']),
            'index': uintString(row['index']),
            'value': uintString(row['value']),
            'spent': state['spent'],
            if (script != null) 'scriptPubKey': script,
            if (height != null)
              'height':
                  height == -1 || height == '-1' ? '0' : uintString(height),
          };
        }(),
    ];
  }

  final canonicalShape = value['txos'] is List;
  final normalized = rows(
    canonicalShape ? value['txos'] : value['results'],
    canonicalShape,
  );
  if (canonicalShape && value.containsKey('results')) {
    need(
      canonical(normalized) == canonical(rows(value['results'], false)),
      'TXO_STATUS_CONFLICT',
    );
  }
  return {'txos': normalized};
}
