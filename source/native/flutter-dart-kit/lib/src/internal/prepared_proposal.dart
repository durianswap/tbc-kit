// Frozen Core Prepared semantics, shared by DApp projection and wallet checks.
// Proposals are untrusted evidence, never signing authority. The existing
// Rust plan, validation, signature and continuation lifecycle stays mandatory.
import 'dart:typed_data';
import 'protocol_codec.dart';
import 'transaction_profiles.dart' show transactionBundleLimit;

enum PreparedRefusal { invalid, expired, mismatch }

final class TbcPreparedRefused extends StateError {
  TbcPreparedRefused(this.reason) : super('Prepared transaction refused');
  final PreparedRefusal reason;
}

bool _matches(Object? v, String pattern) {
  if (v is! String) return false;
  final match = RegExp(pattern).firstMatch(v);
  return match != null && match.start == 0 && match.end == v.length;
}

Map _object(
  Object? v,
  Set<String> required, [
  Set<String> optional = const {},
]) {
  need(v is Map, 'PROPOSAL_OBJECT');
  final map = v as Map;
  need(
    required.every(map.containsKey) &&
        map.keys.every((k) => required.contains(k) || optional.contains(k)),
    'PROPOSAL_FIELDS',
  );
  return map;
}

List _array(Object? v, int min, int max, {bool unique = false}) {
  need(v is List && v.length >= min && v.length <= max, 'PROPOSAL_ARRAY');
  final list = v as List;
  if (unique)
    need(
      list.map(canonical).toSet().length == list.length,
      'PROPOSAL_DUPLICATE',
    );
  return list;
}

void _hash(Object? v) => need(_matches(v, r'[0-9a-f]{64}'), 'PROPOSAL_HASH');
void _id(Object? v) =>
    need(_matches(v, r'[A-Za-z][A-Za-z0-9._-]{0,63}'), 'PROPOSAL_ID');
void _raw(Object? v) => need(_matches(v, r'(?:[0-9a-f]{2})+'), 'PROPOSAL_RAW');
void _amount(Object? v) =>
    need(_matches(v, r'(?:0|[1-9][0-9]*)'), 'PROPOSAL_AMOUNT');
void _index(Object? v, int maximum) =>
    need(v is int && v >= 0 && v <= maximum, 'PROPOSAL_INDEX');
DateTime _time(Object? v) {
  need(v is String, 'PROPOSAL_TIME');
  return protocolTime(v as String);
}

const _identityTemplates = {
  'tbc20-standard': [
    'ft',
    'tbc20',
    '0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84',
  ],
  'tbc721-standard': [
    'collection,nft',
    'tbc721',
    'a97688ec62777b01e93c8486e0505b56701f48dc8cf7947637ece57fe88df104',
  ],
  'tbc20-stablecoin': [
    'stablecoin',
    'coin',
    'c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3',
  ],
  'tbc-amm': [
    'pool',
    'pool3',
    'c98ecae0a22452ce37bcaf24be0c836521d3de3a75aa8f16cef587b8b6f031b2,cf7f95c0483b56ad24825591acbce6e82e37890aa0047fc63183d3fb7a7a4ffc,a821abdb280268430ad7ea7a9421068a719a8e959b84c11265d4456e8d740db7,834610c0726fa0829c50aaa75c3a0b58c046105248f0b023257437a22f8aca22',
  ],
};

