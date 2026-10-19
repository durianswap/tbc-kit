import 'dart:async';

// Internal VM-to-host transport, deliberately not exported from the public
// wallet library. This is not a WebView handler or a signing permission.
enum TbcPrivateHostMethod {
  signingRoles('wallet.signingRoles'),
  accounts('accounts.current'),
  accountsForChain('accounts.forChain'),
  readAuthority('authority.read'),
  commitAuthority('authority.commit'),
  loadPermissions('permissions.load'),
  commitPermissions('permissions.commit'),
  clock('clock.now'),
  entropy('entropy.bytes'),
  approval('approval.request'),
  preparationBegin('approvalPreparation.begin'),
  preparationReview('approvalPreparation.review'),
  preparationFinish('approvalPreparation.finish'),
  sign('signer.sign'),
  acceptContinuation('signer.acceptContinuation'),
  reviewedExecute('reviewed.execute'),
  reviewedSignStage('reviewed.signStage'),
  crypto('crypto.execute'),
  httpRequest('http.request'),
  httpCancel('http.cancel'),
  sqliteBegin('sqlite.begin'),
  sqliteExecute('sqlite.execute'),
  sqliteCommit('sqlite.commit'),
  sqliteRollback('sqlite.rollback');

  const TbcPrivateHostMethod(this.wireName);
  final String wireName;
}

final class TbcPrivateHostCall {
  const TbcPrivateHostCall._({
    required this.runtimeId,
    required this.callId,
    required this.method,
    required this.input,
    required bool Function() active,
  }) : _active = active;
  final String runtimeId;
  final String callId;
  final TbcPrivateHostMethod method;
  // Exact Kit JSON. No timestamp normalization, repeated hashing or raw logging.
  final String input;
  final bool Function() _active;
  bool get isActive => _active();
  void requireActive() {
    if (!isActive) throw StateError('Private Host call is no longer active');
  }

  @override
  String toString() => 'TbcPrivateHostCall(${method.wireName}, redacted)';
}

typedef TbcPrivateHostHandler =
    FutureOr<String> Function(TbcPrivateHostCall call);
typedef TbcPrivateHostReply =
    FutureOr<void> Function(Map<String, Object> reply);

/// A native-created VM owns one dispatcher. Arrival order is FIFO, but handlers
/// execute concurrently. Closing suppresses delivery, not external side effects;
/// the platform must also invalidate its authority, custody and network scope.
final class TbcPrivateHostDispatcher {
  TbcPrivateHostDispatcher({
    required this.runtimeId,
    required TbcPrivateHostHandler handle,
    required TbcPrivateHostReply reply,
    this.maxPending = 256,
    this.maxWireCodeUnits = 8 * 1024 * 1024,
  }) : _handle = handle,
       _reply = reply {
    if (!_identity.hasMatch(runtimeId) ||
        maxPending < 1 ||
        maxPending > 4096 ||
        maxWireCodeUnits < 1 ||
        maxWireCodeUnits > 16 * 1024 * 1024) {
      throw const FormatException('Invalid private Host channel configuration');
    }
  }

  static final _identity = RegExp(r'^[A-Za-z0-9_-]{1,128}$');
  static final _positiveSequence = RegExp(r'^[1-9][0-9]{0,15}$');
  static final _methods = {
    for (final v in TbcPrivateHostMethod.values) v.wireName: v,
  };
  final String runtimeId;
  final int maxPending;
  final int maxWireCodeUnits;
  final TbcPrivateHostHandler _handle;
  final TbcPrivateHostReply _reply;
  final Set<String> _pending = {};
  int _lastSequence = 0;
  bool _closed = false;
  int get pendingCount => _pending.length;
  bool get isClosed => _closed;

  Future<bool> receive(Map<Object?, Object?> envelope) async {
    if (_closed || envelope['runtimeId'] != runtimeId) return false;
    final id = envelope['callId'];
    final method = _methods[envelope['method']];
    final input = envelope['input'];
    if (id is! String ||
        !id.startsWith('$runtimeId:') ||
        method == null ||
        input is! String ||
        input.length > maxWireCodeUnits ||
        envelope.length != 4) {
      throw const FormatException('Invalid private Host callback');
    }
    final suffix = id.substring(runtimeId.length + 1);
    if (!_positiveSequence.hasMatch(suffix)) {
      throw const FormatException('Invalid private Host callback identity');
    }
    final sequence = int.parse(suffix);
    if (sequence > 9007199254740991) {
      throw const FormatException('Invalid private Host callback identity');
    }
    if (sequence <= _lastSequence) return false;
    _lastSequence = sequence;
    if (_pending.length >= maxPending) {
      await _send({'runtimeId': runtimeId, 'callId': id, 'status': 'error'});
      return true;
    }
    _pending.add(id);
    final call = TbcPrivateHostCall._(
      runtimeId: runtimeId,
      callId: id,
      method: method,
      input: input,
      active: () => !_closed && _pending.contains(id),
    );
    Map<String, Object> response;
    try {
      final value = await _handle(call);
      if (value.length > maxWireCodeUnits) {
        throw StateError('Invalid private Host result');
      }
      response = {
        'runtimeId': runtimeId,
        'callId': id,
        'status': 'ok',
        'value': value,
      };
    } catch (_) {
      // No exception details, arguments, private material or native raw errors.
      response = {'runtimeId': runtimeId, 'callId': id, 'status': 'error'};
    }
    if (!_pending.remove(id) || _closed) return false;
    await _send(response);
    return true;
  }

  Future<void> _send(Map<String, Object> value) async {
    if (_closed) return;
    try {
      await _reply(Map.unmodifiable(value));
    } catch (_) {
      throw StateError('Private Host delivery failed');
    }
    // Never retry: loss of delivery cannot prove an effect did not happen.
  }

  void close() {
    _closed = true;
    _pending.clear();
  }
}
