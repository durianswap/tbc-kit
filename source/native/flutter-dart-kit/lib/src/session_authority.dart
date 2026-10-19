import 'dart:convert';
import 'configuration.dart';
import 'private_host_channel.dart';
import 'webview_scope.dart';

/// Provider session state, not DApp grants or wallet unlock state. Only the
/// trusted Kit commit channel may replace it. Never restore it across documents.
final class TbcProviderSessionState {
  TbcProviderSessionState._(
    this.sessionId,
    this.revision,
    this.connected,
    this.network,
    this.accountIds,
  );
  final String sessionId, revision;
  final bool connected;
  final TbcNetwork network;
  final List<String> accountIds;

  factory TbcProviderSessionState._parse(Object? input) {
    final value = _record(input);
    _keys(value, [
      'version',
      'sessionId',
      'revision',
      'connected',
      'activeChainId',
      'activeAccountIds',
    ]);
    final accounts = value['activeAccountIds'];
    final chain = TbcNetwork.values.where(
      (n) => n.chainId == value['activeChainId'],
    );
    if (value['version'] != '1.0' ||
        value['connected'] is! bool ||
        chain.length != 1 ||
        accounts is! List ||
        accounts.length > 16 ||
        accounts.any(
          (a) =>
              a is! String ||
              !a.startsWith('${value['activeChainId']}:') ||
              a.length <= (value['activeChainId'] as String).length + 1,
        )) {
      throw const FormatException('Invalid Provider session');
    }
    final ids = accounts.cast<String>().toList();
    final sorted = [...ids]..sort();
    if (ids.toSet().length != ids.length ||
        jsonEncode(ids) != jsonEncode(sorted)) {
      throw const FormatException('Noncanonical Provider accounts');
    }
    final revision = value['revision'];
    if (revision is! String ||
        !RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(revision)) {
      throw const FormatException('Invalid Provider revision');
    }
    return TbcProviderSessionState._(
      _id(value['sessionId']),
      revision,
      value['connected'] as bool,
      chain.single,
      List.unmodifiable(ids),
    );
  }

  Map<String, Object> toJson() => {
    'version': '1.0',
    'sessionId': sessionId,
    'revision': revision,
    'connected': connected,
    'activeChainId': network.chainId,
    'activeAccountIds': accountIds,
  };
  @override
  String toString() => 'TbcProviderSessionState(redacted)';
}

/// One native-verified document and one private VM. No persistence, chain reads,
/// implicit permission grants or signing. Kit validates mutation/event semantics;
/// this adapter supplies the wallet-owned atomic compare-and-swap boundary.
///
/// [isCurrent] must synchronously check native document and wallet lifecycle.
/// [revokePending] must revoke this scope's pending approvals/key permits at
/// their actual executor; Dart cannot fence a separate native Vault by itself.
/// Call [close] on navigation, lock, account/network change or VM teardown.
final class TbcSessionAuthority {
  TbcSessionAuthority({
    required this.navigation,
    required this.walletProfile,
    required TbcNetwork network,
    required List<TbcAccount> accounts,
    Set<TbcNetwork>? configuredNetworks,
    required bool Function() isCurrent,
    required void Function() revokePending,
    void Function()? cancelDependentIo,
  }) : _isCurrent = isCurrent,
       _revokePending = revokePending,
       _cancelDependentIo = cancelDependentIo,
       _configuredNetworks = Set.unmodifiable(configuredNetworks ?? {network}) {
    if (!RegExp(r'^[a-z][a-z0-9-]{0,63}$').hasMatch(walletProfile) ||
        !_configuredNetworks.contains(network) ||
        accounts.any((a) => a.network != network)) {
      throw const FormatException('Invalid wallet session scope');
    }
    final ids = accounts.map((a) => a.accountId).toList()..sort();
    _state = TbcProviderSessionState._parse({
      'version': '1.0', 'sessionId': navigation.sessionId, 'revision': '0',
      // Kit's transport/session initialization requires true. No grants are
      // installed here: unapproved tbc_accounts still returns an empty list.
      'connected': true,
      'activeChainId': network.chainId,
      'activeAccountIds': ids,
    });
  }

  final TbcWebViewNavigation navigation;
  final String walletProfile;
  final bool Function() _isCurrent;
  final void Function() _revokePending;
  final void Function()? _cancelDependentIo;
  final Set<TbcNetwork> _configuredNetworks;
  late Set<String> _activeInventoryIds = _state.accountIds.toSet();
  late TbcProviderSessionState _state;
  String? _runtimeId, _lastCommitId, _lastCommitInput;
  String? _lastResult;
  int _lifecycleRevision = 0;
  bool _closed = false, _committing = false;
  int get lifecycleRevision => _lifecycleRevision;
  TbcProviderSessionState get state => _state;
  bool get isClosed => _closed;

  Map<String, Object> get _scope => {
    'walletProfile': walletProfile,
    'sessionId': navigation.sessionId,
  };
  Map<String, Object> _snapshot() => {
    'currentContext': {
      'sessionId': navigation.sessionId,
      'navigationId': navigation.navigationId,
      'origin': navigation.origin,
      'topOrigin': navigation.origin,
      'transport': 'webview',
      'frame': 'top',
      'createdAt': navigation.createdAt,
    },
    'currentSession': {
      'version': '1.0',
      'scope': _scope,
      'state': _state.toJson(),
    },
  };

  void _active(TbcPrivateHostCall call) {
    call.requireActive();
    if (_closed || (_runtimeId != null && _runtimeId != call.runtimeId)) {
      throw StateError('Session authority unavailable');
    }
    bool current;
    try {
      current = _isCurrent();
    } catch (_) {
      close();
      throw StateError('Native authority check unavailable');
    }
    if (!current) {
      close();
      throw StateError('Native session changed');
    }
    call.requireActive();
    if (_closed) throw StateError('Session authority closed');
    _runtimeId = call.runtimeId;
  }

