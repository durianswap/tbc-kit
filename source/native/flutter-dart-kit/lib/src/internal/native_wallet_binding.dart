import 'dart:async';
import '../configuration.dart';
import '../host_environment.dart';
import '../signing_backend.dart';
import '../webview_scope.dart';
import 'provider_control.dart';
import 'crypto_action.dart';
import 'protocol_codec.dart';
import 'wire_session.dart';
import 'workflow_request.dart';
import 'send_lifecycle.dart';
import 'broadcast_port.dart';
import 'native_broadcast_binding.dart';
import 'wallet_protocol.dart';
import 'maintenance_backend.dart';
import 'nft_mint_job_backend.dart';

/// Private Flutter transport only. The invoker must queue calls in order on the
/// same native custody channel. It is never registered as a WebView handler.
typedef TbcNativeWalletInvoke =
    Future<Object?> Function(String method, Map<String, Object?> arguments);

bool _sameAccount(TbcAccount a, TbcAccount b) =>
    a.network == b.network &&
    a.address == b.address &&
    a.publicKey == b.publicKey;

// Private transport classification only; converted to the backend's typed
// signal by the active workflow operation, never by another callback.
final class _NativeStepUnavailable implements Exception {
  const _NativeStepUnavailable();
}

final class _NativeCryptoUnavailable implements Exception {
  const _NativeCryptoUnavailable();
}

/// Package-owned adapters for one native wallet owner. No permissive backend,
/// default account, key, grant, approval or network request is installed here.
/// Native navigation/lock hooks fence custody *before* notifying this mirror.
final class TbcNativeWalletBindings
    implements
        TbcWalletSigningBackend,
        TbcMaintenanceBackend,
        TbcNftMintJobBackend {
  TbcNativeWalletBindings({
    required this.network,
    required TbcNativeWalletInvoke invoke,
    this.walletProtocol = TbcNativeWalletProtocol.standard,
    List<TbcNetworkConfiguration> additionalNetworks = const [],
  }) : _invoke = invoke,
       networks = Map.unmodifiable({
         network.chainId: network,
         for (final n in additionalNetworks) n.chainId: n,
       }) {
    if (networks.length != additionalNetworks.length + 1 ||
        networks.length > TbcNetwork.values.length) {
      throw ArgumentError('Duplicate native network configuration');
    }
  }
  final TbcNetworkConfiguration network;
  final TbcNativeWalletProtocol walletProtocol;
  final Map<String, TbcNetworkConfiguration> networks;
  final TbcNativeWalletInvoke _invoke;
  final Map<String, TbcNativeDocumentControl> _documents = {};
  static String _key(TbcWebViewNavigation n) =>
      '${n.webViewInstanceId}/${n.sessionId}/${n.navigationId}';

  Future<TbcNativeDocumentControl> open(
    String ownerId,
    TbcWebViewNavigation navigation,
  ) async {
    if (!RegExp(r'^[A-Za-z0-9_-]{1,128}$').hasMatch(ownerId) ||
        _documents.containsKey(_key(navigation)))
      throw StateError('Native document already open or invalid');
    final document =
        networks.length == 1
            ? TbcNativeDocumentControl._(this, ownerId, navigation)
            : _NativeNetworkDocumentControl(this, ownerId, navigation);
    _documents[_key(navigation)] = document;
    try {
      final value = await document._call(
        networks.length == 1 ? 'snapshot' : 'network.snapshot',
      );
      document._install(value);
      document.requireCurrent();
      return document;
    } catch (_) {
      document.invalidate();
      rethrow;
    }
  }

  /// Called only by the private native channel, never from page messages.
  void authorityChanged(
    String ownerId,
    Map scope,
    Object? snapshot, {
    TbcNativeWalletProtocol walletProtocol = TbcNativeWalletProtocol.standard,
  }) {
    if (walletProtocol != this.walletProtocol) return;
    for (final d in _documents.values.toList()) {
      if (d.ownerId == ownerId && d.navigation.matches(scope)) {
        try {
          if (d._install(snapshot)) d.onAuthorityChanged?.call();
        } catch (_) {
          d.invalidate();
        }
      }
    }
  }

  TbcNativeDocumentControl _document(TbcWebViewNavigation navigation) {
    final d = _documents[_key(navigation)];
    if (d == null || !d.navigation.matches(navigation.toWire()))
      throw TbcWireFailure.unauthorized;
    d.requireCurrent();
    return d;
  }

  @override
  Future<TbcSigningOperation> begin(TbcSigningRequestScope scope) async {
    final d = _document(scope.navigation);
    d._signingScope(scope);
    final operation = _NativeSigningOperation(d, scope);
    try {
      final value = await d._call(
        'signing.begin',
        {
          'operation': scope.operationId,
          'method': scope.method,
          'revision': scope.revision,
          'account': scope.account.toKitAccount(),
        },
        true,
        operation.networkStamp,
      );
      d._installActive(value);
      d._requireNetwork(operation.networkStamp);
      d._signingScope(scope);
      return operation;
    } catch (_) {
      await operation.close().catchError((_) {});
      rethrow;
    }
  }

  @override
  void revokePending(TbcWebViewNavigation navigation) {
    _documents[_key(navigation)]?.invalidate();
  }

  // Private package composition, not a Provider method or caller-supplied
  // approval. The normal signing backend is reused for each native-owned child.
  @override
  Future<void> finishMaintenanceNoop(
    TbcSigningRequestScope scope,
    Map<String, dynamic> consent,
    Map<String, dynamic> result,
  ) async {
    final d = _document(scope.navigation);
    final stamp = d._captureNetwork();
    d._signingScope(scope);
    if (scope.method != 'tbc_sendTransaction')
      throw TbcWireFailure.unauthorized;
    final reply = await d._call(
      'maintenance.noop',
      {
        'operation': scope.operationId,
        'revision': scope.revision,
        'account': scope.account.toKitAccount(),
        'consent': frozen(copied(consent)),
        'result': frozen(copied(result)),
      },
      true,
      stamp,
    );
    d._requireNetwork(stamp);
    d._signingScope(scope);
    if (canonical(reply) != canonical({'status': 'not-required'}))
      throw TbcWireFailure.unavailable;
  }

  @override
  Future<TbcNativeMaintenance> beginMaintenance(
    TbcSigningRequestScope scope,
    Map<String, dynamic> consent,
  ) async {
    final d = _document(scope.navigation);
    d._signingScope(scope);
    if (scope.method != 'tbc_sendTransaction') {
      throw TbcWireFailure.unauthorized;
    }
    final owned = frozen(copied(consent)) as Map<String, dynamic>;
    final stamp = d._captureNetwork();
    try {
      final reply = await d._call(
        'maintenance.begin',
        {
          'operation': scope.operationId,
          'revision': scope.revision,
          'account': scope.account.toKitAccount(),
          'consent': owned,
        },
        true,
        stamp,
      );
      d._signingScope(scope);
      if (reply is! Map ||
          reply.length != 5 ||
          reply['status'] != 'approved' ||
          reply['scopeHash'] != hashJson(owned) ||
          reply['approvalId'] is! String ||
          (reply['approvalId'] as String).isEmpty ||
          protocolTime(
            reply['expiresAt'],
          ).isAfter(protocolTime(owned['limits']['expiresAt'])) ||
          !protocolTime(reply['expiresAt']).isAfter(DateTime.now())) {
        throw TbcWireFailure.unavailable;
      }
      protocolTime(reply['approvedAt']);
      return TbcNativeMaintenance._(
        d,
        scope,
        stamp,
        frozen(copied(reply)) as Map<String, dynamic>,
      );
    } catch (_) {
      await d
          ._call(
            'maintenance.close',
            {'operation': scope.operationId},
            false,
            stamp,
          )
          .catchError((_) => null);
      rethrow;
    }
  }

  @override
  Future<TbcNftMintJobOwner> beginNftMintJob(
    TbcSigningRequestScope scope,
    Map<String, dynamic> consent,
  ) async {
    final d = _document(scope.navigation);
    d._signingScope(scope);
    final stamp = d._captureNetwork(), owned = frozen(copied(consent));
    try {
      final reply = await d._call(
        'mintJob.begin',
        {
          'operation': scope.operationId,
          'revision': scope.revision,
          'account': scope.account.toKitAccount(),
          'consent': owned,
        },
        true,
        stamp,
      );
      d._signingScope(scope);
      d._requireNetwork(stamp);
      if (reply is! Map ||
          reply['status'] != 'approved' ||
          reply['scopeHash'] != hashJson(owned))
        throw TbcWireFailure.unavailable;
      return _NativeMintJob(d, scope, stamp);
    } catch (_) {
      await d
          ._call(
            'mintJob.close',
            {'operation': scope.operationId},
            false,
            stamp,
          )
          .catchError((_) => null);
      rethrow;
    }
  }

  @override
  void revokeOperation(TbcSigningRequestScope scope) {
    final d = _documents[_key(scope.navigation)];
    if (d != null) unawaited(d.cancel(scope.operationId).catchError((_) {}));
  }
}

