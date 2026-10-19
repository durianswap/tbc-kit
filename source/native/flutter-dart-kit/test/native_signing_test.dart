// Offline fixture keys/signatures never enter the production default adapter.
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';
import 'support/trusted_index_candidate.dart';

late Map<String, dynamic> fixture, materials, library;
late ComputeProbe engine;

class FixtureOperation implements TbcSigningOperation {
  FixtureOperation(this.sample);
  final Map<String, dynamic> sample;
  bool active = true, approve = true;
  int consents = 0, binds = 0, signs = 0, closes = 0, advances = 0;
  Future<void> Function()? duringAdvance;
  void Function(Map<String, dynamic>)? alterSignature;
  Future<void> Function()? duringConsent;
  TbcBoundedSigningIntent? consent;
  TbcSigningReceipt? receipt;
  String? boundPlanHash;
  Map<String, dynamic> get audit => copied(sample['audit']);
  @override
  Future<void> requireCurrent() async => need(active, 'FIXTURE_REVOKED');
  @override
  Future<bool> requestConsent(TbcBoundedSigningIntent value) async {
    await requireCurrent();
    consents++;
    consent = value;
    await duringConsent?.call();
    return approve;
  }

  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial value) async {
    await requireCurrent();
    binds++;
    expect(consents, 1);
    expect(value.binding['payload']['requestHash'], hashJson(consent!.request));
    expect(value.binding['payload']['contextHash'], hashJson(consent!.context));
    expect(canonical(value.preview), canonical(audit['preview']));
    boundPlanHash = value.plan?['planHash'];
    expect(
      canonical(value.plan!['payload']['signingTasks']),
      canonical(audit['plan']['payload']['signingTasks']),
    );
    receipt = TbcSigningReceipt({
      ...audit['approval'],
      'bindingHash': value.binding['bindingHash'],
      'approvedAt':
          value.plan!['payload']['createdAt'] ?? consent!.context['createdAt'],
      'expiresAt': value.binding['payload']['expiresAt'],
    });
    return receipt!;
  }

  @override
  Future<void> advance(
    TbcSigningReceipt value,
    TbcSigningContinuation pending,
  ) async {
    await requireCurrent();
    final stages = audit['stages'] as List;
    expect(canonical(value.wire), canonical(receipt!.wire));
    final expected = copied(stages[advances]['result']);
    // A real adapter uses a fresh receipt; Engine binds each pending stage to it.
    expected['continuation']['bindingHash'] = value.wire['bindingHash'];
    expected['continuation']['approvalId'] = value.wire['approvalId'];
    expected['continuation']['planHash'] = boundPlanHash;
    expect(canonical(pending.wire), canonical(expected));
    expect(
      signs,
      (stages.take(advances + 1).expand((s) => s['tasks'] as List)).length,
    );
    expect(pending.toString(), 'TbcSigningContinuation(redacted)');
    expect(() => pending.wire['status'] = 'changed', throwsUnsupportedError);
    advances++;
    await duringAdvance?.call();
  }

  @override
  Future<TbcTaskSignature> sign(
    TbcSigningReceipt value,
    TbcSigningTask task,
  ) async {
    await requireCurrent();
    expect(canonical(value.wire), canonical(receipt!.wire));
    expect(
      canonical(task.wire),
      canonical(
        audit['stages'] == null
            ? audit['plan']['payload']['signingTasks'][signs]
            : (audit['stages'] as List)
                .expand((s) => s['tasks'] as List)
                .elementAt(signs),
      ),
    );
    final signature = copied(audit['signatures'][signs++]);
    alterSignature?.call(signature);
    return TbcTaskSignature(
      taskId: task.taskId,
      signatureEncoding: signature['signatureEncoding'],
      signature: signature['signature'],
    );
  }

  @override
  Future<void> close() async {
    closes++;
    active = false;
  }
}

final class FixtureBackend implements TbcWalletSigningBackend {
  FixtureBackend(this.operation);
  final FixtureOperation operation;
  @override
  Future<TbcSigningOperation> begin(TbcSigningRequestScope scope) async =>
      operation;
  @override
  void revokePending(TbcWebViewNavigation navigation) {
    operation.active = false;
  }

  @override
  void revokeOperation(TbcSigningRequestScope scope) {
    operation.active = false;
  }
}

Map<String, dynamic> sample(String name) =>
    copied((fixture['cases'] as List).singleWhere((c) => c['name'] == name));
Map<String, dynamic> material(String name) =>
    copied((materials['cases'] as List).singleWhere((c) => c['name'] == name));
