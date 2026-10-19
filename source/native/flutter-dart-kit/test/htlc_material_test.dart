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
import 'package:tbc_kit_flutter_dart/src/internal/transaction_profiles.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'native_signing_test.dart' show FixtureOperation, FixtureBackend;
import 'support/trusted_index_candidate.dart';

void main() {
  late Map fixture, library;
  late ComputeProbe engine;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  setUpAll(() {
    fixture = jsonDecode(
      File('test/fixtures/htlc-native-signing.json').readAsStringSync(),
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
  });
  Map<String, dynamic> sample(int i) {
    final s = copied(fixture['cases'][i]);
    // A zero-floor claim has no maturity requirement. Refunds and positive
    // floors must still obtain a current tip and retain their original tests.
    if (s['request']['intent']['type'] == 'tbc-htlc-claim' && s['minConfirmations'] == '0') {
      rebindExpectedSnapshot(s, withoutObservedTip(s['audit']['material']['snapshot']));
      for (final name in ['coldTrace', 'warmTrace']) (s[name] as List).remove('/api/tbc/nodeinfo');
    }
    return s;
  }
  HtlcMaterialReader reader(ApiRead read, ApiTxoStatus status) {
    final history = Tbc20MaterialReader(
      network: network,
      read: read,
      keyless:
          (m, i) => copied(jsonDecode(engine.call('keyless', m, canonical(i)))),
    );
    return HtlcMaterialReader(
      network: network,
      read: read,
      status: status,
      readHistory: history.parent,
      funding: NativeMaterialReader(network: network, read: read),
    );
  }

  Future<Map<String, dynamic>> resolve(HtlcMaterialReader r, Map s) =>
      r.resolve(
        request: htlcMaterialRequest(s['request']),
        account: s['account'],
        now: protocolTime(s['now']),
        snapshotId: s['snapshotId'],
        minConfirmations: s['minConfirmations'],
      );
  for (var i = 0; i < 11; i++)
    test(
      'HTLC native $i exact frozen material/policy/Native signed bytes',
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
          expect(
            paths,
            unorderedEquals(s[warm == 0 ? 'coldTrace' : 'warmTrace']),
          );
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
    'spent',
    'missing',
    'duplicate',
    'unexpected',
    'value',
    'script',
    'future-height',
    'raw',
    'role',
    'refund-height',
    'refund-time',
    'missing-mtp',
    'positive-unknown',
    'mixed-domain',
  ]) {
    test(
      'HTLC native rejects $bad without secret or fee-index reads',
      () async {
        final i =
            bad == 'positive-unknown'
                ? 10
                : ['refund-time', 'missing-mtp'].contains(bad)
                ? 7
                : bad == 'refund-height'
                ? 6
                : bad == 'mixed-domain'
                ? 8
                : 5;
        final s = sample(i),
            replies = s['replies'] as Map,
            rows = replies['/api/tbc/txo/status']['txos'] as List;
        final paths = <String>[];
        var posts = 0;
        if (bad == 'spent') rows[0]['spent'] = true;
        if (bad == 'missing') rows.removeLast();
        if (bad == 'duplicate') rows[1] = copied(rows[0]);
        if (bad == 'unexpected') rows[0]['txid'] = 'ee' * 32;
        if (bad == 'value') rows[0]['value'] = '10001';
        if (bad == 'script') rows[0]['scriptPubKey'] = '51';
        if (bad == 'future-height') {
          // Testing height against a chain tip requires an actual tip policy;
          // zero-floor claims intentionally never download unrelated nodeinfo.
          s['minConfirmations'] = '1';
          rows[0]['height'] = 830001;
        }
        if (bad == 'raw')
          replies['/api/tbc/txraw/txid/${rows[0]['txid']}']['txraw'] = '00';
        if (bad == 'role') {
          s['request']['intent']['type'] = 'tbc-htlc-refund';
          s['request']['intent'].remove('preimage');
        }
        if (bad == 'refund-height')
          replies['/api/tbc/nodeinfo']['blocks'] = 829999;
        if (bad == 'refund-time')
          replies['/api/tbc/nodeinfo']['mediantime'] = 1791799999;
        if (bad == 'missing-mtp')
          replies['/api/tbc/nodeinfo'].remove('mediantime');
        if (bad == 'positive-unknown')
          replies['/api/tbc/decode/txid/${rows[0]['txid']}'].remove(
            'confirmations',
          );
        if (bad == 'mixed-domain') {
          final other = sample(7),
              p = other['request']['constraints']['inputOutpoints'][0];
          s['request']['constraints']['inputOutpoints'][0] = copied(p);
          rows[0] = copied(other['replies']['/api/tbc/txo/status']['txos'][0]);
          replies['/api/tbc/txraw/txid/${p['txid']}'] = copied(
            other['replies']['/api/tbc/txraw/txid/${p['txid']}'],
          );
        }
        final r = reader(
          (p) async {
            paths.add(p);
            return copied(replies[p]);
          },
          (points) async {
            posts++;
            expect(canonical(points).contains('33' * 32), false);
            return copied(replies['/api/tbc/txo/status']);
          },
        );
        await expectLater(resolve(r, s), throwsStateError);
        expect(posts, 1);
        expect(paths.any((p) => p.contains('/utxo/address/')), false);
      },
    );
  }
  test('HTLC material rejects secret-bearing projection before I/O', () async {
    final s = sample(3);
    var reads = 0;
    final r = reader(
      (p) async {
        reads++;
        return {};
      },
      (p) async {
        reads++;
        return {};
      },
    );
    await expectLater(
      r.resolve(
        request: s['request'],
        account: s['account'],
        now: protocolTime(s['now']),
        snapshotId: 'no-proof',
      ),
      throwsStateError,
    );
    expect(reads, 0);
  });
  test('wrong HTLC proof remains an Engine rejection with no leaked proof', () {
    final s = sample(3), material = copied(s['audit']['material']);
    material['request']['intent']['preimage'] = '34' * 32;
    final n =
        jsonDecode(
          engine.call(
            'engine',
            'normalizeRequest',
            canonical({'version': '1.0', 'request': material['request']}),
          ),
        )['result'];
    material['request'] = n['request'];
    material['requestHash'] = n['requestHash'];
    final raw = engine.call('engine', 'plan', canonical(material)),
        r = jsonDecode(raw);
    expect(r['ok'], false);
    expect(raw.contains('34' * 32), false);
  });
  test(
    'HTLC claim warning is mandatory, bounded and not reusable for other operations',
    () {
      final claim = sample(3), plan = copied(claim['audit']['plan']['payload']);
      expect(coveredTransactionWarnings(claim['request'], plan), true);
      final missing = copied(plan);
      missing['preview']['warnings'] = <String>[];
      expect(coveredTransactionWarnings(claim['request'], missing), false);
      final expanded = copied(plan);
      expanded['transactions'].add(copied(expanded['transactions'].first));
      expanded['preview']['transactionCount'] = 2;
      expect(coveredTransactionWarnings(claim['request'], expanded), false);
      plan['preview']['warnings'].add('UNKNOWN');
      expect(coveredTransactionWarnings(claim['request'], plan), false);
      expect(
        coveredTransactionWarnings(
          sample(0)['request'],
          sample(3)['audit']['plan']['payload'],
        ),
        false,
      );
    },
  );
  for (final i in [0, 1, 3, 5, 7, 8])
    test('HTLC native $i shared one-consent parallel read path', () async {
      final s = sample(i),
          op = FixtureOperation(sample(i)),
          paths = <String>[],
          posts = <Object>[],
          released = Completer<void>();
      op.duringConsent = () async {
        final initial = s['request']['intent']['type'] == 'tbc-htlc-claim' ? 1 : 2;
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
          final normalized = copied(s['replies']['/api/tbc/txo/status']);
          // Deployed official endpoint, not the TS client's normalized DTO.
          return {'results': [for (final row in normalized['txos']) {
            'txid': row['txid'], 'index': row['index'], 'value': row['value'],
            'status': {'spent': row['spent']},
            if (row['scriptPubKey'] != null) 'scriptpubkey': row['scriptPubKey'],
            if (row['height'] != null) 'height': row['height'],
          }]};
        },
      );
      addTearDown(worker.close);
      final timing = <String>[];
      final result = await worker.execute(
        scope: TbcSigningRequestScope(
          operationId: 'htlc-$i',
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
