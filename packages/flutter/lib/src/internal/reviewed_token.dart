// Exact current/historical Code/Tape inspection and indexed-identity binding. This is a
// private, keyless review helper, not ownership/lineage/consensus verification.
import 'dart:convert';
import 'protocol_codec.dart';
import 'tbc20_material.dart' show KeylessCall, ApiRead;
import 'transaction_read.dart';
import 'reviewed_historical_token.dart';

bool reviewedCoinCode(Map code) =>
    {'tbc20-stablecoin', 'legacy-stablecoin'}.contains(code['standardId']);

Map<String, dynamic> _assetCode(Object? value) {
  final r = _record(value);
  if (r['generation'] != 'historical') return _code(r);
  need(
    {
          'legacy-ft',
          'legacy-tbc20',
          'legacy-stablecoin',
        }.contains(r['standardId']) &&
        r['verification'] == 'exact-template' &&
        r['assetIdentityVerified'] == false &&
        _uint(r['protocolVersion'], 255) &&
        _uint(r['tapeSize'], 65536) &&
        r['controller'] is String &&
        RegExp(r'^[0-9a-f]{42}$').hasMatch(r['controller']) &&
        r['codeIdentity'] is String &&
        RegExp(r'^(?:[0-9a-f]{2}){33,37}$').hasMatch(r['codeIdentity']),
    'REVIEWED_HISTORICAL_CODE',
  );
  return frozen(r) as Map<String, dynamic>;
}

Map<String, dynamic> _record(Object? value) {
  need(value is Map, 'REVIEWED_TOKEN_RESULT');
  return Map<String, dynamic>.from(value as Map);
}

String _script(Object? value) {
  need(
    value is String &&
        value.length <= 131072 &&
        RegExp(r'^(?:[0-9a-f]{2})*$').hasMatch(value),
    'REVIEWED_TOKEN_SCRIPT',
  );
  return value as String;
}

bool _uint(Object? value, [int max = 0xffffffff]) =>
    value is int && value >= 0 && value <= max;

Map<String, dynamic> _code(Object? value) {
  final r = _record(value), standard = r['standardId'];
  need(
    {'tbc20-standard', 'tbc20-stablecoin'}.contains(standard) &&
        r['verification'] == 'exact-template' &&
        r['assetIdentityVerified'] == false &&
        _uint(r['tapeSize'], 127) &&
        r['tapeSize'] >= (standard == 'tbc20-standard' ? 61 : 66) &&
        r['controller'] is String &&
        RegExp(r'^[0-9a-f]{42}$').hasMatch(r['controller']) &&
        r['codeIdentity'] is String &&
        RegExp(r'^(?:[0-9a-f]{2}){33,37}$').hasMatch(r['codeIdentity']),
    'REVIEWED_TOKEN_CODE',
  );
  if (standard == 'tbc20-standard') {
    final origin = _record(r['originalOutpoint']);
    hash32(origin['txid']);
    need(
      _uint(origin['vout']) &&
          !r.containsKey('coinNftCodeHash') &&
          !r.containsKey('adminPubkeyHash'),
      'REVIEWED_TOKEN_ORIGIN',
    );
  } else {
    hash32(r['coinNftCodeHash']);
    need(
      r['adminPubkeyHash'] is String &&
          RegExp(r'^[0-9a-f]{40}$').hasMatch(r['adminPubkeyHash']) &&
          !r.containsKey('originalOutpoint'),
      'REVIEWED_COIN_IDENTITY',
    );
  }
  return frozen(r) as Map<String, dynamic>;
}

