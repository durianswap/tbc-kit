import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'native_signing_test.dart' show FixtureOperation, FixtureBackend;
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/timelock_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';

void main() {
  late Map fixture;
  late Map library;
  late ComputeProbe engine;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  setUpAll(() {
    fixture = jsonDecode(
      File('test/fixtures/timelock-signing.json').readAsStringSync(),
    );
    library =
        jsonDecode(
          File('test/fixtures/signing/replay.json').readAsStringSync(),
        )['library'];
    expect(
      sha256.convert(File(library['path']).readAsBytesSync()).toString(),
      library['sha256'],
    );
    engine = ComputeProbe(DynamicLibrary.open(library['path']));
  });
  Map<String, dynamic> sample(int i) => copied(fixture['cases'][i]);
  TimelockMaterialReader reader(ApiRead read) {
    final history = Tbc20MaterialReader(
      network: network,
      read: read,
      keyless:
          (method, input) => copied(
            jsonDecode(engine.call('keyless', method, canonical(input))),
          ),
    );
    return TimelockMaterialReader(
      network: network,
      read: read,
      readHistory: history.parent,
      funding: NativeMaterialReader(network: network, read: read),
    );
  }

  Future<Map<String, dynamic>> resolve(TimelockMaterialReader r, Map s) =>
      r.resolve(
        request: s['request'],
        account: s['account'],
        now: protocolTime(s['now']),
        snapshotId: s['snapshotId'],
        minConfirmations: s['minConfirmations'],
      );
  for (var i = 0; i < 8; i++) {
    test(
      'TimeLock $i frozen cold/warm policy/material and Native/WASM bytes',
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
          Map call(String op, Map input) {
            final r = jsonDecode(engine.call('engine', op, canonical(input)));
            expect(r['ok'], true, reason: r['error']?.toString());
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
          final signed = {
            ...material,
            'plan': plan,
            'binding': s['audit']['binding'],
            'approval': s['audit']['approval'],
          };
          expect(
            call('validate', {...signed, 'phase': 'pre-sign'})['valid'],
            true,
          );
          signed['signatures'] = s['audit']['signatures'];
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
  for (final i in [0, 2, 4, 5]) {
    test(
      'TimeLock $i shared worker one consent overlaps two initial reads',
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
            return {
              ...copied(s['replies'][p]),
              if (p == '/api/tbc/nodeinfo') ...{
                // Actual nodeinfo includes non-integer diagnostics. They are
                // not transaction amounts or signed protocol material.
                'difficulty': 12919729.8601678,
                'verificationprogress': 0.00008656866914856023,
              },
            };
          },
        );
        addTearDown(worker.close);
        final result = await worker.execute(
          scope: TbcSigningRequestScope(
            operationId: 'timelock-$i',
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
    'missing',
    'duplicate',
    'value',
    'future-index',
    'immature',
    'raw-hash',
    'unknown-floor',
    'wrong-owner',
    'timestamp-template',
  ]) {
    test(
      'TimeLock rejects $bad without native fee index or fallback',
      () async {
        final s = sample(bad == 'unknown-floor' ? 7 : 3),
            replies = s['replies'] as Map,
            paths = <String>[];
        final index =
            '/api/tbc/frozenUtxo/address/${s['account']['address']}/piggyBank';
        final rows = replies[index]['utxos'] as List,
            point = s['request']['constraints']['inputOutpoints'][0];
        final selected = rows.firstWhere(
          (r) => r['txid'] == point['txid'] && r['index'] == point['vout'],
        );
        if (bad == 'missing') replies[index]['utxos'] = [];
        if (bad == 'duplicate') rows.add(copied(selected));
        if (bad == 'value') selected['value'] = '10001';
        if (bad == 'future-index') selected['height'] = 830001;
        if (bad == 'immature') replies['/api/tbc/nodeinfo']['blocks'] = 829998;
        if (bad == 'raw-hash')
          replies['/api/tbc/txraw/txid/${point['txid']}']['txraw'] = '00';
        if (bad == 'unknown-floor')
          replies['/api/tbc/decode/txid/${point['txid']}'].remove(
            'confirmations',
          );
        if (bad == 'wrong-owner' || bad == 'timestamp-template') {
          final old = point['txid'], path = '/api/tbc/txraw/txid/$old';
          var raw = replies[path]['txraw'] as String;
          raw =
              bad == 'wrong-owner'
                  ? raw.replaceAll(
                    '751e76e8199196d454941c45d1b3a323f1433bd6',
                    '00' * 20,
                  )
                  : raw.replaceAll(
                    '88ad56ba01247f778104ffffffff819e5188042faa0c00',
                    '88ad56ba01247f778104ffffffff819e5188040065cd1d',
                  );
          final changed = inspectTransaction(raw);
          expect(changed['txid'], isNot(old));
          point['txid'] = changed['txid'];
          for (final row in rows)
            if (row['txid'] == old) row['txid'] = changed['txid'];
          replies['/api/tbc/txraw/txid/${changed['txid']}'] = {'txraw': raw};
        }
        final r = reader((p) async {
          paths.add(p);
          expect(replies.containsKey(p), true, reason: p);
          return copied(replies[p]);
        });
        await expectLater(resolve(r, s), throwsA(isA<StateError>()));
        expect(paths.any((p) => p.contains('/utxo/address/')), false);
      },
    );
  }
  test(
    'TimeLock owns selected points before async reads and keeps fresh index',
    () async {
      final s = sample(3);
      var mutate = true, reads = 0;
      final r = reader((p) async {
        reads++;
        if (mutate) {
          mutate = false;
          s['request']['constraints']['inputOutpoints'][0]['vout'] = 1;
        }
        return copied(s['replies'][p]);
      });
      final snapshot = await resolve(r, s);
      expect(snapshot['payload']['utxos'][0]['vout'], 0);
      s['request']['constraints']['inputOutpoints'][0]['vout'] = 0;
      s['replies']['/api/tbc/frozenUtxo/address/${s['account']['address']}/piggyBank']['utxos'] =
          [];
      reads = 0;
      await expectLater(resolve(r, s), throwsStateError);
      expect(reads, 2);
    },
  );
  test('TimeLock invalid explicit selection rejects before reads', () async {
    for (final invalid in [
      null,
      [],
      [
        {'txid': '00', 'vout': 0},
      ],
      List.generate(129, (_) => {'txid': '11' * 32, 'vout': 0}),
    ]) {
      final s = sample(3);
      s['request']['constraints']['inputOutpoints'] = invalid;
      var reads = 0;
      final r = reader((p) async {
        reads++;
        return {};
      });
      await expectLater(resolve(r, s), throwsStateError);
      expect(reads, 0);
    }
  });
}
