// Network-bound read transport. The sole POST is read-only TXO status, never
// broadcast. No retries, redirects or fallback to another network endpoint.
import 'dart:convert';
import 'dart:io';
import '../configuration.dart';
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'txo_status_reply.dart';
import 'txo_status_batches.dart';

final class TbcReadApi {
  TbcReadApi(this.network);
  final TbcNetworkConfiguration network;
  final HttpClient _client =
      HttpClient()..connectionTimeout = const Duration(seconds: 20);
  bool _closed = false;

  /// Public informational queries. Kept separate from transaction material's
  /// allowlist; adding a query never changes the executor's read plan.
  Future<Map<String, dynamic>> getPublic(String path) async {
    need(!_closed, 'READ_SOURCE_CLOSED');
    if (RegExp(
      r'^/api/tbc/(?:ft/tokenlist/address/[1-9A-HJ-NP-Za-km-z]+|ft/tokenbalance/address/[1-9A-HJ-NP-Za-km-z]+/contract/[0-9a-f]{64}|stablecoin/stablecoinlist/address/[1-9A-HJ-NP-Za-km-z]+|stablecoin/tokenbalance/address/[1-9A-HJ-NP-Za-km-z]+/stablecoinid/[0-9a-f]{64}|nft/(?:collectioninfo/collectionid|nftinfo/nftid)/[0-9a-f]{64})$',
    ).hasMatch(path)) {
      return _send('GET', path);
    }
    return get(path);
  }

  Future<Map<String, dynamic>> get(String path) async {
    need(!_closed, 'READ_SOURCE_CLOSED');
    final route = path.split('?').first, uri = Uri.parse(path);
    need(!uri.hasFragment, 'READ_ENDPOINT');
    need(
      RegExp(
        r'^/api/tbc/(?:nodeinfo|frozenUtxo/address/[1-9A-HJ-NP-Za-km-z]+/piggyBank|(?:utxo|balance)/address/[1-9A-HJ-NP-Za-km-z]+|(?:nft/)?utxo/scriptpubkeyhash/[0-9a-f]{64}|pool/(?:poolinfo/poolid|lputxo/scriptpubkeyhash)/[0-9a-f]{64}|ft/(?:utxo/combinescript/[0-9a-f]{42}/contract|info/contract|decode/txid)/[0-9a-f]{64}|stablecoin/(?:utxo/combinescript/[0-9a-f]{42}/stablecoinid|info/stablecoinid|decode/txid)/[0-9a-f]{64}|(?:txraw|decode)/txid/[0-9a-f]{64})$',
      ).hasMatch(route),
      'READ_ENDPOINT',
    );
    if (uri.hasQuery) {
      need(
        RegExp(
          r'^/api/tbc/(?:utxo/(?:address/[1-9A-HJ-NP-Za-km-z]+|scriptpubkeyhash/[0-9a-f]{64})|ft/utxo/combinescript/[0-9a-f]{42}/contract/[0-9a-f]{64}|pool/lputxo/scriptpubkeyhash/[0-9a-f]{64})$',
        ).hasMatch(route),
        'READ_QUERY_ENDPOINT',
      );
      final query = uri.queryParametersAll;
      need(
        query.isNotEmpty &&
            query.keys.every((k) => ['limit', 'after', 'target'].contains(k)) &&
            query.values.every((v) => v.length == 1),
        'READ_QUERY',
      );
      for (final entry in query.entries) {
        final v = entry.value.single;
        if (entry.key == 'after') {
          need(v.isNotEmpty && v.length <= 2048, 'READ_CURSOR');
        } else {
          need(
            RegExp(r'^[1-9][0-9]*$').hasMatch(v) && v.length <= 39,
            'READ_QUERY_AMOUNT',
          );
          if (entry.key == 'limit')
            need(BigInt.parse(v) <= BigInt.from(1000), 'READ_LIMIT');
        }
      }
    }
    return _send('GET', path);
  }

  Future<Map<String, dynamic>> txoStatus(
    List<Map<String, dynamic>> txos,
  ) async {
    // Match the frozen shared reviewer's batched-input bound. Ordinary asset
    // requests retain their own smaller selection limits; no extra request or
    // read is added. Redirect, response-byte and exact-outpoint checks remain.
    need(
      !_closed && txos.isNotEmpty && txos.length <= 10000,
      'TXO_STATUS_BOUND',
    );
    final seen = <String>{};
    for (final p in txos) {
      need(
        p.length == 2 &&
            p['index'] is int &&
            p['index'] >= 0 &&
            p['index'] <= 0xffffffff,
        'TXO_STATUS_POINT',
      );
      need(
        seen.add('${hash32(p['txid'])}:${p['index']}'),
        'TXO_STATUS_DUPLICATE',
      );
    }
    if (txos.length > 25) return readTxoStatusBatches(txoStatus, txos);
    return normalizeTxoStatusReply(
      await _send('POST', '/api/tbc/txo/status', jsonEncode({'txos': txos})),
    );
  }

  Future<Map<String, dynamic>> _send(
    String method,
    String path, [
    String? body,
  ]) async {
    final request = await _client.openUrl(
      method,
      Uri.parse('${network.apiOrigin}$path'),
    );
    // HttpClient may commit headers as soon as the body is written. Configure
    // the redirect boundary before writing, for POST as well as GET.
    request.followRedirects = false;
    if (body != null) {
      request.headers.contentType = ContentType.json;
      request.write(body);
    }
    final response = await request.close().timeout(const Duration(seconds: 20));
    final bytes = <int>[];
    await for (final chunk in response.timeout(const Duration(seconds: 20))) {
      need(
        bytes.length + chunk.length <= 4 * 1024 * 1024,
        'API_RESPONSE_BOUND',
      );
      bytes.addAll(chunk);
    }
    need(!_closed && response.statusCode == 200, 'API_HTTP_REJECTED');
    final envelope = jsonDecode(utf8.decode(bytes));
    need(
      envelope is Map &&
          '${envelope['code']}' == '200' &&
          envelope['data'] is Map,
      'API_ENVELOPE',
    );
    return Map<String, dynamic>.from(envelope['data'] as Map);
  }

  void close() {
    _closed = true;
    _client.close(force: true);
  }
}
