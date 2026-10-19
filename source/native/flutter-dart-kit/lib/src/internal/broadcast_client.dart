// Internal REST codec, shared by all wallet send operations. Transport is an
// explicitly supplied native-authorized adapter; there is no default HTTP or
// page-facing raw send path. No retries, fallback sources or implicit polling.
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import '../configuration.dart';
import 'broadcast_port.dart';
import 'protocol_codec.dart';
import 'transaction_read.dart';

final class BroadcastWireRequest {
  BroadcastWireRequest._(this.sourceIdentity, this.method, this.url, this.body)
    : deadline = DateTime.now().toUtc().add(const Duration(seconds: 15));
  final String sourceIdentity, method, url;
  final String? body;
  final DateTime deadline;
  bool get followRedirects => false;
  bool get retry => false;
  int get maximumResponseBytes => 4 * 1024 * 1024;
}

final class BroadcastWireResponse {
  BroadcastWireResponse({required this.statusCode, required List<int> bytes}) {
    if (bytes.length > 4 * 1024 * 1024) {
      throw const BroadcastNodeFailure('NODE_RESPONSE_INVALID');
    }
    body = Uint8List.fromList(bytes).asUnmodifiableView();
  }
  final int statusCode;
  late final Uint8List body;
}

/// Implementations must bind the wallet-configured network/source and, for
/// POST, the exact native-authorized operation, finalized bytes and durable
/// dispatch permit. Recheck cancellation/account/grant/expiry immediately at
/// network dispatch. Enforce response limit while streaming, the deadline and
/// no redirect/retry. An HTTP failure is NOT proof of non-submission.
abstract interface class BroadcastWireTransport {
  String get sourceIdentity;
  Future<BroadcastWireResponse> send(BroadcastWireRequest request);
}

final class TbcNodeBroadcastClient implements BroadcastClient {
  TbcNodeBroadcastClient(this.network, this.transport)
    : sourceIdentity = broadcastSourceIdentity(network) {
    need(
      transport.sourceIdentity == sourceIdentity,
      'BROADCAST_SOURCE_MISMATCH',
    );
  }
  final TbcNetworkConfiguration network;
  final BroadcastWireTransport transport;
  @override
  final String sourceIdentity;

  Never _invalid() => throw const BroadcastNodeFailure('NODE_RESPONSE_INVALID');
  String _raw(String raw) {
    if (raw.length > 4 * 1024 * 1024 ||
        !RegExp(r'^(?:[0-9a-f]{2})+$').hasMatch(raw))
      _invalid();
    return raw;
  }

  String _txid(String raw) {
    try {
      return inspectTransaction(_raw(raw))['txid'] as String;
    } catch (_) {
      return _invalid();
    }
  }

  String _hash(Object? value) {
    if (value is! String || !RegExp(r'^[0-9a-f]{64}$').hasMatch(value))
      _invalid();
    return value;
  }

  // Local-only default preflight, as in frozen Kit. Engine/approval/material
  // validation belongs before this client. Never add a network simulation here.
  @override
  Future<void> preflight(String raw) async {
    _raw(raw);
  }