final class _NativeMintJob implements TbcNftMintJobOwner {
  _NativeMintJob(this.document, this.scope, this.stamp);
  final TbcNativeDocumentControl document;
  final TbcSigningRequestScope scope;
  final Map<String, Object>? stamp;
  bool finished = false;
  Future<void>? closing;
  void check() {
    if (finished || closing != null) throw TbcWireFailure.unauthorized;
    document._requireNetwork(stamp);
    document._signingScope(scope);
  }

  @override
  Future<TbcSigningOperation> beginBatch(
    TbcSigningRequestScope child,
    Map<String, dynamic> request,
    int offset,
  ) async {
    check();
    if (child.method != 'tbc_sendTransaction' ||
        child.revision != scope.revision ||
        !_sameAccount(child.account, scope.account) ||
        !child.navigation.matches(scope.navigation.toWire()))
      throw TbcWireFailure.unauthorized;
    final operation = _NativeSigningOperation(document, child);
    try {
      final reply = await document._call(
        'mintJob.batch',
        {
          'operation': child.operationId,
          'parent': scope.operationId,
          'offset': offset,
          'request': frozen(copied(request)),
        },
        true,
        stamp,
      );
      document._installActive(reply);
      check();
      document._signingScope(child);
      return operation;
    } catch (_) {
      await operation.close().catchError((_) {});
      rethrow;
    }
  }

  @override
  Future<Map<String, dynamic>> batchResult() async {
    check();
    final result = await document._call(
      'mintJob.result',
      {'operation': scope.operationId},
      true,
      stamp,
    );
    check();
    return copied(result as Map);
  }

  @override
  Future<Map<String, dynamic>> finish(String reason) async {
    check();
    final result = await document._call(
      'mintJob.finish',
      {'operation': scope.operationId, 'reason': reason},
      true,
      stamp,
    );
    check();
    finished = true;
    return copied(result as Map);
  }

  @override
  Future<void> close() =>
      closing ??= document
          ._call(
            'mintJob.close',
            {'operation': scope.operationId},
            false,
            stamp,
          )
          .then<void>((_) {});
}

/// Private native consent lifetime. It holds neither keys nor a second
/// executor. Cancellation closes the native owner and any uncompleted child;
/// unknown submission evidence remains with the existing broadcast journal.
final class TbcNativeMaintenance implements TbcMaintenanceOwner {
  TbcNativeMaintenance._(
    this._document,
    this._scope,
    this._networkStamp,
    this.approval,
  );
  final TbcNativeDocumentControl _document;
  final TbcSigningRequestScope _scope;
  final Map<String, Object>? _networkStamp;
  @override
  final Map<String, dynamic> approval;
  Future<void>? _closing;
  bool _finished = false;

