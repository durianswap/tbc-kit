import 'dart:convert';
import 'protocol_codec.dart';

/// The shared canonical RPC envelope contains Legacy JSON as a string so
/// historical display-amount decimals never relax the Standard integer codec.
/// This is data only: it cannot carry native origin, profile or key authority.
Object? decodeLegacyWireParams(Object? params) {
  need(
    params is Map && params.length == 1 && params['legacyJson'] is String,
    'LEGACY_WIRE_PARAMS',
  );
  final text = (params as Map)['legacyJson'] as String;
  need(utf8.encode(text).length <= 4 * 1024 * 1024, 'LEGACY_WIRE_SIZE');
  final value = jsonDecode(text);
  var count = 0;
  void visit(Object? v, int depth) {
    need(++count <= 10000 && depth <= 32, 'LEGACY_WIRE_BOUND');
    if (v is num) need(v.isFinite, 'LEGACY_WIRE_NUMBER');
    if (v is String) scalarString(v);
    if (v is List)
      for (final item in v) {
        visit(item, depth + 1);
      }
    if (v is Map)
      for (final entry in v.entries) {
        need(
          entry.key is String &&
              !{'__proto__', 'constructor', 'prototype'}.contains(entry.key),
          'LEGACY_WIRE_KEY',
        );
        visit(entry.key, depth + 1);
        visit(entry.value, depth + 1);
      }
  }

  visit(value, 0);
  return value;
}
