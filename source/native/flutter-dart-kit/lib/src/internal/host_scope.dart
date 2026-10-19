import 'dart:convert';

import '../approval_preparation.dart';
import '../configuration.dart';
import '../formal_approval.dart';
import '../host_environment.dart';
import '../permission_approval.dart';
import '../permission_store.dart';
import '../private_host_channel.dart';
import '../session_authority.dart';
import '../webview_scope.dart';
import 'operation_authority.dart';

/// Runtime-independent half of the accepted wallet host. Only a trusted
/// executor may call this; never attach [dispatch] to a WebView message handler.
/// The executor must verify the Core checkpoint before requesting approval.
/// This class is not a Core verifier, signer, broadcaster or permission policy.
///
/// Native invalidation must revoke permits at their actual key executor before
/// asynchronous teardown. The callbacks below do not replace that atomic fence.
final class TbcWalletHostScope {
  TbcWalletHostScope._({
    required this.runtimeId,
    required this.configuration,
    required this.environment,
    required this.navigation,
    required this.preparationUi,
    required Future<TbcApprovalDecision> Function(TbcFormalApproval) review,
    required Future<TbcIssuedApproval> Function(TbcApprovalAuthorization) issue,
    required int Function() readWalletRevision,
    required bool Function() isNativeCurrent,
    required void Function() revokeNativePermits,
    required void Function() cancelDependentIo,
  }) : _review = review,
       _issue = issue,
       _readWalletRevision = readWalletRevision,
       _isNativeCurrent = isNativeCurrent,
       _revokeNativePermits = revokeNativePermits,
       _cancelDependentIo = cancelDependentIo,
       _walletRevision = readWalletRevision();

  static Future<TbcWalletHostScope> open({
    required String runtimeId,
    required TbcWalletConfiguration configuration,
    required TbcHostEnvironment environment,
    required TbcWebViewNavigation navigation,
    required TbcApprovalPreparationUi preparationUi,
    required TbcPermissionStoreBackend permissionStore,
    required Future<TbcApprovalDecision> Function(TbcFormalApproval) review,
    required Future<TbcIssuedApproval> Function(TbcApprovalAuthorization) issue,
    required int Function() readWalletRevision,
    required bool Function() isNativeCurrent,
    required void Function() revokeNativePermits,
    required void Function() cancelDependentIo,
  }) async {
    if (!RegExp(r'^[A-Za-z0-9_-]{1,128}$').hasMatch(runtimeId) ||
        jsonEncode(configuration.network.toKitOptions()) !=
            jsonEncode(environment.network.toKitOptions())) {
      throw const FormatException('Host configuration does not match wallet');
    }
    final scope = TbcWalletHostScope._(
      runtimeId: runtimeId,
      configuration: configuration,
      environment: environment,
      navigation: navigation,
      preparationUi: preparationUi,
      review: review,
      issue: issue,
      readWalletRevision: readWalletRevision,
      isNativeCurrent: isNativeCurrent,
      revokeNativePermits: revokeNativePermits,
      cancelDependentIo: cancelDependentIo,
    );
    try {
      scope.requireCurrent();
      final initial = await environment.currentAccounts();
      scope.requireCurrent();
      scope._firstAccounts = jsonEncode(initial);
      scope._authority = TbcSessionAuthority(
        navigation: navigation,
        walletProfile: configuration.profile,
        network: configuration.network.network,
        configuredNetworks: {
          configuration.network.network,
          for (final n in environment.additionalNetworks) n.network,
        },
        accounts: _accounts(initial, configuration.network.network),
        isCurrent: () {
          scope.requireCurrent();
          return true;
        },
        revokePending: scope._revoke,
        cancelDependentIo: cancelDependentIo,
      );
      scope._permissions = TbcPermissionStoreAdapter(
        walletProfile: configuration.profile,
        origin: navigation.origin,
        backend: permissionStore,
        readRevision: () => scope._generation,
        isAuthorityCurrent: () {
          scope.requireCurrent();
          return true;
        },
      );
      return scope;
    } catch (_) {
      scope.close();
      rethrow;
    }
  }

