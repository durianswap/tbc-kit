// Private Flutter adapter around the shared port/client. No node codec,
// transaction builder, page endpoint, signing policy or retry is reimplemented.
import 'dart:convert';
import '../configuration.dart';
import '../signing_backend.dart';
import 'broadcast_client.dart';
import 'broadcast_port.dart';
import 'protocol_codec.dart';
import 'send_lifecycle.dart';

typedef NativeBroadcastInvoke =
    Future<Object?> Function(String method, Map<String, Object?> fields);

const nativeBroadcastCommands = {
  'signing.broadcast.authorize',
  'signing.broadcast.open',
  'signing.broadcast.guard',
  'signing.broadcast.journal',
  'signing.broadcast.wire',
  'signing.broadcast.finish',
};

/// Package-private transport for the non-UI worker. Native still owns the
/// operation/source/account/receipt and the actual dispatch fence. Keeping the
/// shared port, raw preflight and REST decoding in that worker avoids moving
/// transaction parsing onto Flutter's UI isolate. Never a WebView handler.
abstract interface class NativeBroadcastCommands {
  Future<Object?> invokeBroadcast(String command, Map<String, Object?> fields);
}

final class NativeBroadcastBinding {
  NativeBroadcastBinding({
    required this.network,
    required this.scope,
    required this.invoke,
  });
  final TbcNetworkConfiguration network;
  final TbcSigningRequestScope scope;
  final NativeBroadcastInvoke invoke;
  TbcBroadcastMaterial? _material;
  TbcSigningReceipt? _receipt;
  bool _authorizing = false, _closed = false, _finished = false;
  final Map<int?, Future<_NativeBroadcastSelection>> _selections = {};
  // Existing native journal identities, not a new recovery namespace. Private
  // maintenance composition can retain these without retaining signed bytes
  // or adding bookkeeping to ordinary transactions.
  Future<String?> recoveryId(int index) async {
    final selection = _selections[index];
    if (selection == null) return null;
    try {
      final selected = await selection;
      return selected.port.recoveryKey(
        selected.call['params']['idempotencyKey'] as String,
      );
    } catch (_) {
      return null; // No successfully opened native journal selection.
    }
  }

  bool get _batch =>
      scope.method == 'tbc_sendWorkflow' ||
      scope.method == 'tbc_sendPreparedWorkflow';

  void _current(TbcSigningReceipt receipt) {
    need(
      !_closed &&
          !_finished &&
          _material != null &&
          canonical(receipt.wire) == canonical(_receipt?.wire),
      'NATIVE_BROADCAST_AUTHORITY',
    );
  }

  Future<void> authorize(
    TbcSigningReceipt receipt,
    TbcBroadcastMaterial material,
  ) async {
    need(
      !_closed &&
          !_authorizing &&
          _material == null &&
          sendMethods.contains(scope.method),
      'NATIVE_BROADCAST_AUTHORITY',
    );
    _authorizing = true;
    final captured = TbcBroadcastMaterial(
      bundle: material.bundle,
      workflow: material.workflow,
    );
    try {
      need(
        (_batch && captured.workflow != null) ||
            (!_batch && captured.workflow == null),
        'NATIVE_BROADCAST_SHAPE',
      );
      final value = await invoke('signing.broadcast.authorize', {
        'receipt': receipt.wire,
        'bundle': captured.bundle,
        'workflow': captured.workflow,
      });
      need(value == true && !_closed, 'NATIVE_BROADCAST_AUTHORITY');
      _material = captured;
      _receipt = receipt;
    } finally {
      _authorizing = false;
    }
  }