/// Schema/hash/time checks before reads/consent. Returns only the normalized
/// Engine request projection, not a trusted snapshot or permission.
Map<String, dynamic> checkedPreparedRequest(Map request, DateTime now) {
  try {
    _object(
      request,
      {'version', 'chainId', 'from', 'intent', 'proposal'},
      {'clientRequestId', 'constraints', 'signingRoles'},
    );
    need(
      request['version'] == '1.0' && request['intent'] is Map,
      'PROPOSAL_REQUEST',
    );
    if (request.containsKey('clientRequestId')) {
      final id = request['clientRequestId'];
      need(
        id is String && id.isNotEmpty && id.length <= 128,
        'PROPOSAL_CLIENT_ID',
      );
    }
    final proposal = _object(request['proposal'], {'payload', 'proposalHash'});
    final p = _object(proposal['payload'], {
      'version',
      'engineProfile',
      'createdAt',
      'expiresAt',
      'intentHash',
      'transactions',
      'evidence',
      'estimatedTotalFee',
    });
    need(
      p['version'] == '1.0' &&
          _matches(p['engineProfile'], r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}'),
      'PROPOSAL_PROFILE',
    );
    _hash(proposal['proposalHash']);
    _hash(p['intentHash']);
    _amount(p['estimatedTotalFee']);
    final created = _time(p['createdAt']), expires = _time(p['expiresAt']);
    for (final value in _array(
      p['transactions'],
      1,
      transactionBundleLimit(request),
    )) {
      need(value is Map, 'PROPOSAL_TRANSACTION');
      final fixed = value['kind'] == 'fixed';
      final tx = _object(value, {
        'id',
        'role',
        'dependsOn',
        'kind',
        'fee',
        if (fixed)
          'unsignedTransaction'
        else ...[
          'unsignedTransactionTemplate',
          'deferredInputs',
        ],
      });
      need(fixed || tx['kind'] == 'deferred', 'PROPOSAL_TRANSACTION_KIND');
      _id(tx['id']);
      _amount(tx['fee']);
      need(_matches(tx['role'], r'[a-z][a-z0-9-]{0,63}'), 'PROPOSAL_ROLE');
      for (final parent in _array(tx['dependsOn'], 0, 31, unique: true)) {
        _id(parent);
      }
      _raw(tx[fixed ? 'unsignedTransaction' : 'unsignedTransactionTemplate']);
      if (!fixed) {
        for (final value in _array(
          tx['deferredInputs'],
          1,
          128,
          unique: true,
        )) {
          final edge = _object(value, {
            'inputIndex',
            'sourceTransactionId',
            'sourceOutputIndex',
          });
          _index(edge['inputIndex'], 65535);
          _id(edge['sourceTransactionId']);
          _index(edge['sourceOutputIndex'], 4294967295);
        }
      }
    }
    final evidence = _object(p['evidence'], {
      'observedAt',
      'parentTransactions',
      'contracts',
    });
    _time(evidence['observedAt']);
    for (final value in _array(
      evidence['parentTransactions'],
      0,
      256,
      unique: true,
    )) {
      final parent = _object(value, {'txid', 'rawTransaction'});
      _hash(parent['txid']);
      _raw(parent['rawTransaction']);
    }
    for (final value in _array(evidence['contracts'], 0, 64, unique: true)) {
      final contract = _object(
        value,
        {'contractId', 'family', 'sourceTransactionId'},
        {
          'standardId',
          'protocolVersion',
          'templateRevision',
          'genesisOutpoint',
        },
      );
      _hash(contract['contractId']);
      _hash(contract['sourceTransactionId']);
      need(
        {
          'collection',
          'nft',
          'ft',
          'stablecoin',
          'pool',
        }.contains(contract['family']),
        'PROPOSAL_FAMILY',
      );
      if (contract.containsKey('standardId')) {
        final identity = _identityTemplates[contract['standardId']];
        need(
          identity != null &&
              identity[0].split(',').contains(contract['family']) &&
              identity[1] == contract['protocolVersion'] &&
              identity[2].split(',').contains(contract['templateRevision']),
          'PROPOSAL_IDENTITY',
        );
        final genesis = _object(contract['genesisOutpoint'], {'txid', 'vout'});
        _hash(genesis['txid']);
        need(
          genesis['vout'] is int && genesis['vout'] == 0,
          'PROPOSAL_GENESIS',
        );
      } else {
        need(
          ![
            'protocolVersion',
            'templateRevision',
            'genesisOutpoint',
          ].any(contract.containsKey),
          'PROPOSAL_HISTORICAL_IDENTITY',
        );
      }
    }
    need(hashJson(p) == proposal['proposalHash'], 'PROPOSAL_HASH_MISMATCH');
    need(!created.isAfter(expires), 'PROPOSAL_INTERVAL');
    if (!now.isBefore(expires))
      throw TbcPreparedRefused(PreparedRefusal.expired);
    return frozen({
          for (final k in request.keys)
            if (k != 'proposal') k: request[k],
        })
        as Map<String, dynamic>;
  } on TbcPreparedRefused {
    rethrow;
  } on StateError {
    throw TbcPreparedRefused(PreparedRefusal.invalid);
  } on FormatException {
    throw TbcPreparedRefused(PreparedRefusal.invalid);
  }
}

// Structural template parsing only. Unlike a mined transaction, multiple zero
// placeholders may have the same vout but refer to DIFFERENT reviewed parents.
// Do not run a confirmed-transaction duplicate-outpoint check on those zeros.
final class _TemplateReader {
  _TemplateReader(String raw) : bytes = unhex(raw);
  final Uint8List bytes;
  int offset = 0;
  Uint8List take(int n) {
    need(n >= 0 && n <= bytes.length - offset, 'PREPARED_TRUNCATED');
    final r = Uint8List.sublistView(bytes, offset, offset + n);
    offset += n;
    return r;
  }

  int uint(int n) {
    var result = 0;
    for (final b in take(n).reversed) {
      result = result * 256 + b;
    }
    return result;
  }

  int compact() {
    final first = uint(1);
    if (first < 253) return first;
    need(first != 255, 'PREPARED_COMPACT_BOUND');
    final value = uint(first == 253 ? 2 : 4);
    need(value >= (first == 253 ? 253 : 65536), 'PREPARED_COMPACT_CANONICAL');
    return value;
  }

  void script() {
    final size = compact();
    need(size <= 10000, 'PREPARED_SCRIPT_BOUND');
    take(size);
  }
}

