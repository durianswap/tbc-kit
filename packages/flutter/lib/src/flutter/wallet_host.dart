import 'dart:async';
import 'dart:convert';
import 'package:flutter/services.dart';
import '../configuration.dart';
import '../webview_scope.dart';
import '../internal/native_wallet_binding.dart';
import '../internal/provider_control.dart';
import '../internal/provider_session.dart';
import '../internal/signing_worker.dart';
import '../internal/protocol_codec.dart';
import '../internal/wallet_protocol.dart';
import '../internal/wire_session.dart';
import 'webview_platform.dart';
part 'wallet_actions.dart';

/// Optional wallet-owned chain-data transport. Paths are selected by Kit, never
/// by the page. Returned data still passes the material/Engine checks. Omit to
/// keep default HTTPS retrieval and parsing in the non-UI worker. The callback
/// must be asynchronous and bound to the configured network/source identity.
typedef TbcChainDataRead = Future<Map<String, dynamic>> Function(String path);

/// Read-only outpoint status, not transaction submission. A custom GET source
/// must also supply this callback for NFT holder operations; Kit never falls
/// back to another endpoint and never caches unspent state.
typedef TbcTxoStatusRead =
    Future<Map<String, dynamic>> Function(List<Map<String, dynamic>> txos);

/// An additional wallet-configured network and its optional read adapters.
/// The matching native lane must use the same source identity. Pages cannot
/// add a network or choose its endpoints. Omit adapters for Kit's HTTPS reads.
final class TbcFlutterNetwork {
  const TbcFlutterNetwork({
    required this.configuration,
    this.chainDataRead,
    this.txoStatusRead,
  });
  final TbcNetworkConfiguration configuration;
  final TbcChainDataRead? chainDataRead;
  final TbcTxoStatusRead? txoStatusRead;
}

/// Candidate Flutter composition over the shared business worker and native
/// custody. No embedded Vault, default grant, test account, alternate Legacy
/// executor or automatic approval. Final partner acceptance is tracked separately.
final class TbcFlutterWallet {
  TbcFlutterWallet._(
    this.configuration,
    this._channel,
    this._bindings,
    this._legacyBindings,
  );
  static const _privateChannel = MethodChannel(
    'io.tbc.kit.dart/private-wallet',
  );
  static bool _registered = false;
  final TbcWalletConfiguration configuration;
  final MethodChannel _channel;
  final TbcNativeWalletBindings _bindings;
  final TbcNativeWalletBindings? _legacyBindings;
  final Map<String, TbcSigningWorker> _workers = {};
  final Map<String, TbcSigningWorker> _legacyWorkers = {};
  final Set<TbcFlutterWalletView> _views = {};
  TbcWalletActions? _actions;
  bool _openingActions = false;
  bool _closed = false;

  static Future<TbcFlutterWallet> open({
    required TbcWalletConfiguration configuration,
    required TbcPinnedComputeLibrary compute,
    TbcChainDataRead? chainDataRead,
    TbcTxoStatusRead? txoStatusRead,
    List<TbcFlutterNetwork> additionalNetworks = const [],
  }) async {
    // Capabilities are derived from actual native support, never caller claims.
    if (configuration.capabilityScopes.isNotEmpty) {
      throw UnsupportedError('Candidate requires derived capabilities');
    }
    if (_registered) throw StateError('Wallet already registered');
    final bindings = TbcNativeWalletBindings(
      network: configuration.network,
      additionalNetworks: [for (final n in additionalNetworks) n.configuration],
      invoke:
          (method, arguments) =>
              _privateChannel.invokeMethod<Object?>(method, arguments),
    );
    final legacyBindings =
        configuration.legacy
            ? TbcNativeWalletBindings(
              network: configuration.network,
              additionalNetworks: [
                for (final n in additionalNetworks) n.configuration,
              ],
              walletProtocol: TbcNativeWalletProtocol.legacy,
              invoke:
                  (method, arguments) =>
                      _privateChannel.invokeMethod<Object?>(method, arguments),
            )
            : null;
    _registered = true;
    final wallet = TbcFlutterWallet._(
      configuration,
      _privateChannel,
      bindings,
      legacyBindings,
    );
    try {
      // Each existing worker remains immutable and caches only its own source.
      // Switching selects a worker; it never mutates endpoints or migrates cache.
      for (final n in [
        TbcFlutterNetwork(
          configuration: configuration.network,
          chainDataRead: chainDataRead,
          txoStatusRead: txoStatusRead,
        ),
        ...additionalNetworks,
      ]) {
        wallet._workers[n.configuration.chainId] = await TbcSigningWorker.start(
          library: compute,
          network: n.configuration,
          backend: bindings,
          read: n.chainDataRead,
          txoStatus: n.txoStatusRead,
        );
        if (legacyBindings != null) {
          wallet._legacyWorkers[n
              .configuration
              .chainId] = await TbcSigningWorker.start(
            library: compute,
            network: n.configuration,
            backend: legacyBindings,
            read: n.chainDataRead,
            txoStatus: n.txoStatusRead,
            messageProfile: MessageSigningProfile.legacyBitcoin,
          );
        }
      }
      wallet._channel.setMethodCallHandler(wallet._nativeEvent);
      return wallet;
    } catch (_) {
      try {
        await Future.wait(
          [
            ...wallet._workers.values,
            ...wallet._legacyWorkers.values,
          ].map((w) => w.close()),
        );
      } finally {
        _registered = false;
      }
      rethrow;
    }
  }

