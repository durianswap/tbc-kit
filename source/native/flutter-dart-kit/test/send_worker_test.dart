// Actual non-UI worker and frozen Engine. The custody and broadcast backend
// here replays public fixtures; this is not device, HTTP or chain acceptance.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_broadcast_binding.dart';
import 'package:tbc_kit_flutter_dart/src/internal/broadcast_port.dart';
import 'native_broadcast_binding_test.dart' show Channel;
import 'support/signing_replay.dart' as replay;
import 'support/trusted_index_candidate.dart';

Map fixture(String name) =>
    jsonDecode(File('test/fixtures/$name.json').readAsStringSync());
Map sample(String file, String name) =>
    (fixture(file)['cases'] as List).singleWhere((c) => c['name'] == name);

final class Harness implements TbcWalletSigningBackend {
  Harness(this.method) {
    workflow = method.endsWith('Workflow');
    prepared = method.contains('Prepared');
    source = copied(
      sample(
        workflow
            ? 'workflow-planning'
            : prepared
            ? 'prepared-signing'
            : 'native-signing',
        workflow
            ? prepared
                ? 'prepared-typed'
                : 'native-message'
            : 'transfer-single',
      ),
    );
    expected =
        workflow ? copied(sample('workflow-signing', source['name'])) : source;
    request = copied(source['request']);
    final now = DateTime.now().toUtc(),
        expiry = now.add(const Duration(minutes: 2));
    void refresh(Map r) {
      if (r['proposal'] == null) return;
      final p = r['proposal']['payload'];
      p['createdAt'] = tbcProtocolTimestamp(now);
      p['expiresAt'] = tbcProtocolTimestamp(expiry);
      p['evidence']['observedAt'] = tbcProtocolTimestamp(now);
      r['proposal']['proposalHash'] = hashJson(p);
    }

    if (workflow) {
      request['expiresAt'] = tbcProtocolTimestamp(expiry);
      for (final step in request['steps']) refresh(step);
    } else {
      refresh(request);
    }
    material = copied(
      workflow
          ? (source['materials'] as Map).values.first
          : source['audit']['material'],
    );
    policy = copied(material['policy']);
    policy['payload']['expiresAt'] = tbcProtocolTimestamp(expiry);
    policy['policyHash'] = hashJson(policy['payload']);
  }
  final String method;
  late final bool workflow, prepared;
  late final Map<String, dynamic> source, expected, request, material, policy;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  final paths = <String>[], checks = <String>[];
  bool active = true, supported = true, unknown = false;
  bool nativeCommands = false;
  String? revoked;
  Completer<void>? entered, released;
  late final Operation operation =
      nativeCommands ? CommandOperation(this) : Operation(this);
  late TbcSigningWorker worker;
  late final account = TbcAccount(
    network: TbcNetwork.testnet,
    address: source['account']['address'],
    publicKey: source['account']['publicKey'],
  );
  late final nav = TbcWebViewNavigation(
    webViewInstanceId: 'send-worker',
    sessionId: 'send-session',
    navigationId: 'doc',
    origin: 'https://partner.example',
    committedUrl: 'https://partner.example/dapp',
    createdAt: tbcProtocolTimestamp(DateTime.now()),
  );
  Future<void> start() async {
    // Current read plan omits the chain tip at a zero-confirmation policy.
    // Use its paired Engine; immutable signed-output fixtures remain unchanged.
    final library = trustedIndexCandidateLibrary();
    worker = await TbcSigningWorker.start(
      library: TbcPinnedComputeLibrary(
        path: library['path'],
        sha256: library['sha256'],
      ),
      network: network,
      backend: this,
      read: read,
    );
  }

  Future<Map<String, dynamic>> read(String path) async {
    paths.add(path);
    final p = material['snapshot']['payload'];
    if (path == '/api/tbc/nodeinfo')
      return {
        'blocks': int.parse(p['block']['height']),
        'bestblockhash': p['block']['hash'],
      };
    if (path == '/api/tbc/utxo/address/${account.address}')
      return {
        'utxos': [
          for (final u in p['utxos'])
            {
              'txid': u['txid'],
              'index': '${u['vout']}',
              'value': u['satoshis'],
              'height':
                  '${int.parse(p['block']['height']) - int.parse(u['confirmations']) + 1}',
            },
        ],
      };
    throw StateError('Unexpected material read');
  }