List<Map<String, dynamic>> _dependencies(Map tx, Set<String> known) {
  final r = _TemplateReader(tx['unsignedTransaction']);
  need(r.uint(4) == 10, 'PREPARED_VERSION');
  final count = r.compact(), zeros = <Map<String, dynamic>>[];
  need(count >= 1 && count <= 10000, 'PREPARED_INPUT_COUNT');
  for (var i = 0; i < count; i++) {
    final previous = r.take(32), vout = r.uint(4);
    r.script();
    r.take(4);
    if (previous.every((b) => b == 0))
      zeros.add({'inputIndex': i, 'sourceOutputIndex': vout});
  }
  final outputs = r.compact();
  need(outputs >= 1 && outputs <= 10000, 'PREPARED_OUTPUT_COUNT');
  for (var i = 0; i < outputs; i++) {
    r.take(8);
    r.script();
  }
  r.take(4);
  need(r.offset == r.bytes.length, 'PREPARED_TRAILING_BYTES');
  final parents = tx['dependsOn'] as List,
      explicit = tx['deferredInputs'] as List?;
  need(
    parents.toSet().length == parents.length && parents.every(known.contains),
    'PREPARED_DEPENDENCIES',
  );
  need(
    explicit == null
        ? zeros.length == parents.length
        : explicit.isNotEmpty && explicit.length == zeros.length,
    'PREPARED_DEPENDENCY_COUNT',
  );
  final usedParents = <String>{}, usedOutputs = <String>{};
  final result = <Map<String, dynamic>>[];
  for (var i = 0; i < zeros.length; i++) {
    final edge =
        explicit == null
            ? {...zeros[i], 'sourceTransactionId': parents[i]}
            : copied(explicit[i]);
    need(
      edge['inputIndex'] == zeros[i]['inputIndex'] &&
          edge['sourceOutputIndex'] == zeros[i]['sourceOutputIndex'] &&
          parents.contains(edge['sourceTransactionId']) &&
          usedOutputs.add(
            '${edge['sourceTransactionId']}:${edge['sourceOutputIndex']}',
          ),
      'PREPARED_DEPENDENCY_BINDING',
    );
    usedParents.add(edge['sourceTransactionId']);
    result.add(edge);
  }
  need(usedParents.length == parents.length, 'PREPARED_UNUSED_DEPENDENCY');
  return result;
}

/// Projection of an already wallet-validated Engine plan. No parsing or
/// selection based on a DApp's claimed transaction/fee/contract labels.
List<Map<String, dynamic>> preparedProposalTransactions(List planned) {
  final known = <String>{}, result = <Map<String, dynamic>>[];
  for (final tx in planned) {
    final inputs = _dependencies(tx, known);
    final common = {
      'id': tx['id'],
      'role': tx['role'],
      'dependsOn': tx['dependsOn'],
      'fee': tx['fee'],
    };
    need(known.add(tx['id']), 'PREPARED_DUPLICATE_PLAN_ID');
    result.add({
      ...common,
      if (inputs.isEmpty) ...{
        'kind': 'fixed',
        'unsignedTransaction': tx['unsignedTransaction'],
      } else ...{
        'kind': 'deferred',
        'unsignedTransactionTemplate': tx['unsignedTransaction'],
        'deferredInputs': inputs,
      },
    });
  }
  return (frozen(result) as List).cast<Map<String, dynamic>>();
}

Map<String, dynamic> _evidence(Map snapshot, String observedAt) => {
  'observedAt': observedAt,
  'parentTransactions': [
    for (final p in snapshot['payload']['parents'])
      {'txid': p['txid'], 'rawTransaction': p['rawTransaction']},
  ],
  'contracts': [
    for (final c in snapshot['payload']['contracts'])
      {
        'contractId': c['contractId'],
        'family': c['family'],
        'sourceTransactionId':
            c['sourceTransactionId'] ?? c['creationTxid'] ?? c['contractId'],
        if (c['standardId'] != null) ...{
          'standardId': c['standardId'],
          'protocolVersion': c['protocolVersion'],
          'templateRevision': c['templateRevision'],
          if (c['genesisOutpoint'] != null)
            'genesisOutpoint': {
              'txid': c['genesisOutpoint']['txid'],
              'vout': c['genesisOutpoint']['vout'],
            },
        },
      },
  ],
};

void assertPreparedProposalForPlan(Map request, Map snapshot, Map plan) {
  final proposal = request['proposal'], p = proposal['payload'];
  // Only the proposal's own created/observed timestamp must agree. Independent
  // DApp and wallet clocks need not match; actual wallet material stays fresh.
  if (p['engineProfile'] != 'tbc-engine-plan-v1' ||
      p['intentHash'] != hashJson(request['intent']) ||
      canonical(p['transactions']) !=
          canonical(
            preparedProposalTransactions(plan['payload']['transactions']),
          ) ||
      canonical(p['evidence']) !=
          canonical(_evidence(snapshot, p['createdAt'])) ||
      p['estimatedTotalFee'] != plan['payload']['preview']['totalFee']) {
    throw TbcPreparedRefused(PreparedRefusal.mismatch);
  }
}
