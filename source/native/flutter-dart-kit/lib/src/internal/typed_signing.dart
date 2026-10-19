// Frozen TWS typed-data framing, not EIP-712 and not ordinary signMessage.
// This module contains no transport, key, approval, persistence or transaction
// algorithms. Authorization and account liveness stay in the shared lifecycle.
import 'dart:convert';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'protocol_codec.dart';

final _identifier = RegExp(r'^[A-Za-z][A-Za-z0-9_]{0,63}$');
final _fieldType = RegExp(
  r'^[A-Za-z][A-Za-z0-9_]*(?:\[(?:[1-9][0-9]{0,2})?\])?$',
);

bool _matches(Object? value, RegExp pattern) =>
    value is String && pattern.hasMatch(value);

void _shape(Map value, Set<String> required, Set<String> optional) {
  need(
    required.every(value.containsKey) &&
        value.keys.every((k) => required.contains(k) || optional.contains(k)),
    'TYPED_DATA_SHAPE',
  );
}

void _string(Object? value, int min, int max) {
  need(value is String, 'TYPED_DATA_STRING');
  final s = value as String;
  scalarString(s);
  need(s.runes.length >= min && s.runes.length <= max, 'TYPED_DATA_STRING');
}

// The frozen reducer sorts ASCII schema field names with localeCompare("en"):
// primary weight ignores case, '_' precedes digits and letters, then a
// lowercase-before-uppercase tertiary tie break. Map keys still use the
// existing UTF-16 canonical JSON ordering. Equal names preserve source order.
int typedFieldNameCompare(String a, String b) {
  int weight(int c) => c == 95 ? 0 : c;
  final left = a.toLowerCase(), right = b.toLowerCase();
  final length = left.length < right.length ? left.length : right.length;
  for (var i = 0; i < length; i++) {
    final primary = weight(
      left.codeUnitAt(i),
    ).compareTo(weight(right.codeUnitAt(i)));
    if (primary != 0) return primary;
  }
  if (left.length != right.length) return left.length.compareTo(right.length);
  for (var i = 0; i < a.length; i++) {
    if (a.codeUnitAt(i) != b.codeUnitAt(i)) {
      return b.codeUnitAt(i).compareTo(a.codeUnitAt(i));
    }
  }
  return 0;
}

// A fixed, data-free classification can cross the private worker boundary.
// Other failures (Vault, signature, binding, lifecycle) remain internal errors.
final class TbcInvalidTypedData extends StateError {
  TbcInvalidTypedData() : super('INVALID_TYPED_DATA');
}

Map<String, dynamic> typedDataEnvelope(Map request, String trustedOrigin) {
  try {
    return _typedDataEnvelope(request, trustedOrigin);
  } on StateError {
    throw TbcInvalidTypedData();
  }
}

