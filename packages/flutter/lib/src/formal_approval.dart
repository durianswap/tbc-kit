import 'dart:async';
import 'dart:convert';
import 'private_host_channel.dart';
import 'host_environment.dart';

enum TbcApprovalDecision { approve, reject }

/// Scope from Kit's verified binding, not from DApp display metadata.
final class TbcApprovalScope {
  TbcApprovalScope._(
    this.runtimeId,
    this.sessionId,
    this.origin,
    this.operationKind,
    this.contextHash,
    this.chainIds,
    this.accountId,
  );
  final String runtimeId, sessionId, origin, operationKind, contextHash;
  final List<String> chainIds;
  final String? accountId;
  @override
  String toString() => 'TbcApprovalScope(redacted)';
}

/// Immutable display-only projection. It contains neither the raw request,
/// Prepared material, approval token nor HTLC claim preimage. Kit creates the
/// projection; this adapter checks correspondence, not a second chain proof.
final class TbcFormalApproval {
  TbcFormalApproval._(
    this.scope,
    this.method,
    this.operationKind,
    this.bindingHash,
    this.requestHash,
    this.operationHash,
    this.expiresAt,
    this.presentation,
    this.details,
    this.earlyDecision,
  );
  final TbcApprovalScope scope;
  final String method, operationKind, bindingHash, requestHash, operationHash;
  final DateTime expiresAt;
  final Map<String, Object?> presentation;

  /// Whitelisted, Kit-verified non-transaction preview for UI rendering.
  /// Display as untrusted text, never HTML or an executable URL. No logging.
  /// Transaction details remain in [presentation], never in raw materials.
  final Map<String, Object?> details;
  final TbcApprovalDecision? earlyDecision;
  @override
  String toString() => 'TbcFormalApproval($operationKind, redacted)';
}

/// Delivered only to trusted authorization/custody plumbing after consent.
/// Never give this object to a page, renderer, logger or analytics callback.
/// The exact envelope retains the verified signing tasks and workflow evidence
/// needed by the existing custody binder, without rehashing or rewriting them.
final class TbcApprovalAuthorization {
  TbcApprovalAuthorization._(this.review, this._envelope, this._requireActive);
  final TbcFormalApproval review;
  final Map<String, Object?> _envelope;
  final void Function() _requireActive;
  void requireActive() => _requireActive();
  Map<String, Object?> get custodyEnvelope {
    requireActive();
    return _envelope;
  }

  @override
  String toString() => 'TbcApprovalAuthorization(redacted)';
}

/// Issued by the trusted permission/custody owner, not by an approval widget.
/// Revocation must be idempotent and remove any newly installed signing permit.
/// Issuing this receipt does not itself sign or authorize arbitrary digests.
final class TbcIssuedApproval {
  TbcIssuedApproval({
    required this.approvalId,
    required this.approvalToken,
    required this.bindingHash,
    required this.approvedAt,
    required this.expiresAt,
    required this.revoke,
  });
  final String approvalId, approvalToken, bindingHash, approvedAt, expiresAt;
  final FutureOr<void> Function() revoke;
  Map<String, Object> _wire() => {
    'status': 'approved',
    'approvalId': approvalId,
    'approvalToken': approvalToken,
    'bindingHash': bindingHash,
    'approvedAt': approvedAt,
    'expiresAt': expiresAt,
  };
  @override
  String toString() => 'TbcIssuedApproval(redacted)';
}

/// Private Host approval adapter, never a WebView message handler. The wallet
/// owns UI, local authority revisions and its atomic custody implementation.
/// `isAuthorityCurrent` must be a local fence check, not chain/API fetching.
/// The custody owner must also atomically recheck at the actual key operation;
/// these async Dart checks do not prove cross-executor Vault atomicity.
final class TbcFormalApprovalAdapter {
  const TbcFormalApprovalAdapter({
    required this.review,
    required this.isAuthorityCurrent,
    required this.issue,
    required this.clock,
  });
  final Future<TbcApprovalDecision> Function(TbcFormalApproval) review;
  final bool Function(TbcApprovalScope) isAuthorityCurrent;
  final Future<TbcIssuedApproval> Function(TbcApprovalAuthorization) issue;
  // Reuse TbcHostEnvironment.now; never normalize bound input after approval.
  final Future<String> Function() clock;

