// Synthetic transport: zero sockets, private accounts, signatures or broadcasts.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/configuration.dart';
import 'package:tbc_kit_flutter_dart/src/internal/broadcast_client.dart';
import 'package:tbc_kit_flutter_dart/src/internal/broadcast_port.dart';
import 'broadcast_port_test.dart' as state;

final class Wire implements BroadcastWireTransport {
  Wire(this.sourceIdentity, this.response);
  @override
  final String sourceIdentity;
  Map response;
  final trace = <Map<String, dynamic>>[], requests = <BroadcastWireRequest>[];
  bool fail = false;
  Completer<void>? entered, release;
  @override
  Future<BroadcastWireResponse> send(BroadcastWireRequest request) async {
    expect(request.sourceIdentity, sourceIdentity);
    expect(request.followRedirects, isFalse);
    expect(request.retry, isFalse);
    expect(request.maximumResponseBytes, 4 * 1024 * 1024);
    expect(request.deadline.isAfter(DateTime.now().toUtc()), isTrue);
    requests.add(request);
    trace.add({
      'url': request.url,
      'method': request.method,
      'redirect': 'error',
      'body': request.body == null ? null : jsonDecode(request.body!),
    });
    entered?.complete();
    await release?.future;
    if (fail)
      throw StateError(
        'Synthetic wire failure MUST NOT leak secret-looking content',
      );
    return BroadcastWireResponse(
      statusCode: response['http'],
      bytes: utf8.encode(response['body']),
    );
  }
}

TbcNetworkConfiguration config(Map options) {
  final network = TbcNetwork.values.byName(options['network']);
  final endpoint = options['endpoint'];
  return endpoint == null
      ? TbcNetworkConfiguration.official(network)
      : TbcNetworkConfiguration.trustedCustom(
        network: network,
        apiOrigin: endpoint['apiOrigin'],
        trustId: endpoint['trustId'],
      );
}

