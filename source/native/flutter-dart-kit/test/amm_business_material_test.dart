import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/amm_business_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
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
      File('test/fixtures/amm-business-signing.json').readAsStringSync(),
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
    indexed.projectAmm(s);
    return s;
  }
  Map<String, dynamic> keyless(String op, Map<String, dynamic> input) =>
      copied(jsonDecode(engine.call('keyless', op, jsonEncode(input))));
  AmmBusinessMaterialReader reader(ApiRead read) {
    final history = Tbc20MaterialReader(
      network: network,
      read: read,
      keyless: keyless,
    );
    return AmmBusinessMaterialReader(
      network: network,
      read: read,
      readHistory: history.parent,
      funding: NativeMaterialReader(network: network, read: read),
      keyless: keyless,
    );
  }

  Future<Map<String, dynamic>> resolve(
    AmmBusinessMaterialReader reader,
    Map s,
  ) => reader.resolve(
    request: s['request'],
    account: s['account'],
    now: protocolTime(s['now']),
    snapshotId: s['snapshotId'],
    minConfirmations: s['minConfirmations'],
  );
  for (var i = 0; i < 5; i++) {
    test(
      'AMM funding $i frozen selection, bounded reads and signed output',
      () async {
        final s = copied(
              jsonDecode(
                File('test/fixtures/amm-funding.json').readAsStringSync(),
              )['cases'][i],
            ),
            paths = <String>[];
        final r = reader((p) async {
          paths.add(p);
          expect(s['replies'].containsKey(p), true, reason: p);
          return copied(s['replies'][p]);
        });
        if (s['snapshot']['portError'] != null) {
          final pool = s['replies']['/api/tbc/pool/poolinfo/poolid/${s['request']['intent']['poolContractId']}'];
          final ftid = pool['ft_contract_id'];
          s['replies']['/api/tbc/ft/info/contract/$ftid'] = indexed.ftInfo(ftid);
          await expectLater(resolve(r, s), throwsA(isA<StateError>()));
          return;
        }
        s['coldTrace'] = s['trace'];
        s['warmTrace'] = <String>[];
        IndexedFixture([s]).projectAmm(s);
        s['snapshot'] = s['audit']['material']['snapshot'];
        final snapshot = await resolve(r, s);
        expect(canonical(snapshot), canonical(s['snapshot']));
        expect(paths, unorderedEquals(s['trace']));
        expect(paths.length, paths.toSet().length);
        final input = {...copied(s['audit']['material']), 'snapshot': snapshot};
        final planned = jsonDecode(
          engine.call('engine', 'plan', canonical(input)),
        );
        expect(planned['ok'], true);
        expect(
          canonical(planned['result']['plan']),
          canonical(s['audit']['plan']),
        );
        final signing = {
          ...input,
          'plan': planned['result']['plan'],
          'binding': s['audit']['binding'],
          'approval': s['audit']['approval'],
          'signatures': s['audit']['signatures'],
        };
        final finalization = jsonDecode(
          engine.call('engine', 'finalize', canonical(signing)),
        );
        expect(finalization['ok'], true);
        expect(
          canonical(finalization['result']['bundle']),
          canonical(s['result']),
        );
        final check = jsonDecode(
          engine.call(
            'engine',
            'validate',
            canonical({
              ...signing,
              'phase': 'finalized',
              'bundle': finalization['result']['bundle'],
            }),
          ),
        );
        expect(check['result']['valid'], true);
      },
    );
  }
  for (var i = 0; i < 8; i++) {
    test(
      'AMM business $i exact frozen material/policy/Native plan, cold and warm',
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
            (snapshot['payload']['parents'] as List).map((p) => p['txid']),
            (s['audit']['material']['snapshot']['payload']['parents'] as List)
                .map((p) => p['txid']),
          );
          expect(
            hashJson(snapshot),
            hashJson(s['audit']['material']['snapshot']),
          );
          expect(
            paths,
            unorderedEquals(s[warm == 0 ? 'coldTrace' : 'warmTrace']),
          );
          expect(paths.length, paths.toSet().length);
          final policy = defaultTransactionPolicy(
            network: network,
            request: s['request'],
            snapshot: snapshot,
            now: protocolTime(s['now']),
          );
          expect(
            canonical(policy),
            canonical(s['audit']['material']['policy']),
          );
          final input = {
            ...copied(s['audit']['material']),
            'snapshot': snapshot,
            'policy': policy,
          };
          final planned = jsonDecode(
            engine.call('engine', 'plan', canonical(input)),
          );
          expect(planned['ok'], true, reason: planned['error']?.toString());
          expect(
            canonical(planned['result']['plan']),
            canonical(s['audit']['plan']),
          );
          final validated = jsonDecode(
            engine.call(
              'engine',
              'validate',
              canonical({
                ...input,
                'plan': planned['result']['plan'],
                'phase': 'plan',
              }),
            ),
          );
          expect(validated['result']['valid'], true);
          final signing = {
            ...input,
            'plan': planned['result']['plan'],
            'binding': s['audit']['binding'],
            'approval': s['audit']['approval'],
          };
          final before = jsonDecode(
            engine.call(
              'engine',
              'validate',
              canonical({...signing, 'phase': 'pre-sign'}),
            ),
          );
          expect(before['result']['valid'], true);
          final finalized = jsonDecode(
            engine.call(
              'engine',
              'finalize',
              canonical({...signing, 'signatures': s['audit']['signatures']}),
            ),
          );
          expect(finalized['ok'], true, reason: finalized['error']?.toString());
          expect(
            hashJson(finalized['result']['bundle']),
            hashJson(s['result']),
          );
          final after = jsonDecode(
            engine.call(
              'engine',
              'validate',
              canonical({
                ...signing,
                'phase': 'finalized',
                'signatures': s['audit']['signatures'],
                'bundle': finalized['result']['bundle'],
              }),
            ),
          );
          expect(after['result']['valid'], true);
        }
      },
    );
  }
  for (var i = 0; i < 4; i++) {
    test('AMM shared worker $i overlaps four reads and one approval', () async {
      final s = sample(i), op = FixtureOperation(sample(i)), paths = <String>[];
      final released = Completer<void>();
      op.duringConsent = () async {
        for (var n = 0; paths.length < 2 && n < 200; n++) {
          await Future<void>.delayed(const Duration(milliseconds: 1));
        }
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
          operationId: 'amm-business-$i',
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
        hashJson(result['transactions']),
        hashJson(s['result']['transactions']),
      );
      expect(result['totalFee'], s['result']['totalFee']);
      expect(
        [op.consents, op.binds, op.advances, op.signs],
        [1, 1, 0, (s['audit']['signatures'] as List).length],
      );
      expect(paths, unorderedEquals(s['coldTrace']));
    });
  }
  test(
    'AMM native tip/index and Pool identity/current-index start in parallel',
    () async {
      final s = sample(0), paths = <String>[], released = Completer<void>();
      final r = reader((p) async {
        paths.add(p);
        await released.future;
        return copied(s['replies'][p]);
      });
      final prepared = resolve(r, s);
      for (var n = 0; paths.length < 2 && n < 200; n++) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }
      expect(paths.length, 2);
      released.complete();
      await prepared;
      expect(paths, unorderedEquals(s['coldTrace']));
    },
  );
  for (final bad in ['minimum-output', 'maximum-ft', 'pool-state']) {
    test('AMM $bad bound fails before binding or signing', () async {
      final s = sample(bad == 'maximum-ft' ? 0 : 1);
      final op = FixtureOperation(copied(s));
      final intent = s['request']['intent'] as Map;
      if (bad == 'minimum-output')
        intent['minimumOutput'] = '1000000000000000000';
      if (bad == 'maximum-ft') intent['maximumFtAmount'] = '1';
      if (bad == 'pool-state') intent['poolStateHash'] = '00' * 32;
      final r = reader((p) async => copied(s['replies'][p]));
      final executor = TbcSigningExecutor(
        engine: engine,
        signer: op,
        authority: TbcOperationAuthority(
          context: s['context'],
          account: TbcAccount(
            network: TbcNetwork.testnet,
            address: s['account']['address'],
            publicKey: s['account']['publicKey'],
          ),
          requireAuthorized: (_) {},
          isUnlocked: () => true,
          clock: () => protocolTime(s['now']),
        ),
        prepareMaterial: (request, account) async {
          final snapshot = await r.resolve(
            request: request,
            account: account,
            now: protocolTime(s['now']),
            snapshotId: s['snapshotId'],
          );
          return {
            'snapshot': snapshot,
            'policy': defaultTransactionPolicy(
              network: network,
              request: request,
              snapshot: snapshot,
              now: protocolTime(s['now']),
            ),
          };
        },
      );
      await expectLater(
        executor.execute(s['method'], s['request']),
        throwsA(isA<StateError>()),
      );
      expect([op.binds, op.signs], [0, 0]);
    });
  }
  for (final bad in [
    'fee',
    'reserve',
    'script',
    'point',
    'raw',
    'asset-amount',
    'duplicate-reserve',
    'funding-value',
  ]) {
    test('AMM $bad mismatch is rejected before a signing plan', () async {
      final s = sample(0), replies = s['replies'] as Map;
      final info =
          replies.entries
                  .singleWhere((e) => (e.key as String).contains('/poolinfo/'))
                  .value
              as Map;
      final index =
          replies.entries
                  .where((e) => (e.key as String).contains('/ft/utxo/'))
                  .first
                  .value['utxos']
              as List;
      switch (bad) {
        case 'fee':
          info['service_fee_rate'] = 1;
        case 'reserve':
          info['token_balance'] = '123';
        case 'script':
          info['pool_code_script'] = '00';
        case 'point':
          info['vout'] = '1';
        case 'raw':
          replies['/api/tbc/txraw/txid/${info['txid']}']['txraw'] = '00';
        case 'asset-amount':
          index[0]['ft_value'] = '123';
        case 'duplicate-reserve':
          index.add(copied(index.first));
        case 'funding-value':
          final native =
              replies.entries
                      .singleWhere(
                        (e) => (e.key as String).contains('/utxo/address/'),
                      )
                      .value['utxos']
                  as List;
          native[0]['value'] = '3000000';
      }
      final r = reader((p) async => copied(replies[p]));
      await expectLater(resolve(r, s), throwsA(isA<StateError>()));
    });
  }
}
