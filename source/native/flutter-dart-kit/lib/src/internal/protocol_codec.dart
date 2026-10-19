// Limited protocol DTO codec for this experiment, not a general JCS library.
// Non-integer JSON numbers are unsupported, never silently reformatted.
import 'dart:convert';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';

void need(bool value, String code) {
  if (!value) throw StateError(code);
}

void scalarString(String s) {
  for (var i = 0; i < s.length; i++) {
    final c = s.codeUnitAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      need(
        ++i < s.length &&
            s.codeUnitAt(i) >= 0xdc00 &&
            s.codeUnitAt(i) <= 0xdfff,
        'INVALID_UNICODE',
      );
    } else {
      need(c < 0xdc00 || c > 0xdfff, 'INVALID_UNICODE');
    }
  }
}

String canonical(Object? value) {
  if (value == null || value is bool) return jsonEncode(value);
  if (value is String) {
    scalarString(value);
    return jsonEncode(value);
  }
  if (value is int) {
    need(value.abs() <= 9007199254740991, 'UNSAFE_INTEGER');
    return '$value';
  }
  if (value is List) return '[${value.map(canonical).join(',')}]';
  if (value is Map) {
    need(value.keys.every((k) => k is String), 'INVALID_JSON_KEY');
    final keys = value.keys.cast<String>().toList()..sort();
    return '{${keys.map((k) => '${canonical(k)}:${canonical(value[k])}').join(',')}}';
  }
  throw StateError('UNSUPPORTED_JSON_VALUE');
}

String hashJson(Object? value) =>
    sha256.convert(utf8.encode(canonical(value))).toString();
String rpcOperationId(String sessionId, Object? id) => base64Url
    .encode(
      sha256
          .convert(
            utf8.encode(['P4/rpc', sessionId, canonical(id)].join('\u0000')),
          )
          .bytes,
    )
    .replaceAll('=', '');
Map<String, dynamic> copied(Map value) =>
    jsonDecode(canonical(value)) as Map<String, dynamic>;
Object? frozen(Object? value) {
  if (value is Map)
    return Map<String, dynamic>.unmodifiable({
      for (final k in value.keys) k as String: frozen(value[k]),
    });
  if (value is List) return List<dynamic>.unmodifiable(value.map(frozen));
  return value;
}

String hex(Iterable<int> bytes) =>
    bytes.map((v) => v.toRadixString(16).padLeft(2, '0')).join();
// Constant-stack grammar checks. Repeated regex groups overflow Dart AOT's
// regexp stack on otherwise valid, bounded crypto payloads on Android.
bool base64Text(String value) {
  if (value.length % 4 != 0) return false;
  final padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  final end = value.length - padding;
  for (var i = 0; i < end; i++) {
    final c = value.codeUnitAt(i);
    if (!(c >= 65 && c <= 90 || c >= 97 && c <= 122 ||
        c >= 48 && c <= 57 || c == 43 || c == 47)) return false;
  }
  return true; // Padding bits retain the historical grammar policy.
}

bool lowerHexText(String value) =>
    value.length.isEven && RegExp(r'^[0-9a-f]*$').hasMatch(value);

Uint8List unhex(String value) {
  need(lowerHexText(value), 'INVALID_HEX');
  return Uint8List.fromList([
    for (var i = 0; i < value.length; i += 2)
      int.parse(value.substring(i, i + 2), radix: 16),
  ]);
}

Uint8List messageBytes(Map message) {
  final data = message['data'];
  need(data is String && data.length <= 131072, 'INVALID_MESSAGE');
  switch (message['encoding']) {
    case 'utf8':
      scalarString(data);
      return Uint8List.fromList(utf8.encode(data));
    case 'hex':
      return unhex(data);
    case 'base64':
      need(
        base64Text(data),
        'INVALID_BASE64',
      );
      final b = base64Decode(data);
      need(base64Encode(b) == data, 'NONCANONICAL_BASE64');
      return b;
    default:
      throw StateError('UNSUPPORTED_ENCODING');
  }
}

List<int> compactSize(int n) =>
    n < 253
        ? [n]
        : n <= 65535
        ? [253, n & 255, n >> 8]
        : [254, n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];

// Private immutable worker configuration, never a page/request field. Native
// custody independently derives the same profile from its registered protocol.
enum MessageSigningProfile { standard, legacyBitcoin }

Uint8List messagePayload(
  Map envelope, {
  MessageSigningProfile profile = MessageSigningProfile.standard,
}) {
  need(
    envelope['type'] == 'tbc.message' && envelope['version'] == '1.0',
    'UNSUPPORTED_MESSAGE_PROFILE',
  );
  final body = messageBytes(envelope['message']);
  need(body.length <= 65536, 'MESSAGE_TOO_LARGE');
  final magic = utf8.encode(
    profile == MessageSigningProfile.legacyBitcoin
        ? 'Bitcoin Signed Message:\n'
        : 'TBC Signed Message:\n',
  );
  return Uint8List.fromList([
    ...compactSize(magic.length),
    ...magic,
    ...compactSize(body.length),
    ...body,
  ]);
}

String messageDigest(
  Map envelope, {
  MessageSigningProfile profile = MessageSigningProfile.standard,
}) =>
    sha256
        .convert(
          sha256.convert(messagePayload(envelope, profile: profile)).bytes,
        )
        .toString();

DateTime protocolTime(String value) {
  need(
    RegExp(
      r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$',
    ).hasMatch(value),
    'INVALID_TIME',
  );
  final t = DateTime.parse(value);
  final expected =
      value.length == 20
          ? '${value.substring(0, 19)}.000Z'
          : '${value.substring(0, 20)}${value.substring(20, value.length - 1).padRight(3, '0')}Z';
  need(t.toIso8601String() == expected, 'INVALID_CALENDAR_TIME');
  return t;
}