void main() {
  final bytes = File('test/fixtures/broadcast-client.json').readAsBytesSync();
  if (sha256.convert(bytes).toString() !=
      '77a837d28f587f3d6f476cc1a4b48c2e1704424913de56b589d63eab1fff6f07') {
    throw StateError('Frozen wire oracle changed');
  }
  final oracle = jsonDecode(utf8.decode(bytes)) as Map,
      cases = oracle['cases'] as List;
  for (final sample in cases) {
    test('frozen REST client ${sample['name']}', () async {
      final network = config(sample['options']),
          wire = Wire(broadcastSourceIdentity(network), sample['response']);
      final client = TbcNodeBroadcastClient(network, wire);
      Map result;
      try {
        Object? value;
        switch (sample['kind']) {
          case 'single':
            value = await client.submit(sample['input']);
          case 'batch':
            value = await client.submitBatch(
              (sample['input'] as List).cast<String>(),
            );
          case 'status':
            value = await client.status(sample['input']);
          case 'preflight':
            await client.preflight(sample['input']);
        }
        result = {'ok': true, 'value': value};
      } on BroadcastNodeFailure catch (e) {
        result = {'ok': false, 'code': e.code};
      }
      expect(result, sample['result']);
      expect(wire.trace, sample['trace']);
    });
  }
  final single = cases.firstWhere((c) => c['name'] == 'single-success') as Map,
      network = config(single['options']),
      source = broadcastSourceIdentity(network);
  test('wire source mismatch is refused before use', () {
    final wire = Wire('f' * 64, single['response']);
    expect(
      () => TbcNodeBroadcastClient(network, wire),
      throwsA(isA<StateError>()),
    );
    expect(wire.trace, isEmpty);
  });
  test('wire errors are redacted and POST is never retried', () async {
    final wire = Wire(source, single['response'])..fail = true;
    try {
      await TbcNodeBroadcastClient(network, wire).submit(single['input']);
      fail('must fail');
    } on BroadcastNodeFailure catch (e) {
      expect(e.code, 'NODE_REQUEST_FAILED');
      expect(e.toString(), 'Broadcast node failure');
    }
    expect(wire.trace.length, 1);
  });
  test('bounded response is copied and immutable', () {
    final bytes = utf8.encode('{"code":200}'),
        r = BroadcastWireResponse(statusCode: 200, bytes: bytes);
    bytes[0] = 0;
    expect(r.body[0], 123);
    expect(() => r.body[0] = 0, throwsUnsupportedError);
    expect(
      () => BroadcastWireResponse(
        statusCode: 200,
        bytes: List.filled(4 * 1024 * 1024 + 1, 32),
      ),
      throwsA(
        isA<BroadcastNodeFailure>().having(
          (e) => e.code,
          'code',
          'NODE_RESPONSE_INVALID',
        ),
      ),
    );
  });
  test(
    'batch inputs captured before async transport and output immutable',
    () async {
      final s =
          cases.firstWhere((c) => c['name'] == 'batch-accepted-strings') as Map;
      final wire =
          Wire(source, s['response'])
            ..entered = Completer<void>()
            ..release = Completer<void>();
      final raws = (s['input'] as List).cast<String>().toList(),
          expected = List<String>.from(raws);
      final pending = TbcNodeBroadcastClient(network, wire).submitBatch(raws);
      await wire.entered!.future;
      raws.clear();
      wire.release!.complete();
      final result = await pending;
      expect(
        (wire.trace.single['body'] as List).map((v) => v['txraw']),
        expected,
      );
      expect(() => result.clear(), throwsUnsupportedError);
      expect(() => result.first['status'] = 'tampered', throwsUnsupportedError);
    },
  );
  test(
    'status reads do not poll or substitute current tip for missing confirmations',
    () async {
      final s =
              cases.firstWhere(
                    (c) => c['name'] == 'status-missing-confirmations',
                  )
                  as Map,
          wire = Wire(source, s['response']);
      await expectLater(
        TbcNodeBroadcastClient(network, wire).status(s['input']),
        throwsA(isA<BroadcastNodeFailure>()),
      );
      expect(wire.trace.length, 1);
      expect(wire.trace.single['method'], 'GET');
      expect(
        wire.trace.single['url'],
        endsWith('/api/tbc/decode/txid/${s['input']}'),
      );
    },
  );
  test(
    'port and wire unknown submit recovers by one status GET without another POST',
    () async {
      final s =
          jsonDecode(
                File('test/fixtures/broadcast-port.json').readAsStringSync(),
              )['cases'].firstWhere(
                (c) => c['name'] == 'single-unknown-confirmed',
              )
              as Map;
      final wire = Wire(source, single['response'])..fail = true,
          journal = state.MemoryJournal(source),
          client = TbcNodeBroadcastClient(network, wire);
      final port = TbcBroadcastPort(
        network: network,
        client: client,
        journal: journal,
        accountScopeHash: () async => '1' * 64,
        authorize: (_) async {},
      );
      final action = s['actions'][0];
      expect(
        (await port.submit(
          action['params'],
          action['call'],
        ))['portError']['name'],
        'UNAVAILABLE',
      );
      expect(journal.rows.values.single['state'], 'uncertain');
      expect(
        (await port.submit(
          action['params'],
          action['call'],
        ))['portError']['name'],
        'UNAVAILABLE',
      );
      expect(wire.trace.length, 1);
      final status = cases.firstWhere((c) => c['name'] == 'status-confirmed');
      wire.fail = false;
      wire.response = status['response'];
      expect(await port.recover([status['input']]), {
        'transactions': [status['result']['value']],
      });
      expect(journal.rows.values.single['state'], 'completed');
      expect(wire.trace.map((r) => r['method']), ['POST', 'GET']);
    },
  );
  test(
    'port and wire one batch POST preserves unknown child after rejected parent',
    () async {
      final reference = jsonDecode(
            File('test/fixtures/broadcast-port.json').readAsStringSync(),
          )['cases'].firstWhere((c) => c['name'] == 'batch-accepted-replay'),
          action = reference['actions'][0];
      final ids =
              (action['params']['transactions'] as List)
                  .map((t) => t['txid'])
                  .toList(),
          wire = Wire(source, {
            'http': 200,
            'body': jsonEncode({
              'code': 400,
              'message': 'partial failure',
              'data': {
                'success': 1,
                'failed': 1,
                'results': [
                  {'error': 'synthetic parent rejection'},
                  ids[1],
                ],
              },
            }),
          }),
          journal = state.MemoryJournal(source);
      final port = TbcBroadcastPort(
        network: network,
        client: TbcNodeBroadcastClient(network, wire),
        journal: journal,
        accountScopeHash: () async => '1' * 64,
        authorize: (_) async {},
      );
      final result = await port.submitBatch(action['params'], action['call']);
      expect((result['transactions'] as List).map((r) => r['status']), [
        'rejected',
        'unknown',
      ]);
      expect(journal.rows.values.map((r) => r['state']), [
        'completed',
        'uncertain',
      ]);
      await port.submitBatch(action['params'], action['call']);
      expect(wire.trace.length, 1);
      expect(wire.trace.single['url'], endsWith('/api/tbc/broadcasttxs'));
    },
  );
}
