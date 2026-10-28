import 'dart:async';
import '../configuration.dart';
import '../signing_backend.dart';
import '../webview_scope.dart';
import 'provider_control.dart';
import 'protocol_codec.dart';
import 'prepared_proposal.dart';
import 'signing_executor.dart';
import 'signing_worker.dart';
import 'transaction_profiles.dart';
import 'typed_signing.dart';
import 'wire_session.dart';
import 'workflow_request.dart';
import 'crypto_action.dart';
import 'send_lifecycle.dart';
import 'wallet_protocol.dart';
import 'legacy_wire_params.dart';
import 'legacy_signing_call.dart';
import 'legacy_mapping.dart';
import 'balance_read.dart';
import 'legacy_maintenance.dart';
import 'multi_round_merge.dart';

/// Executable candidate, not yet the public/full-feature wallet entrypoint.
/// All signing routes through the same worker; no App/Legacy execute fallback.
/// The current advertised subset expands only with implementations + evidence.
final class TbcProviderSession {
  TbcProviderSession._(
    this.configuration,
    this.control,
    this._workers,
    this._networks,
    this.policy,
    this.timing,
    this.walletProtocol,
  ) : navigation = control.navigation;
  static Future<TbcProviderSession> open({
    required TbcWalletConfiguration configuration,
    required TbcProviderControl control,
    required TbcDocumentDelivery delivery,
    required TbcSigningWorker worker,
    Map<String, TbcSigningWorker> additionalWorkers = const {},
    FutureOr<Map<String, dynamic>> Function(Map<String, dynamic> request)?
    policy,
    TbcExecutionTiming? timing,
    TbcNativeWalletProtocol walletProtocol = TbcNativeWalletProtocol.standard,
  }) async {
    if (canonical(configuration.network.toKitOptions()) !=
            canonical(control.network.toKitOptions()) ||
        worker.network.chainId != control.network.chainId ||
        worker.network.apiOrigin != control.network.apiOrigin ||
        worker.network.rpcOrigin != control.network.rpcOrigin ||
        worker.network.trustId != control.network.trustId) {
      throw StateError('Wallet session source mismatch');
    }
    final workers = {worker.network.chainId: worker, ...additionalWorkers};
    final nativeProtocol =
        control is TbcProviderProtocolControl
            ? (control as TbcProviderProtocolControl).walletProtocol
            : TbcNativeWalletProtocol.standard;
    if (nativeProtocol != walletProtocol ||
        workers.values.any(
          (w) =>
              w.usesLegacyMessageProfile !=
              (walletProtocol == TbcNativeWalletProtocol.legacy),
        ) ||
        (walletProtocol == TbcNativeWalletProtocol.legacy && policy != null)) {
      throw StateError('Wallet protocol registration mismatch');
    }
    final configured =
        control is TbcProviderNetworkControl
            ? (control as TbcProviderNetworkControl).supportedNetworks
            : {control.network.chainId: control.network};
    final catalog = Map<String, TbcNetworkConfiguration>.unmodifiable(
      configured,
    );
    if (catalog.isEmpty ||
        catalog.length > TbcNetwork.values.length ||
        catalog.entries.any((e) => e.key != e.value.chainId) ||
        !catalog.containsKey(control.network.chainId)) {
      throw StateError('Wallet network catalog mismatch');
    }
    if (additionalWorkers.containsKey(worker.network.chainId) ||
        workers.length != catalog.length ||
        workers.entries.any(
          (entry) =>
              entry.key != entry.value.network.chainId ||
              !catalog.containsKey(entry.key) ||
              canonical(entry.value.network.toKitOptions()) !=
                  canonical(catalog[entry.key]!.toKitOptions()),
        )) {
      throw StateError('Wallet network worker catalog mismatch');
    }
    final session = TbcProviderSession._(
      configuration,
      control,
      Map.unmodifiable(workers),
      catalog,
      policy,
      timing,
      walletProtocol,
    );
    session._requireCurrent();
    session.wire = TbcWireSession(
      platform: delivery,
      navigation: session.navigation,
      configuration: configuration,
      execute: session._execute,
      cancel: (id) async {
        for (final worker in workers.values) {
          worker.cancelOperation(id, session.navigation);
        }
        await control.cancel(id);
      },
      invalidateNative: () {
        try {
          control.invalidate();
        } finally {
          for (final worker in workers.values) {
            worker.invalidate(session.navigation);
          }
        }
      },
      requireCurrent: session._requireCurrent,
      onAcknowledged: (id) async {
        if (control is TbcProviderDeliveryControl) {
          await (control as TbcProviderDeliveryControl).acknowledgeDelivery(id);
        }
        session._deliveryMethods.remove(canonical(id));
      },
      beforeDelivery:
          (method, id, text) => control.beforeDelivery(
            session._deliveryMethods[canonical(id)] ?? method,
            id,
            text,
          ),
      walletProtocol: walletProtocol,
      sensitiveMethods: {
        if (walletProtocol == TbcNativeWalletProtocol.legacy) ...{
          'connect',
          'sendTransaction',
          'signTransaction',
          'signAssociatedTransaction',
          'signMessage',
          'encrypt',
          'decrypt',
          'sendBatchRequest',
          'mergeUtxos',
          'mergeFtUtxos',
          'mergeStableCoinUtxos',
        },
        'tbc_switchChain',
        'tbc_runMultiRoundMerge',
        'wallet_requestPermissions',
        'tbc_requestAccounts',
        'tbc_signMessage',
        'tbc_signTypedData',
        'tbc_signTransaction',
        'tbc_signPreparedTransaction',
        'tbc_signReviewedTransaction',
        'tbc_signWorkflow',
        'tbc_signPreparedWorkflow',
        ...cryptoMethods,
        ...sendMethods,
      },
      supportedChainIds: catalog.keys.toList()..sort(),
    );
    await session.wire.start();
    return session;
  }