  @override
  Future<void> finish(Map<String, dynamic> result) async {
    if (_closing != null || _finished) throw TbcWireFailure.unauthorized;
    _document._requireNetwork(_networkStamp);
    _document._signingScope(_scope);
    final reply = await _document._call(
      'maintenance.finish',
      {'operation': _scope.operationId, 'result': frozen(copied(result))},
      true,
      _networkStamp,
    );
    if (reply != true || _closing != null) throw TbcWireFailure.unauthorized;
    _document._requireNetwork(_networkStamp);
    _document._signingScope(_scope);
    _finished = true;
  }

  @override
  Future<TbcSigningOperation> beginStep({
    required TbcSigningRequestScope scope,
    required Map<String, dynamic> step,
    required Map<String, dynamic> request,
    required List<String> selectedInputs,
  }) async {
    if (_closing != null ||
        _finished ||
        scope.method != 'tbc_sendTransaction' ||
        scope.operationId == _scope.operationId ||
        scope.revision != _scope.revision ||
        !_sameAccount(scope.account, _scope.account) ||
        !_scope.navigation.matches(scope.navigation.toWire())) {
      throw TbcWireFailure.unauthorized;
    }
    _document._requireNetwork(_networkStamp);
    _document._signingScope(_scope);
    _document._signingScope(scope);
    final operation = _NativeSigningOperation(_document, scope);
    try {
      final reply = await _document._call(
        'maintenance.step',
        {
          'operation': scope.operationId,
          'parent': _scope.operationId,
          'step': frozen(copied(step)),
          'request': frozen(copied(request)),
          'selectedInputs': List<String>.unmodifiable(selectedInputs),
        },
        true,
        _networkStamp,
      );
      _document._installActive(reply);
      if (_closing != null) throw TbcWireFailure.unauthorized;
      _document._requireNetwork(_networkStamp);
      _document._signingScope(_scope);
      _document._signingScope(scope);
      return operation;
    } catch (_) {
      await operation.close().catchError((_) {});
      rethrow;
    }
  }

  @override
  Future<void> close() =>
      _closing ??= _document
          ._call(
            'maintenance.close',
            {'operation': _scope.operationId},
            false,
            _networkStamp,
          )
          .then<void>((_) {});
}

