import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart'
    show tbcProtocolTimestamp;
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_session.dart';
import 'provider_session_test.dart' as provider;
import 'support/signing_replay.dart' as replay;

Map<String, dynamic> fresh(Map sample) {
  final s = copied(sample), p = s['request']['proposal']['payload'];
  final now = tbcProtocolTimestamp(DateTime.now());
  p['createdAt'] = now;
  p['evidence']['observedAt'] = now;
  p['expiresAt'] = tbcProtocolTimestamp(
    DateTime.now().add(const Duration(minutes: 2)),
  );
  s['request']['proposal']['proposalHash'] = hashJson(p);
  return s;
}

void main() {
  final prepared =
      (jsonDecode(
            File('test/fixtures/prepared-signing.json').readAsStringSync(),
          )['cases']
          as List);
  final material =
      (jsonDecode(
            File('test/fixtures/native-transfers.json').readAsStringSync(),
          )['cases']
          as List);
  setUpAll(replay.loadReplay);
  Future<provider.SessionHarness> open(Map s) async {
    final h = provider.SessionHarness();
    h.signing.backend.preparedSample = s as Map<String, dynamic>;
    final reads =
        material.singleWhere((m) => m['name'] == s['name'])['replies'] as Map;
    h.signing.customRead = (p) async => copied(reads[p]);
    await h.start(defaultPolicy: true);
    addTearDown(h.close);
    return h;
  }

  for (final name in [
    'transfer-single',
    'transfer-exact-requested',
    'merge-two',
  ]) {
    test(
      'Prepared Provider $name uses transaction grant and exact frozen result, one consent, one UTXO read',
      () async {
        final s = fresh(prepared.singleWhere((v) => v['name'] == name)),
            h = await open(s);
        await h.grant();
        expect(h.control.grants.contains('tbc_signPreparedTransaction'), false);
        expect(
          TbcProviderSession.methods.contains('tbc_signPreparedTransaction'),
          true,
        );
        final writes = h.control.writes;
        await h.request(
          'prepared',
          'tbc_signPreparedTransaction',
          s['request'],
        );
        final result = copied(h.response('prepared')['result']);
        result['approvalId'] = s['result']['approvalId'];
        expect(canonical(result), canonical(s['result']));
        final op = h.signing.backend.operations.single;
        expect(
          [op.consents, op.binds, op.signs, op.closes],
          [1, 1, s['audit']['signatures'].length, 1],
        );
        expect(h.signing.paths, ['/api/tbc/utxo/address/${s['account']['address']}']);
        expect(h.control.writes, writes);
      },
    );
  }
  test(
    'Prepared cannot run with message grant or invent its own permission name',
    () async {
      final s = fresh(prepared.first), h = await open(s);
      await h.request('grant', 'wallet_requestPermissions', [
        {
          'tbc_accounts': {
            'chains': ['tbc:testnet'],
          },
          'tbc_signMessage': {
            'chains': ['tbc:testnet'],
          },
        },
      ]);
      await h.request(1, 'tbc_signPreparedTransaction', s['request']);
      expect(h.response(1)['error']['code'], 4100);
      expect(h.signing.backend.begins, 0);
      await h.request('invented', 'wallet_requestPermissions', [
        {
          'tbc_signPreparedTransaction': {
            'chains': ['tbc:testnet'],
          },
        },
      ]);
      expect(h.response('invented')['error']['code'], 4200);
      expect(h.signing.paths, isEmpty);
    },
  );
  test(
    'Prepared invalid, expired and mismatched proposals return fixed errors and no signature',
    () async {
      final s = fresh(prepared.first), h = await open(s);
      await h.grant();
      for (final kind in ['hash', 'expired', 'mismatch']) {
        final r = copied(s['request']), p = r['proposal']['payload'];
        if (kind == 'expired') {
          p['createdAt'] = '2020-01-01T00:00:00Z';
          p['evidence']['observedAt'] = p['createdAt'];
          p['expiresAt'] = '2020-01-01T00:02:00Z';
        }
        if (kind == 'mismatch') p['estimatedTotalFee'] = '1';
        r['proposal']['proposalHash'] =
            kind == 'hash' ? '00' * 32 : hashJson(p);
        final reads = h.signing.paths.length;
        await h.request(kind, 'tbc_signPreparedTransaction', r);
        expect(h.response(kind)['error'], {
          'code':
              kind == 'hash'
                  ? -32602
                  : kind == 'expired'
                  ? 4100
                  : -32603,
          'message':
              kind == 'hash'
                  ? 'Invalid parameters'
                  : kind == 'expired'
                  ? 'Unauthorized'
                  : 'Wallet operation unavailable',
        });
        if (kind != 'mismatch') expect(h.signing.paths.length, reads);
        final op = h.signing.backend.operations.last;
        expect([op.binds, op.signs, op.closes], [0, 0, 1]);
      }
      await h.request('valid', 'tbc_signPreparedTransaction', s['request']);
      expect(h.response('valid').containsKey('result'), true);
    },
  );
  test(
    'Prepared material starts during held consent; revoke stops bind and signing',
    () async {
      final s = fresh(prepared.first), h = await open(s);
      await h.grant();
      h.signing.backend.holdConsent = Completer<void>();
      h.signing.backend.consentEntered = Completer<void>();
      final result = h.request(
        'held',
        'tbc_signPreparedTransaction',
        s['request'],
      );
      await h.signing.backend.consentEntered!.future;
      for (var i = 0; h.signing.paths.isEmpty && i < 100; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }
      expect(h.signing.paths, ['/api/tbc/utxo/address/${s['account']['address']}']);
      h.control.grants.remove('tbc_signTransaction');
      h.signing.backend.holdConsent!.complete();
      await result;
      expect(h.response('held').containsKey('error'), true);
      expect(h.signing.backend.operations.single.signs, 0);
      expect(h.signing.backend.operations.single.binds, 0);
    },
  );
}