  final TbcWalletConfiguration configuration;
  final TbcProviderControl control;
  final TbcWebViewNavigation navigation;
  final Map<String, TbcSigningWorker> _workers;
  final Map<String, TbcNetworkConfiguration> _networks;
  TbcSigningWorker get worker =>
      _workers[control.network.chainId] ??
      (throw StateError('Wallet network worker unavailable'));
  final FutureOr<Map<String, dynamic>> Function(Map<String, dynamic>)? policy;
  final TbcExecutionTiming? timing;
  final TbcNativeWalletProtocol walletProtocol;
  // Bounded by the wire's128 per-document requests. Native attestation uses
  // the selected shared method, never the page's historical spelling.
  final Map<String, String> _deliveryMethods = {};
  late final TbcWireSession wire;
  static const methods = [
    'tbc_chainId',
    'tbc_accounts',
    'tbc_requestAccounts',
    'tbc_getAccount',
    'tbc_getCapabilities',
    'wallet_getPermissions',
    'wallet_requestPermissions',
    'tbc_disconnect',
    'tbc_signMessage',
    'tbc_signTypedData',
    'tbc_signTransaction',
    'tbc_signPreparedTransaction',
    'tbc_signReviewedTransaction',
    'tbc_signWorkflow',
    'tbc_signPreparedWorkflow',
  ];
  static const permissionNames = {
    'tbc_accounts',
    'tbc_accountMetadata',
    'tbc_signMessage',
    'tbc_signTypedData',
    'tbc_signTransaction',
    'tbc_signWorkflow',
  };
  bool _supports(String method, {String? chainId}) =>
      methods.contains(method) ||
      (method == 'tbc_switchChain' && control is TbcProviderNetworkControl) ||
      ((cryptoMethods.contains(method) || sendMethods.contains(method)) &&
          (control is TbcProviderNetworkControl
              ? (control as TbcProviderNetworkControl)
                  .optionalMethodsForChain(chainId ?? control.network.chainId)
                  .contains(method)
              : control is TbcProviderOptionalMethods &&
                  (control as TbcProviderOptionalMethods).optionalMethods
                      .contains(method)));
  Iterable<String> get availableMethods =>
      _availableMethods(control.network.chainId);
  Iterable<String> _availableMethods(String chainId) => [
    ...methods,
    if (_supports('tbc_switchChain', chainId: chainId)) 'tbc_switchChain',
    for (final method in {...cryptoMethods, ...sendMethods})
      if (_supports(method, chainId: chainId)) method,
  ];

