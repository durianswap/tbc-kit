// Public synthetic LP fragments. Rust/WASM independently pinned the bytes.
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'native_signing_test.dart' show FixtureOperation;
import 'support/trusted_index_candidate.dart';

void main() {
  final cases =
      (jsonDecode(
                File('test/fixtures/lp-staged-signing.json').readAsStringSync(),
              )['cases']
              as List)
          .cast<Map>();
  final library = trustedIndexCandidateLibrary();
  final engine = ComputeProbe(DynamicLibrary.open(library['path']));
  for (final original in cases) {
    test(
      '${original['name']}: exact bytes, one approval, one prepare',
      () async {
        final s = copied(original), op = FixtureOperation(s);
        final phases = <String>[];
        var prepares = 0;
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
          prepareMaterial: (_, __) async {
            prepares++;
            return copied(s['audit']['material']);
          },
          timing: (name, _) => phases.add(name),
        );
        final result = await executor.execute(s['method'], s['request']);
        final stages = (s['audit']['stages'] as List).length;
        expect(canonical(result), canonical(s['result']));
        expect(
          [prepares, op.consents, op.binds, op.advances, op.signs, op.closes],
          [1, 1, 1, stages - 1, (s['audit']['signatures'] as List).length, 1],
        );
        expect(
          phases.where((p) => p == 'validate:finalized'),
          hasLength(stages),
        );
        expect(phases.where((p) => p == 'validate:pre-sign'), hasLength(1));
      },
    );
  }
  for (final failure in ['cancel', 'expiry', 'bad-parent-signature']) {
    test('LP intermediate $failure never authorizes the child', () async {
      final s = copied(cases[2]), op = FixtureOperation(s);
      var now = protocolTime(s['now']);
      if (failure == 'bad-parent-signature') {
        op.alterSignature = (sig) => sig['signature'] = '00' * 64;
      } else {
        op.duringAdvance = () async {
          if (failure == 'cancel') {
            op.active = false;
          } else {
            now = now.add(const Duration(hours: 1));
          }
        };
      }
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
          clock: () => now,
        ),
        prepareMaterial: (_, __) async => copied(s['audit']['material']),
      );
      await expectLater(
        executor.execute(s['method'], s['request']),
        throwsA(isA<StateError>()),
      );
      expect(
        [op.consents, op.binds, op.signs, op.closes],
        [1, 1, (s['audit']['stages'][0]['tasks'] as List).length, 1],
      );
    });
  }
}