  Future<Map<String, dynamic>?> _data(
    String method,
    String path, {
    Object? body,
    bool allowNotFound = false,
    bool batch = false,
  }) async {
    final request = BroadcastWireRequest._(
      sourceIdentity,
      method,
      '${network.apiOrigin}$path',
      body == null ? null : jsonEncode(body),
    );
    BroadcastWireResponse response;
    try {
      response = await transport
          .send(request)
          .timeout(const Duration(seconds: 15));
    } on BroadcastNodeFailure {
      rethrow;
    } catch (_) {
      throw const BroadcastNodeFailure('NODE_REQUEST_FAILED');
    }
    if (response.statusCode == 404 && allowNotFound) return null;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw const BroadcastNodeFailure('NODE_REQUEST_FAILED');
    }
    Object? decoded;
    try {
      decoded = _losslessIntegers(utf8.decode(response.body));
    } catch (_) {
      return _invalid();
    }
    if (decoded is! Map<String, dynamic>) _invalid();
    final envelope = decoded, code = '${decoded['code']}';
    if (code == '404' && allowNotFound) return null;
    final partial =
        batch &&
        code == '400' &&
        envelope['message'] is String &&
        (envelope['message'] as String).toLowerCase().contains(
          'partial failure',
        );
    if (code != '200' && !partial) {
      throw const BroadcastNodeFailure('NODE_REQUEST_FAILED');
    }
    if (envelope['data'] is! Map<String, dynamic>) _invalid();
    return envelope['data'] as Map<String, dynamic>;
  }

  @override
  Future<Map<String, dynamic>> submit(String raw) async {
    final id = _txid(raw);
    final data = await _data(
      'POST',
      '/api/tbc/broadcasttx',
      body: {'txraw': raw},
    );
    if (data == null || _hash(data['txid']) != id) _invalid();
    return Map.unmodifiable({'txid': id});
  }

  @override
  Future<List<Map<String, dynamic>>> submitBatch(
    List<String> rawTransactions,
  ) async {
    if (rawTransactions.isEmpty || rawTransactions.length > 32) {
      throw const BroadcastNodeFailure('INVALID_INPUT');
    }
    // Capture before the first await; caller mutation cannot replace a tx after
    // its local ID was checked. No extra chain-data GETs are needed.
    final raws = List<String>.unmodifiable(rawTransactions),
        ids = raws.map(_txid).toList();
    if (ids.toSet().length != ids.length)
      throw const BroadcastNodeFailure('INVALID_INPUT');
    final data = await _data(
      'POST',
      '/api/tbc/broadcasttxs',
      body: [
        for (final raw in raws) {'txraw': raw},
      ],
      batch: true,
    );
    int count(Object? value) {
      if (value is! String || !RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(value))
        _invalid();
      final parsed = BigInt.parse(value);
      if (parsed > BigInt.from(9007199254740991)) _invalid();
      return parsed.toInt();
    }

    if (data == null ||
        count(data['success']) + count(data['failed']) > raws.length)
      _invalid();
    final items = data['results'];
    if (data.containsKey('results') &&
        (items is! List || items.length > raws.length))
      _invalid();
    return List.unmodifiable([
      for (var i = 0; i < ids.length; i++)
        Map<String, dynamic>.unmodifiable(
          _batchItem(
            ids[i],
            items is List && i < items.length ? items[i] : null,
          ),
        ),
    ]);
  }

  Map<String, dynamic> _batchItem(String id, Object? item) {
    String shortened(String text) =>
        text.length <= 512 ? text : text.substring(0, 512);
    if (item is String)
      return item == id
          ? {'txid': id, 'status': 'accepted'}
          : {
            'txid': id,
            'status': 'rejected',
            'reason':
                item.isEmpty ? 'TBC batch item rejected' : shortened(item),
          };
    if (item is Map) {
      if (item['txid'] == id && !item.containsKey('error'))
        return {'txid': id, 'status': 'accepted'};
      if (item['error'] is String && (item['error'] as String).isNotEmpty)
        return {
          'txid': id,
          'status': 'rejected',
          'reason': shortened(item['error']),
        };
    }
    return {
      'txid': id,
      'status': 'unknown',
      'reason': 'TBC batch response omitted this transaction result',
    };
  }

  @override
  Future<Map<String, dynamic>> status(String txid) async {
    try {
      _hash(txid);
    } catch (_) {
      throw const BroadcastNodeFailure('INVALID_INPUT');
    }
    final data = await _data(
      'GET',
      '/api/tbc/decode/txid/$txid',
      allowNotFound: true,
    );
    if (data == null)
      return Map.unmodifiable({'txid': txid, 'status': 'unknown'});
    if (data['txid'] != txid) _invalid();
    String confirmations;
    try {
      final value = data['confirmations'];
      confirmations = uintString(
        value is double &&
                value.isFinite &&
                value.truncateToDouble() == value &&
                value.abs() <= 9007199254740991
            ? value.toInt()
            : value,
      );
    } catch (_) {
      return _invalid();
    }
    return Map.unmodifiable({
      'txid': txid,
      'status':
          BigInt.parse(confirmations) > BigInt.zero ? 'confirmed' : 'mempool',
      'confirmations': confirmations,
    });
  }
}

// REST integers are decimal strings, including numbers beyond JS's safe range.
// Scan only outside quoted strings, then let the JSON decoder validate syntax.
// Decimal/exponent tokens stay numbers; consumers apply their integer policy.
Object? _losslessIntegers(String text) {
  final out = StringBuffer(),
      number = RegExp(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?');
  var quoted = false, escaped = false;
  for (var i = 0; i < text.length; i++) {
    final c = text[i];
    if (quoted) {
      out.write(c);
      if (escaped) {
        escaped = false;
      } else if (c == '\\') {
        escaped = true;
      } else if (c == '"') {
        quoted = false;
      }
    } else if (c == '"') {
      quoted = true;
      out.write(c);
    } else if (c == '-' || (c.codeUnitAt(0) >= 48 && c.codeUnitAt(0) <= 57)) {
      final match = number.matchAsPrefix(text, i);
      if (match == null) throw const FormatException('Invalid numeric token');
      final token = match.group(0)!;
      out.write(token.contains(RegExp(r'[.eE]')) ? token : '"$token"');
      i = match.end - 1;
    } else {
      out.write(c);
    }
  }
  return jsonDecode(out.toString());
}
