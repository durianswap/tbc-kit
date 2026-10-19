import 'dart:convert';
import 'configuration.dart';
import 'private_host_channel.dart';

/// Kit's existing permission scope. Wallet profile is a separate storage
/// namespace, not an additional public protocol field.
final class TbcPermissionScope {
  TbcPermissionScope({required String origin, required this.network})
    : origin = _origin(origin);
  final String origin;
  final TbcNetwork network;
  String get chainId => network.chainId;
  String get storageKey => jsonEncode([origin, chainId]);
  Map<String, Object> toJson() => {'origin': origin, 'chainId': chainId};
  @override
  String toString() => 'TbcPermissionScope(redacted)';
}

/// Immutable stored data. Kit remains responsible for permission schema and
/// capability/caveat interpretation; the adapter checks storage scope isolation.
final class TbcPermissionSnapshot {
  TbcPermissionSnapshot({
    required String revision,
    required List<Map<String, Object?>> permissions,
  }) : revision = _revision(revision),
       permissions = List.unmodifiable(
         permissions.map((p) => _object(_freeze(p))),
       );
  factory TbcPermissionSnapshot.empty() =>
      TbcPermissionSnapshot(revision: '0', permissions: []);
  factory TbcPermissionSnapshot.fromJson(Map<String, Object?> value) {
    _keys(value, ['revision', 'permissions']);
    return TbcPermissionSnapshot(
      revision: _text(value['revision']),
      permissions: _records(value['permissions']),
    );
  }
  final String revision;
  final List<Map<String, Object?>> permissions;
  Map<String, Object?> toJson() => {
    'revision': revision,
    'permissions': permissions,
  };
  @override
  String toString() => 'TbcPermissionSnapshot(redacted)';
}

final class TbcPermissionChange {
  TbcPermissionChange._(this.scope, this.expectedRevision, this.permissions);
  final TbcPermissionScope scope;
  final String expectedRevision;
  final List<Map<String, Object?>> permissions;
  String get nextRevision =>
      (BigInt.parse(expectedRevision) + BigInt.one).toString();
}

/// Execution fence from the trusted wallet owner. A backend must enforce it at
/// its actual atomic write, not only before awaiting I/O. Native executors need
/// a native lifecycle fence; this callback alone cannot revoke another thread.
final class TbcPermissionStoreAccess {
  TbcPermissionStoreAccess._(
    this.walletProfile,
    this.runtimeId,
    this.lifecycleRevision,
    this._active,
  );
  final String walletProfile, runtimeId;
  final int lifecycleRevision;
  final void Function() _active;
  void requireActive() => _active();
  @override
  String toString() => 'TbcPermissionStoreAccess(redacted)';
}

final class TbcPermissionCommit {
  TbcPermissionCommit._(
    this.access,
    this.callId,
    this.canonicalParams,
    this.changes,
  );
  final TbcPermissionStoreAccess access;

  /// Stable Kit Port ID, NOT the transient Flutter callback sequence.
  final String callId;

  /// Exact parameter meaning with sorted object keys; no hash or grant rewrite.
  final String canonicalParams;
  final List<TbcPermissionChange> changes;
  Map<String, Object> get acknowledgment => {
    'revisions':
        changes
            .map((c) => {'scope': c.scope.toJson(), 'revision': c.nextRevision})
            .toList(),
  };
  @override
  String toString() => 'TbcPermissionCommit(redacted)';
}

enum TbcPermissionStoreFailure implements Exception {
  conflict('CONFLICT'),
  unavailable('UNAVAILABLE'),
  unauthorized('UNAUTHORIZED');

  const TbcPermissionStoreFailure(this.wireName);
  final String wireName;
}