  Future<void> _nativeEvent(MethodCall call) async {
    if (_closed) return;
    final value = call.arguments;
    if (call.method != 'authorityChanged' ||
        value is! Map ||
        value.keys.any(
          (k) =>
              !{'ownerId', 'scope', 'snapshot', 'walletProtocol'}.contains(k),
        ) ||
        !value.containsKey('snapshot') ||
        value['ownerId'] is! String ||
        value['scope'] is! Map)
      return;
    final protocol =
        value.containsKey('walletProtocol')
            ? (value['walletProtocol'] ==
                    TbcNativeWalletProtocol.legacy.namespace
                ? TbcNativeWalletProtocol.legacy
                : null)
            : TbcNativeWalletProtocol.standard;
    if (protocol == null) return;
    final selected =
        protocol == TbcNativeWalletProtocol.standard
            ? _bindings
            : _legacyBindings;
    selected?.authorityChanged(
      value['ownerId'],
      value['scope'],
      value['snapshot'],
      walletProtocol: protocol,
    );
  }

  Future<TbcFlutterWalletView> createWebView() async {
    if (_closed || _views.length >= 8) throw StateError('Wallet unavailable');
    final view = TbcFlutterWalletView._(this);
    _views.add(view);
    try {
      view._platform = await TbcWebViewPlatform.create(
        onNavigation: view._navigation,
        onMessage: view._message,
        onInvalidated: view._invalidate,
      );
      if (configuration.legacy && !view._view.supportsLegacyPage) {
        await view._view.dispose();
        throw StateError('Legacy page resource does not match this native Kit');
      }
      if (_closed || view._closed) {
        await view._view.dispose();
        throw StateError('Wallet closed');
      }
      return view;
    } catch (_) {
      _views.remove(view);
      rethrow;
    }
  }

  /// Wallet-owned Flutter pages, without a WebView or a second transaction
  /// executor. One local session per wallet; dispose it on page/flow teardown.
  /// Request its permissions explicitly before business calls. This never
  /// imports an existing DApp grant or silently authorizes a transaction.
  Future<TbcWalletActions> openActions() async {
    if (_closed || _openingActions || _actions != null) {
      throw StateError('Native wallet session unavailable');
    }
    _openingActions = true;
    _LocalDelivery? delivery;
    TbcNativeDocumentControl? control;
    try {
      final result = await _channel.invokeMapMethod<String, dynamic>(
        'local.open',
        <String, Object?>{},
      );
      if (result?['ok'] != true || result?['value'] is! Map) {
        throw StateError('Native wallet session unavailable');
      }
      final value = result!['value'] as Map, scope = value['scope'] as Map;
      final navigation = TbcWebViewNavigation(
        webViewInstanceId: scope['webViewInstanceId'] as String,
        sessionId: scope['sessionId'] as String,
        navigationId: scope['navigationId'] as String,
        committedUrl: scope['committedUrl'] as String,
        origin: scope['origin'] as String,
        createdAt: scope['createdAt'] as String,
      );
      delivery = _LocalDelivery(
        _channel,
        value['ownerId'] as String,
        navigation,
      );
      control = await _bindings.open(delivery.ownerId, navigation);
      final session = await TbcProviderSession.open(
        configuration: configuration,
        control: control,
        delivery: delivery,
        worker: _workers[configuration.network.chainId]!,
        additionalWorkers: {
          for (final e in _workers.entries)
            if (e.key != configuration.network.chainId) e.key: e.value,
        },
      );
      final actions = TbcWalletActions._(this, session, control, delivery);
      control.onAuthorityChanged = () => unawaited(session.authorityChanged());
      await actions._frame('ready');
      if (_closed) {
        await actions.dispose();
        throw StateError('Wallet closed');
      }
      _actions = actions;
      return actions;
    } catch (_) {
      control?.invalidate();
      if (delivery != null) await delivery.close(delivery.navigation);
      rethrow;
    } finally {
      _openingActions = false;
    }
  }

