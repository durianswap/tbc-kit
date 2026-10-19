// Projection of internally authenticated review data, not a DApp-provided
// preview or an asset decoder. These helpers grant no permission to sign.
import 'protocol_codec.dart';
import '../host_environment.dart' show tbcProtocolTimestamp;
import 'reviewed_material.dart';
import 'reviewed_status.dart';
import 'transaction_read.dart';
import 'reviewed_lop_terms.dart' show publicReviewedLopOrders;

Map<String, dynamic> _record(Object? value) {
  need(value is Map, 'REVIEWED_PREVIEW_SHAPE');
  return Map<String, dynamic>.from(value as Map);
}

String? _address(Object? value) {
  if (value is! Map) return null;
  final address = value['address'];
  return address is String &&
          RegExp(r'^[1-9A-HJ-NP-Za-km-z]{26,35}$').hasMatch(address)
      ? address
      : null;
}

Map<String, dynamic>? _flow(Map asset, Map flow, Object? action) {
  need(flow['recognized'] == true, 'REVIEWED_UNRECOGNIZED_FLOW');
  final type = asset['type'];
  final kind =
      const {
        'tbc': 'native',
        'nftCollection': 'collection',
        'ftlp': 'lp',
        'ft': 'ft',
        'stablecoin': 'stablecoin',
        'nft': 'nft',
      }[type];
  need(kind != null, 'REVIEWED_ASSET_TYPE');
  final purpose = flow['purpose'];
  if (purpose == 'state' || purpose == 'self') return null;
  final direction =
      purpose == 'mint'
          ? type == 'nftCollection' ||
                  (type == 'nft' && asset['subtype'] == 'poolNft')
              ? 'create'
              : 'mint'
          : purpose == 'burn'
          ? 'burn'
          : purpose == 'lock'
          ? 'lock'
          : purpose == 'release'
          ? 'unlock'
          : purpose == 'fee'
          ? 'fee'
          : action == 'merge'
          ? 'merge'
          : flow['direction'] == 'in'
          ? 'receive'
          : 'send';
  var amount = '1';
  if (flow.containsKey('amount')) {
    final a = _record(flow['amount']);
    amount = uintString(a['raw'] ?? a['satoshis']);
  }
  final contract = asset['contractId'] ?? asset['collectionId'];
  final from = _address(flow['from']), to = _address(flow['to']);
  return {
    'kind': asset['subtype'] == 'poolNft' ? 'pool' : kind,
    'direction': direction,
    'amount': amount,
    if (contract is String && RegExp(r'^[0-9a-f]{64}$').hasMatch(contract))
      'contractId': contract,
    if (from != null) 'from': from,
    if (to != null) 'to': to,
  };
}

const _commonLock = {
  'position',
  'index',
  'amount',
  'domain',
  'transactionLockTime',
  'sequence',
  'chainMaturityChecked',
};
const _timeLock = {
  'owner',
  'lockHeight',
  'verification',
  'scriptLockChecked',
  'scriptExecutionVerified',
};
const _htlcLock = {
  'hashlock',
  'sender',
  'receiver',
  'lockTime',
  'verification',
  'branch',
  'preimageVerified',
  'scriptExecutionVerified',
  'escrowToken',
};