/// Trusted wallet storage, never exposed to the WebView. A commit is atomic
/// across all changes: compare every revision, persist rows AND replay receipt,
/// then return. Same profile/callId/params replays the exact first acknowledgment;
/// same ID with changed params is CONFLICT. Empty permissions revoke a scope.
///
/// Do not implement commit as read -> async write without a transaction/fence.
/// Failed or unknown persistence must not publish an in-memory success. On
/// revocation invalidate affected pending approvals/signing permits at the
/// authoritative executor. No private keys, transaction bytes or signing permit
/// may be persisted here. This interface does not itself supply durable storage.
abstract interface class TbcPermissionStoreBackend {
  Future<TbcPermissionSnapshot> load(
    TbcPermissionStoreAccess access,
    TbcPermissionScope scope,
  );
  Future<Map<String, Object?>> commit(TbcPermissionCommit request);
}

/// Typed translation for the existing permissions.load/commit private callbacks.
/// No cache, global request queue, chain reads, retry, permission policy or new
/// public Provider operation. Use a native-verified origin and session fence.
final class TbcPermissionStoreAdapter {
  TbcPermissionStoreAdapter({
    required String walletProfile,
    required String origin,
    required this.backend,
    required this.readRevision,
    required this.isAuthorityCurrent,
  }) : walletProfile = _text(walletProfile),
       origin = _origin(origin);
  final String walletProfile, origin;
  final TbcPermissionStoreBackend backend;
  final int Function() readRevision;
  final bool Function() isAuthorityCurrent;

  Future<String> dispatch(TbcPrivateHostCall call) async {
    call.requireActive();
    final revision = readRevision();
    void active() {
      call.requireActive();
      if (revision != readRevision() || !isAuthorityCurrent()) {
        throw TbcPermissionStoreFailure.unauthorized;
      }
      // A trusted callback may synchronously revoke/close while answering.
      call.requireActive();
      if (revision != readRevision()) {
        throw TbcPermissionStoreFailure.unauthorized;
      }
    }

    try {
      active();
      final load = call.method == TbcPrivateHostMethod.loadPermissions;
      if (!load && call.method != TbcPrivateHostMethod.commitPermissions) {
        throw const FormatException('Not a permission store callback');
      }
      final input = _object(_freeze(jsonDecode(call.input)));
      _keys(input, ['params', 'port']);
      final params = _object(input['params']), port = _object(input['port']);
      final expectedOperation =
          load ? 'permissionStore.load' : 'permissionStore.commit';
      if (params['version'] != '1.0' ||
          port['version'] != '1.0' ||
          port['operation'] != expectedOperation ||
          _canonical(port['params']) != _canonical(params)) {
        throw const FormatException('Permission Port mismatch');
      }
      final portId = _text(port['callId']);
      final access = TbcPermissionStoreAccess._(
        walletProfile,
        call.runtimeId,
        revision,
        active,
      );
      if (load) {
        _keys(params, ['version', 'scope']);
        final scope = _scope(params['scope']);
        final value = await backend.load(access, scope);
        active();
        _scopeRecords(value.permissions, scope);
        return jsonEncode(value.toJson());
      }
      _keys(params, ['version', 'changes']);
      final source = params['changes'];
      if (source is! List || source.isEmpty || source.length > 16) {
        throw const FormatException('Invalid permission change count');
      }
      final keys = <String>{}, changes = <TbcPermissionChange>[];
      for (final value in source) {
        final c = _object(value);
        _keys(c, ['scope', 'expectedRevision', 'permissions']);
        final scope = _scope(c['scope']);
        if (!keys.add(scope.storageKey))
          throw const FormatException('Duplicate permission scope');
        final records = List<Map<String, Object?>>.unmodifiable(
          _records(c['permissions']),
        );
        _scopeRecords(records, scope);
        changes.add(
          TbcPermissionChange._(
            scope,
            _revision(_text(c['expectedRevision'])),
            records,
          ),
        );
      }
      final request = TbcPermissionCommit._(
        access,
        portId,
        _canonical(params),
        List.unmodifiable(changes),
      );
      final result = await backend.commit(request);
      active();
      // Reject incorrect/cross-scope acknowledgment; never pretend a persisted
      // effect did not happen and never retry it here. Backend owns reconciliation.
      if (_canonical(result) != _canonical(request.acknowledgment)) {
        throw StateError('Invalid permission commit acknowledgment');
      }
      return jsonEncode(request.acknowledgment);
    } on TbcPermissionStoreFailure catch (error) {
      call.requireActive();
      return jsonEncode({
        'portError': {
          'name': error.wireName,
          'message': 'Permission storage operation did not complete.',
          'retryable': false,
        },
      });
    }
  }

