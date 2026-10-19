// Private Reviewed material projection. This owns no key/approval/network and
// is not yet a Provider capability. Full asset review and native custody must
// bind this snapshot before the existing signing lifecycle may consume it.
import 'dart:convert';
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'reviewed_htlc_witness.dart' show associatedHtlcRefundLock;

const _profiles = {
  'p2pkh': 'p2pkh',
  'ft': 'tbc20',
  'ft-contract': 'tbc20_contract',
  'contract-template': 'other',
  'tbc-lop-match': 'tbc_lop_match',
  'tbc20-standard': 'tbc20-standard',
  'tbc20-stablecoin': 'tbc20-stablecoin',
};

Map<String, dynamic> _fields(
  Object? value,
  Set<String> required, [
  Set<String> optional = const {},
]) {
  need(value is Map, 'REVIEWED_SHAPE');
  final map = Map<String, dynamic>.from(value as Map);
  need(
    required.every(map.containsKey) &&
        map.keys.every(
          (key) => required.contains(key) || optional.contains(key),
        ),
    'REVIEWED_FIELDS',
  );
  return map;
}

List _rows(Object? value, int min, int max) {
  need(
    value is List && value.length >= min && value.length <= max,
    'REVIEWED_ROW_BOUND',
  );
  return value as List;
}

String _bytes(Object? value, [int max = 2097152]) {
  need(
    value is String &&
        value.isNotEmpty &&
        value.length <= max &&
        RegExp(r'^(?:[0-9a-f]{2})+$').hasMatch(value),
    'REVIEWED_HEX',
  );
  return value as String;
}

int _index(Object? value) {
  need(value is int && value >= 0 && value <= 0xffffffff, 'REVIEWED_INDEX');
  return value as int;
}

int _amount(Object? value) {
  need(
    value is String && RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(value),
    'REVIEWED_AMOUNT',
  );
  final amount = BigInt.parse(value as String);
  need(amount <= BigInt.from(9007199254740991), 'REVIEWED_SAFE_AMOUNT');
  return amount.toInt();
}

Map<String, dynamic> _input(Object? value) {
  final row = _fields(
    value,
    {'outputIndex', 'signingProfile'},
    {
      'txid',
      'satoshis',
      'scriptPubKey',
      'previousTransaction',
      'ancestorTransactions',
      'previousOutputContext',
      'contractTransaction',
      'contractVersion',
      'unlockingScriptTemplate',
    },
  );
  final profile = _profiles[row['signingProfile']];
  need(profile != null, 'REVIEWED_PROFILE');
  final current = profile == 'tbc20-standard' || profile == 'tbc20-stablecoin';
  if (current) {
    need(
      !{
        'previousOutputContext',
        'contractTransaction',
        'contractVersion',
        'unlockingScriptTemplate',
      }.any(row.containsKey),
      'REVIEWED_PROOF_OVERRIDE',
    );
    if (row.containsKey('txid')) {
      need(
        {
          'satoshis',
          'scriptPubKey',
          'previousTransaction',
          'ancestorTransactions',
        }.every(row.containsKey),
        'REVIEWED_PROOF_REQUIRED',
      );
    } else {
      need(!row.containsKey('previousTransaction'), 'REVIEWED_LOCAL_PARENT');
    }
  } else {
    need(!row.containsKey('ancestorTransactions'), 'REVIEWED_ANCESTOR_PROFILE');
  }
  List<String>? ancestors;
  if (row.containsKey('ancestorTransactions')) {
    ancestors =
        _rows(
          row['ancestorTransactions'],
          0,
          6,
        ).map((raw) => _bytes(raw)).toList();
    need(
      ancestors.toSet().length == ancestors.length,
      'REVIEWED_DUPLICATE_PROOF',
    );
  }
  if (row.containsKey('contractVersion')) {
    need(
      row['contractVersion'] is int &&
          row['contractVersion'] >= 1 &&
          row['contractVersion'] <= 3,
      'REVIEWED_CONTRACT_VERSION',
    );
  }
  return {
    if (row.containsKey('txid')) 'txId': hash32(row['txid']),
    'outputIndex': _index(row['outputIndex']),
    if (row.containsKey('satoshis')) 'satoshis': _amount(row['satoshis']),
    if (row.containsKey('scriptPubKey')) 'script': _bytes(row['scriptPubKey']),
    'scriptSigType': profile,
    if (ancestors != null) 'ancestorTransactions': ancestors,
    for (final pair
        in const {
          'previousTransaction': 'preTx',
          'previousOutputContext': 'prePreTxData',
          'contractTransaction': 'contractTx',
          'unlockingScriptTemplate': 'unfinishedScriptSig',
        }.entries)
      if (row.containsKey(pair.key)) pair.value: _bytes(row[pair.key]),
    if (row.containsKey('contractVersion')) 'ftVersion': row['contractVersion'],
  };
}