  Future<void> accept(String text, TbcWebViewMessageSource source) =>
      wire.accept(text, source);
  Future<void> close() => wire.close();

  /// Wallet-local operation, deliberately not a public Provider method. It uses
  /// the same grants, account fence, worker and native authority as sendTransaction.
  Future<Map<String, dynamic>> mintNftJob({
    required String operation,
    required String collectionId,
    required List<Map<String, dynamic>> items,
    required Map<String, dynamic> limits,
  }) async {
    final selected = worker,
        account = control.selectedAccount,
        revision = control.revision;
    void authorized() {
      _permission('tbc_sendTransaction');
      if (!wire.isActive ||
          walletProtocol != TbcNativeWalletProtocol.standard ||
          worker != selected ||
          control.revision != revision ||
          canonical(control.selectedAccount.toKitAccount()) !=
              canonical(account.toKitAccount()))
        throw TbcWireFailure.unauthorized;
    }

    authorized();
    if (!_supports('tbc_sendTransaction') || !selected.supportsNftMintJob)
      throw TbcWireFailure.unsupported;
    final result = await selected.executeNftMintJob(
      scope: TbcSigningRequestScope(
        operationId: operation,
        method: 'tbc_sendTransaction',
        navigation: navigation,
        account: account,
        revision: revision,
      ),
      collectionId: collectionId,
      items: items,
      limits: limits,
      requireAuthorized: authorized,
      isUnlocked: () => control.isUnlocked,
      timing: timing,
    );
    authorized();
    return result;
  }

  /// Native authority notifications, not events supplied by the page.
  Future<void> authorityChanged() => wire.authorityChanged(_permissionEvents());
  // Worker is shared by the wallet/network and is not owned by one page.
  void _requireCurrent() {
    control.requireCurrent();
    if (!navigation.matches(control.navigation.toWire()) ||
        control.selectedAccount.network != control.network.network ||
        worker.network.chainId != control.network.chainId ||
        worker.network.apiOrigin != control.network.apiOrigin ||
        worker.network.rpcOrigin != control.network.rpcOrigin ||
        worker.network.trustId != control.network.trustId) {
      throw StateError('Wallet selection changed networks');
    }
  }

  void _permission(String name) {
    _requireCurrent();
    final grant = signingPermissionForMethod(name);
    if (!control.isUnlocked ||
        !control.permits('tbc_accounts') ||
        !control.permits(grant))
      throw TbcWireFailure.unauthorized;
  }

  List<String> _accounts() =>
      control.isUnlocked && control.permits('tbc_accounts')
          ? _connectedAccounts().map((a) => a.address).toList(growable: false)
          : [];
  List<TbcAccount> _connectedAccounts() =>
      control is TbcProviderAccountCatalog
          ? (control as TbcProviderAccountCatalog).connectedAccounts
          : [control.selectedAccount];
  void _noParams(Object? params) {
    if (params != null && !(params is List && params.isEmpty))
      throw TbcWireFailure.invalidParams;
  }

  Map<String, dynamic> _named(Object? value, Set<String> keys) {
    if (value is! Map || !value.keys.every(keys.contains))
      throw TbcWireFailure.invalidParams;
    return copied(value);
  }

  Map<String, dynamic> _permissions(Object? params) {
    if (params is! List || params.length != 1 || params.single is! Map)
      throw TbcWireFailure.invalidParams;
    final p = copied(params.single as Map);
    if (p.isEmpty ||
        !p.keys.every(
          (name) =>
              permissionNames.contains(name) ||
              (name == 'tbc_switchChain' && _supports('tbc_switchChain')) ||
              (name == 'tbc_sendTransaction' && sendMethods.every(_supports)) ||
              (name == 'tbc_crypto' && cryptoMethods.every(_supports)),
        ))
      throw TbcWireFailure.unsupported;
    for (final entry in p.entries) {
      final fields =
          entry.key == 'tbc_accounts' ? {'chains', 'maxAccounts'} : {'chains'};
      final request = _named(entry.value, fields);
      final chains = request['chains'];
      final supported = _networks.keys.toSet();
      if (chains is! List ||
          chains.isEmpty ||
          chains.toSet().length != chains.length ||
          chains.any(
            (chain) => chain is! String || !supported.contains(chain),
          )) {
        throw TbcWireFailure.unsupported;
      }
      if (request.containsKey('maxAccounts') &&
          (request['maxAccounts'] is! int ||
              request['maxAccounts'] < 1 ||
              request['maxAccounts'] > 16))
        throw TbcWireFailure.invalidParams;
    }
    return p;
  }