  Future<Map<String, dynamic>> run() => worker.execute(
    scope: TbcSigningRequestScope(
      operationId: 'send',
      method: method,
      navigation: nav,
      account: account,
      revision: 0,
    ),
    request: request,
    policy: policy,
    requireAuthorized: () => need(active && revoked != method, 'REVOKED'),
    isUnlocked: () => true,
    requireAuthorizedMethod: (m) {
      checks.add(m);
      need(active && revoked != m, 'REVOKED');
    },
  );
  @override
  Future<TbcSigningOperation> begin(TbcSigningRequestScope s) async =>
      supported ? operation : SignOnly(operation);
  @override
  void revokePending(TbcWebViewNavigation n) {
    active = false;
  }

  @override
  void revokeOperation(TbcSigningRequestScope s) {
    active = false;
  }
}

class Operation
    implements TbcWorkflowSigningOperation, TbcBroadcastSigningOperation {
  Operation(this.h);
  final Harness h;
  int consents = 0,
      signs = 0,
      closes = 0,
      posts = 0,
      gets = 0,
      authorizations = 0;
  TbcSigningReceipt? receipt;
  TbcBroadcastMaterial? selected;
  String? step;
  @override
  Future<void> requireCurrent() async => need(h.active, 'REVOKED');
  @override
  Future<bool> requestConsent(TbcBoundedSigningIntent i) async {
    consents++;
    expect(i.method, h.method);
    expect(canonical(i.request), canonical(h.request));
    return true;
  }

  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial m) async {
    expect(consents, 1);
    expect(m.binding['bindingHash'], hashJson(m.binding['payload']));
    return receipt = TbcSigningReceipt({
      'status': 'approved',
      'approvalId': 'send',
      'approvalToken': 'public-replay-only',
      'bindingHash': m.binding['bindingHash'],
      'approvedAt': tbcProtocolTimestamp(DateTime.now()),
      'expiresAt': m.binding['payload']['expiresAt'],
    });
  }

  void same(TbcSigningReceipt r) {
    need(h.active, 'REVOKED');
    expect(canonical(r.wire), canonical(receipt!.wire));
  }

  @override
  Future<void> advance(TbcSigningReceipt r, TbcSigningContinuation c) async =>
      throw StateError('Not a staged sample');
  @override
  Future<void> enterWorkflowStep(
    TbcSigningReceipt r,
    TbcSigningContinuation c,
  ) async {
    same(r);
    step = c.wire['stepId'];
  }

  @override
  Future<void> finishWorkflowStep(
    TbcSigningReceipt r,
    TbcSigningContinuation c,
  ) async {
    same(r);
    expect(c.wire['stepId'], step);
    step = null;
  }

  @override
  Future<TbcTaskSignature> sign(TbcSigningReceipt r, TbcSigningTask t) async {
    same(r);
    signs++;
    final Map task, sig;
    if (h.workflow) {
      final row = (h.expected['signed'] as List).singleWhere(
        (v) => v['stepId'] == step && v['task']['taskId'] == t.taskId,
      );
      task = row['task'];
      sig = row['result'];
    } else {
      task = (h.source['audit']['plan']['payload']['signingTasks'] as List)
          .singleWhere((v) => v['taskId'] == t.taskId);
      sig = (h.source['audit']['signatures'] as List).singleWhere(
        (v) => v['taskId'] == t.taskId,
      );
    }
    expect(canonical(t.wire), canonical(task));
    return TbcTaskSignature(
      taskId: t.taskId,
      signatureEncoding: sig['signatureEncoding'],
      signature: sig['signature'],
    );
  }

  @override
  Future<void> authorizeBroadcast(
    TbcSigningReceipt r,
    TbcBroadcastMaterial m,
  ) async {
    same(r);
    expect(authorizations++, 0);
    expect(signs, greaterThan(0));
    selected = m;
    final expected =
        h.workflow
            ? (h.expected['result']['steps'] as List)
                .where((s) => s['result']?['transactions'] != null)
                .expand((s) => s['result']['transactions'] as List)
                .toList()
            : h.source['result']['transactions'];
    expect(canonical(m.bundle['transactions']), canonical(expected));
    expect(m.bundle['totalFee'], h.expected['result']['totalFee']);
  }

  Future<TbcBroadcastResult> submit(TbcSigningReceipt r, {int? index}) async {
    same(r);
    expect(selected, isNotNull);
    posts++;
    h.entered?.complete();
    await h.released?.future;
    if (h.unknown)
      return TbcBroadcastResult({
        'portError': {'name': 'UNAVAILABLE', 'retryable': true},
      });
    final rows = selected!.bundle['transactions'] as List;
    return TbcBroadcastResult(
      index == null
          ? {
            'transactions': [
              for (final tx in rows) {'txid': tx['txid'], 'status': 'accepted'},
            ],
          }
          : {'txid': rows[index]['txid'], 'status': 'accepted'},
    );
  }

  @override
  Future<TbcBroadcastResult> submitTransaction(
    TbcSigningReceipt r,
    int index,
  ) => submit(r, index: index);
  @override
  Future<TbcBroadcastResult> submitBatch(TbcSigningReceipt r) => submit(r);
  @override
  Future<TbcBroadcastResult> reconcileSubmitted(
    TbcSigningReceipt r,
    List<String> ids,
  ) async {
    same(r);
    gets++;
    expect(
      ids,
      (selected!.bundle['transactions'] as List)
          .take(ids.length)
          .map((t) => t['txid'])
          .toList(),
    );
    return TbcBroadcastResult({
      'transactions': [
        for (final id in ids) {'txid': id, 'status': 'confirmed'},
      ],
    });
  }

  @override
  Future<void> close() async {
    closes++;
  }

  Map? finished;
  bool refuseFinish = false;
  @override
  Future<void> finishBroadcast(
    TbcSigningReceipt r,
    TbcBroadcastResult result,
  ) async {
    same(r);
    need(!refuseFinish, 'TEST_FINISH_REFUSED');
    expect(finished, isNull);
    expect(posts, greaterThan(0));
    finished = result.wire;
  }
}

