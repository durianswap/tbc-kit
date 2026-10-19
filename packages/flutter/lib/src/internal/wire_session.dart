// Adapted from the sealed P5 WebView protocol, without test identity/network,
// payload diagnostics or a Flutter dependency. This is transport, NOT a grant
// evaluator. Only a trusted package session may provide execute/authorize.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import '../configuration.dart';
import '../webview_scope.dart';
import 'protocol_codec.dart';
import 'wallet_protocol.dart';

abstract interface class TbcDocumentDelivery {
  /// Native must verify the expected document at the actual delivery, not just
  /// when a Flutter callback is queued. Sensitive result delivery must also be
  /// fenced against the committed grant/account revision at that executor.
  Future<bool> deliver(String text, TbcWebViewNavigation expected);
  Future<bool> describe(
    Map<String, Object?> value,
    TbcWebViewNavigation expected,
  );
  Future<void> close(TbcWebViewNavigation expected);
}

typedef TbcWireExecute =
    Future<TbcWireOutcome> Function(
      String method,
      Object? params,
      String operationId,
      Object requestId,
    );

/// Fixed public errors only. Native exception strings never reach the page.
enum TbcWireFailure implements Exception {
  rejected(4001, 'Request rejected'),
  unauthorized(4100, 'Unauthorized'),
  unsupported(4200, 'Unsupported method or profile'),
  unsupportedChain(4901, 'Unsupported chain'),
  invalidParams(-32602, 'Invalid parameters'),
  unavailable(-32603, 'Wallet operation unavailable');

  const TbcWireFailure(this.code, this.message);
  final int code;
  final String message;
}

final class TbcWireOutcome {
  TbcWireOutcome(
    Object? value, {
    List<Object?> events = const [],
    this.authorizationChanged = false,
  }) : value = frozen(value),
       events = List.unmodifiable(events.map(frozen));
  final Object? value;
  final List<Object?> events;
  final bool authorizationChanged;
}

/// One native-owned document. No database, network request, signer, Legacy
/// fallback or implicit authorization. Replays never execute a request again.
/// Native cancellation must invalidate permits before asynchronous cleanup.
/// `beforeDelivery` is required for ALL results/replays, not only new requests.
final class TbcWireSession {
  TbcWireSession({
    required this.platform,
    required this.navigation,
    required this.configuration,
    required this.execute,
    required this.cancel,
    required this.invalidateNative,
    required this.requireCurrent,
    required this.beforeDelivery,
    this.onAcknowledged,
    required Set<String> sensitiveMethods,
    this.walletProtocol = TbcNativeWalletProtocol.standard,
    List<String>? supportedChainIds,
  }) : sensitiveMethods = Set.unmodifiable(sensitiveMethods),
       supportedChainIds = List.unmodifiable(
         supportedChainIds ?? [configuration.network.chainId],
       ) {
    if (this.supportedChainIds.isEmpty ||
        this.supportedChainIds.toSet().length !=
            this.supportedChainIds.length ||
        !this.supportedChainIds.contains(configuration.network.chainId) ||
        this.supportedChainIds.any(
          (c) => !TbcNetwork.values.any((n) => n.chainId == c),
        )) {
      throw ArgumentError('Invalid wallet network catalog');
    }
  }
  final TbcDocumentDelivery platform;
  final TbcNativeWalletProtocol walletProtocol;
  final TbcWebViewNavigation navigation;
  final TbcWalletConfiguration configuration;
  final TbcWireExecute execute;
  final Future<void> Function(String operationId) cancel;
  final void Function() invalidateNative, requireCurrent;
  final Future<void> Function(
    String method,
    Object requestId,
    String serialized,
  )
  beforeDelivery;
  final Future<void> Function(Object requestId)? onAcknowledged;
  final Set<String> sensitiveMethods;
  final List<String> supportedChainIds;
  bool _active = true, _ready = false, _started = false;
  int _sequence = 0, _retainedBytes = 0;
  final Map<String, _Request> _requests = {};
  // Acknowledged requests release the bounded in-flight slot and payload, but
  // retain a small collision/replay tombstone for this document's lifetime.
  // Do not LRU-evict these: an old signing request must never execute again.
  final Map<String, String> _retired = {};
  final Set<String> _acknowledged = {};
  static const _maxTrackedMessages = 100000; // Same session bound as Provider.
  // Keep fingerprints, not duplicate page payloads/private witnesses.
  final Map<String, String> _messages = {};
  final Map<String, _Request> _deliveries = {};
  Future<void>? _closing;
  bool get isActive => _active;