Map<String, dynamic> _publicNativeLock(
  Object? value,
  String type,
  int transactionIndex,
) {
  final row = _record(value), isTime = type == 'timeLocks';
  final allowed = {..._commonLock, ...isTime ? _timeLock : _htlcLock};
  // Explicit public fields only. Raw witnesses/templates/preimages never pass
  // into UI, logs or approval artifacts, even through an internal decoder bug.
  need(row.keys.every(allowed.contains), 'REVIEWED_LOCK_PRIVATE_FIELD');
  need(
    row['position'] == 'input' || row['position'] == 'output',
    'REVIEWED_LOCK_POSITION',
  );
  final input = row['position'] == 'input';
  for (final entry
      in {
        'index': 65535,
        'transactionLockTime': 0xffffffff,
        if (input) 'sequence': 0xffffffff,
      }.entries) {
    need(
      row[entry.key] is int &&
          row[entry.key] >= 0 &&
          row[entry.key] <= entry.value,
      'REVIEWED_LOCK_INTEGER',
    );
  }
  need(
    input == row.containsKey('sequence') &&
        row['chainMaturityChecked'] == false &&
        row['scriptExecutionVerified'] == false &&
        row['verification'] == 'exact-template',
    'REVIEWED_LOCK_PROOF_SCOPE',
  );
  uintString(row['amount']);
  if (isTime) {
    need(
      row['domain'] == 'height' &&
          row['lockHeight'] is int &&
          row['lockHeight'] >= 0 &&
          row['lockHeight'] < 500000000 &&
          _address({'address': row['owner']}) != null &&
          row['scriptLockChecked'] == input,
      'REVIEWED_TIMELOCK_TERMS',
    );
    if (input)
      need(
        row['sequence'] != 0xffffffff &&
            row['transactionLockTime'] < 500000000 &&
            row['transactionLockTime'] >= row['lockHeight'],
        'REVIEWED_TIMELOCK_CONDITION',
      );
  } else {
    hash32(row['hashlock']);
    need(
      row['lockTime'] is int &&
          row['lockTime'] > 0 &&
          row['lockTime'] <= 0x7fffffff &&
          row['domain'] ==
              (row['lockTime'] < 500000000 ? 'height' : 'timestamp') &&
          _address({'address': row['sender']}) != null &&
          _address({'address': row['receiver']}) != null &&
          {'unresolved', 'claim', 'refund'}.contains(row['branch']) &&
          row['preimageVerified'] == (row['branch'] == 'claim'),
      'REVIEWED_HTLC_TERMS',
    );
    if (row['branch'] != 'unresolved') need(input, 'REVIEWED_HTLC_BRANCH');
    if (row['branch'] == 'refund')
      need(
        row['sequence'] != 0xffffffff &&
            row['transactionLockTime'] >= row['lockTime'] &&
            row['transactionLockTime'] <= 0x7fffffff &&
            (row['transactionLockTime'] < 500000000) ==
                (row['lockTime'] < 500000000),
        'REVIEWED_HTLC_REFUND',
      );
    if (row.containsKey('escrowToken')) {
      final token = _record(row['escrowToken']),
          coin = token['standardId'] == 'tbc20-stablecoin';
      final fields = {
        'index',
        'standardId',
        'contractId',
        'amount',
        if (coin) ...{'coinLockTime', 'coinInputLockChecked'},
      };
      need(
        token.length == fields.length &&
            token.keys.every(fields.contains) &&
            {
              'tbc20-standard',
              'tbc20-stablecoin',
            }.contains(token['standardId']) &&
            token['index'] is int &&
            token['index'] >= 0 &&
            token['index'] <= 65535 &&
            row['amount'] == '100',
        'REVIEWED_HTLC_ESCROW_TERMS',
      );
      hash32(token['contractId']);
      final amount = BigInt.parse(uintString(token['amount']));
      need(
        amount > BigInt.zero && amount <= (BigInt.one << 63) - BigInt.one,
        'REVIEWED_HTLC_ESCROW_AMOUNT',
      );
      if (coin) {
        final lock = token['coinLockTime'];
        need(
          lock is int &&
              lock >= 0 &&
              lock <= 0xffffffff &&
              token['coinInputLockChecked'] == input &&
              (lock == 0 ||
                  (lock < 500000000) == (row['lockTime'] < 500000000)),
          'REVIEWED_HTLC_ESCROW_COIN_LOCK',
        );
      }
    }
  }
  return {...row, 'transactionIndex': transactionIndex};
}

Map<String, dynamic> _publicCoinLock(Object? value, int transactionIndex) {
  final row = _record(value),
      allowed = {
        ..._commonLock,
        'owner',
        'contractId',
        'lockTime',
        'scriptLockChecked',
      };
  need(
    row.keys.every(allowed.contains) &&
        _address({'address': row['owner']}) != null &&
        (row['position'] == 'input' || row['position'] == 'output'),
    'REVIEWED_COIN_TERMS',
  );
  final input = row['position'] == 'input';
  hash32(row['contractId']);
  uintString(row['amount']);
  for (final entry
      in {
        'index': 65535,
        'lockTime': 0xffffffff,
        'transactionLockTime': 0xffffffff,
        if (input) 'sequence': 0xffffffff,
      }.entries) {
    need(
      row[entry.key] is int &&
          row[entry.key] >= 0 &&
          row[entry.key] <= entry.value,
      'REVIEWED_COIN_INTEGER',
    );
  }
  final lock = row['lockTime'] as int;
  need(
    row['domain'] ==
            (lock == 0
                ? 'none'
                : lock < 500000000
                ? 'height'
                : 'timestamp') &&
        row['scriptLockChecked'] == input &&
        row['chainMaturityChecked'] == false &&
        row.containsKey('sequence') == input,
    'REVIEWED_COIN_PROOF_SCOPE',
  );
  if (input && lock > 0)
    need(
      row['sequence'] != 0xffffffff &&
          row['transactionLockTime'] >= lock &&
          (row['transactionLockTime'] < 500000000) == (lock < 500000000),
      'REVIEWED_COIN_LOCK_CONDITION',
    );
  return {...row, 'transactionIndex': transactionIndex};
}

