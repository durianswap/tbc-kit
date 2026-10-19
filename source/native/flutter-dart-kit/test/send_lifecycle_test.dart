// Frozen Core reference + actual Native Engine verification. Every custody,
// approval, POST and status callback below is a synthetic in-memory double.
// This does not prove installed device/Vault/HTTP/chain acceptance.
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/reviewed_reviewer.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_stages.dart';
import 'package:tbc_kit_flutter_dart/src/internal/workflow_request.dart';
import 'native_signing_test.dart' show FixtureOperation;

late Map reference, review;
late ComputeProbe engine;
Map read(String path) =>
    jsonDecode(File('test/fixtures/$path.json').readAsStringSync());
Map<String, dynamic> sample(String name) =>
    copied((reference['cases'] as List).singleWhere((c) => c['name'] == name));

final class Harness {
  Harness(this.s) : time = protocolTime(s['now']);
  final Map<String, dynamic> s;
  DateTime time;
  bool granted = true, unlocked = true;
  String? revokedPermission;
  int preparations = 0, reviews = 0, reviewReads = 0;
  final phases = <String>[];
  Future<void> Function()? duringPrepare;
  void Function(String)? duringTiming;
  late final operation = Operation(this);
  late final authority = TbcOperationAuthority(
    context: s['context'],
    account: TbcAccount(
      network: TbcNetwork.testnet,
      address: s['account']['address'],
      publicKey: s['account']['publicKey'],
    ),
    clock: () => time,
    isUnlocked: () => unlocked,
    requireAuthorized: (m) {
      need(granted && m != revokedPermission, 'TEST_GRANT_REVOKED');
      expect({
        s['method'],
        if (s['workflow'] == true)
          ...workflowRequiredPermissions(s['request'], method: s['method']),
      }, contains(m));
    },
  );
  Future<Map<String, dynamic>> prepare(Map r, Map a) async {
    preparations++;
    await duringPrepare?.call();
    if (s['workflow'] != true) return copied(s['material']);
    final step = (s['request']['steps'] as List).singleWhere(
      (t) =>
          t['intent'] != null &&
          canonical(workflowTransactionRequest(s['request'], t)) ==
              canonical(r),
    );
    return copied(s['materials'][step['id']]);
  }

  late final executor = TbcSigningExecutor(
    authority: authority,
    engine: engine,
    signer: operation,
    prepareMaterial: prepare,
    prepareRoleMaterial: (r, a, _) => prepare(r, a),
    prepareReviewed: (r, a, current) async {
      reviews++;
      return ReviewedTransactionReviewer(
        chainId: a['chainId'],
        now: () => time,
        keyless:
            (m, p) =>
                copied(jsonDecode(engine.call('keyless', m, canonical(p)))),
        read: (p) async {
          reviewReads++;
          return copied(review['replies'][p]);
        },
        readHistory: (_) async => throw StateError('No new history reads'),
        status: (points) async {
          reviewReads++;
          return {
            'txos': [
              for (final p in points)
                copied(
                  (review['statuses'] as List).singleWhere(
                    (u) =>
                        u['txid'] == p['txid'] && u['index'] == '${p['index']}',
                  ),
                ),
            ],
          };
        },
      ).review(request: r, account: a, requireCurrent: current);
    },
    timing: (phase, _) {
      phases.add(phase);
      duringTiming?.call(phase);
    },
  );
  Future<Map<String, dynamic>> run() =>
      executor.execute(s['method'], s['request']);
}