  Future<String> dispatch(TbcPrivateHostCall call) async {
    call.requireActive();
    if (call.method != TbcPrivateHostMethod.approval) {
      throw UnsupportedError('Not an approval callback');
    }
    final envelope = _object(_immutable(jsonDecode(call.input)));
    final parsed = _parse(call.runtimeId, envelope);
    void active() {
      call.requireActive();
      if (!isAuthorityCurrent(parsed.scope)) {
        throw StateError('Approval authority changed');
      }
    }

    active();
    final openedAt = _instant(await clock());
    active();
    // A bound early refusal survives expiry, without reopening a dialog.
    if (parsed.earlyDecision == TbcApprovalDecision.reject) {
      return _rejection(parsed.bindingHash, openedAt);
    }
    if (!openedAt.isBefore(parsed.expiresAt)) {
      throw StateError('Approval expired');
    }
    final decision = parsed.earlyDecision ?? await review(parsed);
    active();
    final decidedAt = _instant(await clock());
    active();
    if (decision == TbcApprovalDecision.reject) {
      return _rejection(parsed.bindingHash, decidedAt);
    }
    if (decidedAt.isBefore(openedAt) || !decidedAt.isBefore(parsed.expiresAt)) {
      throw StateError('Approval clock or expiry changed');
    }
    TbcIssuedApproval? issued;
    try {
      issued = await issue(
        TbcApprovalAuthorization._(parsed, envelope, active),
      );
      active();
      final observed = _instant(await clock());
      active();
      final approved = _instant(issued.approvedAt),
          expires = _instant(issued.expiresAt);
      if (!_opaque(issued.approvalId) ||
          !_opaque(issued.approvalToken) ||
          issued.bindingHash != parsed.bindingHash ||
          approved.isBefore(decidedAt) ||
          approved.isAfter(observed) ||
          expires.isAfter(parsed.expiresAt) ||
          !expires.isAfter(observed)) {
        throw StateError('Invalid issued approval');
      }
      return jsonEncode(issued._wire());
    } catch (_) {
      // Issue may finish after navigation or unlock cancellation. Do not leave
      // an orphan permission to sign merely because its reply was suppressed.
      if (issued != null) await issued.revoke();
      rethrow;
    }
  }
}

TbcFormalApproval _parse(String runtimeId, Map<String, Object?> envelope) {
  final params = _object(envelope['params']), port = _object(envelope['port']);
  final binding = _object(params['binding']),
      payload = _object(binding['payload']);
  final p = _object(envelope['presentation']), pBinding = _object(p['binding']);
  final evidence = _object(p['evidence']);
  final hash = _hash(binding, 'bindingHash'),
      requestHash = _hash(payload, 'requestHash');
  final operationHash = _hash(payload, 'operationHash');
  final method = _text(payload, 'method'),
      kind = _text(payload, 'operationKind');
  if (p['trust'] != 'binding-verified' ||
      p['phase'] != 'formal' ||
      pBinding['status'] != 'verified' ||
      pBinding['bindingHash'] != hash ||
      pBinding['requestHash'] != requestHash ||
      pBinding['operationHash'] != operationHash ||
      p['method'] != method ||
      p['operationKind'] != kind ||
      port['operation'] != 'approval.request' ||
      evidence['callId'] != _text(port, 'callId')) {
    throw const FormatException('Approval presentation mismatch');
  }
  final requester = _object(_known(p, 'requester'));
  final origin = _text(payload, 'origin');
  if (requester['origin'] != origin ||
      requester['topOrigin'] != origin ||
      requester['frame'] != 'top') {
    throw const FormatException('Approval requester mismatch');
  }
  final expiry = _text(payload, 'expiresAt');
  if (_known(p, 'expiresAt') != expiry) {
    throw const FormatException('Approval expiry mismatch');
  }
  final chains =
      kind == 'permission'
          ? _strings(payload['chainIds'])
          : [_text(payload, 'chainId')];
  if (chains.isEmpty || chains.toSet().length != chains.length) {
    throw const FormatException('Invalid approval chains');
  }
  if (kind != 'permission' && _known(p, 'chainId') != chains.single) {
    throw const FormatException('Approval chain mismatch');
  }
  final account = payload['accountId'];
  if (account != null &&
      (account is! String || _known(p, 'accountId') != account)) {
    throw const FormatException('Approval account mismatch');
  }
  TbcApprovalDecision? early;
  final preparation = port['approvalPreparation'];
  if (preparation != null) {
    final value = _object(preparation);
    if (value['state'] != 'ready' ||
        value['method'] != method ||
        value['operationKind'] != kind ||
        value['requestHash'] != requestHash) {
      throw const FormatException('Approval preparation mismatch');
    }
    if (value['earlyConsent'] != null) {
      final status = _object(value['earlyConsent'])['status'];
      if (status != 'approved' && status != 'rejected') {
        throw const FormatException('Invalid early approval decision');
      }
      early =
          status == 'approved'
              ? TbcApprovalDecision.approve
              : TbcApprovalDecision.reject;
    }
  }
  // Only Kit's display projection reaches UI. Retained raw material goes solely
  // to the custody issuer; reject accidental preimage leakage in projections.
  _assertNoPreimage(p);
  return TbcFormalApproval._(
    TbcApprovalScope._(
      runtimeId,
      _text(payload, 'sessionId'),
      origin,
      kind,
      _hash(payload, 'contextHash'),
      List.unmodifiable(chains),
      account as String?,
    ),
    method,
    kind,
    hash,
    requestHash,
    operationHash,
    _instant(expiry),
    p,
    _displayDetails(kind, params),
    early,
  );
}