/// A cheap cache of native committed state, never the authority at key use or
/// emission. Updating a snapshot does not itself grant a native signing permit.
final class TbcNativeDocumentControl
    implements
        TbcProviderControl,
        TbcProviderDeliveryControl,
        TbcProviderProtocolControl,
        TbcProviderAccountCatalog,
        TbcProviderOptionalMethods {
  TbcNativeDocumentControl._(this._hub, this.ownerId, this.navigation);
  final TbcNativeWalletBindings _hub;
  @override
  TbcNativeWalletProtocol get walletProtocol => _hub.walletProtocol;
  final String ownerId;
  @override
  final TbcWebViewNavigation navigation;
  _NativeSnapshot? _snapshot;
  bool _active = true;
  final Set<String> _cancelled = {};
  void Function()? onAuthorityChanged;
  @override
  TbcNetworkConfiguration get network => _hub.network;
  _NativeSnapshot get _state {
    requireCurrent();
    return _snapshot!;
  }

  @override
  TbcAccount get selectedAccount => _state.account;
  @override
  int get revision => _state.revision;
  @override
  bool get isUnlocked => _state.unlocked;
  @override
  Set<String> get optionalMethods => _state.optionalMethods;
  @override
  void requireCurrent() {
    if (!_active || _snapshot == null) throw TbcWireFailure.unauthorized;
  }

  bool _install(Object? value) {
    if (!_active) throw TbcWireFailure.unauthorized;
    final next = _NativeSnapshot.parse(
          value,
          network.network,
          navigation.origin,
        ),
        old = _snapshot;
    if (old != null) {
      if (next.revision < old.revision) return false;
      if (next.accountRevision < old.accountRevision)
        throw StateError('Native account revision regressed');
      if (next.revision == old.revision) {
        if (next.identity != old.identity)
          throw StateError('Native snapshot changed without revision');
        return false;
      }
    }
    _snapshot = next;
    return true;
  }

  bool _installActive(Object? value) => _install(value);
  void _installReply(Object? value) => _install(value);
  Map<String, Object>? _captureNetwork() => null;
  void _requireNetwork(Map<String, Object>? expected) {}
  void _requireResponseNetwork(
    String method,
    Map<String, Object?> fields,
    Map<String, Object>? expected,
  ) => _requireNetwork(expected);

  Future<Object?> _call(
    String method, [
    Map<String, Object?> fields = const {},
    bool requireActive = true,
    Map<String, Object>? expectedNetwork,
  ]) async {
    if (requireActive && !_active) throw TbcWireFailure.unauthorized;
    final stamp = expectedNetwork ?? _captureNetwork();
    if (requireActive) _requireNetwork(stamp);
    Object? reply;
    try {
      reply = await _hub._invoke(method, {
        'ownerId': ownerId,
        'scope': navigation.toWire(),
        ...fields,
        if (_hub.walletProtocol != TbcNativeWalletProtocol.standard)
          'walletProtocol': _hub.walletProtocol.namespace,
        if (stamp != null && method != 'network.snapshot') 'network': stamp,
      });
    } catch (_) {
      throw TbcWireFailure.unavailable;
    }
    if (requireActive && !_active) throw TbcWireFailure.unauthorized;
    if (requireActive) _requireResponseNetwork(method, fields, stamp);
    if (reply is! Map || reply['ok'] is! bool) throw TbcWireFailure.unavailable;
    if (reply['ok'] == false) {
      if (reply.keys.toSet().difference({'ok', 'code'}).isNotEmpty)
        throw TbcWireFailure.unavailable;
      if (reply['code'] == 'USER_REJECTED') throw const TbcSigningRejected();
      if (reply['code'] == 'UNSUPPORTED_CHAIN')
        throw TbcWireFailure.unsupportedChain;
      if (method == 'signing.broadcast.wire' &&
          {
            'NODE_REQUEST_FAILED',
            'NODE_RESPONSE_INVALID',
          }.contains(reply['code'])) {
        throw BroadcastNodeFailure(reply['code']);
      }
      if (method == 'signing.sign' &&
          reply['code'] == 'NATIVE_WORKFLOW_STEP_UNAVAILABLE')
        throw const _NativeStepUnavailable();
      if (method == 'signing.crypto' &&
          reply['code'] == 'NATIVE_WORKFLOW_CRYPTO_UNAVAILABLE')
        throw const _NativeCryptoUnavailable();
      throw TbcWireFailure.unauthorized;
    }
    if (!reply.containsKey('value') ||
        reply.keys.toSet().difference({'ok', 'value', 'snapshot'}).isNotEmpty)
      throw TbcWireFailure.unavailable;
    if (requireActive && reply.containsKey('snapshot'))
      _installReply(reply['snapshot']);
    if (requireActive) _requireResponseNetwork(method, fields, stamp);
    return reply['value'];
  }

  @override
  bool permits(String capability) {
    return _permitsAccount(capability, _state.account);
  }

  bool _permitsAccount(String capability, TbcAccount account) {
    final s = _state;
    if (!s.unlocked) return false;
    return s.permissions.any((p) {
      if (p['parentCapability'] != capability) return false;
      if (!(p['caveats'] as List).any(
        (c) =>
            c['type'] == 'restrictAccounts' &&
            (c['value'] as List).contains(account.accountId),
      ))
        return false;
      final expiry = (p['caveats'] as List).where(
        (c) => c['type'] == 'expiresAt',
      );
      return expiry.isEmpty ||
          DateTime.now().isBefore(
            parseTbcProtocolTimestamp(expiry.single['value']),
          );
    });
  }

  @override
  List<TbcAccount> get connectedAccounts => List.unmodifiable(
    _state.connectedAccounts.where((a) => _permitsAccount('tbc_accounts', a)),
  );

  @override
  bool permitsAccount(String capability, TbcAccount account) =>
      connectedAccounts.any((a) => _sameAccount(a, account)) &&
      _permitsAccount(capability, account);

  @override
  List<Map<String, dynamic>> currentPermissions() => _state.permissions
      .where((p) => permits(p['parentCapability']))
      .toList(growable: false);
  void _signingScope(TbcSigningRequestScope scope) {
    requireCurrent();
    if (_cancelled.contains(scope.operationId) ||
        ((cryptoMethods.contains(scope.method) ||
                sendMethods.contains(scope.method)) &&
            !optionalMethods.contains(scope.method)) ||
        !navigation.matches(scope.navigation.toWire()) ||
        revision != scope.revision ||
        !_sameAccount(selectedAccount, scope.account) ||
        !permits('tbc_accounts') ||
        (sendMethods.contains(scope.method) &&
            !permits('tbc_sendTransaction')) ||
        !permits(signingPermissionForMethod(scope.method)))
      throw TbcWireFailure.unauthorized;
  }

  @override
  Future<List<Map<String, dynamic>>> requestPermissions(
    TbcPermissionRequest request,
  ) async {
    requireCurrent();
    if (_cancelled.contains(request.operationId) ||
        !navigation.matches(request.navigation.toWire()) ||
        revision != request.revision ||
        !_sameAccount(selectedAccount, request.account))
      throw TbcWireFailure.unauthorized;
    try {
      final value = await _call('permissions.request', {
        'operation': request.operationId,
        'permissions': request.permissions,
        'providerMethod': request.providerMethod,
      });
      requireCurrent();
      if (value is! List) throw TbcWireFailure.unavailable;
      return List.unmodifiable(
        value.map((v) => frozen(copied(v as Map)) as Map<String, dynamic>),
      );
    } on TbcSigningRejected {
      throw TbcWireFailure.rejected;
    }
  }

  @override
  Future<void> disconnect(String operationId) async {
    await _call('permissions.disconnect', {'operation': operationId});
  }

  @override
  Future<void> beforeDelivery(
    String method,
    Object requestId,
    String serialized,
  ) async {
    if (await _call('delivery.prepare', {
          'method': method,
          'requestId': requestId,
          'serialized': serialized,
        }) !=
        true)
      throw TbcWireFailure.unauthorized;
  }

  @override
  Future<void> acknowledgeDelivery(Object requestId) async {
    if (await _call('delivery.acknowledge', {'requestId': requestId}) != true) {
      throw TbcWireFailure.unavailable;
    }
  }

  @override
  Future<void> cancel(String operationId) {
    if (!_active) return Future.value();
    _cancelled.add(operationId);
    // Queue before any later native begin/sign. The native owner maintains its
    // own tombstone and checks it at actual key use, not at Dart notification.
    return _call('operation.cancel', {
      'operation': operationId,
    }).then<void>((_) {});
  }

  @override
  void invalidate() {
    if (!_active) return;
    _active = false;
    if (identical(
      _hub._documents[TbcNativeWalletBindings._key(navigation)],
      this,
    ))
      _hub._documents.remove(TbcNativeWalletBindings._key(navigation));
    unawaited(
      _call('document.invalidate', const {}, false).catchError((_) {
        return null;
      }),
    );
  }
}