final class SignOnly implements TbcSigningOperation {
  SignOnly(this.inner);
  final Operation inner;
  @override
  Future<void> requireCurrent() => inner.requireCurrent();
  @override
  Future<bool> requestConsent(TbcBoundedSigningIntent i) =>
      inner.requestConsent(i);
  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial m) => inner.bind(m);
  @override
  Future<void> advance(TbcSigningReceipt r, TbcSigningContinuation c) =>
      inner.advance(r, c);
  @override
  Future<TbcTaskSignature> sign(TbcSigningReceipt r, TbcSigningTask t) =>
      inner.sign(r, t);
  @override
  Future<void> close() => inner.close();
}

// The package-owned native adapter exposes only the private transport here.
// Direct submit callbacks deliberately fail: preflight/REST/port work must stay
// in the worker, not move back to Flutter's UI isolate.
final class CommandOperation extends Operation
    implements NativeBroadcastCommands {
  CommandOperation(super.h);
  final channel = Channel();
  @override
  Future<Object?> invokeBroadcast(
    String command,
    Map<String, Object?> fields,
  ) async {
    await requireCurrent();
    expect(nativeBroadcastCommands, contains(command));
    if (command == 'signing.broadcast.authorize') {
      await super.authorizeBroadcast(
        TbcSigningReceipt(fields['receipt'] as Map),
        TbcBroadcastMaterial(
          bundle: fields['bundle'] as Map,
          workflow: fields['workflow'] as Map?,
        ),
      );
    }
    channel.unknownPost = h.unknown;
    final value =
        await channel.invoke(command, {
              'ownerId': 'owner',
              'scope': channel.navigation.toWire(),
              'operation': 'send',
              ...fields,
            })
            as Map;
    posts = channel.posts;
    gets = channel.gets;
    if (command == 'signing.broadcast.finish')
      finished = fields['result'] as Map;
    if (value['ok'] != true) throw BroadcastNodeFailure(value['code']);
    return value['value'];
  }

  @override
  Future<TbcBroadcastResult> submitTransaction(
    TbcSigningReceipt r,
    int index,
  ) async => throw StateError('Port must run in worker');
  @override
  Future<TbcBroadcastResult> submitBatch(TbcSigningReceipt r) async =>
      throw StateError('Port must run in worker');
  @override
  Future<TbcBroadcastResult> reconcileSubmitted(
    TbcSigningReceipt r,
    List<String> txids,
  ) async => throw StateError('Port must run in worker');
}

