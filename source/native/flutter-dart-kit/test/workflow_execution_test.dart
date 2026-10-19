// Source-level execution parity with actual frozen Rust validation and public
// offline signature replay. Not native custody, device or chain acceptance.
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
import 'package:tbc_kit_flutter_dart/src/internal/workflow_request.dart';

late ComputeProbe native;
late Map planning, signing, reviewFixture;
Map read(String file) =>
    jsonDecode(File('test/fixtures/$file.json').readAsStringSync());
Map<String, dynamic> keyless(String m, Map<String, dynamic> p) =>
    copied(jsonDecode(native.call('keyless', m, canonical(p))));

final class Harness {
  Harness(String name, {this.messageProfile = MessageSigningProfile.standard}) {
    source = copied(
      (planning['cases'] as List).singleWhere((s) => s['name'] == name),
    );
    expected = copied(
      (signing['cases'] as List).singleWhere((s) => s['name'] == name),
    );
    time = protocolTime(source['now']);
  }
  late Map<String, dynamic> source, expected;
  final MessageSigningProfile messageProfile;
  late DateTime time;
  bool authorized = true,
      unlocked = true,
      materialDone = false,
      checkExact = true;
  String? revokedGrant;
  int preparations = 0, reviewPreparations = 0, reads = 0;
  Future<void> Function()? duringMaterial;
  late final operation = ReplayOperation(this);
  late final authority = TbcOperationAuthority(
    context: source['context'],
    account: TbcAccount(
      network: TbcNetwork.testnet,
      address: source['account']['address'],
      publicKey: source['account']['publicKey'],
    ),
    isUnlocked: () => unlocked,
    clock: () => time,
    requireAuthorized: (m) {
      need(authorized && m != revokedGrant, 'TEST_AUTH_REVOKED');
      expect({
        source['method'],
        ...workflowRequiredPermissions(source['request']),
      }, contains(m));
    },
  );
  Future<Map<String, dynamic>> prepare(Map<String, dynamic> r, Map a) async {
    preparations++;
    await duringMaterial?.call();
    final step = (source['request']['steps'] as List).firstWhere(
      (s) =>
          s['intent'] != null &&
          canonical(workflowTransactionRequest(source['request'], s)) ==
              canonical(r),
    );
    materialDone = true;
    return copied(source['materials'][step['id']]);
  }

  late final executor = TbcSigningExecutor(
    messageProfile: messageProfile,
    authority: authority,
    engine: native,
    signer: operation,
    prepareMaterial: prepare,
    prepareRoleMaterial: (r, a, roles) => prepare(r, a),
    prepareReviewed: (request, account, fresh) async {
      reviewPreparations++;
      final result = await ReviewedTransactionReviewer(
        chainId: account['chainId'],
        now: () => time,
        keyless: keyless,
        read: (p) async {
          reads++;
          expect(reviewFixture['replies'].containsKey(p), true);
          return copied(reviewFixture['replies'][p]);
        },
        readHistory: (_) async => throw StateError('No new history fetch'),
        status: (points) async {
          reads++;
          return {
            'txos': [
              for (final p in points)
                copied(
                  (reviewFixture['statuses'] as List).singleWhere(
                    (u) =>
                        u['txid'] == p['txid'] && u['index'] == '${p['index']}',
                  ),
                ),
            ],
          };
        },
      ).review(request: request, account: account, requireCurrent: fresh);
      materialDone = true;
      return result;
    },
  );
  Future<Map<String, dynamic>> run() =>
      executor.execute(source['method'], source['request']);
}