/// Multi-network mirror, using the same native custody calls and signing
/// operation as a single-network wallet. No second transaction executor.
final class _NativeNetworkDocumentControl extends TbcNativeDocumentControl
    implements TbcProviderNetworkControl, TbcProviderNativeCapabilities {
  _NativeNetworkDocumentControl(super.hub, super.ownerId, super.navigation)
    : super._();
  String? _chain;
  int _generation = 0;
  Map<String, _NativeSnapshot> _lanes = {};
  List<Map<String, dynamic>> _permissions = const [];

  @override
  Map<String, TbcNetworkConfiguration> get supportedNetworks => _hub.networks;
  @override
  TbcNetworkConfiguration get network =>
      supportedNetworks[_chain ?? _hub.network.chainId]!;
  @override
  int get networkRevision {
    requireCurrent();
    return _generation;
  }

  @override
  Map<String, Object>? _captureNetwork() =>
      _chain == null
          ? null
          : Map.unmodifiable({'chainId': _chain!, 'revision': _generation});
  @override
  void _requireNetwork(Map<String, Object>? expected) {
    if (expected == null) {
      if (_chain != null) throw TbcWireFailure.unauthorized;
    } else if (expected['chainId'] != _chain ||
        expected['revision'] != _generation) {
      throw TbcWireFailure.unauthorized;
    }
  }

  @override
  void _requireResponseNetwork(
    String method,
    Map<String, Object?> fields,
    Map<String, Object>? expected,
  ) {
    if (method == 'network.snapshot' && expected == null) return;
    if (method == 'network.switch' &&
        expected != null &&
        expected['chainId'] != fields['chainId'] &&
        _chain == fields['chainId'] &&
        _generation == (expected['revision'] as int) + 1)
      return;
    _requireNetwork(expected);
  }

  @override
  bool _install(Object? value) {
    if (!_active) throw TbcWireFailure.unauthorized;
    if (value is! Map ||
        value.length != 4 ||
        !value.keys.toSet().containsAll({
          'network',
          'sources',
          'lanes',
          'permissions',
        }))
      throw const FormatException('Invalid native network snapshot');
    final stamp = value['network'],
        sources = value['sources'],
        lanes = value['lanes'];
    if (stamp is! Map ||
        stamp.length != 2 ||
        stamp['chainId'] is! String ||
        !supportedNetworks.containsKey(stamp['chainId']) ||
        stamp['revision'] is! int ||
        stamp['revision'] < 0 ||
        stamp['revision'] > 0x7fffffff ||
        sources is! Map ||
        lanes is! Map ||
        sources.length != supportedNetworks.length ||
        lanes.length != supportedNetworks.length ||
        !sources.keys.toSet().containsAll(supportedNetworks.keys) ||
        !lanes.keys.toSet().containsAll(supportedNetworks.keys))
      throw const FormatException('Invalid native network catalog');
    final chain = stamp['chainId'] as String,
        generation = stamp['revision'] as int;
    if (_chain == null && (chain != _hub.network.chainId || generation != 0))
      throw const FormatException('Unexpected initial native network');
    for (final entry in supportedNetworks.entries) {
      if (sources[entry.key] != broadcastSourceIdentity(entry.value))
        throw const FormatException('Native network source mismatch');
    }
    if (_chain != null && generation < _generation) return false;
    if (_chain != null && generation == _generation && chain != _chain)
      throw const FormatException('Native network changed without revision');
    final parsed = <String, _NativeSnapshot>{};
    for (final entry in supportedNetworks.entries) {
      final next = _NativeSnapshot.parse(
        lanes[entry.key],
        entry.value.network,
        navigation.origin,
        primaryFirst: false,
      );
      final old = _lanes[entry.key];
      if (old != null) {
        if (next.accountRevision < old.accountRevision)
          throw const FormatException('Native account revision regressed');
        if (next.revision < old.revision) {
          if (generation == _generation) return false;
          throw const FormatException('Native lane revision regressed');
        }
        if (next.revision == old.revision && next.identity != old.identity)
          throw const FormatException('Native lane changed without revision');
      }
      parsed[entry.key] = next;
    }
    final records = _parseNetworkPermissions(value['permissions']);
    final changed =
        chain != _chain ||
        generation != _generation ||
        parsed.entries.any(
          (e) => _lanes[e.key]?.identity != e.value.identity,
        ) ||
        canonical(records) != canonical(_permissions);
    _lanes = Map.unmodifiable(parsed);
    _permissions = records;
    _chain = chain;
    _generation = generation;
    _snapshot = _lanes[chain];
    return changed;
  }

  List<Map<String, dynamic>> _parseNetworkPermissions(Object? value) {
    if (value is! List || value.length > supportedNetworks.length * 9)
      throw const FormatException('Invalid native network grants');
    final records = <Map<String, dynamic>>[], seen = <String>{};
    // Preserve native committed order; public permission events use this exact
    // projection, including grants which do not include the primary account.
    for (final raw in value) {
      if (raw is! Map || raw['caveats'] is! List)
        throw const FormatException('Invalid native network grant');
      final chains =
          (raw['caveats'] as List)
              .where((c) => c is Map && c['type'] == 'restrictChains')
              .toList();
      if (chains.length != 1 ||
          chains.single['value'] is! List ||
          (chains.single['value'] as List).length != 1)
        throw const FormatException('Invalid native network grant scope');
      final chain = (chains.single['value'] as List).single;
      final configured = supportedNetworks[chain];
      if (configured == null)
        throw const FormatException('Unknown native grant chain');
      final p =
          _parseNativePermissions(
            [raw],
            configured.network,
            navigation.origin,
          ).single;
      if (!seen.add('$chain/${p['parentCapability']}'))
        throw const FormatException('Duplicate native network grant');
      records.add(p);
    }
    return List.unmodifiable(records);
  }

  @override
  bool _installActive(Object? value) {
    final next = _NativeSnapshot.parse(
          value,
          network.network,
          navigation.origin,
          primaryFirst: false,
        ),
        old = _snapshot;
    if (old == null) throw TbcWireFailure.unauthorized;
    if (next.accountRevision < old.accountRevision)
      throw const FormatException('Native account revision regressed');
    if (next.revision < old.revision) return false;
    if (next.revision == old.revision) {
      if (next.identity != old.identity)
        throw const FormatException('Native snapshot changed without revision');
      return false;
    }
    _lanes = Map.unmodifiable({..._lanes, network.chainId: next});
    _snapshot = next;
    return true;
  }

  @override
  void _installReply(Object? value) {
    if (value is Map && value.containsKey('network')) {
      _install(value);
    } else {
      _installActive(value);
    }
  }

  bool _liveGrant(Map p, String chain, [String? accountId]) {
    if (_lanes[chain]?.unlocked != true) return false;
    final caveats = p['caveats'] as List;
    if (!caveats.any(
      (c) =>
          c['type'] == 'restrictChains' && (c['value'] as List).contains(chain),
    ))
      return false;
    if (accountId != null &&
        !caveats.any(
          (c) =>
              c['type'] == 'restrictAccounts' &&
              (c['value'] as List).contains(accountId),
        ))
      return false;
    final expiry = caveats.where((c) => c['type'] == 'expiresAt');
    return expiry.isEmpty ||
        DateTime.now().isBefore(
          parseTbcProtocolTimestamp(expiry.single['value']),
        );
  }

  @override
  List<Map<String, dynamic>> currentPermissions() {
    requireCurrent();
    return List.unmodifiable(
      _permissions.where(
        (p) => supportedNetworks.keys.any((chain) => _liveGrant(p, chain)),
      ),
    );
  }

  @override
  Set<String> optionalMethodsForChain(String chainId) {
    requireCurrent();
    return _lanes[chainId]?.optionalMethods ??
        (throw TbcWireFailure.unsupportedChain);
  }

  @override
  bool permitsAddressOnChain(String chainId, String address) {
    requireCurrent();
    return _permissions.any(
      (p) =>
          p['parentCapability'] == 'tbc_accounts' &&
          _liveGrant(p, chainId, '$chainId:$address'),
    );
  }

  @override
  Future<Map<String, dynamic>> nativeCapabilities({
    required String operationId,
    required String chainId,
    String? address,
  }) async {
    final result = await _call('network.capabilities', {
      'operation': operationId,
      'chainId': chainId,
      'address': address,
    });
    if (result is! Map || result['chainId'] != chainId)
      throw TbcWireFailure.unavailable;
    return frozen(copied(result)) as Map<String, dynamic>;
  }

  @override
  Future<List<Object?>> switchChain({
    required String operationId,
    required String chainId,
    required int expectedRevision,
  }) async {
    requireCurrent();
    if (!supportedNetworks.containsKey(chainId))
      throw TbcWireFailure.unsupportedChain;
    if (_cancelled.contains(operationId) || expectedRevision != _generation)
      throw TbcWireFailure.unauthorized;
    final oldChain = network.chainId, before = _captureNetwork()!;
    final result = await _call(
      'network.switch',
      {'operation': operationId, 'chainId': chainId},
      true,
      before,
    );
    if (network.chainId != chainId ||
        _generation != expectedRevision + (oldChain == chainId ? 0 : 1) ||
        result is! List)
      throw TbcWireFailure.unauthorized;
    // Native independently binds these exact events to the committed switch
    // and rechecks them at actual WebView emission.
    if (oldChain == chainId) {
      if (result.isNotEmpty) throw TbcWireFailure.unavailable;
    } else if (result.isEmpty ||
        result.length > 2 ||
        canonical(result.first) !=
            canonical({'name': 'chainChanged', 'payload': chainId}) ||
        (result.length == 2 &&
            canonical(result.last) !=
                canonical({
                  'name': 'accountsChanged',
                  'payload': connectedAccounts.map((a) => a.address).toList(),
                })))
      throw TbcWireFailure.unavailable;
    return (frozen(copied({'events': result})) as Map)['events']
        as List<Object?>;
  }
}

