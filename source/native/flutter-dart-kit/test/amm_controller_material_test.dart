// Public synthetic fixtures only. These tests do not grant native custody or
// substitute for the separately tested shared worker/native custody adapter.
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/amm_business_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_compute.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/operation_authority.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_executor.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_policy.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_signing_roles.dart';
import 'native_signing_test.dart' show FixtureOperation;
import 'support/trusted_index_candidate.dart';
import 'support/indexed_fixture.dart';

void main() {
  late Map fixture;
  late ComputeProbe engine;
  late IndexedFixture indexed;
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  setUpAll(() {
    fixture = jsonDecode(
      File('test/fixtures/amm-controller-signing.json').readAsStringSync(),
    );
    final library =
        jsonDecode(
          File('test/fixtures/signing/replay.json').readAsStringSync(),
        )['library'];
    expect(
      sha256.convert(File(library['path']).readAsBytesSync()).toString(),
      library['sha256'],
    );
    engine = ComputeProbe(DynamicLibrary.open(trustedIndexCandidateLibrary()['path']));
    indexed = IndexedFixture((fixture['cases'] as List).cast<Map>());
  });
  Map<String, dynamic> sample(int i) {
    final s = copied(fixture['cases'][i]);
    indexed.projectAmm(s);
    return s;
  }
  TransactionSigningAccounts accounts(Map s) =>
      TransactionSigningAccounts.resolve(
        request: s['request'],
        primary: s['account'],
        additional:
            (s['additionalAccounts'] as List).map((a) => copied(a)).toList(),
      );
  Map<String, dynamic> call(String op, Map input) =>
      copied(jsonDecode(engine.call('engine', op, canonical(input))));
  AmmBusinessMaterialReader reader(ApiRead read) {
    Map<String, dynamic> keyless(String op, Map<String, dynamic> input) =>
        copied(jsonDecode(engine.call('keyless', op, canonical(input))));
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

  Future<Map<String, dynamic>> resolve(AmmBusinessMaterialReader r, Map s) =>
      r.resolve(
        request: s['request'],
        account: s['account'],
        now: protocolTime(s['now']),
        snapshotId: s['snapshotId'],
        minConfirmations: s['minConfirmations'],
        signingAccounts:
            (s['additionalAccounts'] as List).map((a) => copied(a)).toList(),
      );

  for (var i = 0; i < 8; i++) {
    test(
      'controller AMM $i exact frozen cold/warm material, plan and signed result',
      () async {
        final s = sample(i), paths = <String>[], role = accounts(s);
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
          expect(paths.toSet().length, paths.length);
          role.requireSnapshot(snapshot['payload']);
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
          final planned = call('plan', input);
          expect(planned['ok'], true, reason: planned['error']?.toString());
          final plan = planned['result']['plan'];
          expect(canonical(plan), canonical(s['audit']['plan']));
          expect(
            canonical(plan['payload']['preview']['signingRoles']),
            canonical(role.roles),
          );
          final tasks = plan['payload']['signingTasks'] as List;
          role.requireTasks(tasks);
          expect(
            tasks
                .where((t) => t['accountId'] == role.controller!['accountId'])
                .length,
            1,
          );
          expect(
            call('validate', {
              ...input,
              'plan': plan,
              'phase': 'plan',
            })['result']['valid'],
            true,
          );
          final bound = {
            ...input,
            'plan': plan,
            'binding': s['audit']['binding'],
            'approval': s['audit']['approval'],
          };
          expect(
            call('validate', {
              ...bound,
              'phase': 'pre-sign',
            })['result']['valid'],
            true,
          );
          final signed = {...bound, 'signatures': s['audit']['signatures']};
          final result = call('finalize', signed);
          expect(result['ok'], true, reason: result['error']?.toString());
          expect(canonical(result['result']['bundle']), canonical(s['result']));
          expect(
            call('validate', {
              ...signed,
              'phase': 'finalized',
              'bundle': result['result']['bundle'],
            })['result']['valid'],
            true,
          );
        }
      },
    );
  }

  for (final bad in [
    'missing',
    'duplicate',
    'unrequested',
    'empty-roles',
    'unknown-role',
    'role-chain',
    'account-chain',
    'account-address',
    'account-key',
    'wrong-selection',
    'profile',
    'role-extra-field',
  ]) {
    test('controller identity $bad fails before network reads', () async {
      final s = sample(0),
          request = s['request'] as Map,
          extra = s['additionalAccounts'] as List;
      switch (bad) {
        case 'missing':
          extra.clear();
        case 'duplicate':
          extra.add(copied(extra.single));
        case 'unrequested':
          request.remove('signingRoles');
        case 'empty-roles':
          request['signingRoles'] = [];
        case 'unknown-role':
          request['signingRoles'][0]['role'] = 'coin-admin';
        case 'role-chain':
          request['signingRoles'][0]['accountId'] =
              'tbc:mainnet:${extra.single['address']}';
        case 'account-chain':
          extra.single['chainId'] = 'tbc:mainnet';
        case 'account-address':
          extra.single['address'] = s['account']['address'];
        case 'account-key':
          extra.single['publicKey'] = s['account']['publicKey'];
        case 'wrong-selection':
          request['signingRoles'][0]['accountId'] = s['account']['accountId'];
        case 'profile':
          request['intent']['type'] = 'tbc-amm-create';
        case 'role-extra-field':
          request['signingRoles'][0]['publicKey'] = extra.single['publicKey'];
      }
      var reads = 0;
      final r = reader((_) async {
        reads++;
        throw StateError('unexpected read');
      });
      await expectLater(resolve(r, s), throwsA(isA<StateError>()));
      expect(reads, 0);
    });
  }
  test(
    'role identity captures trusted accounts and forbids mutable substitution',
    () {
      final s = sample(0),
          role = accounts(s),
          id = role.controller!['accountId'];
      s['additionalAccounts'][0]['accountId'] = 'changed';
      s['request']['signingRoles'][0]['accountId'] = 'changed';
      expect(role.controller!['accountId'], id);
      expect(
        () => role.controller!['accountId'] = 'changed',
        throwsUnsupportedError,
      );
      expect(() => role.additional.clear(), throwsUnsupportedError);
    },
  );
  test(
    'primary account may fill explicit controller role without extra custody account',
    () {
      final s = sample(0);
      s['request']['signingRoles'][0]['accountId'] = s['account']['accountId'];
      s['additionalAccounts'] = [];
      final role = accounts(s);
      expect(role.additional, isEmpty);
      expect(canonical(role.controller), canonical(s['account']));
      role.requireSnapshot({'account': s['account']});
      expect(
        () => role.requireSnapshot({
          'account': s['account'],
          'signingAccounts': [],
        }),
        throwsStateError,
      );
    },
  );
  test(
    'snapshot cannot substitute controller account or inject unused identity',
    () {
      final s = sample(0), role = accounts(s);
      final snapshot = copied(s['audit']['material']['snapshot']['payload']);
      role.requireSnapshot(snapshot);
      snapshot['signingAccounts'] = [s['account']];
      expect(() => role.requireSnapshot(snapshot), throwsStateError);
      snapshot['signingAccounts'] = [s['additionalAccounts'][0], s['account']];
      expect(() => role.requireSnapshot(snapshot), throwsStateError);
    },
  );
  test('signing tasks must pair the exact selected account and public key', () {
    final s = sample(0), role = accounts(s);
    final tasks =
        (s['audit']['plan']['payload']['signingTasks'] as List)
            .map((t) => copied(t))
            .toList();
    role.requireTasks(tasks);
    tasks.first['publicKey'] = s['account']['publicKey'];
    expect(() => role.requireTasks(tasks), throwsStateError);
    tasks.first['accountId'] = 'tbc:testnet:foreign';
    expect(() => role.requireTasks(tasks), throwsStateError);
  });
  test(
    'controller identity helper is not public worker custody authorization',
    () async {
      final s = sample(0), op = FixtureOperation(s);
      var preparations = 0;
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
          preparations++;
          throw StateError('must not prepare');
        },
      );
      await expectLater(
        executor.execute(s['method'], s['request']),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'reason',
            'ROLE_ADAPTER_REQUIRED',
          ),
        ),
      );
      expect(
        [preparations, op.consents, op.binds, op.signs, op.closes],
        [0, 0, 0, 0, 1],
      );
    },
  );
}
