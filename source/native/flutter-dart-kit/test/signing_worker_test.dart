import 'dart:async';

import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';

import 'support/signing_replay.dart';

void main() {
  setUpAll(loadReplay);

  test(
    'non-UI executor preserves outputs, one consent and cold/warm read reuse',
    () async {
      final h = Harness();
      await h.start();
      addTearDown(h.worker.close);
      for (var i = 0; i < 2; i++) {
        final before = h.paths.length, result = await h.execute();
        expect(
          canonical(result['transactions']),
          canonical(transaction['result']['transactions']),
        );
        expect(result['totalFee'], '539');
        expect(h.paths.length - before, i == 0 ? 5 : 3);
        final op = h.backend.operations.last;
        expect([op.consents, op.binds, op.signs, op.closes], [1, 1, 2, 1]);
      }
      expect(h.worker.pendingCount, 0);
    },
  );

  test(
    'message uses the same worker/native callback path with no chain reads',
    () async {
      final h = Harness();
      await h.start();
      addTearDown(h.worker.close);
      expect(
        canonical(await h.execute(method: 'tbc_signMessage')),
        canonical(message['result']),
      );
      expect(h.paths, isEmpty);
      expect(h.backend.operations.single.signs, 1);
    },
  );

  test(
    'default worker transport stays lazy for ordinary message signing',
    () async {
      final h = Harness();
      h.worker = await TbcSigningWorker.start(
        library: TbcPinnedComputeLibrary(
          path: replay['library']['path'],
          sha256: replay['library']['sha256'],
        ),
        network: h.network,
        backend: h.backend,
      );
      addTearDown(h.worker.close);
      expect(
        canonical(await h.execute(method: 'tbc_signMessage')),
        canonical(message['result']),
      );
      expect(h.paths, isEmpty);
      expect(h.backend.operations.single.signs, 1);
    },
  );

  test(
    'held consent does not globally serialize other document operations',
    () async {
      final h = Harness();
      await h.start();
      addTearDown(h.worker.close);
      h.backend.holdConsent = Completer<void>();
      h.backend.consentEntered = Completer<void>();
      final first = h.execute(nav: h.navigation('first'));
      await h.backend.consentEntered!.future;
      final second = await h.execute(
        method: 'tbc_signMessage',
        nav: h.navigation('second'),
      );
      expect(second['digest'], message['result']['digest']);
      expect(h.backend.operations.first.signs, 0);
      h.backend.holdConsent!.complete();
      await first;
      expect(h.backend.operations.first.signs, 2);
    },
  );

  test(
    'navigation invalidation revokes before late consent and returns no signature',
    () async {
      final h = Harness();
      await h.start();
      addTearDown(h.worker.close);
      h.backend.holdConsent = Completer<void>();
      h.backend.consentEntered = Completer<void>();
      final nav = h.navigation();
      final result = h.execute(nav: nav);
      final rejected = expectLater(result, throwsStateError);
      await h.backend.consentEntered!.future;
      h.worker.invalidate(nav);
      expect(h.backend.revokes, 1);
      h.backend.holdConsent!.complete();
      await rejected;
      expect(h.backend.operations.single.signs, 0);
      expect(h.backend.operations.single.closes, 1);
      expect(h.worker.pendingCount, 0);
    },
  );

  test(
    'grant loss without explicit worker cancellation still stops native issuance',
    () async {
      final h = Harness();
      await h.start();
      addTearDown(h.worker.close);
      h.backend.holdConsent = Completer<void>();
      h.backend.consentEntered = Completer<void>();
      final result = h.execute();
      final rejected = expectLater(result, throwsStateError);
      await h.backend.consentEntered!.future;
      h.backend.granted = false;
      h.backend.holdConsent!.complete();
      await rejected;
      expect(h.backend.operations.single.binds, 0);
      expect(h.backend.operations.single.signs, 0);
    },
  );

  test(
    'cancellation while native begin waits rejects promptly and closes a late handle',
    () async {
      final h = Harness();
      await h.start();
      addTearDown(h.worker.close);
      h.backend.holdBegin = Completer<void>();
      h.backend.beginEntered = Completer<void>();
      final nav = h.navigation(), result = h.execute(nav: h.navigation());
      final rejected = expectLater(result, throwsStateError);
      await h.backend.beginEntered!.future;
      h.worker.invalidate(nav);
      try {
        await rejected.timeout(const Duration(seconds: 1));
      } finally {
        h.backend.holdBegin!.complete();
      }
      await Future<void>.delayed(Duration.zero);
      expect(h.backend.operations.single.closes, 1);
      expect(h.paths, isEmpty);
    },
  );

  test('wrong artifact is rejected before account/Vault callbacks', () async {
    final h = Harness();
    await expectLater(
      TbcSigningWorker.start(
        library: TbcPinnedComputeLibrary(
          path: replay['library']['path'],
          sha256: '0' * 64,
        ),
        network: h.network,
        backend: h.backend,
        read: h.read,
      ),
      throwsStateError,
    );
    expect(h.backend.begins, 0);
    expect(h.paths, isEmpty);
  });
}
