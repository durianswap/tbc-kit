import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';

import 'trusted_index_candidate.dart';
import 'indexed_fixture.dart';

late Map<String, dynamic> replay, material;
late Map<String, dynamic> transaction, message;

final class Backend implements TbcWalletSigningBackend {
  int begins = 0, revokes = 0;
  bool granted = true, approve = true;
  Map<String, dynamic>? typedSample;
  Map<String, dynamic>? messageSample;
  Map<String, dynamic>? preparedSample;
  Map<String, dynamic>? reviewedSample, reviewedSource;
  final List<Operation> operations = [];
  Completer<void>? beginEntered, holdBegin, consentEntered, holdConsent;
  @override
  Future<TbcSigningOperation> begin(TbcSigningRequestScope scope) async {
    begins++;
    beginEntered?.complete();
    await holdBegin?.future;
    final op = Operation(this, scope);
    operations.add(op);
    return op;
  }

  @override
  void revokePending(TbcWebViewNavigation navigation) {
    revokes++;
    for (final op in operations.where(
      (o) => o.scope.navigation.sessionId == navigation.sessionId,
    )) {
      op.active = false;
    }
  }

  @override
  void revokeOperation(TbcSigningRequestScope scope) {
    for (final op in operations.where(
      (o) =>
          o.scope.operationId == scope.operationId &&
          o.scope.navigation.sessionId == scope.navigation.sessionId,
    )) {
      op.active = false;
    }
  }
}

// Native-shaped offline adapter only. No keys, actual signing or broadcast.
// Recorded public-fixture signatures are accepted only for identical digests.
final class Operation implements TbcSigningOperation {
  Operation(this.backend, this.scope);
  final Backend backend;
  final TbcSigningRequestScope scope;
  bool active = true;
  int consents = 0, binds = 0, signs = 0, closes = 0;
  int reviewedStage = 0, reviewedRow = 0, advances = 0;
  TbcBoundedSigningIntent? intent;
  TbcSigningMaterial? approved;
  TbcSigningReceipt? receipt;
  final Set<String> consumed = {};
  Map<String, dynamic> get sample =>
      scope.method == 'tbc_signTransaction'
          ? transaction
          : scope.method == 'tbc_signPreparedTransaction'
          ? backend.preparedSample!
          : scope.method == 'tbc_signReviewedTransaction'
          ? backend.reviewedSample!
          : scope.method == 'tbc_signTypedData'
          ? backend.typedSample!
          : backend.messageSample ?? message;
  void current() {
    need(active && backend.granted, 'OFFLINE_NATIVE_AUTHORITY');
  }

  @override
  Future<void> requireCurrent() async {
    current();
  }

