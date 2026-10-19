// Exact order terms come from the frozen Rust codec, not a suffix or index label.
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'tbc20_material.dart' show KeylessCall;

Map<String, dynamic> publicReviewedLopTerms(Object? value) {
  need(value is Map, 'REVIEWED_LOP_TERMS');
  final t = copied(value as Map);
  const fields = {
    'standardId',
    'market',
    'side',
    'ownerHash',
    'saleVolume',
    'unitPrice',
    'feeRate',
    'feeRecipientHash',
    'feeScale',
    'priceScale',
    'baseAsset',
    'quoteAsset',
  };
  need(
    t.length == fields.length &&
        t.keys.every(fields.contains) &&
        t['standardId'] == 'tbc-lop' &&
        {'native-token', 'token-token'}.contains(t['market']) &&
        {'buy', 'sell'}.contains(t['side']) &&
        t['priceScale'] == '1000000' &&
        t['feeScale'] == '1000000',
    'REVIEWED_LOP_TERMS',
  );
  for (final key in ['ownerHash', 'feeRecipientHash'])
    need(
      t[key] is String && RegExp(r'^[0-9a-f]{40}$').hasMatch(t[key]),
      'REVIEWED_LOP_HASH',
    );
  for (final key in ['saleVolume', 'unitPrice', 'feeRate']) {
    final amount = BigInt.parse(uintString(t[key]));
    need(
      amount <= (BigInt.one << 63) - BigInt.one &&
          (key == 'feeRate' || amount > BigInt.zero),
      'REVIEWED_LOP_AMOUNT',
    );
  }
  for (final name in ['baseAsset', 'quoteAsset']) {
    final a = t[name];
    final native = name == 'baseAsset' && t['market'] == 'native-token';
    need(
      a is Map &&
          (native
              ? a.length == 1 && a['kind'] == 'native'
              : a.length == 3 &&
                  a['kind'] == 'token' &&
                  a.containsKey('contractId') &&
                  a.containsKey('partialHash')),
      'REVIEWED_LOP_ASSET',
    );
    if (!native) {
      hash32(a['contractId']);
      hash32(a['partialHash']);
    }
  }
  return frozen(t) as Map<String, dynamic>;
}

Map<String, Map<String, dynamic>?> inspectReviewedLopCodes(
  KeylessCall keyless,
  List<String> scripts,
) {
  final unique = scripts.toSet().toList();
  need(
    unique.isNotEmpty &&
        unique.length <= 256 &&
        unique.every(
          (s) =>
              s.length <= 131072 && RegExp(r'^(?:[0-9a-f]{2})*$').hasMatch(s),
        ),
    'REVIEWED_LOP_BOUND',
  );
  Map result;
  try {
    result = keyless('inspectLopMaterial', {
      'phase': 'inspectOrderScripts',
      'scripts': unique,
    });
  } catch (_) {
    throw StateError('REVIEWED_LOP_INSPECTION');
  }
  final orders = result['orders'], controllers = result['controllers'];
  need(
    orders is List &&
        controllers is List &&
        orders.length == unique.length &&
        controllers.length == unique.length,
    'REVIEWED_LOP_MAPPING',
  );
  final byScript = <String, Map<String, dynamic>?>{};
  for (var i = 0; i < unique.length; i++) {
    if (orders[i] == null) {
      need(controllers[i] == null, 'REVIEWED_LOP_MAPPING');
      byScript[unique[i]] = null;
    } else {
      need(
        controllers[i] is String &&
            RegExp(r'^[0-9a-f]{40}$').hasMatch(controllers[i]),
        'REVIEWED_LOP_CONTROLLER',
      );
      byScript[unique[i]] = Map.unmodifiable({
        'terms': publicReviewedLopTerms(orders[i]),
        'controller': controllers[i],
      });
    }
  }
  return Map.unmodifiable(byScript);
}

Map<String, dynamic> publicReviewedLopOrders(
  Object? value,
  int transactionIndex,
) {
  need(value is Map, 'REVIEWED_LOP_ORDERS');
  final row = copied(value as Map);
  need(
    row.length == 4 &&
        row['verification'] == 'exact-template' &&
        row['assetIdentityVerified'] == false &&
        row['inputs'] is List &&
        row['outputs'] is List,
    'REVIEWED_LOP_ORDERS',
  );
  final all = [...row['inputs'], ...row['outputs']];
  need(all.isNotEmpty && all.length <= 256, 'REVIEWED_LOP_ORDERS');
  for (final side in ['inputs', 'outputs']) {
    final indexes = <int>{};
    for (final item in row[side]) {
      need(
        item is Map &&
            item.length == 2 &&
            item['index'] is int &&
            item['index'] >= 0 &&
            item['index'] <= 65535 &&
            indexes.add(item['index']),
        'REVIEWED_LOP_POSITION',
      );
      item['terms'] = publicReviewedLopTerms(item['terms']);
    }
  }
  return {...row, 'transactionIndex': transactionIndex};
}