final class _NativeSigningOperation
    implements
        TbcWorkflowSigningOperation,
        TbcTransactionSigningRoles,
        TbcCryptoSigningOperation,
        TbcBroadcastSigningOperation,
        NativeBroadcastCommands {
  _NativeSigningOperation(this.document, this.scope)
    : network = document.network,
      networkStamp = document._captureNetwork();
  final TbcNativeDocumentControl document;
  final TbcSigningRequestScope scope;
  final TbcNetworkConfiguration network;
  final Map<String, Object>? networkStamp;
  Future<void>? _closing;
  NativeBroadcastBinding? _broadcast;
  Future<Object?> _call(
    String method, [
    Map<String, Object?> fields = const {},
  ]) async {
    if (_closing != null) throw TbcWireFailure.unauthorized;
    document._requireNetwork(networkStamp);
    document._signingScope(scope);
    final result = await document._call(
      method,
      {'operation': scope.operationId, ...fields},
      true,
      networkStamp,
    );
    document._requireNetwork(networkStamp);
    document._signingScope(scope);
    return result;
  }

  @override
  Future<void> requireCurrent() async {
    if (await _call('signing.check') != true) throw TbcWireFailure.unauthorized;
  }

  @override
  Future<List<TbcAccount>> resolveSigningAccounts(
    TbcBoundedSigningIntent intent,
  ) async {
    if (intent.method != scope.method) throw TbcWireFailure.unauthorized;
    final raw = await _call('signing.roles', {
      'request': intent.request,
      'context': intent.context,
    });
    final maxRoles = workflowMethods.contains(scope.method) ? 5 : 1;
    if (raw is! List || raw.length > maxRoles) throw TbcWireFailure.unavailable;
    return List.unmodifiable(
      raw.map((value) {
        if (value is! Map ||
            value.length != 4 ||
            value['chainId'] != scope.account.network.chainId) {
          throw TbcWireFailure.unavailable;
        }
        final account = TbcAccount(
          network: scope.account.network,
          address: value['address'],
          publicKey: value['publicKey'],
        );
        if (canonical(account.toKitAccount()) != canonical(value) ||
            account.accountId == scope.account.accountId) {
          throw TbcWireFailure.unavailable;
        }
        return account;
      }),
    );
  }

  @override
  Future<bool> requestConsent(TbcBoundedSigningIntent intent) async =>
      await _call('signing.consent', {
        'method': intent.method,
        'request': intent.request,
        'context': intent.context,
        if (intent.review != null) 'review': intent.review,
      }) ==
      true;
  @override
  Future<TbcSigningReceipt> bind(TbcSigningMaterial material) async =>
      TbcSigningReceipt(
        await _call('signing.bind', {
              'binding': material.binding,
              'preview': material.preview,
              'plan': material.plan,
              'envelope': material.envelope,
              if (material.reviewed != null) 'reviewed': material.reviewed,
            })
            as Map,
      );
  @override
  Future<void> enterWorkflowStep(
    TbcSigningReceipt receipt,
    TbcSigningContinuation continuation,
  ) async {
    if (await _call('signing.workflow.enter', {
          'receipt': receipt.wire,
          'entry': continuation.wire,
        }) !=
        true)
      throw TbcWireFailure.unauthorized;
  }

  @override
  Future<void> finishWorkflowStep(
    TbcSigningReceipt receipt,
    TbcSigningContinuation continuation,
  ) async {
    if (await _call('signing.workflow.finish', {
          'receipt': receipt.wire,
          'outcome': continuation.wire,
        }) !=
        true)
      throw TbcWireFailure.unauthorized;
  }

  @override
  Future<void> advance(
    TbcSigningReceipt receipt,
    TbcSigningContinuation continuation,
  ) async {
    if (await _call('signing.advance', {
          'receipt': receipt.wire,
          'pending': continuation.wire,
        }) !=
        true)
      throw TbcWireFailure.unauthorized;
  }

  @override
  Future<TbcTaskSignature> sign(
    TbcSigningReceipt receipt,
    TbcSigningTask task,
  ) async {
    final Object? value;
    try {
      value = await _call('signing.sign', {
        'receipt': receipt.wire,
        'task': task.wire,
      });
    } on _NativeStepUnavailable {
      if (workflowMethods.contains(scope.method))
        throw const TbcWorkflowStepUnavailable();
      throw TbcWireFailure.unauthorized;
    }
    if (value is! Map ||
        value.keys.toSet().difference({
          'taskId',
          'signatureEncoding',
          'signature',
        }).isNotEmpty ||
        value['taskId'] != task.taskId ||
        value['signatureEncoding'] != task.signatureEncoding ||
        value['signature'] is! String)
      throw TbcWireFailure.unavailable;
    return TbcTaskSignature(
      taskId: value['taskId'],
      signatureEncoding: value['signatureEncoding'],
      signature: value['signature'],
    );
  }

  @override
  Future<TbcCryptoResult> executeCrypto(
    TbcSigningReceipt receipt,
    TbcCryptoTask task,
  ) async {
    if (!cryptoMethods.contains(scope.method) &&
        !workflowMethods.contains(scope.method))
      throw TbcWireFailure.unauthorized;
    Object? value;
    try {
      value = await _call('signing.crypto', {
        'receipt': receipt.wire,
        'task': task.wire,
      });
    } on _NativeCryptoUnavailable {
      if (workflowMethods.contains(scope.method)) {
        throw const TbcWorkflowStepUnavailable.crypto();
      }
      throw TbcWireFailure.unauthorized;
    }
    if (value is! Map) throw TbcWireFailure.unavailable;
    try {
      checkCryptoResult(task.wire, value);
    } on StateError {
      throw TbcWireFailure.unavailable;
    } on FormatException {
      throw TbcWireFailure.unavailable;
    }
    return TbcCryptoResult(value);
  }

  @override
  Future<Object?> invokeBroadcast(String command, Map<String, Object?> fields) {
    if (!sendMethods.contains(scope.method) ||
        !nativeBroadcastCommands.contains(command) ||
        fields.keys.any({'ownerId', 'scope', 'operation'}.contains))
      throw TbcWireFailure.unauthorized;
    return _call(command, fields);
  }

  @override
  Future<void> authorizeBroadcast(
    TbcSigningReceipt receipt,
    TbcBroadcastMaterial material,
  ) async {
    if (!sendMethods.contains(scope.method) || _broadcast != null)
      throw TbcWireFailure.unauthorized;
    final binding = NativeBroadcastBinding(
      network: network,
      scope: scope,
      invoke: _call,
    );
    _broadcast = binding;
    await binding.authorize(receipt, material);
  }

  @override
  Future<TbcBroadcastResult> submitTransaction(
    TbcSigningReceipt receipt,
    int index,
  ) => (_broadcast ?? (throw TbcWireFailure.unauthorized)).submit(
    receipt,
    index,
  );
  @override
  Future<TbcBroadcastResult> submitBatch(TbcSigningReceipt receipt) =>
      (_broadcast ?? (throw TbcWireFailure.unauthorized)).submit(receipt, null);
  @override
  Future<TbcBroadcastResult> reconcileSubmitted(
    TbcSigningReceipt receipt,
    List<String> txids,
  ) => (_broadcast ?? (throw TbcWireFailure.unauthorized)).reconcile(
    receipt,
    txids,
  );
  @override
  Future<void> finishBroadcast(
    TbcSigningReceipt receipt,
    TbcBroadcastResult result,
  ) => (_broadcast ?? (throw TbcWireFailure.unauthorized)).finish(
    receipt,
    result,
  );
  @override
  Future<void> close() {
    _broadcast?.close();
    return _closing ??= document
        ._call(
          'signing.close',
          {'operation': scope.operationId},
          false,
          networkStamp,
        )
        .then<void>((_) {});
  }
}

