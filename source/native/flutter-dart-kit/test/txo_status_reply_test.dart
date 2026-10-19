import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/txo_status_reply.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';

void main() {
  Map raw() => {
    'results': [
      {
        'txid': 'ab' * 32,
        'index': 0,
        'value': 10000,
        'scriptpubkey': '51',
        'status': <String, dynamic>{'spent': false},
      },
    ],
  };
  Map expected() => {
    'txos': [
      {
        'txid': 'ab' * 32,
        'index': '0',
        'value': '10000',
        'scriptPubKey': '51',
        'spent': false,
      },
    ],
  };
  test('official deployed status and normalized client DTO are equivalent', () {
    expect(normalizeTxoStatusReply(raw()), expected());
    expect(normalizeTxoStatusReply(expected()), expected());
    expect(normalizeTxoStatusReply({...raw(), ...expected()}), expected());
    expect(
      (normalizeTxoStatusReply(raw())['txos'] as List).single.containsKey(
        'height',
      ),
      false,
    );
  });
  test('spent state and zero confirmation are not fabricated', () {
    final v = raw();
    v['results'][0]['status']['spent'] = true;
    v['results'][0]['height'] = -1;
    final row = normalizeTxoStatusReply(v)['txos'][0];
    expect(row['spent'], true);
    expect(row['height'], '0');
    expect(row.containsKey('confirmations'), false);
  });
  for (final bad in [
    'missing-state',
    'string-spent',
    'txid',
    'index',
    'value',
    'height',
    'script',
    'conflict',
  ]) {
    test('reject malformed status $bad', () {
      final v = raw(), row = v['results'][0];
      if (bad == 'missing-state') row.remove('status');
      if (bad == 'string-spent') row['status']['spent'] = 'false';
      if (bad == 'txid') row['txid'] = '00';
      if (bad == 'index') row['index'] = 0.1;
      if (bad == 'value') row['value'] = 10000.1;
      if (bad == 'height') row['height'] = 1.5;
      if (bad == 'script') row['scriptpubkey'] = '5';
      if (bad == 'conflict') {
        v['txos'] = copied(expected())['txos'];
        v['txos'][0]['spent'] = true;
      }
      expect(() => normalizeTxoStatusReply(v), throwsStateError);
    });
  }
  test('response list bound is retained', () {
    expect(
      () => normalizeTxoStatusReply({'results': List.filled(10001, {})}),
      throwsStateError,
    );
  });
}