  final String runtimeId;
  final TbcWalletConfiguration configuration;
  final TbcHostEnvironment environment;
  final TbcWebViewNavigation navigation;
  final TbcApprovalPreparationUi preparationUi;
  final Future<TbcApprovalDecision> Function(TbcFormalApproval) _review;
  final Future<TbcIssuedApproval> Function(TbcApprovalAuthorization) _issue;
  final int Function() _readWalletRevision;
  final bool Function() _isNativeCurrent;
  final void Function() _revokeNativePermits, _cancelDependentIo;
  final int _walletRevision;
  TbcSessionAuthority? _authority;
  TbcPermissionStoreAdapter? _permissions;
  String? _firstAccounts;
  int _generation = 0, _permissionCommits = 0;
  bool _closed = false;
  bool get isClosed => _closed;
  int get generation => _generation;

  TbcProviderSessionState get state {
    requireCurrent();
    return _authority!.state;
  }

  /// Captured only after the shared permission evaluator has selected the
  /// account. The callback must check the committed grant for [method]; merely
  /// being connected is not authorization. No extra account/API fetch occurs.
  /// Do not transfer this closure to an isolate and assume live state is shared;
  /// cross-isolate execution also uses the native operation fence.
  TbcOperationAuthority operationAuthority({
    required String method,
    required TbcAccount account,
    required void Function(String) requirePermission,
    required bool Function() isUnlocked,
    required DateTime Function() clock,
  }) {
    requireCurrent();
    final captured = _generation;
    void authorized(String requestedMethod) {
      requireCurrent();
      if (requestedMethod != method ||
          _generation != captured ||
          _permissionCommits != 0 ||
          !state.connected ||
          account.network != state.network ||
          !state.accountIds.contains(account.accountId)) {
        throw StateError('Signing operation authority changed');
      }
      requirePermission(method);
      requireCurrent();
      if (_generation != captured) throw StateError('Signing grant changed');
    }

    authorized(method);
    return TbcOperationAuthority(
      context: {
        'sessionId': navigation.sessionId,
        'navigationId': navigation.navigationId,
        'origin': navigation.origin,
        'topOrigin': navigation.origin,
        'transport': 'webview',
        'frame': 'top',
        'createdAt': navigation.createdAt,
      },
      account: account,
      requireAuthorized: authorized,
      isUnlocked: isUnlocked,
      clock: clock,
    );
  }

  void requireCurrent() {
    var current = false;
    if (!_closed && _authority?.isClosed != true) {
      try {
        current =
            _readWalletRevision() == _walletRevision && _isNativeCurrent();
      } catch (_) {
        // Wallet callback details must never reach the page.
      }
    }
    if (!current || _closed || _authority?.isClosed == true) {
      close();
      throw StateError('Wallet host scope changed');
    }
  }

  bool _scopeCurrent(TbcApprovalScope scope, int generation) {
    try {
      requireCurrent();
    } catch (_) {
      return false;
    }
    final nonSigning =
        scope.operationKind == 'permission' ||
        scope.operationKind == 'switchChain';
    return _generation == generation &&
        _permissionCommits == 0 &&
        scope.runtimeId == runtimeId &&
        scope.sessionId == navigation.sessionId &&
        scope.origin == navigation.origin &&
        scope.chainIds.every(
          (chain) =>
              nonSigning
                  ? environment.supportsChainId(chain)
                  : chain == _authority!.state.network.chainId,
        ) &&
        (scope.operationKind != 'switchChain' || scope.accountId == null) &&
        (scope.accountId == null ||
            _authority!.state.accountIds.contains(scope.accountId));
  }

  void _revoke() {
    _generation++;
    _firstAccounts = null;
    try {
      _revokeNativePermits();
    } catch (_) {
      close();
      throw StateError('Native permit revocation unavailable');
    }
  }

  /// No chain read, signing or permission persistence happens on close.
  void close() {
    if (_closed) return;
    _closed = true;
    _firstAccounts = null;
    if (_authority != null) {
      _authority!.close(); // Revokes at the executor before any async cleanup.
    } else {
      try {
        _revoke();
      } catch (_) {}
    }
    try {
      _cancelDependentIo();
    } catch (_) {}
  }