final class _NativeSnapshot {
  _NativeSnapshot(
    this.account,
    this.revision,
    this.accountRevision,
    this.unlocked,
    this.permissions,
    this.connectedAccounts,
    this.optionalMethods,
    this.identity,
  );
  final TbcAccount account;
  final int revision, accountRevision;
  final bool unlocked;
  final List<Map<String, dynamic>> permissions;
  final List<TbcAccount> connectedAccounts;
  final Set<String> optionalMethods;
  final String identity;
  static _NativeSnapshot parse(
    Object? value,
    TbcNetwork network,
    String origin, {
    bool primaryFirst = true,
  }) {
    if (value is! Map ||
        value.keys.toSet().length != 7 ||
        !value.keys.toSet().containsAll({
          'account',
          'revision',
          'accountRevision',
          'unlocked',
          'permissions',
          'connectedAccounts',
          'optionalMethods',
        }))
      throw const FormatException('Invalid native snapshot');
    final optional = value['optionalMethods'];
    if (optional is! List ||
        optional.toSet().length != optional.length ||
        optional.any(
          (v) =>
              v is! String ||
              !(cryptoMethods.contains(v) || sendMethods.contains(v)),
        ))
      throw const FormatException('Invalid optional native methods');
    final a = value['account'];
    if (a is! Map || a.length != 4 || a['chainId'] != network.chainId)
      throw const FormatException('Invalid native account');
    final account = TbcAccount(
      network: network,
      address: a['address'],
      publicKey: a['publicKey'],
    );
    if (canonical(a) != canonical(account.toKitAccount()))
      throw const FormatException('Native account mismatch');
    final revision = value['revision'],
        accountRevision = value['accountRevision'];
    if (revision is! int ||
        revision < 0 ||
        revision > 0x7fffffff ||
        accountRevision is! int ||
        accountRevision < 0 ||
        accountRevision > 9007199254740991 ||
        value['unlocked'] is! bool ||
        value['permissions'] is! List)
      throw const FormatException('Invalid native authority');
    final records = _parseNativePermissions(
      value['permissions'],
      network,
      origin,
      requiredAccountId: account.accountId,
    );
    final rawAccounts = value['connectedAccounts'];
    if (rawAccounts is! List ||
        rawAccounts.length > 16 ||
        (value['unlocked'] == false && rawAccounts.isNotEmpty)) {
      throw const FormatException('Invalid connected accounts');
    }
    final connected = <TbcAccount>[], ids = <String>{}, keys = <String>{};
    final grant = records.where((p) => p['parentCapability'] == 'tbc_accounts');
    for (final raw in rawAccounts) {
      if (raw is! Map || raw.length != 4 || raw['chainId'] != network.chainId)
        throw const FormatException('Invalid connected account');
      final member = TbcAccount(
        network: network,
        address: raw['address'],
        publicKey: raw['publicKey'],
      );
      if (canonical(raw) != canonical(member.toKitAccount()) ||
          !ids.add(member.accountId) ||
          !keys.add(member.publicKey.substring(2)) ||
          grant.isEmpty ||
          !(grant.single['caveats'] as List).any(
            (c) =>
                c['type'] == 'restrictAccounts' &&
                (c['value'] as List).contains(member.accountId),
          )) {
        throw const FormatException('Connected account not authorized');
      }
      connected.add(member);
    }
    if ((connected.isNotEmpty &&
            (primaryFirst
                ? connected.first.accountId != account.accountId
                : !ids.contains(account.accountId))) ||
        (value['unlocked'] == true && grant.isNotEmpty && connected.isEmpty))
      throw const FormatException('Primary connection mismatch');
    return _NativeSnapshot(
      account,
      revision,
      accountRevision,
      value['unlocked'],
      records,
      List.unmodifiable(connected),
      Set.unmodifiable(optional.cast<String>()),
      hashJson(value),
    );
  }
}

