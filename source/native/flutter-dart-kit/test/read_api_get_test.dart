import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/wallet.dart';
import 'package:tbc_kit_flutter_dart/src/internal/read_api.dart';

// Exercise the actual read transport with a controlled HttpClient, not the live
// network. Production continues to require a configured exact HTTPS origin.
final class _Client implements HttpClient {
  final calls = <Map<String, Object>>[];
  final requests = <_Request>[];
  int responseStatus = 200;
  bool closed = false;
  @override
  Duration? connectionTimeout;
  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async {
    calls.add({'method': method, 'url': url.toString()});
    final request = _Request(responseStatus);
    requests.add(request);
    return request;
  }

  @override
  void close({bool force = false}) => closed = true;
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final class _Request implements HttpClientRequest {
  _Request(this.status);
  final int status;
  @override
  bool followRedirects = true;
  @override
  Future<HttpClientResponse> close() async => _Response(status);
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final class _Response extends Stream<List<int>> implements HttpClientResponse {
  _Response(this.statusCode);
  @override
  final int statusCode;
  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int>)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => Stream.value(
    utf8.encode('{"code":200,"data":{"controlled":true}}'),
  ).listen(
    onData,
    onError: onError,
    onDone: onDone,
    cancelOnError: cancelOnError,
  );
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  final paths = [
    '/api/tbc/balance/address/1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
    '/api/tbc/utxo/address/1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH?after=a%2B%2F%3D',
    '/api/tbc/ft/utxo/combinescript/${'ab' * 21}/contract/${'ab' * 32}?target=9007199254740993&limit=128',
    '/api/tbc/ft/info/contract/${'ab' * 32}',
    '/api/tbc/ft/decode/txid/${'cd' * 32}',
    '/api/tbc/stablecoin/decode/txid/${'ef' * 32}',
  ];
  test('UTXO query validation rejects before HTTP', () async {
    final client = _Client();
    await HttpOverrides.runZoned(() async {
      final api = TbcReadApi(
        TbcNetworkConfiguration.official(TbcNetwork.testnet),
      );
      try {
        const p = '/api/tbc/utxo/address/1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
        for (final path in [
          '$p?limit=1001',
          '$p?target=0',
          '$p?target=1.5',
          '$p?after=',
          '$p?after=a&after=b',
          '$p?evil=x',
          '$p?after=a#bad',
          '/api/tbc/nodeinfo?after=a',
          '/api/tbc/balance/address/1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH?limit=1',
        ]) {
          await expectLater(api.get(path), throwsStateError);
        }
        expect(client.calls, isEmpty);
      } finally {
        api.close();
      }
    }, createHttpClient: (_) => client);
  });
  test(
    'Reviewed GETs use exact configured mainnet or testnet source once',
    () async {
      for (final config in [
        TbcNetworkConfiguration.official(TbcNetwork.mainnet),
        TbcNetworkConfiguration.official(TbcNetwork.testnet),
        TbcNetworkConfiguration.trustedCustom(
          network: TbcNetwork.testnet,
          apiOrigin: 'https://partner-api.example',
          trustId: 'partner-test',
        ),
      ]) {
        final client = _Client();
        await HttpOverrides.runZoned(() async {
          final api = TbcReadApi(config);
          try {
            for (final path in paths) {
              expect(await api.get(path), {'controlled': true});
            }
            expect(client.calls, [
              for (final path in paths)
                {'method': 'GET', 'url': '${config.apiOrigin}$path'},
            ]);
            expect(client.requests.every((r) => !r.followRedirects), isTrue);
          } finally {
            api.close();
          }
        }, createHttpClient: (_) => client);
        expect(client.closed, isTrue);
      }
    },
  );
  test(
    'Reviewed endpoint additions do not allow query, mutation or path escape',
    () async {
      final client = _Client();
      await HttpOverrides.runZoned(() async {
        final api = TbcReadApi(
          TbcNetworkConfiguration.official(TbcNetwork.testnet),
        );
        try {
          for (final path in [
            ...paths.map((p) => '${p.split('?').first}?network=mainnet'),
            ...paths.map((p) => '${p.split('?').first}/../broadcast'),
            '/api/tbc/ft/mint/contract/${'ab' * 32}',
            '/api/tbc/stablecoin/freeze/txid/${'ef' * 32}',
            '/api/tbc/ft/info/contract/${'AB' * 32}',
            '/api/tbc/ft/decode/txid/not-a-hash',
          ]) {
            await expectLater(api.get(path), throwsStateError);
          }
          expect(client.calls, isEmpty);
        } finally {
          api.close();
        }
      }, createHttpClient: (_) => client);
    },
  );
  test(
    'Reviewed HTTP failure never retries or falls back to another source',
    () async {
      final client = _Client()..responseStatus = 302;
      await HttpOverrides.runZoned(() async {
        final api = TbcReadApi(
          TbcNetworkConfiguration.official(TbcNetwork.testnet),
        );
        try {
          await expectLater(api.get(paths.first), throwsStateError);
          expect(client.calls, hasLength(1));
          expect(client.requests.single.followRedirects, isFalse);
        } finally {
          api.close();
        }
      }, createHttpClient: (_) => client);
    },
  );
}