  Future<_NativeBroadcastSelection> _selection(
    TbcSigningReceipt receipt,
    int? index,
  ) {
    _current(receipt);
    final rows = _material!.bundle['transactions'] as List;
    need(
      _batch
          ? index == null
          : index != null && index >= 0 && index < rows.length,
      'NATIVE_BROADCAST_SELECTION',
    );
    return _selections.putIfAbsent(index, () async {
      final selected = _batch ? rows : [rows[index!]];
      final id = hashJson({
        'version': '1.0',
        'method': scope.method,
        'operation': scope.operationId,
        'bindingHash': receipt.wire['bindingHash'],
        'source': broadcastSourceIdentity(network),
        'index': index,
      });
      final params = <String, dynamic>{
        'version': '1.0',
        'chainId': network.chainId,
        'idempotencyKey': 'send-$id',
        if (_batch)
          'transactions': selected
        else
          'transaction': selected.single,
      };
      final call = <String, dynamic>{
        'callId': id,
        'operation': _batch ? 'broadcast.submitBatch' : 'broadcast.submit',
        'execution': {'type': 'session-only'},
        'params': params,
      };
      final adapter = _NativeBroadcastSelection(
        network,
        scope.account,
        receipt,
        index,
        call,
        (method, fields) {
          _current(receipt);
          return invoke(method, fields);
        },
      );
      await adapter.open();
      _current(receipt);
      return adapter;
    });
  }

  Future<TbcBroadcastResult> submit(
    TbcSigningReceipt receipt,
    int? index,
  ) async {
    final selected = await _selection(receipt, index);
    final result =
        _batch
            ? await selected.port.submitBatch(
              selected.call['params'],
              selected.call,
            )
            : await selected.port.submit(
              selected.call['params'],
              selected.call,
            );
    _current(receipt);
    return TbcBroadcastResult(result);
  }

  Future<TbcBroadcastResult> reconcile(
    TbcSigningReceipt receipt,
    List<String> txids,
  ) async {
    _current(receipt);
    final rows = _material!.bundle['transactions'] as List;
    need(
      txids.isNotEmpty &&
          txids.length <= rows.length &&
          canonical(txids) ==
              canonical(rows.take(txids.length).map((r) => r['txid']).toList()),
      'NATIVE_BROADCAST_PREFIX',
    );
    final Map<String, dynamic> result;
    if (_batch) {
      need(_selections.containsKey(null), 'NATIVE_BROADCAST_NOT_ATTEMPTED');
      result = await (await _selections[null]!).port.recover(
        txids,
        uncertainOnly: false,
      );
    } else {
      need(
        List.generate(txids.length, (i) => i).every(_selections.containsKey),
        'NATIVE_BROADCAST_NOT_ATTEMPTED',
      );
      // Same bounded prefix and GET count as the shared single-send lifecycle;
      // only per-selection native ownership differs. No polling or POST here.
      final results = await Future.wait([
        for (var i = 0; i < txids.length; i++)
          _selections[i]!.then(
            (s) => s.port.recover([txids[i]], uncertainOnly: false),
          ),
      ]);
      final failures = results.where((r) => r.containsKey('portError'));
      result =
          failures.isNotEmpty
              ? failures.first
              : {
                'transactions': [
                  for (final r in results) ...(r['transactions'] as List),
                ],
              };
    }
    _current(receipt);
    return TbcBroadcastResult(result);
  }

  void close() {
    _closed = true;
    _material = null;
    _receipt = null;
    _selections.clear();
  }

  Future<void> finish(
    TbcSigningReceipt receipt,
    TbcBroadcastResult result,
  ) async {
    _current(receipt);
    final reply = await invoke('signing.broadcast.finish', {
      'receipt': receipt.wire,
      'result': result.wire,
    });
    _current(receipt);
    need(reply == true, 'NATIVE_BROADCAST_RESULT');
    _finished = true;
  }
}

