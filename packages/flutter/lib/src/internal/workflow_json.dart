// Frozen Core uses JSON.parse / JSON.stringify inside a UTF-8 message binding,
// not canonical protocol-map ordering. Keep that narrow wire behavior separate
// from protocol_codec, which intentionally accepts integer JSON values only.
import 'dart:convert';
import 'protocol_codec.dart';

String _number(num value) {
  // JSON.parse numbers have IEEE754 semantics, including integer-looking input.
  final number = value.toDouble();
  if (!number.isFinite) return 'null';
  if (number == 0) return '0';
  final sign = number < 0 ? '-' : '', text = number.abs().toString();
  final parts = text.split('e'), mantissa = parts[0];
  final point = mantissa.indexOf('.');
  var position =
      (point < 0 ? mantissa.length : point) +
      (parts.length == 2 ? int.parse(parts[1]) : 0);
  var digits = mantissa.replaceAll('.', '');
  while (digits.startsWith('0')) {
    digits = digits.substring(1);
    position--;
  }
  while (digits.endsWith('0')) {
    digits = digits.substring(0, digits.length - 1);
  }
  if (position > 0 && position <= 21) {
    if (position >= digits.length)
      return '$sign$digits${'0' * (position - digits.length)}';
    return '$sign${digits.substring(0, position)}.${digits.substring(position)}';
  }
  if (position <= 0 && position > -6)
    return '${sign}0.${'0' * -position}$digits';
  final exponent = position - 1;
  return '$sign${digits[0]}${digits.length > 1 ? '.${digits.substring(1)}' : ''}e${exponent >= 0 ? '+' : ''}$exponent';
}

// Shared with the thin Legacy display-amount adapter. Atomic protocol amounts
// remain integer strings; this only preserves JavaScript Number.toString input.
String javascriptNumberText(num value) {
  need(value.isFinite, 'NONFINITE_NUMBER');
  return _number(value);
}

int? _index(String key) {
  if (!RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(key) || key.length > 10)
    return null;
  final value = int.parse(key);
  return value < 4294967295 ? value : null;
}

String _stringify(Object? value) {
  if (value is num) return _number(value);
  if (value is List) return '[${value.map(_stringify).join(',')}]';
  if (value is Map) {
    final keys = value.keys.cast<String>().toList();
    final indexed =
        keys.where((k) => _index(k) != null).toList()
          ..sort((a, b) => _index(a)!.compareTo(_index(b)!));
    final ordered = [...indexed, ...keys.where((k) => _index(k) == null)];
    return '{${ordered.map((k) => '${jsonEncode(k)}:${_stringify(value[k])}').join(',')}}';
  }
  return jsonEncode(value);
}

String bindWorkflowJsonMessage(
  String text,
  String field,
  List<String> transactionIds,
) {
  final parsed = jsonDecode(text);
  need(
    parsed is Map &&
        RegExp(r'^[A-Za-z][A-Za-z0-9_]{0,63}$').hasMatch(field) &&
        !{'__proto__', 'constructor', 'prototype'}.contains(field) &&
        !parsed.keys.any({'__proto__', 'constructor', 'prototype'}.contains) &&
        (!parsed.containsKey(field) || parsed[field] is List),
    'WORKFLOW_JSON_TEMPLATE',
  );
  parsed[field] = transactionIds;
  return _stringify(parsed);
}