final class ReviewedTokenCodec {
  ReviewedTokenCodec(this.keyless);
  final KeylessCall keyless;
  // Exact immutable scripts only, bounded and tied to this native source.
  // The dispatcher creates one codec per review; mutable UTXOs are not cached.
  final _codes = <String, Map<String, dynamic>?>{};
  List _batch(Map<String, dynamic> request, String field, int length) {
    need(
      length > 0 &&
          length <= 256 &&
          utf8.encode(canonical(request)).length <= 8388608,
      'REVIEWED_TOKEN_BATCH',
    );
    Map<String, dynamic> response;
    try {
      response = keyless('inspectTokenMaterial', request);
    } catch (_) {
      throw StateError('REVIEWED_TOKEN_INSPECTION_FAILED');
    }
    need(
      response[field] is List && (response[field] as List).length == length,
      'REVIEWED_TOKEN_MAPPING',
    );
    return response[field] as List;
  }

  List<Map<String, dynamic>?> codes(List<String> scripts) {
    need(scripts.isNotEmpty && scripts.length <= 256, 'REVIEWED_TOKEN_BATCH');
    final unique = scripts.map(_script).toSet().toList();
    if (_codes.length + unique.where((s) => !_codes.containsKey(s)).length >
        256)
      _codes.clear();
    final missing = unique.where((s) => !_codes.containsKey(s)).toList();
    if (missing.isNotEmpty) {
      final values = _batch(
            {'phase': 'inspectCodes', 'scripts': missing},
            'codes',
            missing.length,
          ),
          decoded = <String, Map<String, dynamic>?>{};
      for (var i = 0; i < missing.length; i++)
        decoded[missing[i]] = values[i] == null ? null : _code(values[i]);
      _codes.addAll(decoded);
    }
    return List.unmodifiable(scripts.map((s) => _codes[s]));
  }

  List<Map<String, dynamic>> pairs(List<Map<String, dynamic>> rows) {
    need(rows.isNotEmpty && rows.length <= 256, 'REVIEWED_TOKEN_BATCH');
    final keys = <String>[], unique = <String, Map<String, dynamic>>{};
    for (final row in rows) {
      need(
        row['codeSatoshis'] == 500 && row['tapeSatoshis'] == 0,
        'REVIEWED_TOKEN_PAIR_VALUE',
      );
      final lock = row['inputLock'];
      if (lock != null)
        need(
          lock is Map &&
              lock.length == 2 &&
              _uint(lock['sequence']) &&
              _uint(lock['transactionLockTime']),
          'REVIEWED_COIN_INPUT_LOCK',
        );
      final r = <String, dynamic>{
        'codeScript': _script(row['codeScript']),
        'codeSatoshis': 500,
        'tapeScript': _script(row['tapeScript']),
        'tapeSatoshis': 0,
        if (lock != null)
          'inputLock': {
            'sequence': lock['sequence'],
            'transactionLockTime': lock['transactionLockTime'],
          },
      };
      final key = canonical(r);
      keys.add(key);
      unique[key] = r;
    }
    final values = _batch(
          {'phase': 'inspectPairs', 'pairs': unique.values.toList()},
          'pairs',
          unique.length,
        ),
        byKey = <String, Map<String, dynamic>>{};
    var i = 0;
    for (final entry in unique.entries) {
      final result = _record(values[i++]),
          code = _code(result['code']),
          balance = result['balanceRaw'];
      need(
        balance is String &&
            RegExp(r'^(0|[1-9][0-9]{0,19})$').hasMatch(balance) &&
            BigInt.parse(balance) <=
                BigInt.from(6) * ((BigInt.one << 63) - BigInt.one),
        'REVIEWED_TOKEN_BALANCE',
      );
      need(
        code['standardId'] == 'tbc20-standard'
            ? !result.containsKey('lockTime')
            : _uint(result['lockTime']),
        'REVIEWED_COIN_LOCK',
      );
      final locked = entry.value.containsKey('inputLock');
      need(
        locked
            ? code['standardId'] == 'tbc20-stablecoin' &&
                result['inputLockChecked'] == true
            : !result.containsKey('inputLockChecked'),
        'REVIEWED_COIN_LOCK_RESULT',
      );
      byKey[entry.key] =
          frozen({
                'code': code,
                'balanceRaw': balance,
                if (result.containsKey('lockTime'))
                  'lockTime': result['lockTime'],
                if (locked) 'inputLockChecked': true,
              })
              as Map<String, dynamic>;
    }
    return List.unmodifiable(keys.map((key) => byKey[key]!));
  }