  @override
  Future<bool> requestConsent(TbcBoundedSigningIntent value) async {
    current();
    consents++;
    intent = value;
    expect(value.method, scope.method);
    expect(value.context['origin'], scope.navigation.origin);
    expect(value.request['from'], scope.account.address);
    if ((scope.method == 'tbc_signTransaction' ||
            scope.method == 'tbc_signPreparedTransaction' ||
            scope.method == 'tbc_signReviewedTransaction') &&
        backend.holdConsent != null) {
      backend.consentEntered?.complete();
      await backend.holdConsent!.future;
    }
    current();
    return backend.approve;
  }

  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial value) async {
    current();
    binds++;
    approved = value;
    expect(consents, 1);
    final p = value.binding['payload'];
    expect(value.binding['bindingHash'], hashJson(p));
    expect(p['contextHash'], hashJson(intent!.context));
    expect(
      p['requestHash'],
      hashJson({
        for (final key in intent!.request.keys)
          if (scope.method != 'tbc_signPreparedTransaction' ||
              key != 'proposal')
            key: intent!.request[key],
      }),
    );
    expect(p['sessionId'], scope.navigation.sessionId);
    expect(p['accountId'], scope.account.accountId);
    expect(p['chainId'], scope.account.network.chainId);
    if (scope.method == 'tbc_signReviewedTransaction') {
      expect(value.reviewed, isNotNull);
      expect(
        canonical(value.reviewed!['material']),
        canonical(backend.reviewedSource!['material']),
      );
      expect(
        canonical(value.reviewed!['stage']),
        canonical(backend.reviewedSource!['stages'][0]['stage']),
      );
      expect(canonical(value.preview), canonical(sample['audit']['preview']));
      expect(
        canonical(value.plan!['payload']['review']),
        canonical(intent!.review),
      );
    } else if (value.plan != null) {
      expect(
        canonical(value.plan!['payload']['signingTasks']),
        canonical(sample['audit']['plan']['payload']['signingTasks']),
      );
      expect(canonical(value.preview), canonical(sample['audit']['preview']));
    } else {
      expect(value.preview['digest'], sample['audit']['preview']['digest']);
    }
    receipt = TbcSigningReceipt({
      'status': 'approved',
      'approvalId': scope.operationId,
      'approvalToken': 'offline-only-${scope.operationId}',
      'bindingHash': value.binding['bindingHash'],
      'approvedAt': tbcProtocolTimestamp(DateTime.now()),
      'expiresAt': p['expiresAt'],
    });
    return receipt!;
  }

  @override
  Future<void> advance(
    TbcSigningReceipt receipt,
    TbcSigningContinuation continuation,
  ) async {
    if (scope.method != 'tbc_signReviewedTransaction')
      throw StateError('Single-stage replay must not advance');
    current();
    expect(canonical(receipt.wire), canonical(this.receipt!.wire));
    final rows = backend.reviewedSource!['stages'] as List;
    expect(reviewedRow, (rows[reviewedStage]['signatures'] as List).length);
    advances++;
    reviewedStage++;
    reviewedRow = 0;
    final p = continuation.wire;
    expect(p['kind'], 'reviewed');
    expect(p['stageIndex'], reviewedStage);
    expect(p['planHash'], approved!.plan!['planHash']);
    expect(canonical(p['stage']), canonical(rows[reviewedStage]['stage']));
    expect(p['previousTransactions'], [
      for (var i = 0; i < reviewedStage; i++) rows[i]['finalized']['txraw'],
    ]);
  }

  @override
  Future<TbcTaskSignature> sign(
    TbcSigningReceipt value,
    TbcSigningTask task,
  ) async {
    current();
    expect(canonical(value.wire), canonical(receipt!.wire));
    expect(consumed.add(task.taskId), true);
    if (scope.method == 'tbc_signReviewedTransaction') {
      final row = backend.reviewedSource!['stages'][reviewedStage],
          stage = row['stage'];
      expect(
        task.taskId,
        'review-single-tx-$reviewedStage-input-${stage['signingInputIndexes'][reviewedRow]}',
      );
      expect(task.digest, stage['digests'][reviewedRow]);
      expect(task.publicKey, scope.account.publicKey);
      signs++;
      return TbcTaskSignature(
        taskId: task.taskId,
        signatureEncoding: 'compact64',
        signature: row['signatures'][reviewedRow++],
      );
    }
    final samples = sample['audit']['signatures'] as List;
    if (approved!.plan != null) {
      final planned = (approved!.plan!['payload']['signingTasks'] as List)
          .singleWhere((t) => t['taskId'] == task.taskId);
      expect(canonical(task.wire), canonical(planned));
    } else {
      expect(task.digest, sample['result']['digest']);
    }
    final sig = samples.singleWhere((s) => s['taskId'] == task.taskId) as Map;
    signs++;
    return TbcTaskSignature(
      taskId: sig['taskId'],
      signatureEncoding: sig['signatureEncoding'],
      signature: sig['signature'],
    );
  }

  @override
  Future<void> close() async {
    if (closes == 0) closes++;
    active = false;
  }
}