// Both lane snapshots and the origin-wide projection use the same grant
// validation. Only the latter may contain records for a non-primary account.
List<Map<String, dynamic>> _parseNativePermissions(
  Object? value,
  TbcNetwork network,
  String origin, {
  String? requiredAccountId,
}) {
  if (value is! List || value.length > 9)
    throw const FormatException('Invalid native grants');
  final records = <Map<String, dynamic>>[], seen = <String>{};
  for (final raw in value) {
    if (raw is! Map) throw const FormatException('Invalid native grant');
    final p = copied(raw), method = p['parentCapability'];
    if (p.keys.toSet().difference({
          'id',
          'parentCapability',
          'invoker',
          'date',
          'caveats',
        }).isNotEmpty ||
        p.length != 5 ||
        p['id'] is! String ||
        p['date'] is! int ||
        p['invoker'] != origin ||
        !{
          'tbc_accounts',
          'tbc_accountMetadata',
          'tbc_switchChain',
          'tbc_signMessage',
          'tbc_signTypedData',
          'tbc_signTransaction',
          'tbc_sendTransaction',
          'tbc_signWorkflow',
          'tbc_crypto',
        }.contains(method) ||
        !seen.add(method) ||
        p['caveats'] is! List)
      throw const FormatException('Invalid native grant');
    final caveats = <String, Object?>{};
    for (final c in p['caveats']) {
      if (c is! Map ||
          c.length != 2 ||
          !c.containsKey('value') ||
          !{
            'restrictChains',
            'restrictAccounts',
            'restrictMethods',
            'expiresAt',
          }.contains(c['type']) ||
          caveats.containsKey(c['type']))
        throw const FormatException('Invalid native caveat');
      caveats[c['type']] = c['value'];
    }
    if (canonical(caveats['restrictChains']) != canonical([network.chainId]) ||
        canonical(caveats['restrictMethods']) != canonical([method]) ||
        caveats['restrictAccounts'] is! List ||
        (caveats['restrictAccounts'] as List).isEmpty ||
        (caveats['restrictAccounts'] as List).length > 16 ||
        (caveats['restrictAccounts'] as List).toSet().length !=
            (caveats['restrictAccounts'] as List).length ||
        !(caveats['restrictAccounts'] as List).every(
          (id) =>
              id is String &&
              id.startsWith('${network.chainId}:') &&
              id.length > network.chainId.length + 1,
        ) ||
        (requiredAccountId != null &&
            !(caveats['restrictAccounts'] as List).contains(requiredAccountId)))
      throw const FormatException('Native grant scope mismatch');
    if (caveats.containsKey('expiresAt'))
      parseTbcProtocolTimestamp(caveats['expiresAt'] as String);
    records.add(frozen(p) as Map<String, dynamic>);
  }
  return List.unmodifiable(records);
}