  List<Map<String, dynamic>> historicalPairs(List<Map<String, dynamic>> rows) {
    need(rows.isNotEmpty && rows.length <= 256, 'REVIEWED_TOKEN_BATCH');
    final unique = <String, Map<String, dynamic>>{}, keys = <String>[];
    for (final row in rows) {
      need(
        row['codeSatoshis'] == 500 &&
            row['tapeSatoshis'] == 0 &&
            !row.containsKey('inputLock'),
        'REVIEWED_TOKEN_PAIR_VALUE',
      );
      final pair = {
        'codeScript': _script(row['codeScript']),
        'codeSatoshis': 500,
        'tapeScript': _script(row['tapeScript']),
        'tapeSatoshis': 0,
      };
      final key = canonical(pair);
      keys.add(key);
      unique[key] = pair;
    }
    final values = _batch(
          {'phase': 'identifyPairs', 'pairs': unique.values.toList()},
          'identities',
          unique.length,
        ),
        byKey = <String, Map<String, dynamic>>{};
    var i = 0;
    for (final e in unique.entries)
      byKey[e.key] = historicalReviewedPair(e.value, _record(values[i++]));
    return List.unmodifiable(keys.map((key) => byKey[key]!));
  }
}

/// Per-operation dedup only. Decode supplies a selected-output identity hint;
/// info must match the full Rust-decoded Code identity. Amounts/labels from the
/// index are never used. Mutable requests are owned before the first await.
Future<Map<String, Map<String, dynamic>>> discoverReviewedTokenAssets({
  required ReviewedTokenCodec codec,
  required ApiRead read,
  required List<Map<String, dynamic>> inputs,
  required void Function() requireCurrent,
}) async {
  need(inputs.isNotEmpty && inputs.length <= 256, 'REVIEWED_ASSET_BATCH');
  final unique = <String, Map<String, dynamic>>{};
  for (final value in inputs) {
    final input = copied(value), code = _assetCode(input['code']);
    hash32(input['txid']);
    need(_uint(input['vout']), 'REVIEWED_ASSET_OUTPOINT');
    final key = code['codeIdentity'] as String;
    if (unique.containsKey(key))
      need(
        unique[key]!['code']['standardId'] == code['standardId'],
        'REVIEWED_ASSET_AMBIGUITY',
      );
    unique.putIfAbsent(
      key,
      () => {
        'code': code,
        'txid': input['txid'],
        'vout': input['vout'],
        if (code['generation'] == 'historical')
          'tapeScript': _script(input['tapeScript']),
        if (code['generation'] == 'historical')
          'codeScript': _script(input['codeScript']),
      },
    );
  }
  requireCurrent();
  final decoded = <String, Future<Map<String, dynamic>>>{};
  final requests = await Future.wait(
    unique.values.map((input) async {
      final code = input['code'] as Map,
          txid = input['txid'] as String,
          family = reviewedCoinCode(code) ? 'stablecoin' : 'ft';
      final data = await decoded.putIfAbsent(
        '$family:$txid',
        () => read('/api/tbc/$family/decode/txid/$txid'),
      );
      requireCurrent();
      final outputs = data['output'];
      need(
        data['txid'] == txid &&
            outputs is List &&
            outputs.length <= 65536 &&
            outputs.any(
              (r) =>
                  r is Map &&
                  r['txid'] == txid &&
                  (r['vout'] == input['vout'] ||
                      r['vout'] == '${input['vout']}'),
            ),
        'REVIEWED_ASSET_HINT_OUTPOINT',
      );
      final id = hash32(data['contract_id']);
      return {
        'code': code,
        'contractId': id,
        if (input.containsKey('tapeScript')) 'tapeScript': input['tapeScript'],
        if (input.containsKey('codeScript')) 'codeScript': input['codeScript'],
      };
    }),
  );
  return authenticateReviewedTokenAssets(
    codec: codec,
    read: read,
    requests: requests,
    requireCurrent: requireCurrent,
  );
}