  List<Object?> _permissionEvents() => [
    {'name': 'permissionsChanged', 'payload': control.currentPermissions()},
    {'name': 'accountsChanged', 'payload': _accounts()},
  ];

  Future<TbcWireOutcome> _execute(
    String method,
    Object? params,
    String operation,
    Object id,
  ) async {
    _requireCurrent();
    wire.requireExecution(operation, id);
    if (walletProtocol == TbcNativeWalletProtocol.legacy) {
      Object? legacyParams;
      try {
        legacyParams = decodeLegacyWireParams(params);
      } catch (_) {
        throw TbcWireFailure.invalidParams;
      }
      switch (method) {
        case 'connect':
          method = 'wallet_requestPermissions';
          params = [
            {
              'tbc_accounts': {
                'chains': [control.network.chainId],
                'maxAccounts': 1,
              },
              for (final capability in [
                'tbc_accountMetadata',
                'tbc_signTransaction',
                'tbc_signWorkflow',
                'tbc_signMessage',
                if (cryptoMethods.every(_supports)) 'tbc_crypto',
                if (sendMethods.every(_supports)) 'tbc_sendTransaction',
              ])
                capability: {
                  'chains': [control.network.chainId],
                },
            },
          ];
        case 'disconnect':
          method = 'tbc_disconnect';
          params = null;
        case 'getAddress':
        case 'isConnected':
          method = 'tbc_accounts';
          params = null;
        case 'getPubKey':
          method = 'tbc_getAccount';
          params = {'address': control.selectedAccount.address};
        case 'getNetwork':
        case 'getInfo':
          method = 'tbc_chainId';
          params = null;
        case 'getBalance':
          if (legacyParams != null &&
              !(legacyParams is List && legacyParams.isEmpty) &&
              !(legacyParams is Map && legacyParams.isEmpty))
            throw TbcWireFailure.invalidParams;
          _deliveryMethods[canonical(id)] = balanceReadMethod;
          return _readBalance(operation, id);
        case 'mergeUtxos':
        case 'mergeFtUtxos':
        case 'mergeStableCoinUtxos':
          Map<String, dynamic> asset;
          try {
            asset = legacyMergeAsset(method, legacyParams);
          } catch (_) {
            throw TbcWireFailure.invalidParams;
          }
          _deliveryMethods[canonical(id)] = 'wallet_mergeMaintenance';
          return _executeMaintenance(asset, operation, id);
        default:
          if (!const {
            'sendTransaction',
            'signTransaction',
            'signAssociatedTransaction',
            'signMessage',
            'encrypt',
            'decrypt',
            'sendBatchRequest',
          }.contains(method)) {
            throw TbcWireFailure.unsupported;
          }
          late final LegacySigningCall call;
          try {
            call = LegacySigningCall.capture(
              method,
              legacyParams,
              LegacyMappingAccount(
                chainId: control.network.chainId,
                address: control.selectedAccount.address,
                accountId: control.selectedAccount.accountId,
              ),
            );
          } on UnsupportedError {
            throw TbcWireFailure.unsupported;
          } catch (_) {
            throw TbcWireFailure.invalidParams;
          }
          _deliveryMethods[canonical(id)] = call.standardMethod;
          return _executeLegacySigning(call, operation, id);
      }
      _deliveryMethods[canonical(id)] = method;
    }
    switch (method) {
      // Existing Kit wallet extension, not a new standard Provider capability.
      // Both entries join the same coordinator; a page cannot widen the
      // wallet's configured whole-run budget or select its own authority.
      case 'tbc_runMultiRoundMerge':
        if (walletProtocol != TbcNativeWalletProtocol.standard)
          throw TbcWireFailure.unsupported;
        final bounds = configuration.maintenance;
        if (bounds == null ||
            !worker.supportsMaintenance ||
            !_supports('tbc_sendTransaction'))
          throw TbcWireFailure.unsupported;
        _permission('tbc_sendTransaction');
        Map<String, dynamic> asset, limits;
        try {
          final request = _named(params, {
            'version',
            'chainId',
            'from',
            'clientRequestId',
            'asset',
            'limits',
          });
          need(
            request['version'] == '1.0' &&
                request['chainId'] == control.network.chainId &&
                request['from'] == control.selectedAccount.address &&
                request['clientRequestId'] is String &&
                RegExp(
                  r'^[A-Za-z0-9._:-]{1,128}$',
                ).hasMatch(request['clientRequestId']),
            'MERGE_REQUEST',
          );
          asset = copied(request['asset'] as Map);
          final now = DateTime.now().toUtc();
          limits = normalizeMultiRoundMergeLimits(
            asset,
            request['limits'] as Map,
            now.millisecondsSinceEpoch,
          );
          need(
            limits['maxTransactions'] <= bounds.maxTransactions &&
                BigInt.parse(limits['maxTotalFee']) <=
                    BigInt.parse(bounds.maxTotalFee) &&
                !protocolTime(
                  limits['expiresAt'],
                ).isAfter(now.add(bounds.approvalLifetime)) &&
                limits['maxIndexRefreshes'] <= bounds.maxIndexRefreshes &&
                limits['indexRefreshDelayMs'] <=
                    bounds.indexRefreshDelay.inMilliseconds,
            'MERGE_WALLET_BOUNDS',
          );
        } catch (_) {
          throw TbcWireFailure.invalidParams;
        }
        _deliveryMethods[canonical(id)] = 'wallet_runMultiRoundMerge';
        return _executeMaintenance(
          asset,
          operation,
          id,
          requestedLimits: limits,
          includeProgress: true,
        );
      case 'tbc_switchChain':
        if (!_supports(method)) throw TbcWireFailure.unsupported;
        final p = _named(params, {'chainId'});
        if (p['chainId'] is! String) throw TbcWireFailure.invalidParams;
        final networks = control as TbcProviderNetworkControl;
        if (!_networks.containsKey(p['chainId'])) {
          throw TbcWireFailure.unsupportedChain;
        }
        final before = networks.networkRevision;
        List<Object?> events;
        try {
          events = await networks.switchChain(
            operationId: operation,
            chainId: p['chainId'],
            expectedRevision: before,
          );
        } on TbcSigningRejected {
          throw TbcWireFailure.rejected;
        }
        _requireCurrent();
        wire.requireExecution(operation, id);
        if (control.network.chainId != p['chainId']) {
          throw TbcWireFailure.unauthorized;
        }
        return TbcWireOutcome(
          null,
          events: events,
          authorizationChanged: networks.networkRevision != before,
        );
      case 'tbc_chainId':
        _noParams(params);
        return TbcWireOutcome(control.network.chainId);
      case 'tbc_accounts':
        _noParams(params);
        return TbcWireOutcome(_accounts());
      case 'wallet_getPermissions':
        _noParams(params);
        return TbcWireOutcome(control.currentPermissions());
      case 'tbc_getAccount':
        final p = _named(params, {'address'});
        _permission('tbc_accountMetadata');
        final matched = _connectedAccounts().where(
          (a) => a.address == (p['address'] ?? control.selectedAccount.address),
        );
        if (matched.length != 1 ||
            (control is TbcProviderAccountCatalog &&
                !(control as TbcProviderAccountCatalog).permitsAccount(
                  'tbc_accountMetadata',
                  matched.single,
                )))
          throw TbcWireFailure.unauthorized;
        return TbcWireOutcome({
          ...matched.single.toKitAccount(),
          'features': ['tbc:provider'],
        });
      case 'tbc_getCapabilities':
        final p = _named(params, {'address', 'chainId'});
        if ((p.containsKey('chainId') && p['chainId'] is! String) ||
            (p.containsKey('address') && p['address'] is! String)) {
          throw TbcWireFailure.invalidParams;
        }
        final chain = p['chainId'] as String? ?? control.network.chainId;
        if (!_networks.containsKey(chain))
          throw TbcWireFailure.unsupportedChain;
        if (p['address'] != null) {
          final allowed =
              control is TbcProviderNetworkControl
                  ? (control as TbcProviderNetworkControl)
                      .permitsAddressOnChain(chain, p['address'])
                  : _accounts().contains(p['address']);
          if ((control is! TbcProviderNetworkControl && !control.isUnlocked) ||
              !allowed)
            throw TbcWireFailure.unauthorized;
        }
        final capabilities = <String, dynamic>{
          'standard': '1.0.0',
          'provider': '1.0.0',
          'chainId': chain,
          'methods': {for (final m in _availableMethods(chain)) m: '1.0'},
          'intents': {
            for (final profile in transactionTaskLimits.keys) profile: ['1.0'],
          },
          'limits': {
            'workflowSteps': 5,
            'transactionBundleSize': maxTransactionBundleSize,
          },
          'profiles': ['transport:webview'],
        };
        if (control is TbcProviderNativeCapabilities) {
          final committed = await (control as TbcProviderNativeCapabilities)
              .nativeCapabilities(
                operationId: operation,
                chainId: chain,
                address: p['address'] as String?,
              );
          _requireCurrent();
          wire.requireExecution(operation, id);
          if (canonical(committed) != canonical(capabilities))
            throw TbcWireFailure.unavailable;
          return TbcWireOutcome(committed);
        }
        return TbcWireOutcome(capabilities);
      case 'tbc_requestAccounts':
      case 'wallet_requestPermissions':
        if (method == 'tbc_requestAccounts') _noParams(params);
        final p =
            method == 'tbc_requestAccounts'
                ? {
                  'tbc_accounts': {
                    'chains': [control.network.chainId],
                    'maxAccounts': 1,
                  },
                }
                : _permissions(params);
        final granted = await control.requestPermissions(
          TbcPermissionRequest(
            providerMethod: method,
            operationId: operation,
            account: control.selectedAccount,
            navigation: control.navigation,
            revision: control.revision,
            permissions: p,
          ),
        );
        _requireCurrent();
        wire.requireExecution(operation, id);
        return TbcWireOutcome(
          method == 'tbc_requestAccounts' ? _accounts() : granted,
          events: _permissionEvents(),
          authorizationChanged: true,
        );
      case 'tbc_disconnect':
        _noParams(params);
        await control.disconnect(operation);
        _requireCurrent();
        return TbcWireOutcome(
          null,
          events: _permissionEvents(),
          authorizationChanged: true,
        );
      case 'tbc_signMessage':
      case 'tbc_signTypedData':
      case 'tbc_signTransaction':
      case 'tbc_signPreparedTransaction':
      case 'tbc_signReviewedTransaction':
      case 'tbc_signWorkflow':
      case 'tbc_signPreparedWorkflow':
      case 'tbc_sendTransaction':
      case 'tbc_sendPreparedTransaction':
      case 'tbc_sendWorkflow':
      case 'tbc_sendPreparedWorkflow':
      case 'tbc_encrypt':
      case 'tbc_decrypt':
        if (!_supports(method)) throw TbcWireFailure.unsupported;
        _permission(method);
        if (params is! Map) throw TbcWireFailure.invalidParams;
        final request = frozen(copied(params)) as Map<String, dynamic>,
            account = control.selectedAccount,
            revision = control.revision,
            networkRevision =
                control is TbcProviderNetworkControl
                    ? (control as TbcProviderNetworkControl).networkRevision
                    : null;
        if (request['chainId'] != control.network.chainId ||
            request['from'] != account.address)
          throw TbcWireFailure.unauthorized;
        final workflow = workflowMethods.contains(method);
        if (workflow) {
          try {
            checkedWorkflowRequest(
              method: method,
              input: request,
              origin: navigation.origin,
              now: DateTime.now().toUtc(),
            );
          } catch (_) {
            throw TbcWireFailure.invalidParams;
          }
          // Optional BIE1 must be backed by native custody before grants,
          // reads or approval. The batch grant alone cannot enable it.
          for (final step in request['steps']) {
            if (((step['kind'] == 'encrypt' || step['kind'] == 'decrypt') &&
                    !_supports('tbc_${step['kind']}')) ||
                (workflowTransaction(step) &&
                    !transactionTaskLimits.containsKey(
                      step['intent']['type'],
                    ))) {
              throw TbcWireFailure.unsupported;
            }
          }
        }
        final childPermissions =
            workflow
                ? workflowRequiredPermissions(request, method: method)
                : const <String>{};
        final transaction =
            method == 'tbc_signTransaction' ||
            method == 'tbc_signPreparedTransaction' ||
            method == 'tbc_sendTransaction' ||
            method == 'tbc_sendPreparedTransaction';
        if (transaction &&
            (request['intent'] is! Map ||
                !transactionTaskLimits.containsKey(request['intent']['type'])))
          throw TbcWireFailure.unsupported;
        void authorized() {
          _permission(method);
          for (final child in childPermissions) _permission(child);
          wire.requireExecution(operation, id);
          if (control.revision != revision ||
              (networkRevision != null &&
                  (control as TbcProviderNetworkControl).networkRevision !=
                      networkRevision) ||
              control.selectedAccount.accountId != account.accountId ||
              control.selectedAccount.publicKey != account.publicKey)
            throw TbcWireFailure.unauthorized;
        }
        authorized();
        // The same wallet-owned policy callback used by single transactions
        // applies to each unique transaction child. Parallel local preparation;
        // the default path adds no callback, query or policy map.
        Map<String, dynamic>? workflowPolicies;
        if (workflow && policy != null) {
          final requests = <String, Map<String, dynamic>>{};
          for (final step in request['steps']) {
            if (!workflowTransaction(step)) continue;
            final child = workflowTransactionRequest(request, step);
            requests.putIfAbsent(hashJson(child), () => child);
          }
          final entries = await Future.wait(
            requests.entries.map((entry) async {
              authorized();
              final value = copied(await policy!(entry.value));
              authorized();
              return MapEntry(entry.key, value);
            }),
          );
          workflowPolicies = Map.fromEntries(entries);
        }
        final selectedPolicy =
            transaction && policy != null
                ? await policy!({
                  for (final key in request.keys)
                    if (key != 'proposal') key: request[key],
                })
                : null;
        authorized();
        late final Map<String, dynamic> result;
        try {
          result = await worker.execute(
            scope: TbcSigningRequestScope(
              operationId: operation,
              method: method,
              navigation: navigation,
              account: account,
              revision: revision,
            ),
            request: request,
            policy: selectedPolicy,
            policiesByRequestHash: workflowPolicies,
            requireAuthorized: authorized,
            requireAuthorizedMethod: workflow ? _permission : null,
            isUnlocked: () => control.isUnlocked,
            timing: timing,
          );
        } on TbcSigningRejected {
          throw TbcWireFailure.rejected;
        } on TbcInvalidTypedData {
          throw TbcWireFailure.invalidParams;
        } on TbcInvalidCryptoRequest {
          throw TbcWireFailure.invalidParams;
        } on TbcPreparedRefused catch (error) {
          throw switch (error.reason) {
            PreparedRefusal.invalid => TbcWireFailure.invalidParams,
            PreparedRefusal.expired => TbcWireFailure.unauthorized,
            PreparedRefusal.mismatch => TbcWireFailure.unavailable,
          };
        }
        authorized();
        return TbcWireOutcome(result);
      default:
        throw TbcWireFailure.unsupported;
    }
  }

