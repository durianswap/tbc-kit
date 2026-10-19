import 'dart:async';
import 'dart:convert';
import 'private_host_channel.dart';

/// Bounded UI consent, never a Core approval receipt or a signing permit.
final class TbcEarlyConsent {
  const TbcEarlyConsent.reject() : approved = false, feeCapAtomic = null;
  TbcEarlyConsent.approve({this.feeCapAtomic}) : approved = true {
    if (feeCapAtomic != null &&
        !RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(feeCapAtomic!)) {
      throw const FormatException('Expected fee cap in atomic units');
    }
  }
  final bool approved;
  final String? feeCapAtomic;
  Map<String, Object> toKitDecision() => {
    'status': approved ? 'approved' : 'rejected',
    if (feeCapAtomic != null) 'feeCapAtomic': feeCapAtomic!,
  };
}

/// Host-owned immutable UI material. Its request is the available intent, not
/// the final trusted transaction preview. Do not display it as a signed result.
final class TbcPreparationReview {
  TbcPreparationReview._(
    this.preparationId,
    this.method,
    this.operationKind,
    this.requestHash,
    this.expiresAt,
    this.requiresFeeCap,
    this.suggestedFeeCapAtomic,
    this.chainId,
    this.accountId,
    this.warningScope,
    this.context,
    this.request,
    this.reviewedTransactionScope,
  );
  final String preparationId, method, operationKind, requestHash;
  final DateTime expiresAt;
  final bool requiresFeeCap;
  final String? suggestedFeeCapAtomic, chainId, accountId;
  final List<String> warningScope;
  final Map<String, Object?> context;
  final Object? request;
  final Map<String, Object?>? reviewedTransactionScope;
  @override
  String toString() => 'TbcPreparationReview($operationKind, redacted)';
}

final class TbcPreparationStart {
  TbcPreparationStart._(
    this.preparationId,
    this.method,
    this.requestCount,
    this.inputHash,
    this.startedAt,
    this.expiresAt,
    this.context,
  );
  final String preparationId, method, inputHash;
  final int requestCount;
  final DateTime startedAt, expiresAt;
  final Map<String, Object?> context;
  @override
  String toString() => 'TbcPreparationStart(redacted)';
}

enum TbcPreparationOutcome { complete, rejected, cancelled, failed, expired }

final class TbcPreparationFinish {
  TbcPreparationFinish._(this.preparationId, this.outcome);
  final String preparationId;
  final TbcPreparationOutcome outcome;
}

/// Wallet renders the UI. Kit still validates exact request, fees, warnings,
/// authority and expiry before its later approval.request callback.
final class TbcApprovalPreparationUi {
  const TbcApprovalPreparationUi({
    required this.onBegin,
    required this.onReview,
    required this.onFinish,
  });
  final FutureOr<void> Function(TbcPreparationStart) onBegin;
  final Future<TbcEarlyConsent> Function(TbcPreparationReview) onReview;
  final FutureOr<void> Function(TbcPreparationFinish) onFinish;

  // Private plugin plumbing only. Never register this dispatcher on a WebView.
  Future<String> dispatch(TbcPrivateHostCall call) async {
    call.requireActive();
    final value = _object(jsonDecode(call.input)),
        id = _hash(value, 'preparationId');
    switch (call.method) {
      case TbcPrivateHostMethod.preparationBegin:
        final count = value['requestCount'];
        if (count is! int || count < 1 || count > 5)
          throw const FormatException('Invalid preparation count');
        await onBegin(
          TbcPreparationStart._(
            id,
            _string(value, 'method'),
            count,
            _hash(value, 'inputHash'),
            _time(value, 'startedAt'),
            _time(value, 'expiresAt'),
            _object(_immutable(value['context'])),
          ),
        );
        call.requireActive();
        return 'null';
      case TbcPrivateHostMethod.preparationReview:
        final requiresFeeCap = value['requiresFeeCap'],
            warnings = value['warningScope'];
        if (requiresFeeCap is! bool ||
            warnings is! List ||
            warnings.any((v) => v is! String)) {
          throw const FormatException('Invalid preparation scope');
        }
        final decision = await onReview(
          TbcPreparationReview._(
            id,
            _string(value, 'method'),
            _string(value, 'operationKind'),
            _hash(value, 'requestHash'),
            _time(value, 'expiresAt'),
            requiresFeeCap,
            _optionalString(value, 'suggestedFeeCapAtomic'),
            _optionalString(value, 'chainId'),
            _optionalString(value, 'accountId'),
            List<String>.unmodifiable(warnings),
            _object(_immutable(value['context'])),
            _immutable(value['request']),
            value['reviewedTransactionScope'] == null
                ? null
                : _object(_immutable(value['reviewedTransactionScope'])),
          ),
        );
        call.requireActive();
        return jsonEncode(decision.toKitDecision());
      case TbcPrivateHostMethod.preparationFinish:
        final outcome = _string(value, 'outcome');
        final matches = TbcPreparationOutcome.values.where(
          (v) => v.name == outcome,
        );
        if (matches.length != 1)
          throw const FormatException('Invalid preparation outcome');
        await onFinish(TbcPreparationFinish._(id, matches.single));
        call.requireActive();
        return 'null';
      default:
        throw UnsupportedError('Not a preparation callback');
    }
  }
}

Map<String, Object?> _object(Object? value) {
  if (value is! Map<String, Object?>)
    throw const FormatException('Invalid preparation object');
  return value;
}

String _string(Map<String, Object?> value, String key) {
  final text = value[key];
  if (text is! String || text.isEmpty)
    throw const FormatException('Invalid preparation field');
  return text;
}

String? _optionalString(Map<String, Object?> value, String key) =>
    value[key] == null ? null : _string(value, key);
String _hash(Map<String, Object?> value, String key) {
  final text = _string(value, key);
  if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(text))
    throw const FormatException('Invalid preparation binding');
  return text;
}

DateTime _time(Map<String, Object?> value, String key) {
  final at = value[key];
  if (at is! int || at < 0 || at > 8640000000000000)
    throw const FormatException('Invalid preparation time');
  // Kit UI lifecycle uses epoch milliseconds, separate from Core ISO clocks.
  return DateTime.fromMillisecondsSinceEpoch(at, isUtc: true);
}

Object? _immutable(Object? value) {
  if (value is Map<String, Object?>)
    return Map<String, Object?>.unmodifiable(
      value.map((k, v) => MapEntry(k, _immutable(v))),
    );
  if (value is List) return List<Object?>.unmodifiable(value.map(_immutable));
  return value;
}