/// Fixed Standard presentation/hash format. Contract identity and asset-flow
/// recognition must precede this projection; this function cannot prove them.
Map<String, dynamic> projectReviewedPreview(
  ReviewedRawPlan plan,
  Map structured,
) {
  final rows = structured['transactions'];
  need(
    rows is List && rows.length == plan.transactions.length,
    'REVIEWED_PREVIEW_COUNT',
  );
  final flows = <Map<String, dynamic>>[],
      orders = <Map<String, dynamic>>[],
      coin = <Map<String, dynamic>>[],
      htlc = <Map<String, dynamic>>[],
      time = <Map<String, dynamic>>[];
  for (var index = 0; index < rows.length; index++) {
    final tx = _record(rows[index]),
        classification = _record(tx['classification']);
    need(
      tx['index'] == index &&
          tx['txid'] == plan.transactionIds[index] &&
          classification['conformance'] == 'standard',
      'REVIEWED_PREVIEW_IDENTITY',
    );
    if (tx.containsKey('orderTerms'))
      orders.add(publicReviewedLopOrders(tx['orderTerms'], index));
    if (tx.containsKey('coinLocks')) {
      final values = tx['coinLocks'];
      need(
        values is List && values.isNotEmpty && values.length <= 256,
        'REVIEWED_COIN_LOCK_BOUND',
      );
      for (final row in values) coin.add(_publicCoinLock(row, index));
      need(coin.length <= 256, 'REVIEWED_COIN_LOCK_BOUND');
    }
    for (final type in ['htlcLocks', 'timeLocks']) {
      if (!tx.containsKey(type)) continue;
      final values = tx[type];
      need(
        values is List && values.isNotEmpty && values.length <= 256,
        'REVIEWED_LOCK_BOUND',
      );
      final target = type == 'htlcLocks' ? htlc : time;
      for (final row in values) target.add(_publicNativeLock(row, type, index));
      need(target.length <= 256, 'REVIEWED_LOCK_BOUND');
    }
    final groups = tx['groups'];
    need(groups is List, 'REVIEWED_GROUPS');
    for (final value in groups) {
      final group = _record(value), asset = _record(group['asset']);
      need(group['flows'] is List, 'REVIEWED_FLOWS');
      for (final row in group['flows']) {
        final flow = _flow(asset, _record(row), classification['action']);
        if (flow != null) flows.add(flow);
      }
    }
  }
  return frozen({
        'operationKind': 'transaction',
        if (orders.isNotEmpty) 'lopOrders': orders,
        if (coin.isNotEmpty) 'coinLocks': coin,
        if (htlc.isNotEmpty) 'htlcLocks': htlc,
        if (time.isNotEmpty) 'timeLocks': time,
        'assetFlows': flows,
        'totalFee': plan.totalFee,
        'transactionCount': rows.length,
        'warnings': [
          if (rows.length > 1) 'MULTI_TRANSACTION',
          if (htlc.any((r) => r['branch'] == 'claim'))
            'HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE',
          if (time.isNotEmpty ||
              htlc.isNotEmpty ||
              coin.any((r) => r['lockTime'] > 0))
            'LOCKED_ASSET',
        ],
        'irreversible': true,
      })
      as Map<String, dynamic>;
}

Map<String, dynamic> bindReviewedArtifact({
  required ReviewedRawPlan plan,
  required Map structuredPreview,
  required Map policyMaterial,
  required DateTime now,
}) {
  final preview = projectReviewedPreview(plan, structuredPreview);
  need(now.isUtc, 'REVIEWED_CLOCK_UTC');
  final expiresAt = tbcProtocolTimestamp(now.add(const Duration(minutes: 2)));
  protocolTime(expiresAt);
  final payload =
      frozen({
            'preview': preview,
            'totalFee': plan.totalFee,
            'expiresAt': expiresAt,
            'policyMaterial': normalizeReviewedPolicy(policyMaterial),
          })
          as Map<String, dynamic>;
  return Map.unmodifiable({
    'payload': payload,
    'reviewHash': hashJson(payload),
  });
}