  Future<String> dispatch(TbcPrivateHostCall call) async {
    requireCurrent();
    call.requireActive();
    if (call.runtimeId != runtimeId) {
      throw StateError('Wrong private execution scope');
    }
    final generationAtEntry = _generation;
    String result;
    switch (call.method) {
      case TbcPrivateHostMethod.accounts:
        _noInput(call.input);
        if (_firstAccounts != null) {
          result = _firstAccounts!;
          _firstAccounts = null;
        } else {
          result = jsonEncode(
            await environment.accountsForChain(state.network.chainId),
          );
        }
      case TbcPrivateHostMethod.accountsForChain:
        final input = _singleField(call.input, 'chainId');
        if (input is! String) throw const FormatException('Invalid chain');
        result = jsonEncode(await environment.accountsForChain(input));
      case TbcPrivateHostMethod.clock:
        _noInput(call.input);
        result = jsonEncode(await environment.now());
      case TbcPrivateHostMethod.entropy:
        final input = _singleField(call.input, 'length');
        if (input is! int)
          throw const FormatException('Invalid entropy length');
        result = jsonEncode(await environment.randomBytes(input));
      case TbcPrivateHostMethod.readAuthority:
        result = _authority!.dispatch(call);
      case TbcPrivateHostMethod.commitAuthority:
        result = await _commitAuthority(call);
      case TbcPrivateHostMethod.loadPermissions:
        result = await _permissions!.dispatch(call);
      case TbcPrivateHostMethod.commitPermissions:
        _permissionCommits++;
        try {
          _revoke();
          result = await _permissions!.dispatch(call);
        } finally {
          _permissionCommits--;
        }
      case TbcPrivateHostMethod.preparationBegin:
      case TbcPrivateHostMethod.preparationReview:
      case TbcPrivateHostMethod.preparationFinish:
        final generation = _generation;
        result = await preparationUi.dispatch(call);
        if (generation != _generation) {
          throw StateError('Preparation authority changed');
        }
      case TbcPrivateHostMethod.approval:
        final generation = _generation;
        bool current(TbcApprovalScope scope) =>
            _scopeCurrent(scope, generation);
        final permission = TbcPermissionApprovalIssuer(
          environment: environment,
          readRevision: () => _generation,
          isAuthorityCurrent: current,
        );
        final adapter = TbcFormalApprovalAdapter(
          review: _review,
          clock: environment.now,
          isAuthorityCurrent: current,
          issue:
              (authorization) => switch (authorization.review.operationKind) {
                'permission' => permission.issue(authorization),
                'switchChain' => permission.issueSwitch(authorization),
                _ => _issue(authorization),
              },
        );
        result = await adapter.dispatch(call);
      default:
        // The candidate must not silently route signing, HTTP, broadcast or
        // unsupported business calls through the old acceptance implementation.
        throw UnsupportedError('Host execution adapter not installed');
    }
    call.requireActive();
    requireCurrent();
    if (call.method != TbcPrivateHostMethod.commitAuthority &&
        call.method != TbcPrivateHostMethod.commitPermissions &&
        generationAtEntry != _generation) {
      throw StateError('Host result belongs to a revoked generation');
    }
    return result;
  }

  Future<String> _commitAuthority(TbcPrivateHostCall call) async {
    final decoded = jsonDecode(call.input);
    if (decoded is! Map ||
        decoded['mutation'] is! Map ||
        decoded['mutation']['payload'] is! Map) {
      throw const FormatException('Invalid authority mutation');
    }
    final target = decoded['mutation']['payload']['target'];
    if (target is! Map ||
        target['activeChainId'] is! String ||
        target['activeAccountIds'] is! List) {
      throw const FormatException('Invalid authority target');
    }
    final chain = target['activeChainId'] as String;
    List<TbcAccount>? targetAccounts;
    if (chain != state.network.chainId ||
        jsonEncode(target['activeAccountIds']) !=
            jsonEncode(state.accountIds)) {
      final configured = environment.configurationFor(chain);
      targetAccounts = _accounts(
        await environment.accountsForChain(chain),
        configured.network,
      );
      requireCurrent();
      call.requireActive();
    }
    return _authority!.dispatch(call, targetAccounts: targetAccounts);
  }

  static List<TbcAccount> _accounts(
    List<Map<String, Object>> values,
    TbcNetwork network,
  ) => [
    for (final value in values)
      TbcAccount(
        network: network,
        address: value['address'] as String,
        publicKey: value['publicKey'] as String,
      ),
  ];

  static void _noInput(String json) {
    if (jsonDecode(json) != null)
      throw const FormatException('Expected no input');
  }

  static Object? _singleField(String json, String key) {
    final value = jsonDecode(json);
    if (value is! Map || value.length != 1 || !value.containsKey(key)) {
      throw const FormatException('Invalid host input');
    }
    return value[key];
  }
}