Map<String, dynamic> _typedDataEnvelope(Map request, String trustedOrigin) {
  _shape(request, {'version', 'chainId', 'from', 'data'}, {'clientRequestId'});
  need(request['version'] == '1.0', 'REQUEST_VERSION');
  if (request.containsKey('clientRequestId')) {
    _string(request['clientRequestId'], 1, 128);
  }
  need(request['data'] is Map, 'TYPED_DATA_SHAPE');
  final data = request['data'] as Map;
  _shape(data, {'domain', 'types', 'primaryType', 'message'}, {});
  need(data['domain'] is Map, 'TYPED_DATA_DOMAIN');
  final domain = data['domain'] as Map;
  _shape(
    domain,
    {'name', 'chainId'},
    {'version', 'origin', 'verifyingContract', 'salt'},
  );
  _string(domain['name'], 1, 64);
  need(
    domain['chainId'] == request['chainId'] &&
        {'tbc:mainnet', 'tbc:testnet'}.contains(request['chainId']),
    'TYPED_DATA_DOMAIN_CHAIN',
  );
  if (domain.containsKey('origin')) {
    _string(domain['origin'], 1, 2048);
    need(
      domain['origin'] == trustedOrigin &&
          _matches(domain['origin'], RegExp(r'^[a-z][a-z0-9+.-]*://[^/?#]+$')),
      'TYPED_DATA_DOMAIN_ORIGIN',
    );
  }
  if (domain.containsKey('version')) {
    need(
      _matches(domain['version'], RegExp(r'^[!-~]{1,32}$')),
      'TYPED_DATA_VERSION',
    );
  }
  for (final field in ['verifyingContract', 'salt']) {
    if (domain.containsKey(field)) {
      need(
        _matches(domain[field], RegExp(r'^[0-9a-f]{64}$')),
        'TYPED_DATA_HASH',
      );
    }
  }
  need(_matches(data['primaryType'], _identifier), 'TYPED_DATA_PRIMARY_TYPE');
  need(data['types'] is Map, 'TYPED_DATA_TYPES');
  final types = data['types'] as Map;
  need(types.isNotEmpty && types.length <= 32, 'TYPED_DATA_TYPES');
  final normalized = <String, dynamic>{};
  for (final entry in types.entries) {
    need(_matches(entry.key, _identifier), 'TYPED_DATA_TYPE_NAME');
    need(entry.value is List, 'TYPED_DATA_FIELDS');
    final fields = entry.value as List;
    need(fields.isNotEmpty && fields.length <= 64, 'TYPED_DATA_FIELDS');
    for (final field in fields) {
      need(field is Map, 'TYPED_DATA_FIELD');
      _shape(field as Map, {'name', 'type'}, {});
      need(_matches(field['name'], _identifier), 'TYPED_DATA_FIELD_NAME');
      need(_matches(field['type'], _fieldType), 'TYPED_DATA_FIELD_TYPE');
    }
    final indices = List<int>.generate(fields.length, (i) => i)..sort((a, b) {
      final order = typedFieldNameCompare(fields[a]['name'], fields[b]['name']);
      return order == 0 ? a.compareTo(b) : order;
    });
    normalized[entry.key] = [for (final i in indices) copied(fields[i])];
  }
  // The protocol describes values, not an executable ABI: unresolved type names
  // and duplicate names are not rejected by the frozen Core. Do not invent a
  // stricter type checker and silently change what existing DApps can sign.
  need(data['message'] is Map, 'TYPED_DATA_MESSAGE');
  final pending = <Object?>[data['message']];
  while (pending.isNotEmpty) {
    final value = pending.removeLast();
    if (value is String) {
      scalarString(value);
    } else if (value is bool) {
      continue;
    } else if (value is List) {
      need(value.length <= 256, 'TYPED_DATA_ARRAY');
      pending.addAll(value);
    } else if (value is Map) {
      need(
        value.length <= 64 && value.keys.every((k) => k is String),
        'TYPED_DATA_OBJECT',
      );
      pending.addAll(value.values);
    } else {
      throw StateError('TYPED_DATA_VALUE');
    }
  }
  final envelope = {
    'type': 'tbc.typedData',
    'version': '1.0',
    'domain': copied(domain),
    'types': normalized,
    'primaryType': data['primaryType'],
    'message': copied(data['message']),
  };
  // Result schema bound, checked before consent or private key use.
  need(canonical(envelope).runes.length <= 65536, 'TYPED_DATA_TOO_LARGE');
  return frozen(envelope) as Map<String, dynamic>;
}

Uint8List typedDataPayload(Map envelope) {
  need(
    envelope['type'] == 'tbc.typedData' && envelope['version'] == '1.0',
    'TYPED_DATA_ENVELOPE',
  );
  final magic = utf8.encode('TBC Signed Typed Data:\n');
  final body = utf8.encode(canonical(envelope));
  return Uint8List.fromList([
    ...compactSize(magic.length),
    ...magic,
    ...compactSize(body.length),
    ...body,
  ]);
}

String typedDataDigest(Map envelope) =>
    sha256.convert(sha256.convert(typedDataPayload(envelope)).bytes).toString();