  TbcPermissionScope _scope(Object? value) {
    final map = _object(value);
    _keys(map, ['origin', 'chainId']);
    if (map['origin'] != origin) throw TbcPermissionStoreFailure.unauthorized;
    final chain = map['chainId'];
    final network = TbcNetwork.values.where((n) => n.chainId == chain);
    if (network.length != 1)
      throw const FormatException('Unknown permission network');
    return TbcPermissionScope(origin: origin, network: network.single);
  }
}

void _scopeRecords(
  List<Map<String, Object?>> records,
  TbcPermissionScope scope,
) {
  for (final record in records) {
    if (record['invoker'] != scope.origin)
      throw TbcPermissionStoreFailure.unauthorized;
    final caveats = record['caveats'];
    if (caveats is! List)
      throw const FormatException('Invalid permission caveats');
    final chains =
        caveats
            .where((c) => c is Map && c['type'] == 'restrictChains')
            .toList();
    if (chains.length != 1 ||
        _canonical((chains.single as Map)['value']) !=
            _canonical([scope.chainId])) {
      throw TbcPermissionStoreFailure.unauthorized;
    }
  }
}

List<Map<String, Object?>> _records(Object? value) {
  if (value is! List) throw const FormatException('Invalid permission records');
  return value.map(_object).toList();
}

Map<String, Object?> _object(Object? value) {
  if (value is! Map<String, Object?>)
    throw const FormatException('Invalid permission object');
  return value;
}

void _keys(Map<String, Object?> value, List<String> keys) {
  if (value.length != keys.length || keys.any((k) => !value.containsKey(k))) {
    throw const FormatException('Invalid permission fields');
  }
}

String _text(Object? value) {
  if (value is! String ||
      value.isEmpty ||
      value.length > 256 ||
      value.trim() != value ||
      value.codeUnits.any((c) => c < 32 || c == 127))
    throw const FormatException('Invalid permission identity');
  return value;
}

String _revision(String value) {
  if (!RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(value))
    throw const FormatException('Invalid permission revision');
  return value;
}

String _origin(String value) {
  final uri = Uri.tryParse(value);
  if (value.length > 2048 ||
      uri == null ||
      uri.scheme.isEmpty ||
      !['https', 'http'].contains(uri.scheme) ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.path.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      uri.origin != value ||
      value.codeUnits.any((c) => c <= 32 || c == 127))
    throw const FormatException('Invalid permission origin');
  return value;
}

Object? _freeze(Object? value) {
  if (value == null || value is String || value is bool || value is int)
    return value;
  if (value is double && value.isFinite) return value;
  if (value is List) return List<Object?>.unmodifiable(value.map(_freeze));
  if (value is Map && value.keys.every((k) => k is String)) {
    return Map<String, Object?>.unmodifiable({
      for (final key in value.keys) key as String: _freeze(value[key]),
    });
  }
  throw const FormatException('Invalid permission JSON');
}

String _canonical(Object? value) {
  Object? sorted(Object? v) =>
      v is Map
          ? {
            for (final key in (v.keys.cast<String>().toList()..sort()))
              key: sorted(v[key]),
          }
          : v is List
          ? v.map(sorted).toList()
          : v;
  return jsonEncode(sorted(value));
}
