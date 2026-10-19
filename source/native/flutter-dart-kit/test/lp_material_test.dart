import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/lp_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
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
      File('test/fixtures/lp-signing.json').readAsStringSync(),
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
    final s = copied(fixture['cases'][i]);indexed.projectLp(s);return s;
  }
  Map<String, dynamic> keyless(String method, Map<String, dynamic> input) =>
      copied(jsonDecode(engine.call('keyless', method, canonical(input))));
  LpMaterialReader reader(ApiRead read, {KeylessCall? parser}) {
    final history = Tbc20MaterialReader(
      network: network,
      read: read,
      keyless: keyless,
    );
    return LpMaterialReader(
      network: network,
      read: read,
      readHistory: history.parent,
      funding: NativeMaterialReader(network: network, read: read),
      keyless: parser ?? keyless,
    );
  }

  Future<Map<String, dynamic>> resolve(LpMaterialReader r, Map s) => r.resolve(
    request: s['request'],
    account: s['account'],
    now: protocolTime(s['now']),
    snapshotId: s['snapshotId'],
    minConfirmations: s['minConfirmations'],
  );
  for (var i = 0; i < 9; i++) {
    test(
      'LP $i exact frozen cold/warm material, policy, Native/WASM signed bytes',
      () async {
        final s = sample(i), paths = <String>[];
        final r = reader((p) async {
          paths.add(p);
          expect(s['replies'].containsKey(p), true, reason: p);
          return copied(s['replies'][p]);
        });
        for (var warm = 0; warm < 2; warm++) {
          paths.clear();
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
            paths.any(
              (p) => p.contains('/ft/utxo/'),
            ),
            false,
          );
          final policy = defaultTransactionPolicy(
            network: network,
            request: s['request'],
            snapshot: snapshot,
            now: protocolTime(s['now']),
          );
          // Positive confirmation floor is a host-configured policy, not a default.
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
          Map call(String op, Map value) {
            final r = jsonDecode(engine.call('engine', op, canonical(value)));
            expect(r['ok'], true, reason: r['error']?.toString());
            return r['result'];
          }

          final planned = call('plan', material);
          expect(canonical(planned['plan']), canonical(s['audit']['plan']));
          expect(
            call('validate', {
              ...material,
              'plan': planned['plan'],
              'phase': 'plan',
            })['valid'],
            true,
          );
          final signing = {
            ...material,
            'plan': planned['plan'],
            'binding': s['audit']['binding'],
            'approval': s['audit']['approval'],
          };
          expect(
            call('validate', {...signing, 'phase': 'pre-sign'})['valid'],
            true,
          );
          final signed = {...signing, 'signatures': s['audit']['signatures']};
          final result = call('finalize', signed);
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
  }
  for (final i in [0, 1, 3, 5]) {
    test(
      'LP $i shared worker one consent overlaps three initial reads',
      () async {
        final s = sample(i),
            op = FixtureOperation(sample(i)),
            paths = <String>[],
            released = Completer<void>();
        op.duringConsent = () async {
          for (var n = 0; paths.length < 2 && n < 200; n++)
            await Future<void>.delayed(const Duration(milliseconds: 1));
          expect(paths.length, 2);
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
        );
        addTearDown(worker.close);
        final result = await worker.execute(
          scope: TbcSigningRequestScope(
            operationId: 'lp-$i',
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
      },
    );
  }
  for (final bad in [
    'amount',
    'duplicate',
    'height',
    'value',
    'raw',
    'plain-lock',
    'merge-one',
    'selected-missing',
    'low-confirmations',
    'decoded-id',
    'wrong-script',
    'future-lock',
    'timestamp-no-mtp',
    'dependency',
  ]) {
    test('LP rejects $bad before a signing plan', () async {
      final s = sample(
            bad == 'merge-one'
                ? 1
                : bad == 'low-confirmations' || bad == 'decoded-id' || bad == 'height'
                ? 8
                : 0,
          ),
          replies = s['replies'] as Map;
      final rows =
          (replies.entries
                  .singleWhere((e) => (e.key as String).contains('/lputxo/'))
                  .value['utxos'])
              as List;
      final original = rows.first as Map;
      switch (bad) {
        case 'amount':
          original['ft_value'] = '123';
        case 'duplicate':
          rows.add(copied(original));
        case 'height':
          original['height'] = '830001';
        case 'value':
          original['value'] = '501';
        case 'raw':
          replies['/api/tbc/txraw/txid/${original['txid']}']['txraw'] = '00';
        case 'plain-lock':
          s['request']['intent']['type'] = 'tbc20-lp-lock';
          s['request']['intent']['lockTime'] = '830100';
        case 'merge-one':
          rows.removeLast();
        case 'selected-missing':
          s['request']['constraints']['inputOutpoints'] = [
            for (final u
                in s['audit']['material']['snapshot']['payload']['utxos'])
              if (u['classification'] == 'native')
                {'txid': u['txid'], 'vout': u['vout']},
          ];
        case 'low-confirmations':
          replies.entries
                  .singleWhere((e) => (e.key as String).contains('/decode/'))
                  .value['confirmations'] =
              0;
        case 'decoded-id':
          replies.entries
                  .singleWhere((e) => (e.key as String).contains('/decode/'))
                  .value['txid'] =
              '00' * 32;
      }
      final r = reader(
        (p) async => copied(replies[p]),
        parser: (op, input) {
          final result = keyless(op, input);
          if (input['phase'] == 'inspectAssets') {
            final item = result['items'][0];
            if (bad == 'wrong-script') item['scriptPubKey'] = '00';
            if (bad == 'future-lock') item['lockTime'] = 830001;
            if (bad == 'timestamp-no-mtp') item['lockTime'] = 1791800000;
            if (bad == 'dependency')
              item['dependencies'] = [
                {'txid': '00' * 32, 'vout': 0},
              ];
          }
          return result;
        },
      );
      if (bad == 'timestamp-no-mtp')
        replies['/api/tbc/nodeinfo'].remove('mediantime');
      await expectLater(resolve(r, s), throwsA(isA<StateError>()));
    });
  }
}