/// Authenticate explicit contract commitments (e.g. LOP) using the very same
/// indexed Code binding as selected-output discovery. No extra decode request.
Future<Map<String, Map<String, dynamic>>> authenticateReviewedTokenAssets({
  required ReviewedTokenCodec codec,
  required ApiRead read,
  required List<Map<String, dynamic>> requests,
  required void Function() requireCurrent,
}) async {
  need(requests.isNotEmpty && requests.length <= 256, 'REVIEWED_ASSET_BATCH');
  final unique = <String, Map<String, dynamic>>{};
  for (final value in requests) {
    final item = copied(value), code = _assetCode(item['code']);
    hash32(item['contractId']);
    final previous = unique[code['codeIdentity']];
    need(
      previous == null || canonical(previous) == canonical(item),
      'REVIEWED_ASSET_AMBIGUOUS',
    );
    unique[code['codeIdentity']] = item;
  }
  requests = unique.values.toList();
  final scripts = await Future.wait(
    requests.map((r) async {
      requireCurrent();
      final coin = reviewedCoinCode(r['code']), id = r['contractId'];
      final data = await read(
        coin
            ? '/api/tbc/stablecoin/info/stablecoinid/$id'
            : '/api/tbc/ft/info/contract/$id',
      );
      requireCurrent();
      need(!coin || data['stablecoin_id'] == id, 'REVIEWED_COIN_METADATA_ID');
      return _script(data['code_script']);
    }),
  );
  final indexed = <Map<String, dynamic>?>[],
      assets = <String, Map<String, dynamic>>{};
  final currentIndexes = [
    for (var i = 0; i < requests.length; i++)
      if (requests[i]['code']['generation'] != 'historical') i,
  ];
  final historicalIndexes = [
    for (var i = 0; i < requests.length; i++)
      if (requests[i]['code']['generation'] == 'historical') i,
  ];
  indexed.addAll(List.filled(requests.length, null));
  if (currentIndexes.isNotEmpty) {
    final values = codec.codes(currentIndexes.map((i) => scripts[i]).toList());
    for (var i = 0; i < currentIndexes.length; i++)
      indexed[currentIndexes[i]] = values[i];
  }
  if (historicalIndexes.isNotEmpty) {
    final values = codec.historicalPairs([
      for (final i in historicalIndexes)
        {
          'codeScript': scripts[i],
          'codeSatoshis': 500,
          'tapeScript': requests[i]['tapeScript'],
          'tapeSatoshis': 0,
        },
    ]);
    for (var i = 0; i < historicalIndexes.length; i++)
      indexed[historicalIndexes[i]] = values[i]['code'];
  }
  for (var i = 0; i < requests.length; i++) {
    final request = requests[i],
        code = request['code'] as Map,
        id = request['contractId'];
    need(
      indexed[i]?['codeIdentity'] == code['codeIdentity'] &&
          indexed[i]?['standardId'] == code['standardId'] &&
          indexed[i]?['protocolVersion'] == code['protocolVersion'],
      'REVIEWED_ASSET_CODE_IDENTITY',
    );
    if (code['generation'] == 'historical')
      need(
        historicalContractCode(scripts[i]) ==
            historicalContractCode(request['codeScript']),
        'REVIEWED_HISTORICAL_FULL_CODE',
      );
    assets[code['codeIdentity']] = Map.unmodifiable({
      'type': reviewedCoinCode(code) ? 'stablecoin' : 'ft',
      'symbol': id,
      'contractId': id,
    });
  }
  requireCurrent();
  return Map.unmodifiable(assets);
}