  /// Local operation fence, including cancellation before a worker/Vault handle
  /// exists. The native executor still fences its own side effects separately.
  void requireExecution(String operationId, Object requestId) {
    _current();
    final request = _requests[canonical(requestId)];
    need(
      request != null &&
          request.operation == operationId &&
          !request.cancelled &&
          !request.completed,
      'WIRE_OPERATION_INACTIVE',
    );
  }

  void _current() {
    need(_active, 'WIRE_CLOSED');
    requireCurrent();
    need(_active, 'WIRE_CLOSED');
  }

  Map<String, Object> _envelope(String type) => {
    'channel': walletProtocol.wireChannel,
    'type': type,
    'sessionId': navigation.sessionId,
    'navigationId': navigation.navigationId,
    'messageId': 'native-${++_sequence}',
  };

  Future<void> start() async {
    _current();
    need(!_started, 'WIRE_ALREADY_STARTED');
    _started = true;
    try {
      need(
        await platform.deliver(
          canonical({
            ..._envelope('initialize'),
            'origin': navigation.origin,
            'chainId': configuration.network.chainId,
          }),
          navigation,
        ),
        'INITIALIZE_FAILED',
      );
      _current();
      // Only Standard registers discovery metadata. Legacy uses the same
      // bounded transport without registering a second Wallet Standard wallet.
      if (walletProtocol == TbcNativeWalletProtocol.legacy) return;
      need(
        await platform.describe({
          'name': configuration.name,
          'productId': configuration.productId,
          'icon':
              configuration.icon ??
              'data:image/svg+xml;base64,${base64Encode(utf8.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))}',
          'chains': supportedChainIds,
          if (configuration.legacy) ...{
            'walletVersion': configuration.walletVersion,
            'platform': Platform.operatingSystem,
          },
        }, navigation),
        'DESCRIPTOR_FAILED',
      );
      _current();
    } catch (_) {
      await close();
      rethrow;
    }
  }

  void invalidate() {
    if (!_active) return;
    _active = false;
    // Actual native permit revocation is required; local result suppression
    // alone cannot stop another executor from using a key.
    try {
      invalidateNative();
    } finally {
      for (final r in _requests.values) {
        r.cancelled = true;
        r.delivery = null;
        unawaited(cancel(r.operation).catchError((_) {}));
      }
      _messages.clear();
      _deliveries.clear();
      _requests.clear();
      _retired.clear();
      _acknowledged.clear();
      _retainedBytes = 0;
    }
  }

  Future<void> close() => _closing ??= _close();
  Future<void> _close() async {
    try {
      invalidate();
    } finally {
      await platform.close(navigation);
    }
  }

  void _forgetDelivery(_Request r) {
    _retainedBytes -= r.deliveryBytes;
    r.deliveryBytes = 0;
    r.delivery = null;
  }

  // A page cancel has no delivery/ACK. Retire only once both the executor and
  // native cancellation have settled, so cancelled work cannot evade the
  // in-flight bound. Keep the request fingerprint to prevent re-execution.
  void _retireCancelled(_Request r) {
    if (!_active || !r.pageCancelled || !r.cancelSettled ||
        !r.executionSettled || !identical(_requests[canonical(r.id)], r)) return;
    _forgetDelivery(r);
    final deliveryId = r.deliveryId;
    if (deliveryId != null) {
      _deliveries.remove(deliveryId);
      _acknowledged.add(deliveryId); // A queued ACK may still arrive.
    }
    final key = canonical(r.id);
    _retired[key] = r.meaning;
    _requests.remove(key);
  }

