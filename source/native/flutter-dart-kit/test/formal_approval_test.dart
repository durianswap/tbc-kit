import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/private_host_channel.dart';

const now = '2026-10-07T00:00:00Z';
Map<String, dynamic> fixture([String method = 'tbc_signMessage']) {
  final f =
      jsonDecode(
            File(
              'test/fixtures/formal-approval/fixtures.json',
            ).readAsStringSync(),
          )
          as Map;
  return Map<String, dynamic>.from(f['results'][method]['envelope'] as Map);
}

class Harness {
  final replies = <Map<String, Object>>[];
  bool current = true;
  int reviews = 0, issues = 0, revokes = 0;
  String time = now;
  Future<TbcApprovalDecision> Function(TbcFormalApproval)? onReview;
  Future<TbcIssuedApproval> Function(TbcApprovalAuthorization)? onIssue;
  late final adapter = TbcFormalApprovalAdapter(
    review: (review) async {
      reviews++;
      return onReview == null ? TbcApprovalDecision.approve : onReview!(review);
    },
    isAuthorityCurrent:
        (scope) =>
            current &&
            scope.runtimeId == 'native-A' &&
            scope.origin == 'https://partner.example',
    issue: (authorization) async {
      issues++;
      return onIssue == null ? receipt(authorization) : onIssue!(authorization);
    },
    clock: () async => time,
  );
  late final dispatcher = TbcPrivateHostDispatcher(
    runtimeId: 'native-A',
    handle: adapter.dispatch,
    reply: replies.add,
  );
  TbcIssuedApproval receipt(
    TbcApprovalAuthorization a, {
    String? hash,
    String? expiry,
  }) => TbcIssuedApproval(
    approvalId: 'fixture-approval',
    approvalToken: 'fixture-secret-token',
    bindingHash: hash ?? a.review.bindingHash,
    approvedAt: time,
    expiresAt: expiry ?? '2026-10-07T00:01:00Z',
    revoke: () {
      revokes++;
    },
  );
  Future<bool> send(Map<String, dynamic> value) => dispatcher.receive({
    'runtimeId': 'native-A',
    'callId': 'native-A:1',
    'method': 'approval.request',
    'input': jsonEncode(value),
  });
  Map get result => jsonDecode(replies.single['value'] as String) as Map;
}

void early(Map f, String status) {
  final p = f['params']['binding']['payload'] as Map;
  f['port']['approvalPreparation'] = {
    'state': 'ready',
    'method': p['method'],
    'operationKind': p['operationKind'],
    'requestHash': p['requestHash'],
    'earlyConsent': {'status': status},
  };
}

