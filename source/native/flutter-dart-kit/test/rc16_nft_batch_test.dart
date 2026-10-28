import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/nft_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'native_signing_test.dart' show FixtureOperation;

void main() {
  final fixture = copied(
    jsonDecode(File('test/fixtures/rc16-nft-batch.json').readAsStringSync()),
  );
  (fixture['cases'] as List).addAll(jsonDecode(File('test/fixtures/rc16-nft-large.json').readAsStringSync())['cases']);
  late ComputeProbe engine;
  setUpAll(() {
    final path = Platform.environment['TBC_RC16_LIBRARY']!,
        expected = Platform.environment['TBC_RC16_LIBRARY_SHA256'];
    expect(sha256.convert(File(path).readAsBytesSync()).toString(), expected);
    engine = ComputeProbe(DynamicLibrary.open(path));
  });
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  for (final raw in fixture['cases']) {
    final s = copied(raw);
    test(
      '${s['name']}: authenticated material, exact WASM bundle, single consent',
      () async {
        final paths = <String>[];
        Future<Map<String, dynamic>> read(String p) async {
          paths.add(p);
          expect(s['replies'].containsKey(p), true);
          return copied(s['replies'][p]);
        }

        Map<String, dynamic> keyless(String m, Map<String, dynamic> p) =>
            copied(jsonDecode(engine.call('keyless', m, canonical(p))));
        final shared = Tbc20MaterialReader(
          network: network,
          read: read,
          keyless: keyless,
        );
        final reader = NftMaterialReader(
          network: network,
          read: read,
          readHistory: shared.parent,
          keyless: keyless,
          status: (_) async => throw StateError('EXTRA_STATUS'),
        );
        final prepared = Completer<void>();
        final op = FixtureOperation(s)
          ..duringConsent = () async {
            await prepared.future;
          };
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
            try {
              final snapshot = await reader.resolve(
                request: request,
                account: account,
                now: protocolTime(s['now']),
                snapshotId: s['snapshotId'],
              );
              expect(
                canonical(snapshot),
                canonical(s['audit']['material']['snapshot']),
              );
              final policy = defaultTransactionPolicy(
                network: network,
                request: request,
                snapshot: snapshot,
                now: protocolTime(s['now']),
              );
              expect(
                canonical(policy),
                canonical(s['audit']['material']['policy']),
              );
              return {'snapshot': snapshot, 'policy': policy};
            } finally {
              prepared.complete();
            }
          },
        );
        final result = await executor.execute(
          'tbc_signTransaction',
          s['request'],
        );
        expect(canonical(result), canonical(s['result']));
        expect(paths, unorderedEquals(s['trace']));
        expect(paths.toSet().length, paths.length);
        expect(
          [op.consents, op.binds, op.advances, op.signs, op.closes],
          [1, 1, s['count'] - 1, s['audit']['signatures'].length, 1],
        );
      },
    );
  }
  test('duplicate, override and oversize rejected before any read', () async {
    final s = copied(fixture['cases'][0]);
    var reads = 0;
    final reader = NftMaterialReader(
      network: network,
      read: (p) async {
        reads++;
        throw StateError('READ');
      },
      readHistory: (p) async {
        reads++;
        throw StateError('READ');
      },
      status: (_) async => throw StateError('STATUS'),
      keyless: (_, __) => throw StateError('KEYLESS'),
    );
    for (final transfers in [
      List.filled(2, s['request']['intent']['transfers'][0]),
      List.filled(101, s['request']['intent']['transfers'][0]),
      [
        {...s['request']['intent']['transfers'][0], 'type': 'tbc.transfer'},
      ],
    ]) {
      final request = copied(s['request']);
      request['intent']['transfers'] = transfers;
      await expectLater(
        reader.resolve(
          request: request,
          account: s['account'],
          now: protocolTime(s['now']),
          snapshotId: 'reject',
        ),
        throwsStateError,
      );
    }
    expect(reads, 0);
  });
}
