import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/chain_read_reply.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';

void main() {
  test('transport statistics survive without becoming signed material', () {
    final source = {
      'blocks': 837216,
      'difficulty': 12919729.8601678,
      'verificationprogress': 0.00008656866914856023,
      'nested': [
        {'displayValue': 0.00001, 'valueSat': 10},
      ],
    };
    final copy = copyChainReadReply(source);
    expect(copy, source);
    expect(copy['difficulty'], isA<double>());
    (copy['nested'] as List).clear();
    expect(source['nested'], hasLength(1));
    expect(() => canonical(source), throwsStateError);
    expect(uintString(copy['blocks']), '837216');
    expect(() => uintString(copy['difficulty']), throwsStateError);
  });
  for (final value in [
    double.nan,
    double.infinity,
    double.negativeInfinity,
    9007199254740992,
    DateTime.utc(2026),
    {1: 'non-string-key'},
  ]) {
    test(
      'transport does not admit invalid JSON ${value.runtimeType}: $value',
      () {
        expect(() => copyChainReadReply({'value': value}), throwsStateError);
      },
    );
  }
  test('fractional security values are never rounded to accepted integers', () {
    for (final field in [
      'blocks',
      'mediantime',
      'height',
      'value',
      'confirmations',
    ]) {
      final copy = copyChainReadReply({field: 1.5});
      expect(() => uintString(copy[field]), throwsStateError);
      expect(() => canonical(copy), throwsStateError);
    }
  });
}