final class Harness {
  Harness({TbcNetworkConfiguration? network, this.library})
    : network = network ?? TbcNetworkConfiguration.official(TbcNetwork.testnet);
  final backend = Backend();
  final TbcPinnedComputeLibrary? library;
  Future<Map<String, dynamic>> Function(String)? customRead;
  Future<Map<String, dynamic>> Function(List<Map<String, dynamic>>)?
  customStatus;
  int statusReads = 0;
  final paths = <String>[];
  late TbcSigningWorker worker;
  int counter = 0;
  final TbcNetworkConfiguration network;
  TbcWebViewNavigation navigation([String session = 'session-1']) =>
      TbcWebViewNavigation(
        webViewInstanceId: 'view-$session',
        sessionId: session,
        navigationId: 'nav-$session',
        committedUrl: 'https://partner.example/dapp',
        origin: 'https://partner.example',
        createdAt: tbcProtocolTimestamp(DateTime.now()),
      );
  Future<void> start({
    MessageSigningProfile messageProfile = MessageSigningProfile.standard,
  }) async {
    worker = await TbcSigningWorker.start(
      library:
          library ??
          TbcPinnedComputeLibrary(
            path: replay['library']['path'],
            sha256: replay['library']['sha256'],
          ),
      network: network,
      backend: backend,
      messageProfile: messageProfile,
      read: read,
      txoStatus:
          customStatus == null
              ? null
              : (points) {
                statusReads++;
                return customStatus!(points);
              },
    );
  }

  Future<Map<String, dynamic>> read(String path) async {
    paths.add(path);
    if (customRead != null) return customRead!(path);
    if ((material['indexedReplies'] as Map).containsKey(path)) return copied(material['indexedReplies'][path]);
    final p = material['snapshot']['payload'] as Map;
    if (path == '/api/tbc/nodeinfo')
      return {
        'blocks': int.parse(p['block']['height']),
        'bestblockhash': p['block']['hash'],
      };
    if (path == '/api/tbc/utxo/address/${material['account']['address']}')
      return {
        'utxos': [
          for (final u in p['utxos'])
            if (u['classification'] == 'native')
              {
                'txid': u['txid'],
                'index': u['vout'],
                'value': u['satoshis'],
                'height': 900,
              },
        ],
      };
    if (path ==
        '/api/tbc/ft/utxo/combinescript/${material['asset']['controller']}/contract/${material['asset']['contractId']}')
      return {
        'utxos': [
          for (final u in p['utxos'])
            if (u['classification'] == 'ft')
              {
                'txid': u['txid'],
                'index': u['vout'],
                'tbc_value': u['satoshis'],
                'ft_value': material['asset']['amount'],
                'height': 900,
              },
        ],
      };
    if (path.startsWith('/api/tbc/txraw/txid/')) {
      final raw = material['raw'][path.split('/').last];
      if (raw != null) return {'txraw': raw};
    }
    throw StateError('Unexpected material read');
  }

  Future<Map<String, dynamic>> execute({
    String method = 'tbc_signTransaction',
    TbcWebViewNavigation? nav,
  }) {
    final a = material['account'];
    final p = copied(transaction['audit']['material']['policy']);
    p['payload']['expiresAt'] = tbcProtocolTimestamp(
      DateTime.now().add(const Duration(minutes: 5)),
    );
    p['policyHash'] = hashJson(p['payload']);
    return worker.execute(
      scope: TbcSigningRequestScope(
        operationId: 'operation-${++counter}',
        method: method,
        navigation: nav ?? navigation(),
        revision: 0,
        account: TbcAccount(
          network: TbcNetwork.testnet,
          address: a['address'],
          publicKey: a['publicKey'],
        ),
      ),
      request: copied(
        method == 'tbc_signTransaction'
            ? transaction['request']
            : message['request'],
      ),
      policy: p,
      requireAuthorized: () {
        need(backend.granted, 'LOCAL_GRANT_REVOKED');
      },
      isUnlocked: () => true,
    );
  }
}

void loadReplay() {
  replay = jsonDecode(
    File('test/fixtures/signing/replay.json').readAsStringSync(),
  );
  replay['library'] = trustedIndexCandidateLibrary();
  material = jsonDecode(
    File('test/fixtures/signing/material.json').readAsStringSync(),
  );
  transaction = (replay['cases'] as List).singleWhere(
    (c) => c['name'] == 'android-tbc_signTransaction',
  );
  final indexed = IndexedFixture([transaction]);
  final fixture = {...transaction, 'replies': <String,dynamic>{}};
  indexed.enrich(fixture);
  material['indexedReplies'] = fixture['replies'];
  message = (replay['cases'] as List).singleWhere(
    (c) => c['name'] == 'android-tbc_signMessage',
  );
}