  Future<void> _deliver(_Request r) async {
    final text = r.delivery;
    if (!_active || (r.cancelled && !r.cancellationNotice) || text == null)
      return;
    _current();
    await beforeDelivery(r.method, r.id, text);
    _current();
    if (r.cancelled && !r.cancellationNotice) return;
    need(await platform.deliver(text, navigation), 'WIRE_DELIVERY_STALE');
    _current();
  }

  /// Invoked only after the private native owner has committed/fenced a change.
  /// Native delivery validates every event again at actual WebView emission.
  Future<void> authorityChanged(List<Object?> events) async {
    if (!_active) return;
    final committed = List<Object?>.unmodifiable(events.map(frozen));
    try {
      _current();
      await _cancelSensitive(null);
      for (final event in committed) {
        _current();
        need(
          await platform.deliver(
            canonical({..._envelope('event'), 'event': event}),
            navigation,
          ),
          'WIRE_EVENT_STALE',
        );
      }
    } catch (_) {
      await close();
    }
  }

  Future<void> _cancelSensitive(_Request? except) async {
    final pending =
        _requests.values
            .where(
              (r) =>
                  !identical(r, except) &&
                  !r.cancelled &&
                  !r.completed &&
                  sensitiveMethods.contains(r.method),
            )
            .toList();
    // Mark every affected request before awaiting any cancellation callback.
    for (final r in pending) {
      r.cancelled = true;
      _forgetDelivery(r);
    }
    await Future.wait(pending.map((r) => cancel(r.operation)));
    for (final r in pending) {
      if (!_active) return;
      r.cancellationNotice = true;
      _record(r, {
        'jsonrpc': '2.0',
        'id': r.id,
        'error': {'code': 4100, 'message': 'Authorization changed'},
      }, const []);
      await _deliver(r);
    }
  }

  void _record(
    _Request r,
    Map<String, dynamic> response,
    List<Object?> events,
  ) {
    final payload = {'response': response, 'events': events},
        id = hashJson(payload);
    final serialized = canonical({
      ..._envelope('delivery'),
      'deliveryId': id,
      ...payload,
    });
    final size = utf8.encode(serialized).length;
    need(
      size <= 4 * 1024 * 1024 && _retainedBytes + size <= 8 * 1024 * 1024,
      'WIRE_DELIVERY_BOUND',
    );
    _deliveries[id] = r;
    r.deliveryId = id;
    r.completed = true;
    r.delivery = serialized;
    r.deliveryBytes = size;
    _retainedBytes += size;
  }

  void _exact(Map value, Set<String> keys) => need(
    value.length == keys.length && value.keys.every(keys.contains),
    'WIRE_SHAPE',
  );

  void _bounded(Object? value) {
    var count = 0;
    void visit(Object? v, int depth) {
      need(++count <= 100000 && depth <= 128, 'WIRE_BOUND');
      if (v is Map) {
        for (final k in v.keys) {
          need(
            k is String &&
                !{'__proto__', 'constructor', 'prototype'}.contains(k),
            'WIRE_KEY',
          );
          visit(v[k], depth + 1);
        }
      } else if (v is List) {
        for (final e in v) visit(e, depth + 1);
      }
    }

    visit(value, 0);
  }

