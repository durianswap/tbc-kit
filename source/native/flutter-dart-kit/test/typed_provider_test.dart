import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'provider_session_test.dart' as provider;
import 'support/signing_replay.dart' as replay;

void main() {
  final fixture =
      jsonDecode(File('test/fixtures/typed-signing.json').readAsStringSync())
          as Map;
  final samples =
      (fixture['cases'] as List)
          .where((s) => s['request']['chainId'] == 'tbc:testnet')
          .toList();
  setUpAll(replay.loadReplay);
  for (final sample in samples) {
    test(
      'typed Provider ${sample['name']} one approval through shared worker, no reads/writes',
      () async {
        final h = provider.SessionHarness();
        h.signing.backend.typedSample = copied(sample);
        await h.start();
        addTearDown(h.close);
        await h.grant();
        final writes = h.control.writes;
        await h.request('typed', 'tbc_signTypedData', sample['request']);
        expect(
          canonical(h.response('typed')['result']),
          canonical(sample['result']),
        );
        final op = h.signing.backend.operations.single;
        expect([op.consents, op.binds, op.signs, op.closes], [1, 1, 1, 1]);
        expect(h.signing.paths, isEmpty);
        expect(h.control.writes, writes);
      },
    );
  }
  test('ordinary and typed grants remain independent in Provider', () async {
    final h = provider.SessionHarness();
    h.signing.backend.typedSample = copied(samples.first);
    await h.start();
    addTearDown(h.close);
    await h.request('grant', 'wallet_requestPermissions', [
      {
        'tbc_accounts': {
          'chains': ['tbc:testnet'],
        },
        'tbc_signMessage': {
          'chains': ['tbc:testnet'],
        },
      },
    ]);
    await h.request(1, 'tbc_signTypedData', samples.first['request']);
    expect(h.response(1)['error']['code'], 4100);
    expect(h.signing.backend.begins, 0);
    await h.request('typed-grant', 'wallet_requestPermissions', [
      {
        'tbc_signTypedData': {
          'chains': ['tbc:testnet'],
        },
      },
    ]);
    await h.request(2, 'tbc_signTypedData', samples.first['request']);
    expect(
      canonical(h.response(2)['result']),
      canonical(samples.first['result']),
    );
    h.control.grants.remove('tbc_signMessage');
    await h.request(3, 'tbc_signMessage', replay.message['request']);
    expect(h.response(3)['error']['code'], 4100);
    expect(h.signing.backend.begins, 1);
  });
  test(
    'frozen-invalid typed requests return Invalid Params without closing the session',
    () async {
      final h = provider.SessionHarness();
      h.signing.backend.typedSample = copied(samples.first);
      await h.start();
      addTearDown(h.close);
      await h.grant();
      for (final sample in fixture['invalid'] as List) {
        await h.request(sample['name'], 'tbc_signTypedData', sample['request']);
        expect(
          h.response(sample['name'])['error']['code'],
          -32602,
          reason: sample['name'],
        );
      }
      expect(h.signing.paths, isEmpty);
      expect(
        h.signing.backend.operations.every(
          (op) =>
              op.consents == 0 &&
              op.binds == 0 &&
              op.signs == 0 &&
              op.closes == 1,
        ),
        true,
      );
      await h.request('valid', 'tbc_signTypedData', samples.first['request']);
      expect(
        canonical(h.response('valid')['result']),
        canonical(samples.first['result']),
      );
    },
  );
}
