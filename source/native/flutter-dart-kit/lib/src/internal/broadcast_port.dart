// Wallet-private submit boundary. No Provider registration, signing, approval,
// automatic retry, raw-transaction persistence or default in-memory journal.
// The shared send lifecycle must supply its Engine-validated, native-authorized
// exact Host call. This port is not an arbitrary page-facing sendRaw endpoint.
import 'dart:async';
import 'package:crypto/crypto.dart';
import '../configuration.dart';
import 'protocol_codec.dart';
import 'transaction_read.dart';

final class BroadcastNodeFailure implements Exception {
  const BroadcastNodeFailure(this.code);
  final String code;
  @override
  String toString() => 'Broadcast node failure';
}

/// Bound to one wallet-configured network source, never a DApp URL. Preflight
/// is local only. Methods must not retry or redirect a POST. Status is read-only.
abstract interface class BroadcastClient {
  String get sourceIdentity;
  Future<void> preflight(String raw);
  Future<Map<String, dynamic>> submit(String raw);
  Future<List<Map<String, dynamic>>> submitBatch(List<String> raws);
  Future<Map<String, dynamic>> status(String txid);
}

/// Native durable adapter contract, not a signing-session Store. begin must
/// atomically reserve ALL identities or none, returning ordered existing rows
/// on replay. Same key/different identity and active txid/raw collisions reject.
/// Native storage must partition by sourceIdentity; account scope is also bound.
/// Only proven not-submitted rows release their transaction identity for a new
/// key. No implementation is installed by default, and memory is test-only.
abstract interface class BroadcastJournal {
  String get sourceIdentity;
  Future<BroadcastReservation> begin(List<Map<String, dynamic>> identities);
  Future<Map<String, dynamic>?> read(String key);
  Future<List<Map<String, dynamic>>> readByTxids(List<String> txids);

  /// Admit the complete ordered batch atomically. The native adapter retains
  /// its one-use, unstarted dispatch ticket; no ticket is exposed to the page.
  Future<void> markUncertain(List<Map<String, dynamic>> identities);
  Future<void> complete(
    Map<String, dynamic> identity,
    Map<String, dynamic> result,
  );
  Future<void> abortPreflight(
    Map<String, dynamic> identity,
    String failureCode,
  );
}

final class BroadcastReservation {
  BroadcastReservation({
    required this.created,
    required List<Map<String, dynamic>?> records,
  }) : records = List.unmodifiable(
         records.map(
           (r) => r == null ? null : frozen(copied(r)) as Map<String, dynamic>,
         ),
       );
  final bool created;
  final List<Map<String, dynamic>?> records;
}

/// Frozen Kit's source partition. Readable chainId is not endpoint identity.
String broadcastSourceIdentity(TbcNetworkConfiguration network) {
  final other =
      network.network == TbcNetwork.mainnet
          ? TbcNetwork.testnet
          : TbcNetwork.mainnet;
  need(
    network.apiOrigin != other.officialApiOrigin &&
        network.rpcOrigin != other.officialApiOrigin,
    'BROADCAST_NETWORK_ENDPOINT',
  );
  return hashJson({
    'version': '1.0',
    'network': network.network.name,
    'chainId': network.chainId,
    'endpoint': {
      'kind': network.trustId == null ? 'official' : 'trusted-custom',
      'apiOrigin': network.apiOrigin,
      if (network.rpcOrigin != null) 'rpcOrigin': network.rpcOrigin,
      'trustId': network.trustId ?? 'official:${network.network.name}',
    },
  });
}

/// Guard is wallet/native-owned and must enforce the exact finalized result,
/// send-method consent, receipt expiry, account/grant/navigation and network.
/// It is rechecked after async preflight and before uncertainty is persisted.
/// The future native transport must also fence immediately at actual dispatch.
typedef BroadcastGuard = Future<void> Function(Map<String, dynamic> call);