final class Operation
    implements
        TbcWorkflowSigningOperation,
        TbcBroadcastSigningOperation,
        TbcTransactionSigningRoles {
  Operation(this.h);
  final Harness h;
  Map get audit => h.s['audit'];
  bool active = true, approve = true;
  int consents = 0,
      binds = 0,
      signs = 0,
      advances = 0,
      closes = 0,
      authorizations = 0,
      posts = 0,
      statusReads = 0,
      signatureCursor = 0,
      replyCursor = 0,
      stageCursor = 0,
      reviewedStage = 0,
      reviewedInput = 0;
  String? step;
  final completed = <String>[];
  TbcSigningReceipt? issued;
  TbcBroadcastMaterial? authorized;
  TbcBroadcastResult? finished;
  bool refuseFinish = false;
  Future<void> Function()? duringConsent;
  void Function()? duringAuthorize, duringSubmit, duringReconcile;
  void Function(Map)? alterReply, alterSignature;
  @override
  Future<void> requireCurrent() async => need(active, 'TEST_NATIVE_REVOKED');
  @override
  Future<List<TbcAccount>> resolveSigningAccounts(
    TbcBoundedSigningIntent i,
  ) async => [
    for (final a in (h.s['accounts'] as List).skip(1))
      TbcAccount(
        network: TbcNetwork.testnet,
        address: a['address'],
        publicKey: a['publicKey'],
      ),
  ];
  @override
  Future<bool> requestConsent(TbcBoundedSigningIntent i) async {
    await requireCurrent();
    consents++;
    expect(i.method, h.s['method']);
    expect(canonical(i.request), canonical(h.s['request']));
    expect(canonical(i.context), canonical(h.s['context']));
    await duringConsent?.call();
    return approve;
  }

  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial m) async {
    await requireCurrent();
    binds++;
    expect(consents, 1);
    expect(canonical(m.binding), canonical(audit['binding']));
    expect(canonical(m.plan), canonical(audit['plan']));
    expect(canonical(m.preview), canonical(audit['preview']));
    return issued = TbcSigningReceipt(audit['approval']);
  }

  void receipt(TbcSigningReceipt r) {
    need(active, 'TEST_NATIVE_REVOKED');
    expect(canonical(r.wire), canonical(issued!.wire));
  }

  @override
  Future<TbcTaskSignature> sign(
    TbcSigningReceipt r,
    TbcSigningTask task,
  ) async {
    receipt(r);
    signs++;
    Map result;
    final isReview =
        h.s['workflow'] == true &&
        (h.s['request']['steps'] as List).singleWhere(
              (s) => s['id'] == step,
            )['kind'] ==
            'reviewedTransaction';
    if (isReview) {
      final stage = review['stages'][reviewedStage];
      expect(task.digest, stage['stage']['digests'][reviewedInput]);
      result = {
        'taskId': task.taskId,
        'signatureEncoding': 'compact64',
        'signature': stage['signatures'][reviewedInput++],
      };
    } else {
      final record = audit['signed'][signatureCursor++];
      expect(canonical(task.wire), canonical(record['task']));
      result = copied(record['result']);
    }
    alterSignature?.call(result);
    return TbcTaskSignature(
      taskId: result['taskId'],
      signatureEncoding: result['signatureEncoding'],
      signature: result['signature'],
    );
  }

  @override
  Future<void> advance(
    TbcSigningReceipt r,
    TbcSigningContinuation pending,
  ) async {
    receipt(r);
    advances++;
    if (pending.wire['kind'] == 'reviewed') {
      reviewedStage++;
      reviewedInput = 0;
      expect(pending.wire['stageIndex'], reviewedStage);
    } else {
      final refs =
          (audit['stages'] as List)
              .where((s) => s['result']['status'] == 'pending')
              .toList();
      expect(canonical(pending.wire), canonical(refs[stageCursor++]['result']));
    }
  }

  @override
  Future<void> enterWorkflowStep(
    TbcSigningReceipt r,
    TbcSigningContinuation c,
  ) async {
    receipt(r);
    expect(step, isNull);
    step = c.wire['stepId'];
    expect(c.wire['workflowPlanHash'], audit['plan']['workflowPlanHash']);
    final s = (h.s['request']['steps'] as List).singleWhere(
      (s) => s['id'] == step,
    );
    expect((s['dependsOn'] as List).every(completed.contains), true);
  }

  @override
  Future<void> finishWorkflowStep(
    TbcSigningReceipt r,
    TbcSigningContinuation c,
  ) async {
    receipt(r);
    expect(c.wire['stepId'], step);
    final expected = (audit['workflow']['steps'] as List).singleWhere(
      (s) => s['id'] == step,
    );
    expect(canonical(c.wire['result']), canonical(expected['result']));
    completed.add(step!);
    step = null;
  }

  @override
  Future<void> authorizeBroadcast(
    TbcSigningReceipt r,
    TbcBroadcastMaterial m,
  ) async {
    receipt(r);
    authorizations++;
    expect(authorizations, 1);
    expect(consents, 1);
    expect(closes, 0);
    expect(signatureCursor, (audit['signed'] as List).length);
    expect(canonical(m.bundle), canonical(audit['bundle']));
    expect(canonical(m.workflow), canonical(audit['workflow']));
    expect(m.toString(), 'TbcBroadcastMaterial(redacted)');
    expect(
      () => m.bundle['transactions'][0]['rawTransaction'] = 'bad',
      throwsUnsupportedError,
    );
    duringAuthorize?.call();
    authorized = m;
  }

  TbcBroadcastResult next(String operation) {
    need(authorized != null, 'TEST_UNAUTHORIZED_SEND');
    final reply = h.s['submissions'][replyCursor++];
    expect(reply['operation'], operation);
    final result =
        reply.containsKey('error')
            ? <String, dynamic>{'portError': copied(reply['error'])}
            : copied(reply['result']);
    alterReply?.call(result);
    final projected = TbcBroadcastResult(result);
    expect(projected.toString(), 'TbcBroadcastResult(redacted)');
    return projected;
  }

  @override
  Future<TbcBroadcastResult> submitTransaction(
    TbcSigningReceipt r,
    int index,
  ) async {
    receipt(r);
    expect(closes, 0);
    expect(h.s['submissions'][replyCursor]['index'], index);
    posts++;
    duringSubmit?.call();
    return next('broadcast.submit');
  }

  @override
  Future<TbcBroadcastResult> submitBatch(TbcSigningReceipt r) async {
    receipt(r);
    expect(closes, 0);
    expect(authorized!.workflow, isNotNull);
    posts++;
    duringSubmit?.call();
    return next('broadcast.submitBatch');
  }

  @override
  Future<TbcBroadcastResult> reconcileSubmitted(
    TbcSigningReceipt r,
    List<String> txids,
  ) async {
    receipt(r);
    expect(txids, h.s['submissions'][replyCursor]['txids']);
    expect(() => txids.add('bad'), throwsUnsupportedError);
    statusReads++;
    duringReconcile?.call();
    return next('broadcast.reconcile');
  }

  @override
  Future<void> close() async {
    closes++;
    active = false;
    authorized = null;
  }

  @override
  Future<void> finishBroadcast(
    TbcSigningReceipt r,
    TbcBroadcastResult result,
  ) async {
    receipt(r);
    need(!refuseFinish, 'TEST_FINISH_REFUSED');
    expect(finished, isNull);
    expect(posts, greaterThan(0));
    expect(closes, 0);
    finished = result;
  }
}