  Future<TbcWireOutcome> _readBalance(String operation, Object id) async {
    final account = control.selectedAccount, revision = control.revision;
    final selectedWorker = worker;
    final networkRevision =
        control is TbcProviderNetworkControl
            ? (control as TbcProviderNetworkControl).networkRevision
            : null;
    void authorized() {
      _permission('tbc_accounts');
      wire.requireExecution(operation, id);
      if (control.revision != revision ||
          worker != selectedWorker ||
          (networkRevision != null &&
              (control as TbcProviderNetworkControl).networkRevision !=
                  networkRevision) ||
          control.selectedAccount.accountId != account.accountId ||
          control.selectedAccount.publicKey != account.publicKey)
        throw TbcWireFailure.unauthorized;
    }

    authorized();
    final result = await selectedWorker.readBalance(
      scope: TbcSigningRequestScope(
        operationId: operation,
        method: balanceReadMethod,
        navigation: navigation,
        account: account,
        revision: revision,
      ),
      requireAuthorized: authorized,
    );
    authorized();
    return TbcWireOutcome(result);
  }

  Future<TbcWireOutcome> _executeMaintenance(
    Map<String, dynamic> asset,
    String operation,
    Object id, {
    Map<String, dynamic>? requestedLimits,
    bool includeProgress = false,
  }) async {
    final policy = configuration.maintenance;
    if (policy == null ||
        !worker.supportsMaintenance ||
        !_supports('tbc_sendTransaction'))
      throw TbcWireFailure.unsupported;
    final account = control.selectedAccount, revision = control.revision;
    final selectedWorker = worker;
    final networkRevision =
        control is TbcProviderNetworkControl
            ? (control as TbcProviderNetworkControl).networkRevision
            : null;
    void authorized() {
      _permission('tbc_sendTransaction');
      wire.requireExecution(operation, id);
      if (control.revision != revision ||
          worker != selectedWorker ||
          (networkRevision != null &&
              (control as TbcProviderNetworkControl).networkRevision !=
                  networkRevision) ||
          control.selectedAccount.accountId != account.accountId ||
          control.selectedAccount.publicKey != account.publicKey) {
        throw TbcWireFailure.unauthorized;
      }
    }

    authorized();
    try {
      final result = await selectedWorker.executeMaintenance(
        scope: TbcSigningRequestScope(
          operationId: operation,
          method: 'tbc_sendTransaction',
          navigation: navigation,
          account: account,
          revision: revision,
        ),
        asset: asset,
        limits: requestedLimits ?? policy.limits(DateTime.now()),
        requireAuthorized: authorized,
        isUnlocked: () => control.isUnlocked,
        timing: timing,
        includeProgress: includeProgress,
      );
      authorized();
      // The native owner attests this aggregate before page DTO projection.
      return TbcWireOutcome(result);
    } on TbcSigningRejected {
      throw TbcWireFailure.rejected;
    }
  }