Map<String, Object?> _displayDetails(String kind, Map<String, Object?> params) {
  final keys = switch (kind) {
    'permission' => ['requested', 'granted', 'decisions', 'warnings'],
    'message' => ['scheme', 'message', 'digest', 'signIn', 'warnings'],
    'typedData' => [
      'scheme',
      'domain',
      'types',
      'primaryType',
      'message',
      'digest',
      'warnings',
    ],
    'crypto' => ['purpose', 'algorithm', 'message', 'ciphertext', 'warnings'],
    _ => <String>[],
  };
  if (keys.isEmpty) return const {};
  final preview = _object(params['preview']);
  if (preview['operationKind'] != kind) {
    throw const FormatException('Approval preview kind mismatch');
  }
  // Kit's private Host boundary has already authenticated this preview against
  // its pending checkpoint. Do not fetch, hash or reinterpret it in Flutter.
  return Map.unmodifiable({
    for (final key in keys)
      if (preview.containsKey(key)) key: preview[key],
  });
}

Object? _known(Map<String, Object?> value, String key) {
  final field = _object(value[key]);
  if (field['status'] != 'known')
    throw const FormatException('Required approval field is unknown');
  return field['value'];
}

bool _opaque(String value) => value.isNotEmpty && value.length <= 256;
Map<String, Object?> _object(Object? value) {
  if (value is! Map<String, Object?>)
    throw const FormatException('Invalid approval object');
  return value;
}

String _text(Map<String, Object?> value, String key) {
  final result = value[key];
  if (result is! String || result.isEmpty)
    throw const FormatException('Invalid approval field');
  return result;
}

String _hash(Map<String, Object?> value, String key) {
  final result = _text(value, key);
  if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(result))
    throw const FormatException('Invalid approval hash');
  return result;
}

List<String> _strings(Object? value) {
  if (value is! List || value.any((v) => v is! String || v.isEmpty))
    throw const FormatException('Invalid approval list');
  return List<String>.from(value);
}

DateTime _instant(String value) => parseTbcProtocolTimestamp(value);

String _rejection(String hash, DateTime now) => jsonEncode({
  'status': 'rejected',
  'bindingHash': hash,
  'rejectedAt': tbcProtocolTimestamp(now),
});
Object? _immutable(Object? value) {
  if (value is Map<String, Object?>)
    return Map<String, Object?>.unmodifiable(
      value.map((k, v) => MapEntry(k, _immutable(v))),
    );
  if (value is List) return List<Object?>.unmodifiable(value.map(_immutable));
  return value;
}

void _assertNoPreimage(Object? value) {
  if (value is Map) {
    if (value.containsKey('preimage'))
      throw const FormatException('Private witness in approval display');
    for (final entry in value.values) {
      _assertNoPreimage(entry);
    }
  } else if (value is List) {
    for (final entry in value) {
      _assertNoPreimage(entry);
    }
  }
}