void main() {
  setUpAll(() {
    reference = read('send-lifecycle');
    expect(
      reference['archiveSha256'],
      'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0',
    );
    for (final e in (reference['provenance'] as Map).entries) {
      expect(
        sha256
            .convert(File('test/fixtures/${e.key}.json').readAsBytesSync())
            .toString(),
        e.value,
      );
    }
    review = (read('reviewed-material-b')['cases'] as List).singleWhere(
      (s) => s['name'] == 'associated-two-dependent',
    );
    final lib = read('signing/replay')['library'];
    expect(
      sha256.convert(File(lib['path']).readAsBytesSync()).toString(),
      lib['sha256'],
    );
    engine = ComputeProbe(DynamicLibrary.open(lib['path']));
  });
  // Names are fixed to ensure the four methods and error paths cannot silently
  // disappear when regenerating an oracle. The fixture itself is create-only.
  for (final name in [
    'transfer-single-accepted',
    'transfer-single-reject',
    'transfer-single-unknown-confirmed',
    'transfer-single-unknown-unconfirmed',
    'transfer-single-fatal',
    'amm-holder-fragmented-sell-accepted',
    'amm-holder-fragmented-sell-unknown-confirmed',
    'amm-holder-fragmented-sell-unknown-twice',
    'current-ft-staged-transfer-accepted',
    'staged-ft-primary-accepted',
    'staged-ft-primary-unknown',
    'staged-ft-primary-parent-reject',
    'staged-ft-primary-reject',
    'staged-ft-primary-fatal',
    'native-and-ft-accepted',
    'prepared-typed-accepted',
    'reviewed-then-message-accepted',
  ]) {
    test('frozen Core send parity $name', () async {
      final s = sample(name), h = Harness(s), response = s['response'];
      if (response.containsKey('result')) {
        expect(canonical(await h.run()), canonical(response['result']));
        expect(
          canonical(h.operation.finished?.wire),
          canonical(response['result']),
        );
      } else {
        final messages = {
          'TBC transaction broadcast was rejected': 'BROADCAST_REJECTED',
          'TBC transaction broadcast could not be confirmed':
              'BROADCAST_UNCONFIRMED',
          'TBC transaction broadcast failed': 'BROADCAST_FAILED',
          'Broadcast reconciliation limit exceeded':
              'BROADCAST_RECONCILIATION_LIMIT',
          'TBC batch broadcast failed': 'BROADCAST_BATCH_FAILED',
        };
        expect(messages.containsKey(response['error']['message']), true);
        await expectLater(
          h.run(),
          throwsA(
            isA<StateError>().having(
              (e) => e.message,
              'fixed failure',
              messages[response['error']['message']],
            ),
          ),
        );
      }
      expect(h.operation.consents, 1);
      if (!response.containsKey('result')) expect(h.operation.finished, isNull);
      expect(h.operation.binds, 1);
      expect(h.operation.authorizations, 1);
      expect(h.operation.closes, 1);
      expect(h.operation.replyCursor, (s['submissions'] as List).length);
      expect(
        h.preparations,
        s['workflow'] == true ? (s['materials'] as Map).length : 1,
      );
      expect(
        h.phases.where((p) => p == 'validate:pre-broadcast').length,
        h.preparations,
      );
      if (s['workflow'] == true) {
        expect(h.operation.posts, 1);
        expect(h.operation.statusReads, 0);
      } else {
        expect(h.operation.statusReads, lessThanOrEqualTo(1));
      }
      expect(h.operation.authorized, isNull);
    });
  }
  test(
    'send without native submit capability fails before preparation or approval',
    () async {
      final s = sample('transfer-single-accepted'),
          h = Harness(s),
          signer = FixtureOperation(s);
      final executor = TbcSigningExecutor(
        authority: h.authority,
        engine: engine,
        signer: signer,
        prepareMaterial: h.prepare,
      );
      await expectLater(
        executor.execute(s['method'], s['request']),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'capability',
            'BROADCAST_CUSTODY_REQUIRED',
          ),
        ),
      );
      expect(
        [h.preparations, signer.consents, signer.signs, signer.closes],
        [0, 0, 0, 1],
      );
    },
  );
  test(
    'one early consent overlaps pending material; no prepare refetch for send',
    () async {
      final h = Harness(sample('transfer-single-accepted')),
          entered = Completer<void>(),
          hold = Completer<void>();
      h.duringPrepare = () async {
        entered.complete();
        await hold.future;
      };
      h.operation.duringConsent = () async {
        await entered.future;
        expect(h.operation.signs, 0);
        hold.complete();
      };
      await h.run();
      expect(
        [h.preparations, h.operation.consents, h.operation.posts],
        [1, 1, 1],
      );
    },
  );
  test('user rejection never authorizes or submits', () async {
    final h = Harness(sample('transfer-single-accepted'));
    h.operation.approve = false;
    await expectLater(h.run(), throwsA(isA<TbcSigningRejected>()));
    expect(
      [
        h.operation.signs,
        h.operation.authorizations,
        h.operation.posts,
        h.operation.closes,
      ],
      [0, 0, 0, 1],
    );
  });
  test(
    'revocation after Engine pre-broadcast prevents native admission',
    () async {
      final h = Harness(sample('transfer-single-accepted'));
      h.duringTiming = (p) {
        if (p == 'validate:pre-broadcast') h.granted = false;
      };
      await expectLater(h.run(), throwsA(isA<StateError>()));
      expect(
        [h.operation.authorizations, h.operation.posts, h.operation.closes],
        [0, 0, 1],
      );
    },
  );
  test(
    'revocation during admission prevents POST; no second approval',
    () async {
      final h = Harness(sample('transfer-single-accepted'));
      h.operation.duringAuthorize = () => h.operation.active = false;
      await expectLater(h.run(), throwsA(isA<StateError>()));
      expect(
        [
          h.operation.consents,
          h.operation.authorizations,
          h.operation.posts,
          h.operation.closes,
        ],
        [1, 1, 0, 1],
      );
    },
  );
  test(
    'expiry after parent POST stops child, without replaying parent',
    () async {
      final h = Harness(sample('amm-holder-fragmented-sell-accepted'));
      h.operation.duringSubmit =
          () => h.time = protocolTime(h.s['audit']['approval']['expiresAt']);
      await expectLater(h.run(), throwsA(isA<StateError>()));
      expect(
        [h.operation.posts, h.operation.statusReads, h.operation.closes],
        [1, 0, 1],
      );
    },
  );
  test(
    'malformed ordered batch result rejects, never retries or status-polls',
    () async {
      final h = Harness(sample('staged-ft-primary-accepted'));
      h.operation.alterReply =
          (r) =>
              r['transactions'] = (r['transactions'] as List).reversed.toList();
      await expectLater(h.run(), throwsA(isA<StateError>()));
      expect(
        [h.operation.posts, h.operation.statusReads, h.operation.closes],
        [1, 0, 1],
      );
    },
  );
  test('wrong single txid rejects, never retries', () async {
    final h = Harness(sample('transfer-single-accepted'));
    h.operation.alterReply = (r) => r['txid'] = '00' * 32;
    await expectLater(h.run(), throwsA(isA<StateError>()));
    expect(h.operation.posts, 1);
  });
  test(
    'workflow send also requires separate send permission before any approval',
    () async {
      final h = Harness(sample('staged-ft-primary-accepted'))
        ..revokedPermission = 'tbc_sendTransaction';
      await expectLater(h.run(), throwsA(isA<StateError>()));
      expect(
        [
          h.preparations,
          h.operation.consents,
          h.operation.posts,
          h.operation.closes,
        ],
        [0, 0, 0, 1],
      );
    },
  );
  test(
    'tampered signature fails real Rust validation before any submit authorization',
    () async {
      final h = Harness(sample('transfer-single-accepted'));
      h.operation.alterSignature = (s) => s['signature'] = '00' * 64;
      await expectLater(h.run(), throwsA(isA<StateError>()));
      expect(
        [h.operation.authorizations, h.operation.posts, h.operation.closes],
        [0, 0, 1],
      );
    },
  );
  test('completed shared send executor cannot be reused', () async {
    final h = Harness(sample('transfer-single-accepted'));
    await h.run();
    await expectLater(h.run(), throwsA(isA<StateError>()));
    expect(
      [h.operation.consents, h.operation.posts, h.operation.closes],
      [1, 1, 1],
    );
  });
  test(
    'native result refusal cannot become a successful send or trigger retry',
    () async {
      final h = Harness(sample('transfer-single-accepted'));
      h.operation.refuseFinish = true;
      await expectLater(h.run(), throwsStateError);
      expect(h.operation.finished, isNull);
      expect(
        [
          h.operation.posts,
          h.operation.statusReads,
          h.operation.consents,
          h.operation.closes,
        ],
        [1, 0, 1, 1],
      );
    },
  );
  test(
    'sign-only path adds no pre-broadcast validation or custody capability',
    () async {
      final s = copied((read('native-signing')['cases'] as List).first);
      final op = FixtureOperation(s), phases = <String>[];
      var preparations = 0;
      final result = await TbcSigningExecutor(
        engine: engine,
        signer: op,
        authority: TbcOperationAuthority(
          context: s['context'],
          account: TbcAccount(
            network: TbcNetwork.testnet,
            address: s['account']['address'],
            publicKey: s['account']['publicKey'],
          ),
          requireAuthorized: (m) => expect(m, 'tbc_signTransaction'),
          isUnlocked: () => true,
          clock: () => protocolTime(s['now']),
        ),
        prepareMaterial: (_, __) async {
          preparations++;
          return copied(s['audit']['material']);
        },
        timing: (p, _) => phases.add(p),
      ).execute('tbc_signTransaction', s['request']);
      expect(canonical(result), canonical(s['result']));
      expect(phases, isNot(contains('validate:pre-broadcast')));
      expect([preparations, op.consents, op.closes], [1, 1, 1]);
    },
  );
  test(
    'failed pre-broadcast validation stops the common stage runner',
    () async {
      final s = sample('transfer-single-accepted'), a = s['audit'];
      var preBroadcast = 0;
      await expectLater(
        signTransactionStages(
          material: s['material'],
          plan: a['plan'],
          binding: a['binding'],
          receipt: a['approval'],
          account: s['account'],
          forBroadcast: true,
          receiptCheck: () {},
          advance: (_) async => fail('Single stage only'),
          sign: (_) async => [for (final v in a['signed']) copied(v['result'])],
          engine: (m, p) {
            if (p['phase'] == 'pre-broadcast') {
              preBroadcast++;
              return {'valid': false};
            }
            final r = jsonDecode(engine.call('engine', m, canonical(p)));
            expect(r['ok'], true);
            return copied(r['result']);
          },
        ),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'phase failure',
            'PRE_BROADCAST_INVALID',
          ),
        ),
      );
      expect(preBroadcast, 1);
    },
  );
}