final class TbcBroadcastPort {
  TbcBroadcastPort({
    required this.network,
    required this.client,
    required this.journal,
    required this.accountScopeHash,
    required this.authorize,
  }) : sourceIdentity = broadcastSourceIdentity(network) {
    need(
      client.sourceIdentity == sourceIdentity &&
          journal.sourceIdentity == sourceIdentity,
      'BROADCAST_SOURCE_MISMATCH',
    );
  }
  final TbcNetworkConfiguration network;
  final BroadcastClient client;
  final BroadcastJournal journal;
  final String sourceIdentity;
  final Future<String> Function() accountScopeHash;
  final BroadcastGuard authorize;
  Map<String, dynamic> _failure(String name, [bool retryable = false]) => {
    'portError': {
      'name': name,
      'retryable': retryable,
      'message':
          'TBC ${network.network == TbcNetwork.mainnet ? 'Mainnet' : 'Testnet'} ${name == 'UNAVAILABLE' ? 'submission outcome is unknown' : 'broadcast identity conflict'}',
    },
  };
  bool _keys(Map value, Set<String> required) =>
      value.length == required.length && required.every(value.containsKey);
  bool _id(Object? value) =>
      value is String &&
      RegExp(r'^[A-Za-z][A-Za-z0-9._-]{0,63}$').hasMatch(value);
  bool _tx(Object? value) {
    if (value is! Map ||
        !_keys(value, {'id', 'txid', 'rawTransaction', 'role', 'dependsOn'}))
      return false;
    final dependencies = value['dependsOn'];
    return _id(value['id']) &&
        value['txid'] is String &&
        RegExp(r'^[0-9a-f]{64}$').hasMatch(value['txid']) &&
        value['rawTransaction'] is String &&
        value['rawTransaction'].length <= 4 * 1024 * 1024 &&
        RegExp(r'^(?:[0-9a-f]{2})+$').hasMatch(value['rawTransaction']) &&
        {'primary', 'prerequisite', 'maintenance'}.contains(value['role']) &&
        dependencies is List &&
        dependencies.toSet().length == dependencies.length &&
        dependencies.every(_id);
  }

  bool _submitParams(Map p, bool batch) =>
      _keys(p, {
        'version',
        'chainId',
        batch ? 'transactions' : 'transaction',
        'idempotencyKey',
      }) &&
      p['version'] == '1.0' &&
      p['chainId'] is String &&
      RegExp(r'^tbc:[a-z0-9_-]{1,32}$').hasMatch(p['chainId']) &&
      p['idempotencyKey'] is String &&
      p['idempotencyKey'].isNotEmpty &&
      p['idempotencyKey'].length <= 256 &&
      (batch
          ? p['transactions'] is List &&
              p['transactions'].isNotEmpty &&
              p['transactions'].length <= 32 &&
              (p['transactions'] as List).every(_tx) &&
              (p['transactions'] as List)
                      .map((t) => t['txid'])
                      .toSet()
                      .length ==
                  p['transactions'].length
          : _tx(p['transaction']));
  bool _exactCall(Map p, Map? call, String operation) =>
      call != null &&
      call['operation'] == operation &&
      {'session-only', 'durable'}.contains(call['execution']?['type']) &&
      canonical(call['params']) == canonical(p) &&
      call['callId'] is String &&
      call['callId'].isNotEmpty;
  // Package-private shared normalization, also used for maintenance recovery
  // references. Returning the unscoped input key would not locate the journal.
  String recoveryKey(String key) {
    final prefix = 'tbcnet-${sourceIdentity.substring(0, 24)}-';
    return key.startsWith(prefix)
        ? key
        : '$prefix${hashJson({'idempotencyKey': key})}';
  }

  Future<String> _account() async => hash32(await accountScopeHash());
  Map<String, dynamic> _identity(
    Map p,
    Map call,
    Map tx,
    String account,
    int? index,
  ) {
    final raw = tx['rawTransaction'] as String;
    inspectTransaction(raw, tx['txid']);
    return {
      'idempotencyKey': recoveryKey(
        index == null ? p['idempotencyKey'] : '${p['idempotencyKey']}:$index',
      ),
      'rawHash': sha256.convert(unhex(raw)).toString(),
      'txid': tx['txid'],
      'submitContextHash': hashJson({
        'version': '1.0',
        'callId': call['callId'],
        'operation': call['operation'],
        'params': p,
        if (index != null) 'index': index,
      }),
      'accountScopeHash': account,
    };
  }

