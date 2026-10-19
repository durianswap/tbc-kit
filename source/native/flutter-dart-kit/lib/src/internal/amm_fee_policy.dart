// Pure data validation. Fees for existing pools must come from Rust's
// authenticated Code/Tape descriptor, never from API summary fields.
import 'protocol_codec.dart';
import 'transaction_read.dart';

Map<String, dynamic> normalizeAmmFeePolicy(Object? value) {
  const rates = [
    'lpFeeRate',
    'taxFeeRate',
    'serviceProviderFeeRate',
    'protocolFeeRate',
  ];
  need(
    value is Map &&
        value.length == 5 &&
        value.keys.every((k) => k == 'feeAddress' || rates.contains(k)),
    'AMM_FEE_FIELDS',
  );
  final fields = value as Map;
  var total = 0;
  for (final name in rates) {
    final rate = fields[name];
    need(rate is int && rate >= 0 && rate < 10000, 'AMM_FEE_RATE');
    total += rate as int;
  }
  need(total < 10000, 'AMM_TOTAL_FEE');
  inspectP2pkhAddress(fields['feeAddress']);
  return Map.unmodifiable({
    for (final name in rates) name: fields[name],
    'feeAddress': fields['feeAddress'],
  });
}