final class _NativeBroadcastSelection
    implements BroadcastJournal, BroadcastWireTransport {
  _NativeBroadcastSelection(
    this.network,
    this.account,
    this.receipt,
    this.index,
    Map call,
    this.invoke,
  ) : call = frozen(copied(call)) as Map<String, dynamic>;
  final TbcNetworkConfiguration network;
  final TbcAccount account;
  final TbcSigningReceipt receipt;
  final int? index;
  final Map<String, dynamic> call;
  final NativeBroadcastInvoke invoke;
  late final TbcBroadcastPort port;
  @override
  String get sourceIdentity => broadcastSourceIdentity(network);
  Future<Object?> _call(String method, Map<String, Object?> fields) =>
      invoke(method, {'receipt': receipt.wire, 'index': index, ...fields});
  Future<Object?> _journal(String action, Map<String, Object?> arguments) =>
      _call('signing.broadcast.journal', {
        'action': action,
        'arguments': arguments,
      });
  Map<String, dynamic> _identity(Map row) => {
    for (final name in [
      'idempotencyKey',
      'rawHash',
      'txid',
      'submitContextHash',
      'accountScopeHash',
    ])
      name: row[name],
  };
  Future<void> open() async {
    final value = await _call('signing.broadcast.open', {'call': call});
    final accountHash = hashJson(account.toKitAccount());
    need(
      value is Map &&
          value.length == 2 &&
          value['sourceIdentity'] == sourceIdentity &&
          value['accountScopeHash'] == accountHash,
      'NATIVE_BROADCAST_SOURCE',
    );
    port = TbcBroadcastPort(
      network: network,
      client: TbcNodeBroadcastClient(network, this),
      journal: this,
      accountScopeHash: () async => accountHash,
      authorize: (request) async {
        need(
          await _call('signing.broadcast.guard', {'call': request}) == true,
          'NATIVE_BROADCAST_GUARD',
        );
      },
    );
  }

  @override
  Future<BroadcastReservation> begin(
    List<Map<String, dynamic>> identities,
  ) async {
    final r = await _journal('begin', {
      'identities': identities.map(_identity).toList(),
    });
    need(
      r is Map && r.length == 2 && r['created'] is bool && r['records'] is List,
      'NATIVE_BROADCAST_RECORD',
    );
    return BroadcastReservation(
      created: (r as Map)['created'],
      records: [
        for (final v in r['records']) v == null ? null : copied(v as Map),
      ],
    );
  }

  @override
  Future<Map<String, dynamic>?> read(String key) async {
    final value = await _journal('read', {'key': key});
    return value == null ? null : copied(value as Map);
  }

  @override
  Future<List<Map<String, dynamic>>> readByTxids(List<String> txids) async {
    final value = await _journal('readByTxids', {'txids': txids});
    return [for (final row in value as List) copied(row as Map)];
  }

  @override
  Future<void> markUncertain(List<Map<String, dynamic>> identities) async {
    need(
      await _journal('admit', {
            'identities': identities.map(_identity).toList(),
          }) ==
          true,
      'NATIVE_BROADCAST_ADMISSION',
    );
  }

  @override
  Future<void> complete(
    Map<String, dynamic> identity,
    Map<String, dynamic> result,
  ) async {
    need(result['txid'] == identity['txid'], 'NATIVE_BROADCAST_RESULT');
    need(
      await _journal('complete', {
            'identity': _identity(identity),
            'status': result['status'],
          }) ==
          true,
      'NATIVE_BROADCAST_COMMIT',
    );
  }

  @override
  Future<void> abortPreflight(
    Map<String, dynamic> identity,
    String failureCode,
  ) async {
    need(
      await _journal('abortPreflight', {
            'identity': _identity(identity),
            'code': failureCode,
          }) ==
          true,
      'NATIVE_BROADCAST_ABORT',
    );
  }

  @override
  Future<BroadcastWireResponse> send(BroadcastWireRequest request) async {
    need(
      request.sourceIdentity == sourceIdentity &&
          !request.retry &&
          !request.followRedirects,
      'NATIVE_BROADCAST_SOURCE',
    );
    final response = await _call('signing.broadcast.wire', {
      'method': request.method,
      'url': request.url,
      'body': request.body,
      'deadline': request.deadline.toIso8601String(),
    });
    need(
      response is Map &&
          response.length == 2 &&
          response['statusCode'] is int &&
          response['body'] is String &&
          (response['body'] as String).length <= 5592408,
      'NATIVE_BROADCAST_RESPONSE',
    );
    return BroadcastWireResponse(
      statusCode: (response as Map)['statusCode'],
      bytes: base64Decode(response['body']),
    );
  }
}