  void _record(Map<String, dynamic> record, Map<String, dynamic> identity) {
    need(
      identity.entries.every((e) => record[e.key] == e.value) &&
          {
            'prepared',
            'uncertain',
            'completed',
            'not-submitted',
          }.contains(record['state']),
      'BROADCAST_JOURNAL_IDENTITY',
    );
    if (record['state'] == 'completed' || record['state'] == 'not-submitted')
      _result(record['result'], identity['txid'], batch: false);
  }

  void _result(Object? value, String id, {required bool batch}) {
    need(value is Map, 'BROADCAST_RESULT');
    final r = value as Map;
    need(
      r['txid'] == id &&
          r.keys.every({'txid', 'status', 'reason'}.contains) &&
          (batch
                  ? {'accepted', 'rejected', 'unknown'}
                  : {'accepted', 'rejected', 'known'})
              .contains(r['status']) &&
          (!r.containsKey('reason') || r['reason'] is String),
      'BROADCAST_RESULT',
    );
  }

  Future<Map<String, dynamic>> submit(Map rawParams, Map? rawCall) async {
    try {
      final p = frozen(copied(rawParams)) as Map<String, dynamic>,
          call =
              rawCall == null
                  ? null
                  : frozen(copied(rawCall)) as Map<String, dynamic>;
      if (!_exactCall(p, call, 'broadcast.submit')) return _failure('CONFLICT');
      if (!_submitParams(p, false)) return _failure('INVALID_INPUT');
      if (p['chainId'] != network.chainId) return _failure('UNAUTHORIZED');
      await authorize(call!);
      final identity = _identity(
            p,
            call,
            p['transaction'],
            await _account(),
            null,
          ),
          reservation = await journal.begin([identity]);
      need(
        reservation.records.length == 1 && reservation.records.single != null,
        'BROADCAST_RESERVATION',
      );
      final record = reservation.records.single!;
      _record(record, identity);
      if (record['state'] == 'completed') return copied(record['result']);
      if (record['state'] == 'not-submitted') return _failure('INVALID_INPUT');
      if (!reservation.created || record['state'] == 'uncertain')
        return _failure('UNAVAILABLE', true);
      try {
        await client.preflight(p['transaction']['rawTransaction']);
      } on BroadcastNodeFailure catch (e) {
        if ({'INVALID_INPUT', 'NODE_RESPONSE_INVALID'}.contains(e.code)) {
          await journal.abortPreflight(identity, e.code);
          return _failure('INVALID_INPUT');
        }
        return _failure('CONFLICT');
      }
      await authorize(call);
      need(
        await _account() == identity['accountScopeHash'],
        'BROADCAST_ACCOUNT_CHANGED',
      );
      await journal.markUncertain([identity]);
      Map<String, dynamic> submitted;
      try {
        submitted = await client.submit(p['transaction']['rawTransaction']);
      } catch (_) {
        return _failure('UNAVAILABLE', true);
      }
      if (submitted['txid'] != identity['txid'])
        return _failure('UNAVAILABLE', true);
      final result = <String, dynamic>{
        'txid': identity['txid'],
        'status': 'accepted',
      };
      await journal.complete(identity, result);
      return result;
    } catch (e) {
      return _failure(
        e is BroadcastNodeFailure && e.code == 'NODE_REQUEST_FAILED'
            ? 'UNAVAILABLE'
            : 'CONFLICT',
        e is BroadcastNodeFailure && e.code == 'NODE_REQUEST_FAILED',
      );
    }
  }

  Map<String, dynamic> _replay(
    BroadcastReservation reservation,
    List<Map<String, dynamic>> identities,
  ) {
    need(
      reservation.records.length == identities.length &&
          reservation.records.every((r) => r != null),
      'BROADCAST_PARTIAL_RESERVATION',
    );
    return {
      'transactions': [
        for (var i = 0; i < identities.length; i++)
          _replayed(reservation.records[i]!, identities[i]),
      ],
    };
  }

