// Read-only port of frozen Kit testnet-validation.ts. Not a builder, signer,
// script VM, UTXO authority or receipt/ancestry verifier.
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:pointycastle/digests/ripemd160.dart';
import 'protocol_codec.dart';

/// Decode is one fresh status observation plus immutable transaction bytes.
/// Use it instead of a raw download when confirmations are required. Callers
/// may retain the parsed raw bytes, but must not retain confirmation freshness.
Future<Map<String, dynamic>> readConfirmedTransaction(
  Future<Map<String, dynamic>> Function(String) read,
  String id, {
  void Function(Map<String, dynamic>)? remember,
}) async {
  hash32(id);
  final value = await read('/api/tbc/decode/txid/$id');
  need(value['txid'] == id, 'DECODE_IDENTITY');
  final parent = inspectTransaction(
    value['hex'] ?? value['rawTransaction'],
    id,
  );
  need(value['confirmations'] != null, 'CONFIRMATIONS_UNKNOWN');
  final confirmations = uintString(value['confirmations']);
  remember?.call(parent);
  return {...parent, 'confirmations': confirmations};
}

String uintString(Object? value) {
  need(value is String || value is int, 'UINT_TYPE');
  if (value is int)
    need(value >= 0 && value <= 9007199254740991, 'UNSAFE_API_INTEGER');
  final result = '$value';
  need(RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(result), 'UINT_ENCODING');
  return result;
}

String hash32(Object? value) {
  need(value is String && RegExp(r'^[0-9a-f]{64}$').hasMatch(value), 'HASH32');
  return value as String;
}

Uint8List _sha(List<int> value) =>
    Uint8List.fromList(sha256.convert(value).bytes);
List<int> _little(BigInt value, int length) {
  need(
    value >= BigInt.zero && value < (BigInt.one << (length * 8)),
    'UINT_OVERFLOW',
  );
  return [
    for (var i = 0; i < length; i++)
      ((value >> (i * 8)) & BigInt.from(255)).toInt(),
  ];
}

final class _Reader {
  _Reader(String raw) : data = unhex(raw) {
    need(data.isNotEmpty && data.length <= 2 * 1024 * 1024, 'TX_BYTES');
  }
  final Uint8List data;
  int offset = 0;
  Uint8List bytes(int n) {
    need(n >= 0 && n <= data.length - offset, 'TX_TRUNCATED');
    final result = Uint8List.sublistView(data, offset, offset + n);
    offset += n;
    return result;
  }

  BigInt uint(int n) {
    var value = BigInt.zero;
    for (final b in bytes(n).reversed) {
      value = (value << 8) | BigInt.from(b);
    }
    return value;
  }

  int size() {
    final tag = bytes(1)[0];
    if (tag < 253) return tag;
    final n =
            tag == 253
                ? 2
                : tag == 254
                ? 4
                : 8,
        value = uint(n);
    final minimum =
        n == 2
            ? BigInt.from(253)
            : n == 4
            ? BigInt.from(65536)
            : BigInt.one << 32;
    need(
      value >= minimum && value <= BigInt.from(data.length),
      'TX_COMPACT_SIZE',
    );
    return value.toInt();
  }

  Uint8List script() {
    final n = size();
    need(n <= 10000, 'TX_SCRIPT_BOUND');
    return bytes(n);
  }
}

/// Only for an Engine-validated unsigned plan. Avoid decoding outputs and
/// hashing the whole transaction again just to detect cross-step double spends.
/// Zero parent IDs are deferred placeholders, not existing spendable outpoints.
Iterable<String> plannedInputOutpoints(String raw) sync* {
  final r = _Reader(raw);
  need(r.uint(4) == BigInt.from(10), 'TX_VERSION');
  final count = r.size();
  need(count > 0 && count <= 10000, 'TX_INPUT_COUNT');
  for (var i = 0; i < count; i++) {
    final id = hex(r.bytes(32).reversed), index = r.uint(4).toInt();
    r.script();
    r.bytes(4);
    if (id != '0' * 64) yield '$id:$index';
  }
}

Map<String, dynamic> inspectTransaction(String raw, [String? expectedId]) {
  final r = _Reader(raw);
  need(r.uint(4) == BigInt.from(10), 'TX_VERSION');
  final inputs = <Map<String, dynamic>>[],
      outputs = <Map<String, dynamic>>[],
      points = <String>{};
  final ni = r.size();
  need(ni > 0 && ni <= 10000, 'TX_INPUT_COUNT');
  for (var i = 0; i < ni; i++) {
    final id = hex(r.bytes(32).reversed), index = r.uint(4).toInt();
    need(points.add('$id:$index'), 'TX_DUPLICATE_INPUT');
    final script = r.script(), sequence = r.uint(4).toInt();
    inputs.add({
      'txid': id,
      'vout': index,
      'scriptSig': hex(script),
      'sequence': sequence,
    });
  }
  final no = r.size();
  need(no > 0 && no <= 10000, 'TX_OUTPUT_COUNT');
  for (var i = 0; i < no; i++) {
    final value = r.uint(8), script = r.script();
    outputs.add({'satoshis': '$value', 'scriptPubKey': hex(script)});
  }
  final locktime = r.uint(4).toInt();
  need(r.offset == r.data.length, 'TX_TRAILING_BYTES');
  final inputHeader = <int>[], unlockHashes = <int>[], outputHeader = <int>[];
  for (final input in inputs) {
    inputHeader.addAll([
      ...unhex(input['txid']).reversed,
      ..._little(BigInt.from(input['vout']), 4),
      ..._little(BigInt.from(input['sequence']), 4),
    ]);
    unlockHashes.addAll(_sha(unhex(input['scriptSig'])));
  }
  for (final output in outputs) {
    outputHeader.addAll([
      ..._little(BigInt.parse(output['satoshis']), 8),
      ..._sha(unhex(output['scriptPubKey'])),
    ]);
  }
  final header = <int>[
    for (final v in [10, locktime, ni, no]) ..._little(BigInt.from(v), 4),
    ..._sha(inputHeader),
    ..._sha(unlockHashes),
    ..._sha(outputHeader),
  ];
  final id = hex(_sha(_sha(header)).reversed);
  need(expectedId == null || id == expectedId, 'TXID_MISMATCH');
  return {
    'txid': id,
    'rawTransaction': raw,
    'inputs': inputs,
    'outputs': outputs,
    'locktime': locktime,
  };
}

