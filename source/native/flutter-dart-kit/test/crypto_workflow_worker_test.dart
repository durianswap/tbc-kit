// Real private isolate; replay-only native custody, synthetic data, no HTTP.
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'workflow_worker_test.dart' as w;
import 'support/trusted_index_candidate.dart';

void main() {
  setUpAll(() {
    w.planning = w.signing = w.readFixture('crypto-workflow');
    w.library = trustedIndexCandidateLibrary();
  });
  for (final name in [
    'crypto-pair',
    'mixed-crypto',
    'crypto-independent-failure',
  ]) {
    test('private worker crypto batch $name', () async {
      final h = w.Harness(name);
      h.unavailableAt = h.source['failAt'];
      await h.start();
      addTearDown(h.worker.close);
      final result = await h.run();
      final expected = copied(h.expected['result']);
      for (final s in expected['steps']) {
        if (s['result'] is Map && s['result']['approvalId'] != null)
          s['result']['approvalId'] = 'worker-offline';
      }
      expect(canonical(result['steps']), canonical(expected['steps']));
      expect(result['requestHash'], hashJson(h.request));
      final op = h.operations.single;
      expect([op.consents, op.binds, op.cryptos, op.closes], [1, 1, 2, 1]);
      expect(h.paths, name == 'mixed-crypto' ? ['/api/tbc/utxo/address/${h.account.address}'] : isEmpty);
      expect(h.paths.toSet().length, h.paths.length);
      expect(h.checked, contains('tbc_crypto'));
    });
  }
  test('private crypto unavailable is not an arbitrary exception', () async {
    final h =
        w.Harness('crypto-independent-failure')
          ..unavailableAt = 'fails'
          ..arbitraryFailure = true;
    await h.start();
    addTearDown(h.worker.close);
    await expectLater(h.run(), throwsStateError);
    expect(h.operations.single.cryptos, 1);
    expect(h.operations.single.finished, isEmpty);
  });
  test('missing crypto child grant rejects before native operation', () async {
    final h = w.Harness('crypto-pair')..revokedGrant = 'tbc_crypto';
    await h.start();
    addTearDown(h.worker.close);
    await expectLater(h.run(), throwsStateError);
    expect(h.operations, isEmpty);
    expect(h.paths, isEmpty);
  });
}
