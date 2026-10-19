// One-operation trusted status snapshot shared by raw and associated review.
// No global UTXO cache, retry, ancestry walk, key or signing authorization.
import 'nft_material.dart' show ApiTxoStatus;
import 'protocol_codec.dart';
import 'reviewed_material.dart';
import 'transaction_read.dart';

String _point(Map value) => '${hash32(value['txid'])}:${value['vout']}';

Map<String, dynamic> normalizeReviewedPolicy(Map input) {
  need(
    input.length == 1 && input['resolvedOutputs'] is List,
    'REVIEWED_POLICY_SHAPE',
  );
  final rows = input['resolvedOutputs'] as List;
  need(rows.length <= 10000, 'REVIEWED_POLICY_BOUND');
  final seen = <String>{}, outputs = <Map<String, dynamic>>[];
  var bytes = 0;
  for (final row in rows) {
    need(
      row is Map &&
          row.length == 4 &&
          row.keys.every({'txid', 'vout', 'satoshis', 'scriptPubKey'}.contains),
      'REVIEWED_POLICY_FIELDS',
    );
    final p = Map<String, dynamic>.from(row as Map);
    need(
      p['vout'] is int && p['vout'] >= 0 && p['vout'] <= 0xffffffff,
      'REVIEWED_POLICY_INDEX',
    );
    need(
      p['satoshis'] is String &&
          RegExp(r'^(0|[1-9][0-9]{0,19})$').hasMatch(p['satoshis']) &&
          BigInt.parse(p['satoshis']) <= BigInt.parse('18446744073709551615'),
      'REVIEWED_POLICY_AMOUNT',
    );
    final script = p['scriptPubKey'];
    need(
      script is String &&
          script.length <= 131072 &&
          RegExp(r'^(?:[0-9a-f]{2})*$').hasMatch(script),
      'REVIEWED_POLICY_SCRIPT',
    );
    bytes += (script as String).length + 160;
    need(
      bytes <= 4194304 && seen.add(_point(p)),
      'REVIEWED_POLICY_DUPLICATE_OR_BOUND',
    );
    outputs.add(p);
  }
  outputs.sort((a, b) {
    final c = (a['txid'] as String).compareTo(b['txid']);
    return c == 0 ? (a['vout'] as int).compareTo(b['vout']) : c;
  });
  return frozen({'resolvedOutputs': outputs}) as Map<String, dynamic>;
}

final class ReviewedStatusReader {
  ReviewedStatusReader({
    required this.plan,
    required this.status,
    required this.requireCurrent,
  });
  final ReviewedRawPlan plan;
  final ApiTxoStatus status;
  final void Function() requireCurrent;
  final Map<String, Map<String, dynamic>> _external = {};
  bool _started = false, _pending = false, _ready = false, _failed = false;
  Future<void>? _dependencyFlight;
  Map<String, Map<String, dynamic>>? _queuedDependencies;

  Future<void> _read(List<Map<String, dynamic>> points) async {
    requireCurrent();
    need(!_failed, 'REVIEWED_READ_FAILED');
    final missing = <String, Map<String, dynamic>>{};
    for (final point in points) {
      need(
        point.length == 2 &&
            point['vout'] is int &&
            point['vout'] >= 0 &&
            point['vout'] <= 0xffffffff,
        'REVIEWED_STATUS_POINT',
      );
      final key = _point(point);
      if (!_external.containsKey(key) && !plan.localPrevouts.containsKey(key))
        missing[key] = {'txid': point['txid'], 'index': point['vout']};
    }
    if (missing.isEmpty) return;
    need(!_pending && missing.length <= 10000, 'REVIEWED_STATUS_BATCH');
    _pending = true;
    try {
      final reply = await status(List.unmodifiable(missing.values));
      requireCurrent();
      need(
        reply['txos'] is List &&
            (reply['txos'] as List).length == missing.length,
        'REVIEWED_STATUS_INCOMPLETE',
      );
      final parsed = <String, Map<String, dynamic>>{};
      for (final value in reply['txos'] as List) {
        need(value is Map, 'REVIEWED_STATUS_ROW');
        final row = copied(value as Map),
            index = BigInt.parse(uintString(row['index']));
        need(index <= BigInt.from(0xffffffff), 'REVIEWED_STATUS_INDEX');
        final key = '${hash32(row['txid'])}:$index';
        need(
          missing.containsKey(key) &&
              !parsed.containsKey(key) &&
              row['spent'] is bool &&
              row['scriptPubKey'] is String &&
              (row['scriptPubKey'] as String).length <= 131072 &&
              RegExp(r'^(?:[0-9a-fA-F]{2})*$').hasMatch(row['scriptPubKey']),
          'REVIEWED_STATUS_IDENTITY',
        );
        final amount = uintString(row['value']);
        need(
          BigInt.parse(amount) <= BigInt.from(9007199254740991),
          'REVIEWED_STATUS_AMOUNT',
        );
        parsed[key] = {
          'txid': row['txid'],
          'index': '$index',
          'value': amount,
          'spent': row['spent'],
          'scriptPubKey': (row['scriptPubKey'] as String).toLowerCase(),
        };
      }
      // Commit only a complete valid reply. Failure never leaves half a batch.
      _external.addAll(parsed);
    } catch (_) {
      _failed = true;
      rethrow;
    } finally {
      _pending = false;
    }
  }

