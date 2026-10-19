import 'dart:async';
import 'dart:convert';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/private_host_channel.dart';

Map<String, Object?> review() => {
  'preparationId': 'a' * 64,
  'method': 'tbc_signTransaction',
  'operationKind': 'transaction',
  'requestHash': 'b' * 64,
  'expiresAt': 1791331200123,
  'requiresFeeCap': true,
  'suggestedFeeCapAtomic': '200',
  'chainId': 'tbc:testnet',
  'accountId': 'public-test-account',
  'warningScope': ['MULTI_TRANSACTION'],
  'context': {'origin': 'https://partner.example', 'sessionId': 'native-A'},
  'request': {
    'intent': {'amount': '1000', 'privateFixture': 'do-not-log'},
  },
};
Map<Object?, Object?> envelope(
  int id,
  String method,
  Map<String, Object?> value,
) => {
  'runtimeId': 'native-A',
  'callId': 'native-A:$id',
  'method': method,
  'input': jsonEncode(value),
};

void main() {
  test(
    'typed bounded review preserves milliseconds, immutable scope, atomic cap and redaction',
    () async {
      final replies = <Map<String, Object>>[];
      final ui = TbcApprovalPreparationUi(
        onBegin: (_) {},
        onFinish: (_) {},
        onReview: (input) async {
          expect(input.method, 'tbc_signTransaction');
          expect(input.requiresFeeCap, true);
          expect(input.expiresAt.millisecondsSinceEpoch, 1791331200123);
          expect(input.expiresAt.isUtc, true);
          expect(input.suggestedFeeCapAtomic, '200');
          expect(input.toString(), isNot(contains('do-not-log')));
          expect(
            () => input.context['origin'] = 'https://other.example',
            throwsUnsupportedError,
          );
          final intent = (input.request as Map)['intent'] as Map;
          expect(() => intent['amount'] = '2000', throwsUnsupportedError);
          return TbcEarlyConsent.approve(feeCapAtomic: '200');
        },
      );
      final d = TbcPrivateHostDispatcher(
        runtimeId: 'native-A',
        handle: ui.dispatch,
        reply: replies.add,
      );
      expect(
        await d.receive(envelope(1, 'approvalPreparation.review', review())),
        true,
      );
      expect(jsonDecode(replies.single['value'] as String), {
        'status': 'approved',
        'feeCapAtomic': '200',
      });
      // The response has no approvalId, binding receipt or signature.
    },
  );
  test(
    'begin and finish provide typed notifications without granting approval',
    () async {
      final phases = <String>[], replies = <Map<String, Object>>[];
      final ui = TbcApprovalPreparationUi(
        onBegin: (input) {
          expect(input.requestCount, 2);
          phases.add('begin');
        },
        onReview: (_) async => const TbcEarlyConsent.reject(),
        onFinish: (input) {
          expect(input.outcome, TbcPreparationOutcome.cancelled);
          phases.add('finish');
        },
      );
      final d = TbcPrivateHostDispatcher(
        runtimeId: 'native-A',
        handle: ui.dispatch,
        reply: replies.add,
      );
      await d.receive(
        envelope(1, 'approvalPreparation.begin', {
          'preparationId': 'a' * 64,
          'method': 'tbc_signWorkflow',
          'requestCount': 2,
          'inputHash': 'c' * 64,
          'startedAt': 1791331200001,
          'expiresAt': 1791331230001,
          'context': {'origin': 'https://partner.example'},
        }),
      );
      await d.receive(
        envelope(2, 'approvalPreparation.finish', {
          'preparationId': 'a' * 64,
          'outcome': 'cancelled',
        }),
      );
      expect(phases, ['begin', 'finish']);
      expect(replies.map((r) => r['value']).toList(), ['null', 'null']);
    },
  );
  test(
    'late approval after invalidation is suppressed and malformed scopes never reach UI',
    () async {
      final decision = Completer<TbcEarlyConsent>(),
          replies = <Map<String, Object>>[];
      var shown = 0;
      final ui = TbcApprovalPreparationUi(
        onBegin: (_) {},
        onFinish: (_) {},
        onReview: (_) {
          shown++;
          return decision.future;
        },
      );
      final d = TbcPrivateHostDispatcher(
        runtimeId: 'native-A',
        handle: ui.dispatch,
        reply: replies.add,
      );
      await d.receive(
        envelope(1, 'approvalPreparation.review', {
          ...review(),
          'preparationId': 'bad',
        }),
      );
      expect(shown, 0);
      expect(replies.single['status'], 'error');
      final pending = d.receive(
        envelope(2, 'approvalPreparation.review', review()),
      );
      expect(shown, 1);
      d.close();
      decision.complete(TbcEarlyConsent.approve(feeCapAtomic: '200'));
      expect(await pending, false);
      expect(replies.length, 1);
    },
  );
  test('fee cap is exact atomic decimal; rejection does not contain a cap', () {
    for (final value in ['-1', '0.1', '01', '1e3'])
      expect(
        () => TbcEarlyConsent.approve(feeCapAtomic: value),
        throwsFormatException,
      );
    expect(
      TbcEarlyConsent.approve(
        feeCapAtomic: '0',
      ).toKitDecision()['feeCapAtomic'],
      '0',
    );
    expect(const TbcEarlyConsent.reject().toKitDecision(), {
      'status': 'rejected',
    });
  });
}
