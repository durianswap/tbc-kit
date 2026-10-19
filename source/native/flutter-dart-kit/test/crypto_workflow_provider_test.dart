// Public Provider -> non-UI worker -> public replay custody -> result delivery.
// No real native UI/key, chain or installed-mobile acceptance claim.
import 'dart:async';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'workflow_provider_test.dart' as p;
import 'workflow_worker_test.dart' as w;
import 'support/trusted_index_candidate.dart';

void main() {
  setUpAll(() {
    w.planning = w.signing = w.readFixture('crypto-workflow');
    w.library = trustedIndexCandidateLibrary();
  });
  Future<p.Harness> setup(
    String name, {
    bool available = true,
    bool grant = true,
  }) async {
    final h = p.Harness(name);
    h.control.crypto = available;
    h.signing.unavailableAt = h.signing.source['failAt'];
    await h.start();
    addTearDown(h.close);
    await h.grant();
    if (grant && available)
      await h.request('grant-crypto', 'wallet_requestPermissions', [
        {
          'tbc_crypto': {
            'chains': [h.signing.network.chainId],
          },
        },
      ]);
    return h;
  }

  for (final name in [
    'crypto-pair',
    'mixed-crypto',
    'crypto-independent-failure',
  ]) {
    test('public workflow crypto $name returns exact frozen rows', () async {
      final h = await setup(name);
      final writes = h.control.permissionWrites;
      await h.run();
      final response = h.response(1);
      expect(response['error'], isNull, reason: '$response');
      final expected = copied(h.signing.expected['result']);
      for (final s in expected['steps']) {
        if (s['result'] is Map && s['result']['approvalId'] != null)
          s['result']['approvalId'] = 'worker-offline';
      }
      expect(
        canonical(response['result']['steps']),
        canonical(expected['steps']),
      );
      final op = h.signing.operations.single;
      expect([op.consents, op.binds, op.cryptos, op.closes], [1, 1, 2, 1]);
      expect(h.control.permissionWrites, writes);
      expect(h.signing.paths, name == 'mixed-crypto' ? ['/api/tbc/utxo/address/${h.signing.account.address}'] : isEmpty);
      expect(h.policies.length, name == 'mixed-crypto' ? 1 : 0);
      await h.run();
      expect(h.signing.operations.length, 1);
      expect(op.cryptos, 2);
    });
  }
  test('batch grant cannot substitute crypto grant', () async {
    final h = await setup('crypto-pair', grant: false);
    await h.run();
    expect(h.response(1)['error']['code'], 4100);
    expect(h.signing.operations, isEmpty);
    expect(h.signing.paths, isEmpty);
  });
  test('native capability absence rejects crypto batch before work', () async {
    final h = await setup('crypto-pair', available: false);
    await h.run();
    expect(h.response(1)['error']['code'], 4200);
    expect(h.signing.operations, isEmpty);
    expect(h.signing.paths, isEmpty);
  });
  test(
    'crypto child revoke during consent prevents every key operation',
    () async {
      final h = await setup('crypto-pair');
      h.signing.consentEntered = Completer<void>();
      h.signing.releaseConsent = Completer<void>();
      final pending = h.run();
      await h.signing.consentEntered!.future;
      h.control.grants.remove('tbc_crypto');
      h.signing.releaseConsent!.complete();
      await pending;
      // In-flight worker failures retain the existing redacted public error.
      expect(h.response(1)['error'], {
        'code': -32603,
        'message': 'Wallet operation unavailable',
      });
      final op = h.signing.operations.single;
      expect([op.consents, op.binds, op.cryptos], [1, 0, 0]);
    },
  );
}