  Map<String, dynamic> _get(String key) {
    final value = plan.localPrevouts[key] ?? _external[key];
    need(value is Map, 'REVIEWED_STATUS_MISSING');
    return value as Map<String, dynamic>;
  }

  Future<List<List<Map<String, dynamic>>>> readInputs() async {
    need(!_started, 'REVIEWED_READ_ALREADY_STARTED');
    _started = true;
    final request = plan.rawRequest, transactions = plan.transactions;
    final points =
        transactions
            .expand(
              (t) => (t['inputs'] as List).map(
                (p) => <String, dynamic>{'txid': p['txid'], 'vout': p['vout']},
              ),
            )
            .toList();
    await _read(points);
    requireCurrent();
    final verified = <List<Map<String, dynamic>>>[];
    for (var t = 0; t < transactions.length; t++) {
      final result = <Map<String, dynamic>>[],
          inputs = transactions[t]['inputs'] as List;
      for (var i = 0; i < inputs.length; i++) {
        final input = inputs[i],
            value = _get('${input['txid']}:${input['vout']}');
        need(
          value['spent'] == false &&
              value['value'] == '${request['utxos_satoshis'][t][i]}' &&
              value['scriptPubKey'] == request['script_pubkeys'][t][i],
          'REVIEWED_TRUSTED_INPUT_MISMATCH',
        );
        result.add(
          frozen({
                'txid': input['txid'],
                'vout': input['vout'],
                'satoshis': int.parse(value['value']),
                'scriptPubKey': value['scriptPubKey'],
                'spent': false,
              })
              as Map<String, dynamic>,
        );
      }
      verified.add(List.unmodifiable(result));
    }
    _ready = true;
    return List.unmodifiable(verified);
  }

  /// Contract reviewers request only missing Tape/origin outputs after primary
  /// parsing. Already read/local outputs are reused inside this operation.
  Future<List<Map<String, dynamic>>> readDependencies(
    List<Map<String, dynamic>> points,
  ) async {
    need(_ready && !_failed, 'REVIEWED_PRIMARY_REQUIRED');
    final owned = points.map((p) => copied(p)).toList(growable: false);
    for (final p in owned)
      need(
        p.length == 2 &&
            p['vout'] is int &&
            p['vout'] >= 0 &&
            p['vout'] <= 0xffffffff,
        'REVIEWED_STATUS_POINT',
      );
    // Concurrent family reviewers share one same-microtask dependency batch.
    // Arrivals during transport wait for that read, then fetch only any still
    // missing points. A failed transport is never retried.
    while (true) {
      requireCurrent();
      need(!_failed, 'REVIEWED_READ_FAILED');
      final missing = <String, Map<String, dynamic>>{};
      for (final p in owned) {
        final key = _point(p);
        if (!_external.containsKey(key) && !plan.localPrevouts.containsKey(key))
          missing[key] = p;
      }
      if (missing.isEmpty) break;
      final pending = _dependencyFlight;
      if (pending != null) {
        _queuedDependencies?.addAll(missing);
        await pending;
        continue;
      }
      _queuedDependencies = missing;
      final flight = Future<void>.microtask(() async {
        final batch = _queuedDependencies!.values.toList();
        _queuedDependencies = null;
        await _read(batch);
      });
      _dependencyFlight = flight;
      try {
        await flight;
      } finally {
        if (identical(_dependencyFlight, flight)) {
          _dependencyFlight = null;
          _queuedDependencies = null;
        }
      }
    }
    requireCurrent();
    return List.unmodifiable(
      owned.map((p) => frozen(_get(_point(p))) as Map<String, dynamic>),
    );
  }

  Map<String, dynamic> policyMaterial() {
    requireCurrent();
    need(
      _ready && !_pending && !_failed && _dependencyFlight == null,
      'REVIEWED_READ_NOT_READY',
    );
    return normalizeReviewedPolicy({
      'resolvedOutputs':
          _external.values
              .map(
                (p) => {
                  'txid': p['txid'],
                  'vout': int.parse(p['index']),
                  'satoshis': p['value'],
                  'scriptPubKey': p['scriptPubKey'],
                },
              )
              .toList(),
    });
  }
}
