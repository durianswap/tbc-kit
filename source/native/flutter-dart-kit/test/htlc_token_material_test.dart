import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/nft_material.dart'
    show ApiTxoStatus;
import 'package:tbc_kit_flutter_dart/src/internal/htlc_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/htlc_token_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/stablecoin_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'native_signing_test.dart' show FixtureOperation, FixtureBackend;
import 'support/trusted_index_candidate.dart';
import 'support/indexed_fixture.dart';

void main() {
  late Map fixture, library;
  late ComputeProbe engine;
  late IndexedFixture indexed;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  setUpAll(() {
    fixture = jsonDecode(
      File('test/fixtures/htlc-token-signing.json').readAsStringSync(),
    );
    library =
        jsonDecode(
          File('test/fixtures/signing/replay.json').readAsStringSync(),
        )['library'];
    expect(
      sha256.convert(File(library['path']).readAsBytesSync()).toString(),
      library['sha256'],
    );
    library = trustedIndexCandidateLibrary();
    engine = ComputeProbe(DynamicLibrary.open(library['path']));
    indexed = IndexedFixture((fixture['cases'] as List).cast<Map>());
  });
  Map<String, dynamic> sample(int i) {
    final s = copied(fixture['cases'][i]);
    indexed.projectHolder(s, requireTip: s['request']['intent']['type'] != 'tbc-htlc-claim');
    return s;
  }
  HtlcTokenMaterialReader reader(ApiRead read, ApiTxoStatus status) {
    final history = Tbc20MaterialReader(
      network: network,
      read: read,
      keyless:
          (m, i) => copied(jsonDecode(engine.call('keyless', m, canonical(i)))),
    );
    return HtlcTokenMaterialReader(
      network: network,
      read: read,
      status: status,
      tokens: history,
      stablecoins: StablecoinMaterialReader(
        network: network,
        read: read,
        readHistory: history.parent,
        keyless:
            (m, i) =>
                copied(jsonDecode(engine.call('keyless', m, canonical(i)))),
      ),
      funding: NativeMaterialReader(network: network, read: read),
    );
  }

  Future<Map<String, dynamic>> resolve(HtlcTokenMaterialReader r, Map s) =>
      r.resolve(
        request: htlcMaterialRequest(s['request']),
        account: s['account'],
        now: protocolTime(s['now']),
        snapshotId: s['snapshotId'],
        minConfirmations: s['minConfirmations'],
      );
  for (var i = 0; i < 16; i++)
    test(
      'HTLC token $i exact frozen material/policy/Native signed bytes',
      () async {
        final s = sample(i), paths = <String>[], posts = <Object>[];
        final r = reader(
          (p) async {
            paths.add(p);
            expect(s['replies'].containsKey(p), true, reason: p);
            return copied(s['replies'][p]);
          },
          (points) async {
            posts.add({
              'txos': copied({'points': points})['points'],
            });
            return copied(s['replies']['/api/tbc/txo/status']);
          },
        );
        for (var warm = 0; warm < 2; warm++) {
          paths.clear();
          posts.clear();
          final snapshot = await resolve(r, s);
          expect(
            canonical(snapshot),
            canonical(s['audit']['material']['snapshot']),
          );
          final expectedPaths = List<String>.from(
            s[warm == 0 ? 'coldTrace' : 'warmTrace'],
          );
          if ((i == 6 || i == 14) && warm == 0) {
            final decode = expectedPaths.singleWhere(
              (path) => path.contains('/decode/txid/'),
            );
            expect(
              expectedPaths.remove(decode.replaceFirst('/decode/', '/txraw/')),
              isTrue,
            );
          }
          expect(paths, unorderedEquals(expectedPaths));
          expect(paths.length, paths.toSet().length);
          expect(
            canonical(posts),
            canonical(s[warm == 0 ? 'coldStatus' : 'warmStatus']),
          );
          expect(
            canonical({'paths': paths, 'posts': posts}).contains('33' * 32),
            false,
          );
          final projection = htlcMaterialRequest(s['request']);
          expect(projection['intent'].containsKey('preimage'), false);
          final policy = defaultTransactionPolicy(
            network: network,
            request: s['request'],
            snapshot: snapshot,
            now: protocolTime(s['now']),
          );
          policy['payload']['minConfirmations'] = s['minConfirmations'];
          policy['policyHash'] = hashJson(policy['payload']);
          expect(
            canonical(policy),
            canonical(s['audit']['material']['policy']),
          );
          final material = {
            ...copied(s['audit']['material']),
            'snapshot': snapshot,
            'policy': policy,
          };
          Map call(String method, Map value) {
            final r = jsonDecode(
              engine.call('engine', method, canonical(value)),
            );
            expect(r['ok'], true, reason: r['error']?['code']?.toString());
            return r['result'];
          }

          final plan = call('plan', material)['plan'];
          expect(canonical(plan), canonical(s['audit']['plan']));
          expect(
            call('validate', {
              ...material,
              'plan': plan,
              'phase': 'plan',
            })['valid'],
            true,
          );
          final signing = {
            ...material,
            'plan': plan,
            'binding': s['audit']['binding'],
            'approval': s['audit']['approval'],
          };
          expect(
            call('validate', {...signing, 'phase': 'pre-sign'})['valid'],
            true,
          );
          final signed = {...signing, 'signatures': s['audit']['signatures']},
              result = call('finalize', signed);
          expect(canonical(result['bundle']), canonical(s['result']));
          expect(
            call('validate', {
              ...signed,
              'phase': 'finalized',
              'bundle': result['bundle'],
            })['valid'],
            true,
          );
        }
      },
    );
  for (final bad in [
    'escrow-spent',
    'token-spent',
    'missing',
    'duplicate',
    'unrequested',
    'heights',
    'future',
    'value',
    'script',
    'raw',
    'unknown-floor',
    'refund-height',
    'refund-time',
    'missing-mtp',
  ])
    test('Token HTLC material rejects $bad', () async {
      final s = sample(
        bad == 'unknown-floor'
            ? 6
            : bad == 'refund-height'
            ? 4
            : ['refund-time', 'missing-mtp'].contains(bad)
            ? 7
            : 3,
      );
      final id = s['request']['intent']['targetOutpoints'][0]['txid'],
          rows = s['replies']['/api/tbc/txo/status']['txos'] as List;
      switch (bad) {
        case 'escrow-spent':
          rows[0]['spent'] = true;
        case 'token-spent':
          rows[1]['spent'] = true;
        case 'missing':
          rows.removeLast();
        case 'duplicate':
          rows[1] = copied(rows[0]);
        case 'unrequested':
          rows[1]['index'] = 2;
        case 'heights':
          rows[1]['height'] = 829998;
        case 'future':
          s['minConfirmations'] = '1';
          for (final row in rows) row['height'] = 830100;
        case 'value':
          rows[0]['value'] = '101';
        case 'script':
          rows[1]['scriptPubKey'] = '51';
        case 'raw':
          s['replies']['/api/tbc/txraw/txid/$id']['txraw'] = '00';
        case 'unknown-floor':
          s['replies']['/api/tbc/decode/txid/$id'].remove('confirmations');
        case 'refund-height':
          s['replies']['/api/tbc/nodeinfo']['blocks'] = 830009;
        case 'refund-time':
          s['replies']['/api/tbc/nodeinfo']['mediantime'] = 1791800010;
        case 'missing-mtp':
          s['replies']['/api/tbc/nodeinfo'].remove('mediantime');
      }
      final r = reader(
        (p) async => copied(s['replies'][p]),
        (_) async => copied(s['replies']['/api/tbc/txo/status']),
      );
      await expectLater(resolve(r, s), throwsStateError);
    });
  for (final bad in ['secret', 'standard', 'target'])
    test('Token HTLC $bad rejected before reads', () async {
      final s = sample(3), projection = htlcMaterialRequest(s['request']);
      var reads = 0;
      if (bad == 'secret') projection['intent']['preimage'] = '33' * 32;
      if (bad == 'standard')
        projection['intent']['assetStandard'] = 'legacy-ft';
      if (bad == 'target')
        projection['intent']['targetOutpoints'][0]['vout'] = 0;
      final r = reader(
        (_) async {
          reads++;
          return {};
        },
        (_) async {
          reads++;
          return {};
        },
      );
      await expectLater(
        r.resolve(
          request: projection,
          account: s['account'],
          now: protocolTime(s['now']),
          snapshotId: s['snapshotId'],
        ),
        throwsStateError,
      );
      expect(reads, 0);
    });
  test(
    'Token HTLC role follows authenticated escrow, not wallet caller',
    () async {
      final s = sample(3), old = s['account']['address'];
      const other = '1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP';
      s['account'] = {
        'chainId': 'tbc:testnet',
        'accountId': 'tbc:testnet:$other',
        'address': other,
        'publicKey':
            '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
      };
      s['request']['from'] = other;
      s['replies']['/api/tbc/utxo/address/$other'] =
          s['replies']['/api/tbc/utxo/address/$old'];
      final r = reader(
        (p) async => copied(s['replies'][p]),
        (_) async => copied(s['replies']['/api/tbc/txo/status']),
      );
      await expectLater(
        resolve(r, s),
        throwsA(
          isA<StateError>().having((e) => e.message, 'code', 'HTLC_TOKEN_ROLE'),
        ),
      );
    },
  );
  test('Token HTLC warm cache never retains spent status', () async {
    final s = sample(3);
    var spent = false;
    final r = reader((p) async => copied(s['replies'][p]), (_) async {
      final reply = copied(s['replies']['/api/tbc/txo/status']);
      if (spent) reply['txos'][1]['spent'] = true;
      return reply;
    });
    await resolve(r, s);
    spent = true;
    await expectLater(resolve(r, s), throwsStateError);
  });
  test('Token HTLC selection is owned before await', () async {
    final s = sample(3),
        projection = htlcMaterialRequest(s['request']),
        gate = Completer<void>();
    final r = reader(
      (p) async {
        await gate.future;
        return copied(s['replies'][p]);
      },
      (_) async {
        await gate.future;
        return copied(s['replies']['/api/tbc/txo/status']);
      },
    );
    final work = r.resolve(
      request: projection,
      account: s['account'],
      now: protocolTime(s['now']),
      snapshotId: s['snapshotId'],
    );
    projection['intent']['targetOutpoints'][0]['txid'] = 'ff' * 32;
    gate.complete();
    expect(
      canonical(await work),
      canonical(s['audit']['material']['snapshot']),
    );
  });
  test('Token HTLC lock retains frozen five asset-input bound', () async {
    final s = sample(0),
        path = (s['replies'] as Map).keys.singleWhere(
          (p) => p.toString().contains('/ft/utxo/'),
        );
    s['request']['intent']['amount'] = '6';
    s['replies'][path]['utxos'] = [
      for (var n = 1; n <= 6; n++)
        {
          'txid': n.toRadixString(16).padLeft(64, '0'),
          'index': 0,
          'tbc_value': '500',
          'ft_value': '1',
          'height': 829999,
        },
    ];
    final r = reader((p) async => copied(s['replies'][p]), (_) async => {});
    await expectLater(
      resolve(r, s),
      throwsA(
        isA<StateError>().having(
          (e) => e.message,
          'code',
          'TOKEN_MATERIAL_BOUND',
        ),
      ),
    );
  });
  for (final bad in ['identity', 'proof', 'escrow', 'policy'])
    test('Token HTLC Engine rejects rebound $bad', () {
      final s = sample(3), m = copied(s['audit']['material']);
      if (bad == 'identity')
        m['snapshot']['payload']['contracts'][0]['standardId'] =
            'tbc20-stablecoin';
      if (bad == 'proof') {
        m['request']['intent']['preimage'] = '34' * 32;
        m['requestHash'] = hashJson(m['request']);
      }
      if (bad == 'escrow')
        m['snapshot']['payload']['utxos'][1]['satoshis'] = '101';
      // HTLC explicitly requires dust 42. An empty contractPolicies list is
      // not a denial policy in the frozen Engine and must not be tested as one.
      if (bad == 'policy') m['policy']['payload']['dustThreshold'] = '24';
      m['snapshot']['snapshotHash'] = hashJson(m['snapshot']['payload']);
      m['policy']['policyHash'] = hashJson(m['policy']['payload']);
      final result = jsonDecode(engine.call('engine', 'plan', canonical(m)));
      expect(result['ok'], false);
      expect(canonical(result).contains('34' * 32), false);
    });
  for (final i in [0, 2, 3, 4, 8, 10, 11, 15])
    test('HTLC token $i shared one-consent parallel read path', () async {
      final s = sample(i),
          op = FixtureOperation(sample(i)),
          paths = <String>[],
          posts = <Object>[],
          released = Completer<void>();
      final type = s['request']['intent']['type'];
      final initial = type == 'tbc-htlc-lock' ? 4 : type == 'tbc-htlc-claim' ? 4 : 5;
      op.duringConsent = () async {
        for (var n = 0; paths.length + posts.length < initial && n < 200; n++)
          await Future<void>.delayed(const Duration(milliseconds: 1));
        expect(paths.length + posts.length, initial);
        expect(op.binds, 0);
        released.complete();
      };
      final worker = await TbcSigningWorker.start(
        library: TbcPinnedComputeLibrary(
          path: library['path'],
          sha256: library['sha256'],
        ),
        network: network,
        backend: FixtureBackend(op),
        read: (p) async {
          paths.add(p);
          await released.future;
          return copied(s['replies'][p]);
        },
        txoStatus: (points) async {
          posts.add({'txos': points});
          await released.future;
          return copied(s['replies']['/api/tbc/txo/status']);
        },
      );
      addTearDown(worker.close);
      final timing = <String>[];
      final result = await worker.execute(
        scope: TbcSigningRequestScope(
          operationId: 'htlc-token-$i',
          method: s['method'],
          account: TbcAccount(
            network: TbcNetwork.testnet,
            address: s['account']['address'],
            publicKey: s['account']['publicKey'],
          ),
          revision: 0,
          navigation: TbcWebViewNavigation(
            webViewInstanceId: 'view',
            sessionId: 'session',
            navigationId: 'nav',
            committedUrl: 'https://partner.example/dapp',
            origin: 'https://partner.example',
            createdAt: tbcProtocolTimestamp(DateTime.now()),
          ),
        ),
        request: s['request'],
        requireAuthorized: () {},
        isUnlocked: () => true,
        timing: (stage, us) => timing.add(stage),
      );
      expect(
        canonical(result['transactions']),
        canonical(s['result']['transactions']),
      );
      expect(result['totalFee'], s['result']['totalFee']);
      expect(
        [op.consents, op.binds, op.advances, op.signs],
        [1, 1, 0, (s['audit']['signatures'] as List).length],
      );
      expect(paths, unorderedEquals(s['coldTrace']));
      expect(canonical(posts), canonical(s['coldStatus']));
      expect(canonical(timing).contains('33' * 32), false);
    });
}