  Map<String, dynamic> _replayed(
    Map<String, dynamic> r,
    Map<String, dynamic> identity,
  ) {
    _record(r, identity);
    return r['state'] == 'completed'
        ? copied(r['result'])
        : {
          'txid': r['txid'],
          'status': 'unknown',
          'reason':
              'Prior batch submission is unresolved; query status without resending',
        };
  }

  Future<Map<String, dynamic>> submitBatch(Map rawParams, Map? rawCall) async {
    try {
      final p = frozen(copied(rawParams)) as Map<String, dynamic>,
          call =
              rawCall == null
                  ? null
                  : frozen(copied(rawCall)) as Map<String, dynamic>;
      if (!_exactCall(p, call, 'broadcast.submitBatch'))
        return _failure('CONFLICT');
      if (!_submitParams(p, true)) return _failure('INVALID_INPUT');
      if (p['chainId'] != network.chainId) return _failure('UNAUTHORIZED');
      await authorize(call!);
      final account = await _account(),
          transactions = (p['transactions'] as List).cast<Map>();
      final identities = [
        for (var i = 0; i < transactions.length; i++)
          _identity(p, call, transactions[i], account, i),
      ];
      final existing = await Future.wait(
        identities.map((r) => journal.read(r['idempotencyKey'])),
      );
      if (existing.any((r) => r != null))
        return _replay(await journal.begin(identities), identities);
      try {
        await Future.wait(
          transactions.map((t) => client.preflight(t['rawTransaction'])),
        );
      } on BroadcastNodeFailure catch (e) {
        return _failure(
          {'INVALID_INPUT', 'NODE_RESPONSE_INVALID'}.contains(e.code)
              ? 'INVALID_INPUT'
              : 'CONFLICT',
        );
      }
      await authorize(call);
      need(await _account() == account, 'BROADCAST_ACCOUNT_CHANGED');
      final reservation = await journal.begin(identities);
      if (!reservation.created) return _replay(reservation, identities);
      need(
        reservation.records.length == identities.length,
        'BROADCAST_RESERVATION',
      );
      for (var i = 0; i < identities.length; i++) {
        need(reservation.records[i] != null, 'BROADCAST_RESERVATION');
        _record(reservation.records[i]!, identities[i]);
      }
      await journal.markUncertain(identities);
      List<Map<String, dynamic>> results;
      try {
        results = await client.submitBatch(
          transactions.map((t) => t['rawTransaction'] as String).toList(),
        );
      } catch (_) {
        results = [
          for (final id in identities)
            {
              'txid': id['txid'],
              'status': 'unknown',
              'reason': 'TBC batch submission outcome is unknown',
            },
        ];
      }
      need(results.length == identities.length, 'BROADCAST_RESULT_COUNT');
      for (var i = 0; i < results.length; i++)
        _result(results[i], identities[i]['txid'], batch: true);
      final byId = <String, String>{}, normalized = <Map<String, dynamic>>[];
      for (var i = 0; i < results.length; i++) {
        final tx = transactions[i], r = results[i];
        final blocked = (tx['dependsOn'] as List).any(
          (d) => {'rejected', 'unknown'}.contains(byId[d]),
        );
        final result =
            blocked && r['status'] == 'accepted'
                ? <String, dynamic>{
                  'txid': r['txid'],
                  'status': 'unknown',
                  'reason': 'A prerequisite transaction was not accepted',
                }
                : copied(r);
        byId[tx['id']] = result['status'];
        normalized.add(result);
      }
      await Future.wait([
        for (var i = 0; i < normalized.length; i++)
          if (normalized[i]['status'] != 'unknown')
            journal.complete(identities[i], {
              'txid': normalized[i]['txid'],
              'status': normalized[i]['status'],
              if (normalized[i]['status'] == 'rejected')
                'reason': normalized[i]['reason'] ?? 'TBC batch item rejected',
            }),
      ]);
      return {'transactions': normalized};
    } catch (e) {
      return _failure(
        e is BroadcastNodeFailure && e.code == 'NODE_REQUEST_FAILED'
            ? 'UNAVAILABLE'
            : 'CONFLICT',
        e is BroadcastNodeFailure && e.code == 'NODE_REQUEST_FAILED',
      );
    }
  }