/// Same public wire -> private Rust material mapping as frozen Kit. Role-based
/// Coin administration is intentionally outside this partner usage scope.
Map<String, dynamic> normalizeReviewedMaterial(Map input) {
  need(
    utf8.encode(canonical(input)).length <= 4 * 1024 * 1024,
    'REVIEWED_REQUEST_BOUND',
  );
  final root = _fields(copied(input), {'payload'});
  final payload = root['payload'];
  need(payload is Map, 'REVIEWED_PAYLOAD');
  final format = payload['format'];
  Map<String, dynamic> request;
  if (format == 'raw') {
    final p = _fields(payload, {'format', 'transactions'});
    final txraws = <String>[],
        amounts = <List<int>>[],
        scripts = <List<String>>[];
    for (final item in _rows(p['transactions'], 1, 32)) {
      final tx = _fields(item, {'rawTransaction', 'inputs'});
      final raw = _bytes(tx['rawTransaction']);
      final parsed = inspectTransaction(raw);
      final inputs = _rows(tx['inputs'], 1, 1000);
      need(
        inputs.length == (parsed['inputs'] as List).length,
        'REVIEWED_INPUT_MATRIX',
      );
      final money = <int>[], locks = <String>[];
      for (final value in inputs) {
        final row = _fields(value, {'satoshis', 'scriptPubKey'});
        money.add(_amount(row['satoshis']));
        locks.add(_bytes(row['scriptPubKey']));
      }
      txraws.add(raw);
      amounts.add(money);
      scripts.add(locks);
    }
    request = {
      'txraws': txraws,
      'utxos_satoshis': amounts,
      'script_pubkeys': scripts,
    };
  } else {
    need(format == 'associated', 'REVIEWED_FORMAT');
    final p = _fields(payload, {
      'format',
      'sourceTransaction',
      'sourceInputs',
      'children',
    });
    final children = _rows(p['children'], 0, 31),
        inputs = <List>[],
        outputs = <List>[];
    for (final item in children) {
      final child = _fields(item, {'inputs', 'outputs'});
      inputs.add(_rows(child['inputs'], 1, 1000).map(_input).toList());
      outputs.add(
        _rows(child['outputs'], 0, 1000).map((value) {
          final row = _fields(value, {'satoshis', 'scriptPubKey'});
          return {
            'satoshis': _amount(row['satoshis']),
            'script': _bytes(row['scriptPubKey']),
          };
        }).toList(),
      );
    }
    request = {
      'sourceTxraw': _bytes(p['sourceTransaction']),
      'sourceUtxos': _rows(p['sourceInputs'], 0, 1000).map(_input).toList(),
      'inputs': inputs,
      'outputs': outputs,
    };
  }
  return frozen({'format': format, 'request': request}) as Map<String, dynamic>;
}

String _little(int value, int width) => hex([
  for (var i = 0; i < width; i++) (BigInt.from(value) >> (8 * i)).toInt() & 255,
]);
String _size(int value) =>
    value < 253
        ? _little(value, 1)
        : value <= 65535
        ? 'fd${_little(value, 2)}'
        : 'fe${_little(value, 4)}';