  Future<TbcWireOutcome> _executeLegacySigning(
    LegacySigningCall call,
    String operation,
    Object id,
  ) async {
    final method = call.standardMethod;
    if (!_supports(method) ||
        (call.usesCrypto && !cryptoMethods.every(_supports)))
      throw TbcWireFailure.unsupported;
    final account = control.selectedAccount, revision = control.revision;
    final networkRevision =
        control is TbcProviderNetworkControl
            ? (control as TbcProviderNetworkControl).networkRevision
            : null;
    void authorized() {
      _permission(method);
      for (final permission in call.requiredPermissions)
        _permission(permission);
      wire.requireExecution(operation, id);
      if (control.revision != revision ||
          (networkRevision != null &&
              (control as TbcProviderNetworkControl).networkRevision !=
                  networkRevision) ||
          control.selectedAccount.accountId != account.accountId ||
          control.selectedAccount.publicKey != account.publicKey)
        throw TbcWireFailure.unauthorized;
    }

    authorized();
    try {
      final result = await worker.executeLegacy(
        scope: TbcSigningRequestScope(
          operationId: operation,
          method: method,
          navigation: navigation,
          account: account,
          revision: revision,
        ),
        call: call,
        requireAuthorized: authorized,
        requireAuthorizedMethod: _permission,
        isUnlocked: () => control.isUnlocked,
        timing: timing,
      );
      authorized();
      // Keep the full canonical result through native attestation. The page
      // facade maps historical aliases only after this protected delivery.
      return TbcWireOutcome(result);
    } on TbcSigningRejected {
      throw TbcWireFailure.rejected;
    } on TbcInvalidCryptoRequest {
      throw TbcWireFailure.invalidParams;
    }
  }
}