TbcNetworkConfiguration network(Map s) => TbcNetworkConfiguration.official(
  s['network'] == 'mainnet' ? TbcNetwork.mainnet : TbcNetwork.testnet,
);
TbcAccount account(Map s) => TbcAccount(
  network: network(s).network,
  address: s['account']['address'],
  publicKey: s['account']['publicKey'],
);

void main() {
  setUpAll(() {
    fixture = jsonDecode(
      File('test/fixtures/native-signing.json').readAsStringSync(),
    );
    materials = jsonDecode(
      File('test/fixtures/native-transfers.json').readAsStringSync(),
    );
    library =
        jsonDecode(
          File('test/fixtures/signing/replay.json').readAsStringSync(),
        )['library'];
    expect(
      sha256.convert(File(library['path']).readAsBytesSync()).toString(),
      library['sha256'],
    );
    library = trustedIndexCandidateLibrary();
    engine = ComputeProbe(DynamicLibrary.open(library['path']));
  });
  for (final name in [
    'transfer-single',
    'transfer-multiple',
    'transfer-exact-requested',
    'merge-two',
    'merge-limit',
    'mainnet-transfer',
  ]) {
    test(
      '$name Native lifecycle exactly matches frozen WASM signed output',
      () async {
        final s = sample(name), m = material(name), op = FixtureOperation(s);
        final paths = <String>[], phases = <String>[];
        final reader = NativeMaterialReader(
          network: network(s),
          read: (path) async {
            paths.add(path);
            return copied(m['replies'][path]);
          },
        );
        final executor = TbcSigningExecutor(
          engine: engine,
          signer: op,
          authority: TbcOperationAuthority(
            context: s['context'],
            account: account(s),
            requireAuthorized: (method) => expect(method, s['method']),
            isUnlocked: () => true,
            clock: () => protocolTime(s['now']),
          ),
          prepareMaterial:
              (request, account) async => {
                'snapshot': await reader.resolve(
                  request: request,
                  account: account,
                  now: protocolTime(s['now']),
                  snapshotId: m['snapshotId'],
                ),
                'policy': defaultTransactionPolicy(
                  network: network(s),
                  request: request,
                  now: protocolTime(s['now']),
                ),
              },
          timing: (stage, _) => phases.add(stage),
        );
        expect(
          canonical(await executor.execute(s['method'], s['request'])),
          canonical(s['result']),
        );
        expect(paths, (m['trace'] as List).where((p) => p != '/api/tbc/nodeinfo').toList());
        expect(
          [op.consents, op.binds, op.signs, op.closes],
          [1, 1, (s['audit']['signatures'] as List).length, 1],
        );
        for (final stage in [
          'validate:plan',
          'validate:pre-sign',
          'validate:finalized',
        ]) {
          expect(phases.where((p) => p == stage), hasLength(1));
        }
      },
    );
  }
  for (final name in ['transfer-single', 'merge-two']) {
    test(
      '$name shared worker starts the sole UTXO read before consent',
      () async {
        final s = sample(name), m = material(name), op = FixtureOperation(s);
        final reads = <String>[], release = Completer<void>();
        op.duringConsent = () async {
          for (var i = 0; reads.isEmpty && i < 100; i++) {
            await Future<void>.delayed(const Duration(milliseconds: 1));
          }
          expect(reads.length, 1);
          expect(op.binds, 0);
          release.complete();
        };
        final worker = await TbcSigningWorker.start(
          library: TbcPinnedComputeLibrary(
            path: library['path'],
            sha256: library['sha256'],
          ),
          network: network(s),
          backend: FixtureBackend(op),
          read: (path) async {
            reads.add(path);
            await release.future;
            return copied(m['replies'][path]);
          },
        );
        addTearDown(worker.close);
        final now = DateTime.now().toUtc();
        final result = await worker.execute(
          scope: TbcSigningRequestScope(
            operationId: 'native-$name',
            method: 'tbc_signTransaction',
            account: account(s),
            revision: 0,
            navigation: TbcWebViewNavigation(
              webViewInstanceId: 'view',
              sessionId: 'session',
              navigationId: 'nav',
              committedUrl: 'https://partner.example/dapp',
              origin: 'https://partner.example',
              createdAt: tbcProtocolTimestamp(now),
            ),
          ),
          request: s['request'],
          policy: defaultTransactionPolicy(
            network: network(s),
            request: s['request'],
            now: now,
          ),
          requireAuthorized: () {},
          isUnlocked: () => true,
        );
        expect(
          canonical(result['transactions']),
          canonical(s['result']['transactions']),
        );
        expect(result['totalFee'], s['result']['totalFee']);
        expect(
          [op.consents, op.binds, op.signs],
          [1, 1, (s['audit']['signatures'] as List).length],
        );
        expect(reads, (m['trace'] as List).where((p) => p != '/api/tbc/nodeinfo').toList());
      },
    );
  }
}