String _unsigned(List<Map<String, dynamic>> inputs, List outputs, int lock) =>
    '0a000000${_size(inputs.length)}${inputs.map((p) => '${hex(unhex(p['txid']).reversed)}${_little(p['vout'], 4)}00${_little(p['sequence'], 4)}').join()}'
    '${_size(outputs.length)}${outputs.map((p) => '${_little(p['satoshis'], 8)}'
    '${_size((p['script'] as String).length ~/ 2)}${p['script']}').join()}${_little(lock, 4)}';

int _coinLock(Map parent, int vout) {
  final outputs = parent['outputs'] as List;
  need(vout + 1 < outputs.length, 'REVIEWED_COIN_PARENT');
  final code = outputs[vout], tape = outputs[vout + 1];
  final bytes = unhex(tape['scriptPubKey']);
  need(
    code['satoshis'] == '500' &&
        tape['satoshis'] == '0' &&
        bytes.length >= 66 &&
        bytes.length <= 127 &&
        bytes[0] == 0 &&
        bytes[1] == 0x6a &&
        bytes[2] == 0x30 &&
        bytes[bytes.length - 15] == 4 &&
        bytes[bytes.length - 10] == 9 &&
        hex(bytes.sublist(bytes.length - 9)) == '544243323054415045',
    'REVIEWED_COIN_TAPE',
  );
  var value = 0;
  for (var i = 3; i >= 0; i--)
    value = value * 256 + bytes[bytes.length - 14 + i];
  return value;
}

/// Review-only unsigned projection. Finalized parent IDs are different and
/// must be rebuilt by Rust at each signing stage. Local outputs are derived
/// from these exact raws, never supplied by an API/page as trusted evidence.
final class ReviewedRawPlan {
  ReviewedRawPlan._(
    this.rawRequest,
    this.transactionIds,
    this.localPrevouts,
    this.totalFee,
    this.transactions,
  );
  final Map<String, dynamic> rawRequest;
  final List<String> transactionIds;
  final Map<String, dynamic> localPrevouts;
  final String totalFee;
  final List<Map<String, dynamic>> transactions;

