import 'protocol_codec.dart' show need, scalarString;

/// Own a transport JSON response without interpreting it as signed protocol
/// material. Node statistics and decoded display values can be finite decimals.
/// Readers still validate the fields they consume; protocol canonicalization,
/// integer amounts, heights, hashes and approval bindings are unchanged.
Map<String, dynamic> copyChainReadReply(Map value) =>
    _copy(value) as Map<String, dynamic>;

Object? _copy(Object? value) {
  if (value == null || value is bool) return value;
  if (value is String) {
    scalarString(value);
    return value;
  }
  if (value is int) {
    need(value.abs() <= 9007199254740991, 'UNSAFE_INTEGER');
    return value;
  }
  if (value is double) {
    need(value.isFinite, 'NONFINITE_API_NUMBER');
    return value;
  }
  if (value is List) return value.map(_copy).toList();
  if (value is Map) {
    need(value.keys.every((k) => k is String), 'INVALID_JSON_KEY');
    return <String, dynamic>{
      for (final key in value.keys) key as String: _copy(value[key]),
    };
  }
  throw StateError('UNSUPPORTED_API_VALUE');
}