  Future<void> dispose() async {
    if (_closed) return;
    _closed = true;
    try {
      await _actions?.dispose();
      await Future.wait(_views.toList().map((v) => v.dispose()));
    } finally {
      try {
        await Future.wait(
          [..._workers.values, ..._legacyWorkers.values].map((w) => w.close()),
        );
      } finally {
        _channel.setMethodCallHandler(null);
        _registered = false;
      }
    }
  }
}

/// Mount an initially blank flutter_inappwebview view with [markerSource] as a
/// document-start main-frame user script, attach, then load the DApp URL. Native
/// owns verified origin/navigation; page metadata never selects an account.
final class TbcFlutterWalletView {
  TbcFlutterWalletView._(this._wallet);
  final TbcFlutterWallet _wallet;
  TbcWebViewPlatform? _platform;
  TbcWebViewPlatform get _view =>
      _platform ?? (throw StateError('WebView not created'));
  final Map<TbcNativeWalletProtocol, TbcProviderSession> _sessions = {};
  final Map<TbcNativeWalletProtocol, TbcNativeDocumentControl> _controls = {};
  Future<void>? _opening;
  int _generation = 0;
  bool _closed = false;
  String get markerSource => _view.markerSource;
  String? get fallbackPageSource => _view.legacyBootstrapSource;
  Future<bool> attach({int? platformViewId}) =>
      _view.attach(platformViewId: platformViewId);

  void _navigation(TbcWebViewNavigation navigation) {
    _invalidate();
    final generation = _generation;
    _opening = _open(navigation, generation);
    unawaited(_opening);
  }

  Future<void> _open(TbcWebViewNavigation navigation, int generation) async {
    try {
      for (final protocol in [
        TbcNativeWalletProtocol.standard,
        if (_wallet._legacyBindings != null) TbcNativeWalletProtocol.legacy,
      ]) {
        final legacy = protocol == TbcNativeWalletProtocol.legacy;
        final bindings = legacy ? _wallet._legacyBindings! : _wallet._bindings;
        final workers = legacy ? _wallet._legacyWorkers : _wallet._workers;
        final control = await bindings.open(_view.ownerId, navigation);
        if (_closed || generation != _generation) {
          control.invalidate();
          return;
        }
        _controls[protocol] = control;
        final revision = control.revision;
        final networkRevision =
            control is TbcProviderNetworkControl
                ? (control as TbcProviderNetworkControl).networkRevision
                : null;
        final session = await TbcProviderSession.open(
          configuration: _wallet.configuration,
          control: control,
          delivery: legacy ? _view.legacyDelivery : _view,
          walletProtocol: protocol,
          worker: workers[_wallet.configuration.network.chainId]!,
          additionalWorkers: {
            for (final e in workers.entries)
              if (e.key != _wallet.configuration.network.chainId)
                e.key: e.value,
          },
        );
        if (_closed || generation != _generation) {
          await session.close();
          return;
        }
        _sessions[protocol] = session;
        final active = session;
        control.onAuthorityChanged = () {
          unawaited(active.authorityChanged());
        };
        if (revision != control.revision ||
            (control is TbcProviderNetworkControl &&
                networkRevision !=
                    (control as TbcProviderNetworkControl).networkRevision))
          await session.authorityChanged();
      }
    } catch (_) {
      if (generation == _generation) _invalidate();
      // Close only the failed document, never a replacement navigation.
      await _view.close(navigation).catchError((_) {});
    }
  }

  void _message(String text, TbcWebViewMessageSource source) {
    final generation = _generation, opening = _opening;
    unawaited(() async {
      try {
        await opening;
        if (_closed || generation != _generation) return;
        // Only demultiplex; the chosen shared wire still verifies exact keys,
        // canonical bytes, native origin/document, request identity and limits.
        if (text.length > 4 * 1024 * 1024) {
          _invalidate();
          return;
        }
        // Canonical frames sort "channel" first. Inspect only that prefix here
        // so a large batch is not JSON-decoded twice on the transaction path.
        // The wire independently checks the complete channel and every field.
        final protocol =
            TbcNativeWalletProtocol.values
                .where((p) => text.startsWith('{"channel":"${p.wireChannel}",'))
                .firstOrNull;
        if (protocol == null || !_sessions.containsKey(protocol)) return;
        await _sessions[protocol]!.accept(text, source);
      } catch (_) {
        if (generation == _generation) _invalidate();
      }
    }());
  }

  void _invalidate() {
    _generation++;
    final sessions = _sessions.values.toList();
    _sessions.clear();
    for (final control in _controls.values) control.invalidate();
    _controls.clear();
    for (final session in sessions) {
      session.wire.invalidate();
      unawaited(session.close().catchError((_) {}));
    }
  }

  Future<void> dispose() async {
    if (_closed) return;
    _closed = true;
    _invalidate();
    _wallet._views.remove(this);
    await _platform?.dispose();
  }
}
