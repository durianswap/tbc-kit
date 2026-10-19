import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'provider_session_test.dart' as provider;
import 'support/signing_replay.dart' as replay;

void main() {
  final samples =
      (jsonDecode(
                File('test/fixtures/reviewed-signing.json').readAsStringSync(),
              )['cases']
              as List)
          .map((v) => copied(v as Map))
          .toList();
  Map source(Map s) => (jsonDecode(
            File('test/fixtures/${s['source']['file']}').readAsStringSync(),
          )['cases']
          as List)
      .singleWhere((v) => v['name'] == s['source']['name']);
  setUpAll(replay.loadReplay);
  Future<provider.SessionHarness> open(Map<String, dynamic> s) async {
    final h = provider.SessionHarness(), material = source(s);
    h.signing.backend.reviewedSample = s;
    h.signing.backend.reviewedSource = copied(material);
    h.signing.customRead = (p) async {
      expect(
        (material['replies'] as Map?)?.containsKey(p),
        true,
        reason: 'No extra GET',
      );
      return copied(material['replies'][p]);
    };
    h.signing.customStatus =
        (points) async => {
          'txos': [
            for (final p in points)
              copied(
                (material['statuses'] as List).singleWhere(
                  (u) =>
                      u['txid'] == p['txid'] && u['index'] == '${p['index']}',
                ),
              ),
          ],
        };
    await h.start(defaultPolicy: true);
    addTearDown(h.close);
    return h;
  }

  for (final s in samples) {
    test(
      'Reviewed Provider ${s['name']} one approval and exact frozen result without stage reads',
      () async {
        final h = await open(s);
        await h.grant();
        final writes = h.control.writes;
        await h.request('cap', 'tbc_getCapabilities', {});
        expect(
          (h.response('cap')['result']['methods'] as Map).containsKey(
            'tbc_signReviewedTransaction',
          ),
          true,
        );
        expect(h.control.grants.contains('tbc_signReviewedTransaction'), false);
        await h.request(
          'reviewed',
          'tbc_signReviewedTransaction',
          s['request'],
        );
        expect(h.response('reviewed')['error'], isNull);
        final actual = copied(h.response('reviewed')['result']);
        actual['approvalId'] = s['result']['approvalId'];
        expect(canonical(actual), canonical(s['result']));
        final op = h.signing.backend.operations.single,
            rows = source(s)['stages'] as List;
        expect(
          [op.consents, op.binds, op.closes, op.advances],
          [1, 1, 1, rows.length - 1],
        );
        expect(
          op.signs,
          rows.fold<int>(0, (n, r) => n + (r['signatures'] as List).length),
        );
        expect(h.signing.paths.toSet().length, h.signing.paths.length);
        final trace =
            source(s)['statusQueries'] ??
            (source(s)['reads'] as List)
                .where((r) => r['path'] == '/api/tbc/txo/status')
                .toList();
        expect(h.signing.statusReads, (trace as List).length);
        expect(h.control.writes, writes);
        expect(op.intent!.review, isNotNull);
      },
    );
  }
  test(
    'Reviewed requires transaction grant, not message or invented grant',
    () async {
      final h = await open(samples.first);
      await h.request('grant', 'wallet_requestPermissions', [
        {
          for (final name in ['tbc_accounts', 'tbc_signMessage'])
            name: {
              'chains': ['tbc:testnet'],
            },
        },
      ]);
      await h.request(
        'denied',
        'tbc_signReviewedTransaction',
        samples.first['request'],
      );
      expect(h.response('denied')['error']['code'], 4100);
      expect(h.signing.backend.begins, 0);
      await h.request('invented', 'wallet_requestPermissions', [
        {
          'tbc_signReviewedTransaction': {
            'chains': ['tbc:testnet'],
          },
        },
      ]);
      expect(h.response('invented')['error']['code'], 4200);
      expect(h.signing.statusReads, 0);
      expect(h.signing.paths, isEmpty);
    },
  );
  test('Reviewed rejection performs no binding or signature', () async {
    final h = await open(samples.first);
    await h.grant();
    h.signing.backend.approve = false;
    await h.request(
      'no',
      'tbc_signReviewedTransaction',
      samples.first['request'],
    );
    expect(h.response('no')['error']['code'], 4001);
    final op = h.signing.backend.operations.single;
    expect([op.consents, op.binds, op.signs, op.closes], [1, 0, 0, 1]);
  });
  test(
    'Reviewed grant loss during consent cannot sign or deliver success',
    () async {
      final h = await open(samples[2]);
      await h.grant();
      h.signing.backend.consentEntered = Completer<void>();
      h.signing.backend.holdConsent = Completer<void>();
      final future = h.request(
        'pending',
        'tbc_signReviewedTransaction',
        samples[2]['request'],
      );
      await h.signing.backend.consentEntered!.future;
      await h.request('bye', 'tbc_disconnect');
      h.signing.backend.holdConsent!.complete();
      await future;
      expect(h.signing.backend.operations.single.signs, 0);
      expect(h.response('pending')['result'], isNull);
    },
  );
  test(
    'Reviewed rejects caller preview and cross-network before sign',
    () async {
      final h = await open(samples.first);
      await h.grant();
      await h.request('chain', 'tbc_signReviewedTransaction', {
        ...samples.first['request'],
        'chainId': 'tbc:mainnet',
      });
      expect(h.response('chain')['error']['code'], 4100);
      expect(h.signing.backend.begins, 0);
      await h.request('preview', 'tbc_signReviewedTransaction', {
        ...samples.first['request'],
        'preview': {'totalFee': '0'},
      });
      expect(h.response('preview')['result'], isNull);
      expect(h.signing.backend.operations.single.signs, 0);
      expect(h.signing.statusReads, 0);
    },
  );
}