  Future<void> accept(String text, TbcWebViewMessageSource source) async {
    if (!_active) return;
    try {
      _current();
      need(_started, 'WIRE_NOT_STARTED');
      need(utf8.encode(text).length <= 4 * 1024 * 1024, 'WIRE_SIZE');
      final decoded = jsonDecode(text);
      _bounded(decoded);
      need(decoded is Map && canonical(decoded) == text, 'WIRE_CANONICAL');
      final m = decoded as Map;
      const common = {
        'channel',
        'type',
        'sessionId',
        'navigationId',
        'messageId',
      };
      need(
        m['channel'] == walletProtocol.wireChannel &&
            m['sessionId'] == navigation.sessionId &&
            m['navigationId'] == navigation.navigationId,
        'WIRE_SCOPE',
      );
      need(
        source.isMainFrame &&
            source.origin == navigation.origin &&
            source.topOrigin == navigation.origin &&
            source.sessionId == navigation.sessionId &&
            source.navigationId == navigation.navigationId &&
            source.webViewInstanceId == navigation.webViewInstanceId,
        'WIRE_NATIVE_SOURCE',
      );
      final mid = m['messageId'];
      need(
        mid is String && RegExp(r'^[A-Za-z0-9._:-]{1,128}$').hasMatch(mid),
        'WIRE_ID',
      );
      final messageHash = hashJson(m);
      if (_messages.containsKey(mid)) {
        need(_messages[mid] == messageHash, 'WIRE_REPLAY_COLLISION');
        return;
      }
      need(_messages.length < _maxTrackedMessages, 'WIRE_LIMIT');
      _messages[mid as String] = messageHash;
      switch (m['type']) {
        case 'ready':
          _exact(m, common);
          _ready = true;
          return;
        case 'ack':
          _exact(m, {...common, 'deliveryId'});
          if (_acknowledged.contains(m['deliveryId'])) return;
          final r = _deliveries[m['deliveryId']];
          need(r != null, 'WIRE_UNKNOWN_ACK');
          _forgetDelivery(r!);
          _deliveries.remove(m['deliveryId']);
          _acknowledged.add(m['deliveryId'] as String);
          final key = canonical(r.id);
          _retired[key] = r.meaning;
          _requests.remove(key);
          await onAcknowledged?.call(r.id);
          return;
        case 'cancel':
          _exact(m, {...common, 'requestId', 'reason'});
          need(m['reason'] == 'REQUEST_ABORTED', 'WIRE_CANCEL');
          final r = _requests[canonical(m['requestId'])];
          if (r != null && !r.cancelled) {
            r.cancelled = true;
            r.pageCancelled = true;
            _forgetDelivery(r);
            await cancel(r.operation);
            r.cancelSettled = true;
            _retireCancelled(r);
          }
          return;
        case 'request':
          break;
        default:
          throw StateError('WIRE_TYPE');
      }
      _exact(m, {...common, 'request'});
      need(_ready && m['request'] is Map, 'WIRE_NOT_READY');
      final q = m['request'] as Map;
      _exact(q, {
        'jsonrpc',
        'id',
        'method',
        if (q.containsKey('params')) 'params',
      });
      need(
        q['jsonrpc'] == '2.0' &&
            (q['id'] is String || q['id'] is int) &&
            q['method'] is String,
        'RPC_SHAPE',
      );
      final key = canonical(q['id']), meaning = hashJson(q);
      if (_retired.containsKey(key)) {
        need(_retired[key] == meaning, 'RPC_COLLISION');
        return; // Already acknowledged. No payload retained, no re-execution.
      }
      if (_requests.containsKey(key)) {
        final old = _requests[key]!;
        need(old.meaning == meaning, 'RPC_COLLISION');
        await _deliver(old);
        return;
      }
      need(_requests.length < 128, 'RPC_LIMIT');
      final r = _Request(
        meaning,
        rpcOperationId(navigation.sessionId, q['id']),
        q['method'] as String,
        q['id'] as Object,
      );
      _requests[key] = r;
      Map<String, dynamic> response;
      var events = <Object?>[];
      try {
        final outcome = await execute(r.method, q['params'], r.operation, r.id);
        _current();
        if (r.cancelled) return;
        if (outcome.authorizationChanged) await _cancelSensitive(r);
        events = outcome.events;
        response = {'jsonrpc': '2.0', 'id': r.id, 'result': outcome.value};
      } catch (e) {
        final failure = e is TbcWireFailure ? e : TbcWireFailure.unavailable;
        response = {
          'jsonrpc': '2.0',
          'id': r.id,
          'error': {'code': failure.code, 'message': failure.message},
        };
      } finally {
        r.executionSettled = true;
        _retireCancelled(r);
      }
      if (!_active || r.cancelled) return;
      _record(r, response, events);
      await _deliver(r);
    } catch (_) {
      await close();
    }
  }
}

final class _Request {
  _Request(this.meaning, this.operation, this.method, this.id);
  final String meaning, operation, method;
  final Object id;
  bool cancelled = false;
  bool pageCancelled = false, cancelSettled = false, executionSettled = false;
  bool completed = false, cancellationNotice = false;
  String? delivery, deliveryId;
  int deliveryBytes = 0;
}