String inspectP2pkhAddress(Object? address) {
  need(
    address is String && address.length >= 26 && address.length <= 35,
    'ACCOUNT_ADDRESS',
  );
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  final encoded = address as String;
  var n = BigInt.zero;
  for (final c in encoded.split('')) {
    final i = alphabet.indexOf(c);
    need(i >= 0, 'BASE58');
    n = n * BigInt.from(58) + BigInt.from(i);
  }
  final suffix = <int>[];
  while (n > BigInt.zero) {
    suffix.add((n & BigInt.from(255)).toInt());
    n >>= 8;
  }
  final data = <int>[
    for (var i = 0; i < encoded.length && encoded[i] == '1'; i++) 0,
    ...suffix.reversed,
  ];
  need(
    data.length == 25 &&
        data[0] == 0 &&
        hex(data.sublist(21)) ==
            hex(_sha(_sha(data.sublist(0, 21))).sublist(0, 4)),
    'ADDRESS_CHECKSUM',
  );
  return hex(data.sublist(1, 21));
}

Map<String, String> inspectAccount(
  Map account, {
  required String expectedChainId,
}) {
  final address = account['address'];
  final pkh = inspectP2pkhAddress(address);
  final key = account['publicKey'];
  need(
    key is String && RegExp(r'^0[23][0-9a-f]{64}$').hasMatch(key),
    'PUBLIC_KEY',
  );
  need(
    hex(RIPEMD160Digest().process(_sha(unhex(key)))) == pkh,
    'ACCOUNT_PUBLIC_KEY',
  );
  need(
    {'tbc:mainnet', 'tbc:testnet'}.contains(expectedChainId) &&
        account['chainId'] == expectedChainId &&
        account['accountId'] == '$expectedChainId:$address',
    'ACCOUNT_CHAIN',
  );
  return {'publicKeyHash': pkh, 'scriptPubKey': '76a914${pkh}88ac'};
}

// Read hints only. Full identity/lineage verification remains in Rust Engine.
List<String> legacyFtReferences(Map parent, int index) {
  final outputs = parent['outputs'] as List, inputs = parent['inputs'] as List;
  need(index >= 0 && index + 1 < outputs.length, 'FT_PAIR');
  final tape = outputs[index + 1] as Map, b = unhex(tape['scriptPubKey']);
  need(
    tape['satoshis'] == '0' &&
        b.length >= 56 &&
        hex(b.sublist(0, 3)) == '006a30' &&
        hex(b.sublist(b.length - 5)) == '4654617065',
    'FT_TAPE',
  );
  final refs = <String>[];
  for (var i = 5; i >= 0; i--) {
    if (b.sublist(3 + i * 8, 11 + i * 8).every((v) => v == 0)) continue;
    need(i < inputs.length, 'FT_SOURCE_INPUT');
    refs.add(inputs[i]['txid'] as String);
  }
  need(refs.isNotEmpty, 'FT_NO_REFERENCE');
  return refs;
}

List<String> tbc20References(Map parent, int index) {
  final outputs = parent['outputs'] as List, inputs = parent['inputs'] as List;
  need(
    inputs.isNotEmpty &&
        inputs.length <= 6 &&
        index >= 0 &&
        index + 1 < outputs.length,
    'TBC20_PAIR',
  );
  final code = outputs[index] as Map,
      tape = outputs[index + 1] as Map,
      b = unhex(tape['scriptPubKey']);
  need(
    code['satoshis'] == '500' &&
        tape['satoshis'] == '0' &&
        b.length >= 61 &&
        b.length <= 127 &&
        hex(b.sublist(0, 3)) == '006a30' &&
        hex(b.sublist(b.length - 9)) == '544243323054415045',
    'TBC20_TAPE',
  );
  final refs = <String>[];
  for (var i = 5; i >= 0; i--) {
    final slot = b.sublist(3 + i * 8, 11 + i * 8);
    need(slot[7] < 128, 'TBC20_SLOT');
    if (slot.every((v) => v == 0)) continue;
    need(i < inputs.length, 'TBC20_SOURCE_INPUT');
    refs.add(inputs[i]['txid'] as String);
  }
  need(refs.isNotEmpty, 'TBC20_NO_REFERENCE');
  return refs;
}