void main() {
  for (final method in ['tbc_requestAccounts', 'tbc_signMessage']) {
    test(
      'actual Kit $method preview reaches UI immutably; custody is separate',
      () async {
        final h = Harness(), f = fixture(method);
        h.onReview = (r) async {
          expect(r.method, method);
          expect(r.presentation.containsKey('signingTasks'), false);
          expect(r.details.containsKey('binding'), false);
          expect(
            () => r.presentation['phase'] = 'fake',
            throwsUnsupportedError,
          );
          if (method == 'tbc_signMessage') {
            expect(
              (r.details['message'] as Map)['data'],
              'Flutter public approval fixture',
            );
            expect(
              () => (r.details['message'] as Map)['data'] = 'changed',
              throwsUnsupportedError,
            );
          } else {
            expect((r.details['granted'] as List).length, 1);
          }
          expect(
            r.toString(),
            isNot(contains('Flutter public approval fixture')),
          );
          return TbcApprovalDecision.approve;
        };
        h.onIssue = (a) async {
          expect(a.custodyEnvelope['params'], f['params']);
          expect(
            () => a.custodyEnvelope['params'] = null,
            throwsUnsupportedError,
          );
          expect(a.toString(), 'TbcApprovalAuthorization(redacted)');
          expect(
            h.receipt(a).toString(),
            isNot(contains('fixture-secret-token')),
          );
          return h.receipt(a);
        };
        await h.send(f);
        expect(h.result['status'], 'approved');
        expect(h.result['bindingHash'], f['params']['binding']['bindingHash']);
        expect([h.reviews, h.issues, h.revokes], [1, 1, 0]);
      },
    );
  }
  test(
    'verified early approval avoids duplicate UI; bound early refusal survives expiry',
    () async {
      final h = Harness(), f = fixture();
      early(f, 'approved');
      await h.send(f);
      expect(h.result['status'], 'approved');
      expect(h.reviews, 0);
      final cancelled = Harness()..time = '2026-10-07T01:00:00Z', g = fixture();
      early(g, 'rejected');
      await cancelled.send(g);
      expect(cancelled.result['status'], 'rejected');
      expect([cancelled.reviews, cancelled.issues], [0, 0]);
    },
  );
  test(
    'mismatched formal evidence cannot reach UI or issue a permit',
    () async {
      final mutations = <void Function(Map)>[
        (f) => f['presentation']['binding']['bindingHash'] = '0' * 64,
        (f) => f['presentation']['evidence']['callId'] = 'wrong',
        (f) =>
            f['presentation']['requester']['value']['origin'] =
                'https://wrong.example',
        (f) => f['presentation']['accountId']['value'] = 'wrong',
        (f) => f['presentation']['chainId']['value'] = 'tbc:mainnet',
        (f) => f['params']['preview']['operationKind'] = 'transaction',
        (f) {
          early(f, 'approved');
          f['port']['approvalPreparation']['requestHash'] = '0' * 64;
        },
        (f) => f['presentation']['preimage'] = 'never-log-witness',
      ];
      for (final mutate in mutations) {
        final h = Harness(), f = fixture();
        mutate(f);
        await h.send(f);
        expect(h.replies.single['status'], 'error');
        expect([h.reviews, h.issues], [0, 0]);
        expect(jsonEncode(h.replies), isNot(contains('never-log-witness')));
      }
    },
  );
  test(
    'local authority invalidation while UI waits prevents issuance',
    () async {
      final h = Harness(),
          entered = Completer<void>(),
          decision = Completer<TbcApprovalDecision>();
      h.onReview = (_) {
        entered.complete();
        return decision.future;
      };
      final pending = h.send(fixture());
      await entered.future;
      h.current = false;
      decision.complete(TbcApprovalDecision.approve);
      await pending;
      expect(h.issues, 0);
      expect(h.replies.single['status'], 'error');
    },
  );
  test(
    'closed runtime suppresses late approval and never issues a permit',
    () async {
      final h = Harness(),
          entered = Completer<void>(),
          decision = Completer<TbcApprovalDecision>();
      h.onReview = (_) {
        entered.complete();
        return decision.future;
      };
      final pending = h.send(fixture());
      await entered.future;
      h.dispatcher.close();
      decision.complete(TbcApprovalDecision.approve);
      expect(await pending, false);
      expect(h.issues, 0);
      expect(h.replies, isEmpty);
    },
  );
  test(
    'late issuer after closure revokes orphan permit and suppresses delivery',
    () async {
      final h = Harness(),
          entered = Completer<void>(),
          release = Completer<void>();
      h.onIssue = (a) async {
        entered.complete();
        await release.future;
        return h.receipt(a);
      };
      final pending = h.send(fixture());
      await entered.future;
      h.dispatcher.close();
      release.complete();
      expect(await pending, false);
      expect(h.revokes, 1);
      expect(h.replies, isEmpty);
    },
  );
  test(
    'wrong receipt binding or extended expiry revokes issued permit',
    () async {
      for (final badHash in [true, false]) {
        final h = Harness();
        h.onIssue =
            (a) async => h.receipt(
              a,
              hash: badHash ? '0' * 64 : null,
              expiry: badHash ? null : '2026-10-07T01:00:00Z',
            );
        await h.send(fixture());
        expect(h.replies.single['status'], 'error');
        expect(h.revokes, 1);
      }
    },
  );
  test(
    'expiry and invalid calendar rejected before UI, without protocol normalization',
    () async {
      for (final time in [
        '2026-10-07T00:05:00Z',
        '2026-02-30T00:00:00Z',
        '2026-10-07T00:00:00.123456Z',
      ]) {
        final h = Harness()..time = time;
        await h.send(fixture());
        expect(h.replies.single['status'], 'error');
        expect([h.reviews, h.issues], [0, 0]);
      }
    },
  );
  test('millisecond trusted time reaches approval without rewriting bound expiry', () async {
    final h = Harness()..time = '2026-10-07T00:00:00.123Z';
    await h.send(fixture());
    expect(h.replies.single['status'], 'ok');
    expect([h.reviews, h.issues], [1, 1]);
  });
  test('user rejection never reaches custody issuer', () async {
    final h = Harness()..onReview = (_) async => TbcApprovalDecision.reject;
    await h.send(fixture());
    expect(h.result['status'], 'rejected');
    expect(h.issues, 0);
  });
}
