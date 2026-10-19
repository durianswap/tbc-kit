import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'package:tbc_kit_flutter_dart/src/internal/lop_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/nft_material.dart'
    show ApiTxoStatus;
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';
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
      File('test/fixtures/lop-signing.json').readAsStringSync(),
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
  Map<String, dynamic> keyless(String method, Map<String, dynamic> input) =>
      copied(jsonDecode(engine.call('keyless', method, canonical(input))));
  LopMaterialReader reader(ApiRead read, ApiTxoStatus status) =>
      LopMaterialReader(
        network: network,
        read: read,
        status: status,
        history: Tbc20MaterialReader(
          network: network,
          read: read,
          keyless: keyless,
        ),
        keyless: keyless,
      );
  Future<Map<String, dynamic>> resolve(LopMaterialReader r, Map s) => r.resolve(
    request: s['request'],
    account: s['account'],
    now: protocolTime(s['now']),
    snapshotId: s['snapshotId'],
    minConfirmations: s['minConfirmations'],
  );
  Map<String, dynamic> sample(int i) {
    final s = copied(fixture['cases'][i]);
    indexed.projectLop(s);
    return s;
  }

  for (final i in [0, 1, 3, 5, 8, 13, 16, 17, 20, 22])
    test('LOP $i shared one-consent parallel material lifecycle', () async {
      final s = sample(i), op = FixtureOperation(sample(i));
      final paths = <String>[],
          posts = <Object>[],
          released = Completer<void>();
      // Funding and the first independent asset/index reads overlap consent.
      op.duringConsent = () async {
        for (var n = 0; paths.length < 2 && n < 200; n++)
          await Future<void>.delayed(const Duration(milliseconds: 1));
        expect(paths.length, greaterThanOrEqualTo(2));
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
      final result = await worker.execute(
        scope: TbcSigningRequestScope(
          operationId: 'lop-$i',
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
    });
  for (var n = 0; n < 23; n++)
    test(
      'LOP $n exact cold/warm material policy and frozen signed bytes',
      () async {
        final s = sample(n), paths = <String>[], posts = <Object>[];
        final r = reader(
          (p) async {
            paths.add(p);
            expect(s['replies'].containsKey(p), true, reason: p);
            return copied(s['replies'][p]);
          },
          (p) async {
            posts.add({'txos': p});
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
          expect(
            paths,
            unorderedEquals(
              (s[warm == 0 ? 'coldTrace' : 'warmTrace'] as List).where(
                (p) =>
                    !(n == 6 &&
                        warm == 0 &&
                        (s['request']['intent']['targetOutpoints'] as List).any(
                          (target) =>
                              p == '/api/tbc/txraw/txid/${target['txid']}',
                        )),
              ),
            ),
          );
          if (n == 6 && warm == 0) expect(paths.length, 6);
          expect(paths.length, paths.toSet().length);
          expect(
            canonical(posts),
            canonical(s[warm == 0 ? 'coldStatus' : 'warmStatus']),
          );
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
          Map call(String method, Map args) {
            final result = jsonDecode(
              engine.call('engine', method, canonical(args)),
            );
            expect(
              result['ok'],
              true,
              reason: result['error']?['code']?.toString(),
            );
            return result['result'];
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
          final bound = {
            ...material,
            'plan': plan,
            'binding': s['audit']['binding'],
            'approval': s['audit']['approval'],
          };
          expect(
            call('validate', {...bound, 'phase': 'pre-sign'})['valid'],
            true,
          );
          final signed = {...bound, 'signatures': s['audit']['signatures']},
              result = call('finalize', signed);
          expect(canonical(result['bundle']), canonical(s['result']));
          expect(
            call('validate', {
              ...signed,
              'bundle': result['bundle'],
              'phase': 'finalized',
            })['valid'],
            true,
          );
        }
      },
    );
  test('LOP owns request selectors before await', () async {
    final s = sample(1), gate = Completer<void>();
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
    final work = resolve(r, s);
    s['request']['intent']['targetOutpoints'][0]['txid'] = 'ff' * 32;
    gate.complete();
    expect(
      canonical(await work),
      canonical(s['audit']['material']['snapshot']),
    );
  });
  for (final bad in [
    'spent',
    'paired-spent',
    'missing',
    'duplicate',
    'unrequested',
    'sibling-height',
    'future-height',
    'value',
    'script',
    'raw',
    'reverse-order',
    'foreign-cancel',
    'unknown-floor',
    'explicit-pair',
    'native-duplicate',
  ]) {
    test('LOP rejects $bad before returning material', () async {
      final s = sample(
        bad == 'unknown-floor' || bad == 'future-height'
            ? 6
            : bad == 'explicit-pair'
            ? 7
            : 5,
      );
      final rows = s['replies']['/api/tbc/txo/status']['txos'] as List;
      switch (bad) {
        case 'spent':
          rows[0]['spent'] = true;
        case 'paired-spent':
          rows[1]['spent'] = true;
        case 'missing':
          rows.removeLast();
        case 'duplicate':
          rows[1] = copied(rows[0]);
        case 'unrequested':
          rows[0]['txid'] = 'ff' * 32;
        case 'sibling-height':
          rows[1]['height'] = 829998;
        case 'future-height':
          for (final row in rows) row['height'] = 830001;
        case 'value':
          rows[0]['value'] = '999';
        case 'script':
          rows[0]['scriptPubKey'] = '51';
        case 'raw':
          s['replies']['/api/tbc/txraw/txid/${rows[0]['txid']}']['txraw'] =
              '00';
        case 'reverse-order':
          s['request']['intent']['targetOutpoints'] =
              (s['request']['intent']['targetOutpoints'] as List).reversed
                  .toList();
        case 'foreign-cancel':
          s['request']['intent'] = {
            'type': 'tbc-lop-cancel',
            'version': '1.0',
            'targetOutpoints': [s['request']['intent']['targetOutpoints'][0]],
          };
        case 'unknown-floor':
          for (final p in (s['replies'] as Map).keys.where(
            (p) => p.toString().contains('/decode/'),
          ))
            (s['replies'][p] as Map).remove('confirmations');
        case 'explicit-pair':
          (s['request']['constraints']['inputOutpoints'] as List).removeWhere(
            (p) => p['vout'] == 1,
          );
        case 'native-duplicate':
          final native =
              s['replies']['/api/tbc/utxo/address/${s['account']['address']}']['utxos']
                  as List;
          native.add(copied(native[0]));
      }
      final r = reader(
        (p) async => copied(s['replies'][p]),
        (_) async => copied(s['replies']['/api/tbc/txo/status']),
      );
      await expectLater(resolve(r, s), throwsStateError);
    });
  }
  for (final bad in [
    'coin-id',
    'coin-code',
    'coin-tape',
    'balance',
    'zero-volume',
  ])
    test('LOP creation rejects $bad', () async {
      final s = sample(bad.startsWith('coin-') ? 10 : 0);
      if (bad.startsWith('coin-')) {
        final path = (s['replies'] as Map).keys.singleWhere(
          (p) => p.toString().contains('/stablecoin/info/'),
        );
        if (bad == 'coin-id')
          s['replies'][path]['stablecoin_id'] = 'ff' * 32;
        else
          s['replies'][path][bad == 'coin-code'
                  ? 'code_script'
                  : 'tape_script'] =
              '00';
      } else if (bad == 'balance') {
        final path = (s['replies'] as Map).keys.singleWhere(
          (p) =>
              p.toString().contains('/ft/utxo/') &&
              p.toString().contains('751e76'),
        );
        s['replies'][path]['utxos'][0]['ft_value'] = '1';
      } else
        s['request']['intent']['order']['saleVolume'] = '0';
      var reads = 0;
      final r = reader((p) async {
        reads++;
        return copied(s['replies'][p]);
      }, (_) async => {});
      await expectLater(resolve(r, s), throwsStateError);
      if (bad == 'zero-volume') expect(reads, 0);
    });
  test('LOP warmed parents never cache availability', () async {
    final s = sample(5);
    var spent = false;
    final r = reader((p) async => copied(s['replies'][p]), (_) async {
      final v = copied(s['replies']['/api/tbc/txo/status']);
      if (spent) v['txos'][0]['spent'] = true;
      return v;
    });
    await resolve(r, s);
    spent = true;
    await expectLater(resolve(r, s), throwsStateError);
  });
  test('LOP independent initial reads overlap and failure drains', () async {
    final s = sample(13), gate = Completer<void>(), seen = <String>[];
    var done = 0;
    final r = reader((p) async {
      seen.add(p);
      await gate.future;
      done++;
      if (p.startsWith('/api/tbc/utxo/address/'))
        throw StateError('TEST_FUNDING');
      return copied(s['replies'][p]);
    }, (_) async => {});
    final failed = expectLater(resolve(r, s), throwsStateError);
    await Future<void>.delayed(Duration.zero);
    try {
      expect(seen.length, greaterThanOrEqualTo(3));
    } finally {
      gate.complete();
    }
    await failed;
    expect(done, seen.length);
  });
  test('LOP matcher cannot also be an order owner', () {
    final s = sample(5), m = copied(s['audit']['material']);
    const address = '1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP';
    m['request']['from'] = address;
    m['requestHash'] = hashJson(m['request']);
    m['snapshot']['payload']['account'] = {
      'chainId': 'tbc:testnet',
      'accountId': 'tbc:testnet:$address',
      'address': address,
      'publicKey':
          '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
    };
    for (final row in m['snapshot']['payload']['utxos'])
      if (row['classification'] == 'native')
        row['scriptPubKey'] =
            '76a91406afd46bcdfd22ef94ac122aa11f241244a37ecc88ac';
    m['snapshot']['snapshotHash'] = hashJson(m['snapshot']['payload']);
    final result = jsonDecode(engine.call('engine', 'plan', canonical(m)));
    expect(result['ok'], false);
    expect(result['error']['message'], contains('matcher change'));
  });
}