  String dispatch(TbcPrivateHostCall call, {List<TbcAccount>? targetAccounts}) {
    _active(call);
    final input = jsonDecode(call.input);
    if (call.method == TbcPrivateHostMethod.readAuthority) {
      if (input != null)
        throw const FormatException('Authority read takes no page input');
      return jsonEncode(_snapshot());
    }
    if (call.method != TbcPrivateHostMethod.commitAuthority) {
      throw const FormatException('Not an authority callback');
    }
    if (_committing) throw StateError('Reentrant session commit');
    _committing = true;
    try {
      return _commit(call, input, targetAccounts);
    } finally {
      _committing = false;
    }
  }

  String _commit(TbcPrivateHostCall call, Object? input, List<TbcAccount>? targetAccounts) {
    final request = _record(input);
    _keys(request, ['operationId', 'commitId', 'mutation', 'expected']);
    _id(request['operationId']);
    final commitId = request['commitId'];
    if (commitId is! String ||
        !RegExp(r'^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$').hasMatch(commitId)) {
      throw const FormatException('Invalid session commit identity');
    }
    final canonical = _canonical(request);
    if (commitId == _lastCommitId) {
      if (canonical != _lastCommitInput)
        throw StateError('Session commit collision');
      return _lastResult!; // Current commit only; never restore a historical state.
    }
    final mutation = _record(request['mutation']);
    _keys(mutation, ['payload', 'commitId']);
    final payload = _record(mutation['payload']);
    _keys(payload, [
      'version',
      'scope',
      'expectedRevision',
      'target',
      'events',
    ]);
    final events = payload['events'];
    final target = TbcProviderSessionState._parse(payload['target']);
    if (_canonical(request['expected']) != _canonical(_snapshot()) ||
        mutation['commitId'] != commitId ||
        payload['version'] != '1.0' ||
        _canonical(payload['scope']) != _canonical(_scope) ||
        payload['expectedRevision'] != _state.revision ||
        target.sessionId != navigation.sessionId ||
        !_configuredNetworks.contains(target.network) ||
        BigInt.parse(target.revision) !=
            BigInt.parse(_state.revision) + BigInt.one ||
        events is! List ||
        events.isEmpty ||
        events.length > 32) {
      throw StateError('Session compare-and-swap conflict');
    }
    final changesSelection = target.network != _state.network ||
        jsonEncode(target.accountIds) != jsonEncode(_state.accountIds);
    if (changesSelection) {
      if (targetAccounts == null || targetAccounts.isEmpty ||
          targetAccounts.any((account) => account.network != target.network) ||
          targetAccounts.map((account) => account.accountId).toSet().length != targetAccounts.length ||
          target.accountIds.isEmpty ||
          !target.accountIds.every((id) => targetAccounts.any((account) => account.accountId == id))) {
        throw StateError('Target wallet account inventory is unavailable');
      }
    } else if (!target.accountIds.every(_activeInventoryIds.contains)) {
      throw StateError('Provider Session account is not in the wallet inventory');
    }
    _active(call);
    // All work through CAS is synchronous. Invalidate old permits before the
    // new state can be observed. A failed revoke closes the whole authority.
    _lifecycleRevision++;
    try {
      _revokePending();
      // A pure grant/revision mutation need not disrupt unrelated reads.
      // A chain or account change must fence I/O sourced from the old view
      // before exposing the new state. Cancelling a POST is not evidence of
      // non-submission; the broadcast journal remains the source of truth.
      if (target.network != _state.network ||
          jsonEncode(target.accountIds) != jsonEncode(_state.accountIds)) {
        _cancelDependentIo?.call();
      }
      _active(call);
    } catch (_) {
      close();
      throw StateError('Session revocation failed');
    }
    _state = target;
    if (changesSelection) {
      _activeInventoryIds = targetAccounts!.map((account) => account.accountId).toSet();
    }
    final result = jsonEncode({
      'acknowledgment': {
        'version': '1.0',
        'commitId': commitId,
        'status': 'committed',
        'revision': target.revision,
      },
      'authority': _snapshot(),
    });
    _lastCommitId = commitId;
    _lastCommitInput = canonical;
    _lastResult = result;
    return result;
  }

  void close() {
    if (_closed) return;
    _closed = true;
    _lifecycleRevision++;
    _lastCommitId = _lastCommitInput = _lastResult = null;
    try {
      _revokePending();
    } catch (_) {
      /* Remain closed; no secret-bearing error. */
    }
  }

  @override
  String toString() => 'TbcSessionAuthority(redacted)';
}

Map<String, dynamic> _record(Object? value) {
  if (value is! Map<String, dynamic>)
    throw const FormatException('Expected object');
  return value;
}

void _keys(Map value, List<String> names) {
  if (value.length != names.length || !names.every(value.containsKey)) {
    throw const FormatException('Invalid authority fields');
  }
}

String _id(Object? value) {
  if (value is! String ||
      value.isEmpty ||
      value.length > 256 ||
      value.codeUnits.any((c) => c < 0x20 || c == 0x7f)) {
    throw const FormatException('Invalid authority identity');
  }
  return value;
}

String _canonical(Object? value) {
  Object? ordered(Object? v) {
    if (v is Map) {
      final keys = v.keys.cast<String>().toList()..sort();
      return {for (final k in keys) k: ordered(v[k])};
    }
    if (v is List) return v.map(ordered).toList();
    return v;
  }

  return jsonEncode(ordered(value));
}