final class ReplayOperation
    implements
        TbcWorkflowSigningOperation,
        TbcTransactionSigningRoles,
        TbcCryptoSigningOperation {
  ReplayOperation(this.h);
  final Harness h;
  bool current = true, approve = true;
  int consents = 0,
      binds = 0,
      signs = 0,
      advances = 0,
      closes = 0,
      enters = 0,
      finishes = 0,
      cursor = 0,
      reviewStage = 0,
      reviewInput = 0;
  int? readsAtBinding;
  Map<String, dynamic>? consentReview, boundPlan;
  String? active, unavailableAt;
  bool tamperSignature = false;
  bool tamperCrypto = false, opaqueCryptoFailure = false;
  int cryptos = 0;
  final entered = <String>[], completed = <String>{}, failed = <String>{};
  // Optional offline recording for paired native custody replay. Public frozen
  // fixture material only; no device/Vault/key or production logging hook.
  final trace = <Map<String, dynamic>>[];
  Future<void> Function()? duringConsent;
  void Function()? duringBind,
      duringEnter,
      duringAdvance,
      duringSign,
      duringCrypto,
      duringFinish;
  void Function(Map)? alterReceipt;
  @override
  Future<void> requireCurrent() async => need(current, 'TEST_NATIVE_REVOKED');
  @override
  Future<List<TbcAccount>> resolveSigningAccounts(
    TbcBoundedSigningIntent i,
  ) async => [
    for (final a in (h.source['accounts'] as List).skip(1))
      TbcAccount(
        network: TbcNetwork.testnet,
        address: a['address'],
        publicKey: a['publicKey'],
      ),
  ];
  @override
  Future<bool> requestConsent(TbcBoundedSigningIntent i) async {
    consents++;
    expect(canonical(i.request), canonical(h.source['request']));
    expect(canonical(i.context), canonical(h.source['context']));
    expect(i.toString(), 'TbcBoundedSigningIntent(redacted)');
    consentReview = i.review == null ? null : copied(i.review!);
    if (h.reviewPreparations > 0) {
      expect(h.materialDone, true);
      expect(i.review?['kind'], 'workflow');
    }
    await duringConsent?.call();
    trace.add({
      'call': 'consent',
      'request': copied(i.request),
      'context': copied(i.context),
      if (i.review != null) 'review': copied(i.review!),
    });
    return approve;
  }

  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial m) async {
    binds++;
    boundPlan = copied(m.plan!);
    readsAtBinding = h.reads;
    if (h.checkExact) {
      expect(canonical(m.plan), canonical(h.source['plan']));
      expect(canonical(m.binding), canonical(h.source['binding']));
      expect(canonical(m.preview), canonical(h.source['preview']));
    }
    expect(
      () => m.plan!['payload']['totalFee'] = 'bad',
      throwsUnsupportedError,
    );
    duringBind?.call();
    final r = copied(h.expected['approval']);
    r['bindingHash'] = m.binding['bindingHash'];
    alterReceipt?.call(r);
    trace.add({
      'call': 'bind',
      'binding': copied(m.binding),
      'preview': copied(m.preview),
      'plan': copied(m.plan!),
      'receipt': copied(r),
    });
    return TbcSigningReceipt(r);
  }

  @override
  Future<void> enterWorkflowStep(
    TbcSigningReceipt r,
    TbcSigningContinuation c,
  ) async {
    enters++;
    expect(active, isNull);
    active = c.wire['stepId'];
    entered.add(active!);
    expect(c.wire['kind'], 'workflow-step');
    expect(c.toString(), 'TbcSigningContinuation(redacted)');
    final step = (h.source['request']['steps'] as List).singleWhere(
      (s) => s['id'] == active,
    );
    expect((step['dependsOn'] as List).every(completed.contains), true);
    if (h.checkExact) {
      expect(c.wire['workflowPlanHash'], h.source['plan']['workflowPlanHash']);
    }
    final deferred = (h.expected['deferred'] as List).where(
      (d) => d['stepId'] == active,
    );
    if (deferred.isNotEmpty) {
      expect(
        canonical(c.wire['resolvedDeferredSigningTask']),
        canonical(deferred.single['resolved']),
      );
    }
    if (step['kind'] == 'reviewedTransaction') {
      reviewStage = 0;
      reviewInput = 0;
      expect(c.wire['reviewed']?['kind'], 'reviewed');
    }
    duringEnter?.call();
    trace.add({'call': 'enter', 'entry': copied(c.wire)});
  }

  @override
  Future<void> finishWorkflowStep(
    TbcSigningReceipt r,
    TbcSigningContinuation c,
  ) async {
    finishes++;
    expect(c.wire['stepId'], active);
    expect(c.wire['kind'], 'workflow-step-outcome');
    if (c.wire['status'] == 'completed') {
      if (h.checkExact) {
        final expected = (h.expected['result']['steps'] as List).singleWhere(
          (s) => s['id'] == active,
        );
        expect(canonical(c.wire['result']), canonical(expected['result']));
      }
      completed.add(active!);
    } else {
      expect(c.wire['status'], 'failed');
      expect(active, unavailableAt);
      failed.add(active!);
    }
    duringFinish?.call();
    trace.add({'call': 'finish', 'outcome': copied(c.wire)});
    active = null;
  }

  @override
  Future<void> advance(TbcSigningReceipt r, TbcSigningContinuation c) async {
    advances++;
    expect(active, isNotNull);
    expect(h.reads, readsAtBinding);
    if (c.wire['kind'] == 'reviewed') {
      reviewStage++;
      reviewInput = 0;
      expect(c.wire['stageIndex'], reviewStage);
    }
    duringAdvance?.call();
    trace.add({'call': 'advance', 'pending': copied(c.wire)});
  }

  @override
  Future<TbcTaskSignature> sign(TbcSigningReceipt r, TbcSigningTask t) async {
    signs++;
    expect(active, isNotNull);
    expect(h.reads, readsAtBinding);
    if (active == unavailableAt) {
      trace.add({'call': 'signUnavailable', 'task': copied(t.wire)});
      throw const TbcWorkflowStepUnavailable();
    }
    Map result;
    final step = (h.source['request']['steps'] as List).singleWhere(
      (s) => s['id'] == active,
    );
    if (step['kind'] == 'reviewedTransaction') {
      final stage = reviewFixture['stages'][reviewStage];
      final index = stage['stage']['signingInputIndexes'][reviewInput];
      expect(t.taskId, 'review-single-tx-$reviewStage-input-$index');
      expect(t.digest, stage['stage']['digests'][reviewInput]);
      result = {
        'taskId': t.taskId,
        'signatureEncoding': 'compact64',
        'signature': stage['signatures'][reviewInput++],
      };
    } else {
      // Skip reference tasks belonging to explicitly failed/skipped branches.
      final refs = h.expected['signed'] as List;
      while (cursor < refs.length && refs[cursor]['stepId'] != active) cursor++;
      final expected = refs[cursor++];
      expect(canonical(t.wire), canonical(expected['task']));
      result = copied(expected['result']);
    }
    if (tamperSignature) {
      final s = result['signature'] as String;
      result['signature'] =
          '${s.substring(0, s.length - 2)}${s.endsWith('00') ? '01' : '00'}';
    }
    duringSign?.call();
    trace.add({
      'call': 'sign',
      'task': copied(t.wire),
      'result': copied(result),
    });
    return TbcTaskSignature(
      taskId: result['taskId'],
      signatureEncoding: result['signatureEncoding'],
      signature: result['signature'],
    );
  }

  @override
  Future<TbcCryptoResult> executeCrypto(
    TbcSigningReceipt r,
    TbcCryptoTask t,
  ) async {
    cryptos++;
    expect(active, isNotNull);
    expect(h.reads, readsAtBinding);
    final ref = (h.expected['crypto'] as List).singleWhere(
      (c) => c['stepId'] == active,
    );
    expect(canonical(t.wire), canonical(ref['task']));
    if (active == unavailableAt) {
      trace.add({'call': 'cryptoUnavailable', 'task': copied(t.wire)});
      if (opaqueCryptoFailure) throw StateError('redacted');
      throw const TbcWorkflowStepUnavailable.crypto();
    }
    final result = copied(ref['result']);
    if (tamperCrypto) result['taskId'] = 'different-task';
    duringCrypto?.call();
    trace.add({
      'call': 'crypto',
      'task': copied(t.wire),
      'result': copied(result),
    });
    return TbcCryptoResult(result);
  }

  @override
  Future<void> close() async {
    closes++;
    current = false;
  }
}