  /// Wallet-private status recovery only, never sign/submit/resume a workflow.
  /// IDs must already exist in this configured source and active account scope.
  Future<Map<String, dynamic>> reconcile(Map params, Map? call) async {
    try {
      final p = frozen(copied(params)) as Map<String, dynamic>,
          c =
              call == null
                  ? null
                  : frozen(copied(call)) as Map<String, dynamic>;
      if (!_exactCall(p, c, 'broadcast.reconcile')) return _failure('CONFLICT');
      if (!_keys(p, {'version', 'chainId', 'txids'}) ||
          p['version'] != '1.0' ||
          p['txids'] is! List ||
          (p['txids'] as List).any((v) => v is! String))
        return _failure('INVALID_INPUT');
      if (p['chainId'] != network.chainId) return _failure('UNAUTHORIZED');
      await authorize(c!);
      return recover((p['txids'] as List).cast<String>(), uncertainOnly: false);
    } catch (_) {
      return _failure('CONFLICT');
    }
  }

  Future<Map<String, dynamic>> recover(
    List<String> txids, {
    bool uncertainOnly = true,
  }) async {
    try {
      if (txids.isEmpty ||
          txids.length > 32 ||
          txids.toSet().length != txids.length ||
          txids.any((id) => !RegExp(r'^[0-9a-f]{64}$').hasMatch(id)))
        return _failure('INVALID_INPUT');
      final records = await journal.readByTxids(List.unmodifiable(txids)),
          account = await _account();
      need(
        txids.every((id) => records.any((r) => r['txid'] == id)),
        'BROADCAST_UNKNOWN_RECORD',
      );
      need(
        records.every(
          (r) =>
              r['accountScopeHash'] == account &&
              (!uncertainOnly || r['state'] == 'uncertain'),
        ),
        'BROADCAST_RECOVERY_SCOPE',
      );
      final statuses = await Future.wait(txids.map(client.status));
      need(await _account() == account, 'BROADCAST_RECOVERY_ACCOUNT_CHANGED');
      for (var i = 0; i < statuses.length; i++) {
        final status = statuses[i],
            kind = status['status'],
            confirmations = status['confirmations'];
        need(
          status['txid'] == txids[i] &&
              status.keys.every({'txid', 'status', 'confirmations'}.contains),
          'BROADCAST_STATUS_IDENTITY',
        );
        need(
          {'unknown', 'rejected', 'mempool', 'confirmed'}.contains(kind),
          'BROADCAST_STATUS',
        );
        if (kind == 'unknown' || kind == 'rejected') {
          need(
            !status.containsKey('confirmations'),
            'BROADCAST_STATUS_CONFIRMATIONS',
          );
        } else {
          need(
            confirmations is String &&
                RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(confirmations),
            'BROADCAST_STATUS_CONFIRMATIONS',
          );
          need(
            kind == 'mempool'
                ? confirmations == '0'
                : BigInt.parse(confirmations) > BigInt.zero,
            'BROADCAST_STATUS_CONFIRMATIONS',
          );
        }
      }
      // Validate the whole response before any durable status update.
      for (final status in statuses) {
        if (status['status'] == 'unknown') continue;
        final record = records.firstWhere((r) => r['txid'] == status['txid']);
        final result = <String, dynamic>{
          'txid': status['txid'],
          'status': status['status'] == 'rejected' ? 'rejected' : 'known',
          if (status['status'] == 'rejected')
            'reason': 'TBC ${network.network.name} rejected the transaction',
        };
        need(
          !(record['state'] == 'completed' &&
              record['result']?['status'] == 'accepted' &&
              result['status'] == 'rejected'),
          'BROADCAST_STATUS_CONTRADICTION',
        );
        if (record['state'] != 'completed')
          await journal.complete(record, result);
      }
      return {'transactions': statuses};
    } catch (e) {
      return _failure(
        e is BroadcastNodeFailure && e.code == 'NODE_REQUEST_FAILED'
            ? 'UNAVAILABLE'
            : 'CONFLICT',
        e is BroadcastNodeFailure && e.code == 'NODE_REQUEST_FAILED',
      );
    }
  }
}
