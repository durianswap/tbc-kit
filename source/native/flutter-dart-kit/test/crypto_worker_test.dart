// Real private isolate, replay custody only. No wallet key, chain or device
// claim; the independent reference bytes are frozen in crypto-signing.json.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/crypto_action.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'crypto_action_test.dart' as replay;
import 'support/signing_replay.dart' as digest;

final class Harness implements TbcWalletSigningBackend {
  Harness([int index = 0]) : source = replay.CryptoHarness(index) {
    if (source.sample['request'].containsKey('expiresAt')) {
      source.sample['request']['expiresAt'] = tbcProtocolTimestamp(
        DateTime.now().add(const Duration(minutes: 2)),
      );
    }
  }
  final replay.CryptoHarness source;
  late final operation = Operation(this);
  late TbcSigningWorker worker;
  bool enabled = true;
  int reads = 0;
  Completer<void>? entered, release;
  late final navigation = TbcWebViewNavigation(
    webViewInstanceId: 'crypto-worker',
    sessionId: source.sample['context']['sessionId'],
    navigationId: source.sample['context']['navigationId'],
    origin: source.sample['context']['origin'],
    committedUrl: '${source.sample['context']['origin']}/dapp',
    createdAt: source.sample['context']['createdAt'],
  );
  Future<void> start() async {
    final library =
        (jsonDecode(
              File('test/fixtures/signing/replay.json').readAsStringSync(),
            )
            as Map)['library'];
    worker = await TbcSigningWorker.start(
      library: TbcPinnedComputeLibrary(
        path: library['path'],
        sha256: library['sha256'],
      ),
      network: TbcNetworkConfiguration.official(
        source.authority.chainId == 'tbc:mainnet'
            ? TbcNetwork.mainnet
            : TbcNetwork.testnet,
      ),
      backend: this,
      read: (_) async {
        reads++;
        throw StateError('Crypto must not read chain data');
      },
    );
  }

  Future<Map<String, dynamic>> run() => worker.execute(
    scope: TbcSigningRequestScope(
      operationId: 'crypto-operation',
      method: source.sample['method'],
      navigation: navigation,
      account: TbcAccount(
        network:
            source.authority.chainId == 'tbc:mainnet'
                ? TbcNetwork.mainnet
                : TbcNetwork.testnet,
        address: source.sample['account']['address'],
        publicKey: source.sample['account']['publicKey'],
      ),
      revision: 0,
    ),
    request: source.sample['request'],
    requireAuthorized: () => need(source.authorized, 'REVOKED'),
    isUnlocked: () => source.unlocked,
  );
  @override
  Future<TbcSigningOperation> begin(TbcSigningRequestScope scope) async =>
      enabled ? operation : digest.Operation(digest.Backend(), scope);
  @override
  void revokePending(TbcWebViewNavigation navigation) {
    source.authorized = false;
    operation.current = false;
  }

  @override
  void revokeOperation(TbcSigningRequestScope scope) {
    source.authorized = false;
    operation.current = false;
  }
}

final class Operation extends replay.CryptoOperation {
  Operation(this.workerHarness) : super(workerHarness.source);
  final Harness workerHarness;
  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial material) async {
    // Only time-dependent commitments change under the real worker clock.
    // All task/preview/result/account fields still come from the frozen oracle.
    final p = audit['plan']['payload'];
    p['expiresAt'] = material.binding['payload']['expiresAt'];
    p['requestHash'] = hashJson(h.sample['request']);
    audit['plan']['planHash'] = hashJson(p);
    final b = audit['binding']['payload'];
    b['expiresAt'] = p['expiresAt'];
    b['requestHash'] = p['requestHash'];
    b['operationHash'] = audit['plan']['planHash'];
    audit['binding']['bindingHash'] = hashJson(b);
    audit['approval']['approvedAt'] = tbcProtocolTimestamp(DateTime.now());
    audit['approval']['expiresAt'] = p['expiresAt'];
    audit['approval']['bindingHash'] = audit['binding']['bindingHash'];
    return super.bind(material);
  }

  @override
  Future<TbcCryptoResult> executeCrypto(
    TbcSigningReceipt receipt,
    TbcCryptoTask task,
  ) async {
    workerHarness.entered?.complete();
    await workerHarness.release?.future;
    return super.executeCrypto(receipt, task);
  }
}

void main() {
  for (var i = 0; i < (replay.fixture['cases'] as List).length; i++) {
    test(
      'private worker frozen ${replay.fixture['cases'][i]['name']}',
      () async {
        final h = Harness(i);
        await h.start();
        addTearDown(h.worker.close);
        expect(canonical(await h.run()), canonical(h.source.sample['result']));
        expect(
          [
            h.operation.consents,
            h.operation.binds,
            h.operation.cryptos,
            h.operation.closes,
          ],
          [1, 1, 1, 1],
        );
        expect(h.reads, 0);
        expect(h.worker.pendingCount, 0);
      },
    );
  }
  test('digest-only backend fails before consent', () async {
    final h = Harness()..enabled = false;
    await h.start();
    addTearDown(h.worker.close);
    await expectLater(h.run(), throwsStateError);
    expect(h.operation.consents, 0);
    expect(h.reads, 0);
  });
  test('invalid crypto schema retains fixed error across isolate', () async {
    final h = Harness();
    h.source.sample['request']['algorithm'] = 'other';
    await h.start();
    addTearDown(h.worker.close);
    await expectLater(h.run(), throwsA(isA<TbcInvalidCryptoRequest>()));
    expect(h.operation.consents, 0);
    expect(h.operation.cryptos, 0);
    expect(h.reads, 0);
  });
  test('crypto rejection retains common approval result', () async {
    final h = Harness()..operation.approved = false;
    await h.start();
    addTearDown(h.worker.close);
    await expectLater(h.run(), throwsA(isA<TbcSigningRejected>()));
    expect(h.operation.binds, 0);
    expect(h.operation.cryptos, 0);
  });
  for (final boundary in ['grant', 'lock', 'navigation', 'result']) {
    test('$boundary prevents late worker result', () async {
      final h =
          Harness()
            ..entered = Completer<void>()
            ..release = Completer<void>();
      await h.start();
      addTearDown(h.worker.close);
      final rejected = expectLater(h.run(), throwsStateError);
      await h.entered!.future;
      switch (boundary) {
        case 'grant':
          h.source.authorized = false;
        case 'lock':
          h.source.unlocked = false;
        case 'navigation':
          h.worker.invalidate(h.navigation);
        case 'result':
          h.operation.changeResult = (r) => r['algorithm'] = 'other';
      }
      h.release!.complete();
      await rejected;
      expect(h.operation.closes, 1);
      expect(h.worker.pendingCount, 0);
      expect(h.reads, 0);
    });
  }
}