  factory ReviewedRawPlan.fromMaterial(Map material) {
    final request = material['request'] as Map;
    final local = <String, dynamic>{},
        raws = <String>[],
        amounts = <List<int>>[],
        scripts = <List<String>>[];
    if (material['format'] == 'raw') {
      raws.addAll((request['txraws'] as List).cast<String>());
      amounts.addAll(
        (request['utxos_satoshis'] as List).map((v) => (v as List).cast<int>()),
      );
      scripts.addAll(
        (request['script_pubkeys'] as List).map(
          (v) => (v as List).cast<String>(),
        ),
      );
    } else {
      need(material['format'] == 'associated', 'REVIEWED_FORMAT');
      raws.add(request['sourceTxraw']);
      final source = inspectTransaction(raws[0]),
          sourceInputs = request['sourceUtxos'] as List;
      need(
        sourceInputs.length == (source['inputs'] as List).length,
        'REVIEWED_SOURCE_MATRIX',
      );
      amounts.add([]);
      scripts.add([]);
      for (var i = 0; i < sourceInputs.length; i++) {
        final row = sourceInputs[i], point = source['inputs'][i];
        need(
          row['txId'] == point['txid'] &&
              row['outputIndex'] == point['vout'] &&
              row['satoshis'] is int &&
              row['script'] is String,
          'REVIEWED_SOURCE_OUTPOINT',
        );
        amounts[0].add(row['satoshis']);
        scripts[0].add(row['script']);
      }
      final rows = request['inputs'] as List,
          outputRows = request['outputs'] as List;
      need(rows.length == outputRows.length, 'REVIEWED_CHILD_MATRIX');
      for (var t = 0; t < rows.length; t++) {
        final previous = inspectTransaction(raws.last),
            outputs = previous['outputs'] as List;
        final points = <Map<String, dynamic>>[],
            money = <int>[],
            locks = <String>[];
        var lock = 0, hasRefund = false;
        for (final row in rows[t] as List) {
          final vout = row['outputIndex'] as int,
              isLocal = !row.containsKey('txId'),
              profile = row['scriptSigType'];
          need(!isLocal || vout < outputs.length, 'REVIEWED_LOCAL_OUTPOINT');
          var required = 0,
              sequence =
                  profile == 'tbc20-stablecoin' ? 0xfffffffe : 0xffffffff;
          if (profile == 'tbc20-stablecoin') {
            final parent =
                isLocal
                    ? previous
                    : inspectTransaction(row['preTx'], row['txId']);
            required = _coinLock(parent, vout);
          } else if (profile == 'other') {
            final script =
                isLocal ? outputs[vout]['scriptPubKey'] : row['script'];
            final refund =
                script is String
                    ? associatedHtlcRefundLock(
                      script,
                      row['unfinishedScriptSig'],
                    )
                    : null;
            if (refund != null) {
              if (!isLocal) {
                final parent = inspectTransaction(row['preTx'], row['txId']),
                    parentOutputs = parent['outputs'] as List;
                need(
                  vout < parentOutputs.length &&
                      parentOutputs[vout]['scriptPubKey'] == script &&
                      parentOutputs[vout]['satoshis'] == '${row['satoshis']}',
                  'REVIEWED_HTLC_PARENT',
                );
              }
              required = refund;
              sequence = 0xfffffffe;
              hasRefund = true;
            }
          }
          need(
            lock == 0 ||
                required == 0 ||
                (lock < 500000000) == (required < 500000000),
            'REVIEWED_LOCK_DOMAIN',
          );
          if (required > lock) lock = required;
          need(!hasRefund || lock <= 0x7fffffff, 'REVIEWED_LOCK_RANGE');
          if (isLocal) {
            need(
              (!row.containsKey('satoshis') ||
                      '${row['satoshis']}' == outputs[vout]['satoshis']) &&
                  (!row.containsKey('script') ||
                      row['script'] == outputs[vout]['scriptPubKey']),
              'REVIEWED_LOCAL_MATERIAL_MISMATCH',
            );
            for (var i = 0; i < outputs.length; i++)
              local['${previous['txid']}:$i'] = {
                'txid': previous['txid'],
                'index': '$i',
                'spent': false,
                'value': outputs[i]['satoshis'],
                'scriptPubKey': outputs[i]['scriptPubKey'],
              };
          }
          points.add({
            'txid': isLocal ? previous['txid'] : hash32(row['txId']),
            'vout': vout,
            'sequence': sequence,
          });
          money.add(
            isLocal
                ? _amount(outputs[vout]['satoshis'])
                : row['satoshis'] as int,
          );
          locks.add(
            isLocal ? outputs[vout]['scriptPubKey'] : row['script'] as String,
          );
        }
        raws.add(_unsigned(points, outputRows[t], lock));
        amounts.add(money);
        scripts.add(locks);
      }
    }
    need(raws.isNotEmpty && raws.length <= 32, 'REVIEWED_TRANSACTION_BOUND');
    final ids = <String>[], parsedTransactions = <Map<String, dynamic>>[];
    var fee = BigInt.zero;
    for (var i = 0; i < raws.length; i++) {
      final tx = inspectTransaction(raws[i]);
      parsedTransactions.add(frozen(tx) as Map<String, dynamic>);
      ids.add(tx['txid']);
      need(
        (tx['inputs'] as List).length == amounts[i].length &&
            amounts[i].length == scripts[i].length,
        'REVIEWED_INPUT_MATRIX',
      );
      final difference =
          amounts[i].fold(BigInt.zero, (sum, v) => sum + BigInt.from(v)) -
          (tx['outputs'] as List).fold(
            BigInt.zero,
            (sum, v) => sum + BigInt.parse(v['satoshis']),
          );
      need(difference >= BigInt.zero, 'REVIEWED_NEGATIVE_FEE');
      fee += difference;
    }
    return ReviewedRawPlan._(
      frozen({
            'txraws': raws,
            'utxos_satoshis': amounts,
            'script_pubkeys': scripts,
          })
          as Map<String, dynamic>,
      List.unmodifiable(ids),
      frozen(local) as Map<String, dynamic>,
      '$fee',
      List.unmodifiable(parsedTransactions),
    );
  }
}