void main() {
  setUpAll(() {
    planning = read('workflow-planning');
    signing = read('workflow-signing');
    expect(
      sha256
          .convert(
            File('test/fixtures/workflow-planning.json').readAsBytesSync(),
          )
          .toString(),
      signing['planningSha256'],
    );
    reviewFixture = (read('reviewed-material-b')['cases'] as List).singleWhere(
      (s) => s['name'] == 'associated-two-dependent',
    );
    final lib = read('signing/replay')['library'];
    expect(
      sha256.convert(File(lib['path']).readAsBytesSync()).toString(),
      lib['sha256'],
    );
    native = ComputeProbe(DynamicLibrary.open(lib['path']));
  });
  if (Platform.environment['TBC_WORKFLOW_TRACE_OUTPUT']
      case final String output) {
    test('record public native workflow traces', () async {
      final rows = <Map<String, dynamic>>[];
      for (final name in [
        'staged-ft-primary',
        'reviewed-then-message',
        'independent-failure-mode',
      ]) {
        final h = Harness(name)..checkExact = false;
        h.time = DateTime.fromMillisecondsSinceEpoch(
          DateTime.now().millisecondsSinceEpoch,
          isUtc: true,
        );
        final now = h.time.toIso8601String(),
            expiry = h.time.add(const Duration(minutes: 4)).toIso8601String();
        h.source['request']['expiresAt'] = expiry;
        // Refresh only offline observation/deadline metadata. Real Engine
        // planning runs again; signed bytes/tasks still match frozen vectors.
        for (final material in (h.source['materials'] as Map).values) {
          final snapshot = material['snapshot'], policy = material['policy'];
          snapshot['payload']['capturedAt'] = now;
          snapshot['payload']['expiresAt'] = expiry;
          snapshot['snapshotHash'] = hashJson(snapshot['payload']);
          policy['payload']['expiresAt'] = expiry;
          policy['policyHash'] = hashJson(policy['payload']);
        }
        h.operation.alterReceipt = (r) {
          r['approvedAt'] = now;
          r['expiresAt'] = h.operation.boundPlan!['payload']['expiresAt'];
        };
        if (name == 'independent-failure-mode')
          h.operation.unavailableAt = 'one';
        final result = await h.run();
        expect(h.operation.consents, 1);
        expect(h.operation.binds, 1);
        expect(h.operation.closes, 1);
        rows.add({
          'name': name,
          'method': h.source['method'],
          'account': h.source['account'],
          'context': h.source['context'],
          'request': h.source['request'],
          'trace': h.operation.trace,
          'result': result,
          'reads': h.reads,
          'preparations': h.preparations,
        });
      }
      final file = File(output);
      expect(
        file.existsSync(),
        false,
        reason: 'Immutable offline trace output',
      );
      file.writeAsStringSync(
        jsonEncode({
          'status': 'OFFLINE_PUBLIC_EXECUTOR_TRACE',
          'library': read('signing/replay')['library'],
          'cases': rows,
        }),
      );
    });
  }
  for (final name in [
    'messages-no-chain',
    'native-message',
    'ft-typed-ids',
    'staged-ft-primary',
    'independent-failure-mode',
    'reviewed-then-message',
    'prepared-typed',
    'controller-message',
    'native-and-ft',
  ]) {
    test(
      '$name uses shared executor/stages and exact frozen result with one approval',
      () async {
        final h = Harness(name), result = await h.run();
        expect(canonical(result), canonical(h.expected['result']));
        expect(h.operation.consents, 1);
        expect(h.operation.binds, 1);
        expect(h.operation.closes, 1);
        expect(
          h.operation.finishes,
          (h.source['request']['steps'] as List).length,
        );
        expect(
          h.preparations,
          (h.source['request']['steps'] as List)
              .where((s) => workflowTransaction(s))
              .length,
        );
        if (name == 'staged-ft-primary')
          expect(h.operation.advances, greaterThan(0));
        if (name == 'reviewed-then-message') expect(h.operation.advances, 2);
      },
    );
  }
  test(
    'bounded batch starts reads before consent and signs only after all material',
    () async {
      final h = Harness('native-message'), gate = Completer<void>();
      h.duringMaterial = () => gate.future;
      h.operation.duringConsent = () async {
        expect(h.preparations, 1);
        expect(h.materialDone, false);
        expect(h.operation.signs, 0);
        gate.complete();
      };
      await h.run();
      expect(h.operation.consents, 1);
      expect(h.operation.consentReview, isNull);
    },
  );
  test(
    'unbounded batch sends prepared fee/hash to native consent once',
    () async {
      final h = Harness('native-message')..checkExact = false;
      h.source['request'].remove('maxTotalFee');
      h.operation.duringConsent = () async {
        expect(h.materialDone, true);
        expect(h.operation.signs, 0);
        expect(h.operation.consentReview?['kind'], 'workflow');
      };
      await h.run();
      final review = h.operation.consentReview!, plan = h.operation.boundPlan!;
      expect(review['prepared'], {
        'workflowPlanHash': plan['workflowPlanHash'],
        'totalFee': plan['payload']['totalFee'],
      });
      expect(review['steps'], isEmpty);
      expect(h.operation.consents, 1);
      expect(h.preparations, 1);
    },
  );
  test('whole-batch rejection never binds, enters, or signs', () async {
    final h = Harness('native-message');
    h.operation.approve = false;
    await expectLater(h.run(), throwsA(isA<TbcSigningRejected>()));
    expect(h.operation.binds, 0);
    expect(h.operation.enters, 0);
    expect(h.operation.signs, 0);
    expect(h.operation.closes, 1);
  });
  for (final where in [
    'consent',
    'bind',
    'enter',
    'advance',
    'sign',
    'finish',
  ]) {
    test(
      'revocation during $where aborts without running later dependent step',
      () async {
        final h = Harness('staged-ft-primary');
        void revoke() {
          h.authorized = false;
          h.operation.current = false;
        }

        switch (where) {
          case 'consent':
            h.operation.duringConsent = () async => revoke();
          case 'bind':
            h.operation.duringBind = revoke;
          case 'enter':
            h.operation.duringEnter = revoke;
          case 'advance':
            h.operation.duringAdvance = revoke;
          case 'sign':
            h.operation.duringSign = revoke;
          case 'finish':
            h.operation.duringFinish = revoke;
        }
        await expectLater(h.run(), throwsStateError);
        expect(h.operation.entered, isNot(contains('receipt')));
        expect(h.operation.closes, 1);
      },
    );
  }
  test('batch permission does not grant a missing child permission', () async {
    final h = Harness('native-message');
    h.revokedGrant = 'tbc_signMessage';
    await expectLater(h.run(), throwsStateError);
    expect(h.operation.consents, 0);
    expect(h.preparations, 0);
  });
  test('expiry during preparation cannot bind or sign', () async {
    final h = Harness('native-message');
    h.operation.duringConsent = () async {
      h.time = h.time.add(const Duration(minutes: 3));
    };
    await expectLater(h.run(), throwsStateError);
    expect(h.operation.binds, 0);
    expect(h.operation.signs, 0);
  });
  test('tampered receipt cannot enter a step', () async {
    final h = Harness('native-message');
    h.operation.alterReceipt = (r) => r['bindingHash'] = '0' * 64;
    await expectLater(h.run(), throwsStateError);
    expect(h.operation.enters, 0);
  });
  test('invalid parent signature cannot become a deferred source', () async {
    final h = Harness('native-message');
    h.operation.tamperSignature = true;
    await expectLater(h.run(), throwsStateError);
    expect(h.operation.entered, ['payment']);
    expect(h.operation.completed, isEmpty);
  });
  test(
    'native refusal to record completion suppresses derived messages',
    () async {
      final h = Harness('native-message');
      h.operation.duringFinish = () => throw StateError('TEST_NATIVE_RESULT');
      await expectLater(h.run(), throwsStateError);
      expect(h.operation.entered, ['payment']);
    },
  );
  test(
    'continue-independent skips descendants without retrying the failed step',
    () async {
      final h = Harness('independent-failure-mode');
      h.operation.unavailableAt = 'one';
      final result = await h.run(), rows = result['steps'] as List;
      expect(rows[0]['status'], 'failed');
      expect(rows[0]['error'], {
        'code': 'HOST_UNAVAILABLE',
        'message': 'Workflow step failed: signer.sign',
      });
      expect(rows[1]['status'], 'skipped');
      expect(rows[1]['error'], {
        'code': 'DEPENDENCY_FAILED',
        'message': 'Workflow dependency failed',
      });
      expect(canonical(rows[2]), canonical(h.expected['result']['steps'][2]));
      expect(h.operation.entered, ['one', 'three']);
      expect(h.operation.signs, 2);
      expect(h.operation.consents, 1);
      expect(h.operation.closes, 1);
    },
  );
  test('atomic component failure never signs another step', () async {
    final h = Harness('messages-no-chain');
    h.operation.unavailableAt = 'hello';
    await expectLater(h.run(), throwsA(isA<TbcWorkflowStepUnavailable>()));
    expect(h.operation.entered, ['hello']);
    expect(h.operation.closes, 1);
  });
  test(
    'mixed Reviewed/Engine and repeated Reviewed external inputs reject before binding',
    () async {
      for (final engineMixed in [true, false]) {
        final h = Harness('reviewed-then-message')..checkExact = false;
        final first = copied(h.source['request']['steps'][0]);
        if (engineMixed) {
          final n = Harness('native-message');
          h.source['request']['steps'] = [
            n.source['request']['steps'][0],
            first,
          ];
          h.source['materials'] = n.source['materials'];
        } else {
          h.source['request']['steps'] = [
            first,
            {...first, 'id': 'second'},
          ];
        }
        await expectLater(h.run(), throwsStateError);
        expect(h.operation.binds, 0);
        expect(h.operation.signs, 0);
        expect(h.operation.consents, 0);
      }
    },
  );
}