void main() {
  setUpAll(replay.loadReplay);
  Future<Harness> setup(String method) async {
    final h = Harness(method);
    await h.start();
    addTearDown(h.worker.close);
    return h;
  }

  for (final method in [
    'tbc_sendTransaction',
    'tbc_sendPreparedTransaction',
    'tbc_sendWorkflow',
    'tbc_sendPreparedWorkflow',
  ]) {
    test(
      'private worker preserves shared preparation and one consent: $method',
      () async {
        final h = await setup(method), r = await h.run(), o = h.operation;
        expect([o.consents, o.posts, o.authorizations, o.closes], [1, 1, 1, 1]);
        expect(o.gets, 0);
        expect(canonical(o.finished), canonical(r));
        expect(h.paths, ['/api/tbc/utxo/address/${h.account.address}']);
        expect(h.paths.toSet().length, 1);
        if (h.workflow) {
          expect(r['status'], 'complete');
          expect(h.checks, contains('tbc_sendTransaction'));
        } else {
          expect(r['transactions'][0]['status'], 'submitted');
          expect(r['transactions'][0].containsKey('rawTransaction'), false);
        }
      },
    );
  }
  test(
    'worker refuses send on a signer-only backend before approval or reads',
    () async {
      final h = await setup('tbc_sendTransaction');
      h.supported = false;
      await expectLater(h.run(), throwsStateError);
      expect(h.paths, isEmpty);
      expect(h.operation.consents, 0);
      expect(h.operation.closes, 1);
    },
  );
  for (final method in [
    'tbc_sendTransaction',
    'tbc_sendPreparedTransaction',
    'tbc_sendWorkflow',
    'tbc_sendPreparedWorkflow',
  ]) {
    test(
      'native private transport keeps shared port and REST in worker: $method',
      () async {
        final h = await setup(method);
        h.nativeCommands = true;
        final r = await h.run(), o = h.operation;
        expect([o.consents, o.posts, o.authorizations, o.closes], [1, 1, 1, 1]);
        expect(o.gets, 0);
        expect(canonical(o.finished), canonical(r));
        expect(h.paths, ['/api/tbc/utxo/address/${h.account.address}']);
        expect(
          (o as CommandOperation).channel.journal.rows.values.every(
            (r) => r['state'] == 'completed',
          ),
          true,
        );
        expect(
          h.workflow ? r['status'] : r['transactions'][0]['status'],
          h.workflow ? 'complete' : 'submitted',
        );
      },
    );
  }
  test(
    'worker private wire failure keeps fixed classification and reconciles once',
    () async {
      final h = await setup('tbc_sendTransaction');
      h.nativeCommands = true;
      h.unknown = true;
      final r = await h.run();
      expect(r['transactions'][0]['status'], 'submitted');
      expect([h.operation.posts, h.operation.gets], [1, 1]);
    },
  );
  test('workflow send grant is separate and checked before opening', () async {
    final h = await setup('tbc_sendWorkflow');
    h.revoked = 'tbc_sendTransaction';
    await expectLater(h.run(), throwsStateError);
    expect(h.paths, isEmpty);
    expect(h.operation.posts, 0);
  });
  for (final native in [false, true]) {
    test(
      'native result refusal crosses worker without retry (commands=$native)',
      () async {
        final h = await setup('tbc_sendTransaction');
        h.nativeCommands = native;
        final op = h.operation;
        if (op is CommandOperation)
          op.channel.refuseFinish = true;
        else
          op.refuseFinish = true;
        await expectLater(h.run(), throwsStateError);
        expect([op.posts, op.gets, op.consents, op.closes], [1, 0, 1, 1]);
      },
    );
  }
  test('uncertain single send reconciles once without repeated POST', () async {
    final h = await setup('tbc_sendTransaction');
    h.unknown = true;
    final r = await h.run();
    expect(r['transactions'][0]['status'], 'submitted');
    expect([h.operation.posts, h.operation.gets], [1, 1]);
    expect(h.paths, ['/api/tbc/utxo/address/${h.account.address}']);
  });
  test(
    'navigation while submitting rejects late result and never retries',
    () async {
      final h = await setup('tbc_sendTransaction');
      h.entered = Completer();
      h.released = Completer();
      final r = h.run(), failed = expectLater(r, throwsStateError);
      await h.entered!.future;
      h.worker.invalidate(h.nav);
      h.released!.complete();
      await failed;
      expect(h.operation.posts, 1);
      expect(h.operation.closes, 1);
      expect(h.worker.pendingCount, 0);
    },
  );
}
