import 'dart:async';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_wallet_binding.dart';
import 'package:tbc_kit_flutter_dart/src/internal/provider_control.dart';
import 'package:tbc_kit_flutter_dart/src/internal/wire_session.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'support/signing_replay.dart' as replay;
import 'crypto_action_test.dart' as crypto;

// Only a channel-envelope double. Actual native dispatch/emission is checked
// in the paired Kotlin/Swift executables, not claimed from this Dart mock.
class NativeChannel {
  final material = replay.Harness();
  late final navigation = material.navigation();
  late final account = TbcAccount(
    network: TbcNetwork.testnet,
    address: replay.material['account']['address'],
    publicKey: replay.material['account']['publicKey'],
  );
  late final bindings = TbcNativeWalletBindings(
    network: material.network,
    invoke: invoke,
  );
  final calls = <String>[];
  final arguments = <Map<String, Object?>>[];
  final grants = <String>{};
  final optionalMethods = <String>[];
  final replies = <String, Object?>{};
  final additional = <TbcAccount>[];
  final restrictions = <String, List<String>>{};
  Object? roleReply;
  void Function(Map<String, Object?>)? mutateSnapshot;
  int revision = 0;
  bool unlocked = true;
  String? failure;
  Completer<void>? holdBegin, beginEntered;
  Map<String, Object?> snapshot() {
    final value = <String, Object?>{
      'account': account.toKitAccount(),
      'revision': revision,
      'accountRevision': 0,
      'unlocked': unlocked,
      'optionalMethods': optionalMethods,
      'connectedAccounts':
          unlocked && grants.contains('tbc_accounts')
              ? [
                for (final a in [account, ...additional])
                  if ((restrictions['tbc_accounts'] ?? [account.accountId])
                      .contains(a.accountId))
                    a.toKitAccount(),
              ]
              : [],
      'permissions': [
        for (final name in grants)
          {
            'id': 'fixture-$name',
            'date': 1,
            'parentCapability': name,
            'invoker': navigation.origin,
            'caveats': [
              {
                'type': 'restrictChains',
                'value': [account.network.chainId],
              },
              {
                'type': 'restrictAccounts',
                'value': restrictions[name] ?? [account.accountId],
              },
              {
                'type': 'restrictMethods',
                'value': [name],
              },
            ],
          },
      ],
    };
    mutateSnapshot?.call(value);
    return value;
  }

  Future<Object?> invoke(String method, Map<String, Object?> args) async {
    expect(args['ownerId'], 'owner');
    expect(canonical(args['scope']), canonical(navigation.toWire()));
    calls.add(method);
    arguments.add(args);
    if (failure != null) return {'ok': false, 'code': failure};
    if (replies.containsKey(method))
      return {'ok': true, 'value': replies[method]};
    switch (method) {
      case 'snapshot':
        return {'ok': true, 'value': snapshot()};
      case 'permissions.request':
        grants.addAll((args['permissions'] as Map).keys.cast<String>());
        revision++;
        return {
          'ok': true,
          'value': snapshot()['permissions'],
          'snapshot': snapshot(),
        };
      case 'signing.begin':
        beginEntered?.complete();
        await holdBegin?.future;
        return {'ok': true, 'value': snapshot()};
      case 'signing.check':
      case 'delivery.prepare':
        return {'ok': true, 'value': true};
      case 'signing.roles':
        return {'ok': true, 'value': roleReply};
      default:
        return {'ok': true, 'value': null};
    }
  }

  Future<TbcNativeDocumentControl> open() => bindings.open('owner', navigation);
  TbcSigningRequestScope scope({String method = 'tbc_signMessage'}) =>
      TbcSigningRequestScope(
        operationId: 'sign',
        method: method,
        navigation: navigation,
        account: account,
        revision: revision,
      );
  TbcPermissionRequest permission() => TbcPermissionRequest(
    providerMethod: 'wallet_requestPermissions',
    operationId: 'connect',
    account: account,
    navigation: navigation,
    revision: revision,
    permissions: {
      'tbc_accounts': {
        'chains': [account.network.chainId],
      },
    },
  );
}

void main() {
  setUpAll(replay.loadReplay);
  test(
    'below-target maintenance is a private native result, not approval',
    () async {
      final h =
          NativeChannel()
            ..grants.addAll(['tbc_accounts', 'tbc_sendTransaction'])
            ..optionalMethods.add('tbc_sendTransaction');
      await h.open();
      h.replies['maintenance.noop'] = {'status': 'not-required'};
      final scope = h.scope(method: 'tbc_sendTransaction');
      await h.bindings.finishMaintenanceNoop(
        scope,
        {'consent': 'fixture'},
        {'result': 'fixture'},
      );
      expect(h.calls, ['snapshot', 'maintenance.noop']);
      expect(h.arguments.last['operation'], scope.operationId);
      expect(h.arguments.last['consent'], {'consent': 'fixture'});
      expect(h.arguments.last['result'], {'result': 'fixture'});
      h.replies['maintenance.noop'] = {'status': 'approved'};
      await expectLater(
        h.bindings.finishMaintenanceNoop(scope, {}, {}),
        throwsA(TbcWireFailure.unavailable),
      );
      await expectLater(
        h.bindings.finishMaintenanceNoop(h.scope(), {}, {}),
        throwsA(TbcWireFailure.unauthorized),
      );
    },
  );
  test(
    'maintenance native owner reuses ordinary signing child transport',
    () async {
      final h =
          NativeChannel()
            ..grants.addAll(['tbc_accounts', 'tbc_sendTransaction'])
            ..optionalMethods.add('tbc_sendTransaction');
      await h.open();
      final now = DateTime.fromMillisecondsSinceEpoch(
        DateTime.now().millisecondsSinceEpoch,
        isUtc: true,
      );
      final consent = <String, dynamic>{
        'limits': {
          'expiresAt': now.add(const Duration(minutes: 3)).toIso8601String(),
        },
      };
      // Envelope-only double. Real native scope/bounds/approval checks are in
      // MaintenanceCheck.swift/.kt, not inferred from this abbreviated input.
      h.replies['maintenance.begin'] = {
        'status': 'approved',
        'scopeHash': hashJson(consent),
        'approvalId': 'native-owned',
        'approvedAt': now.toIso8601String(),
        'expiresAt': consent['limits']['expiresAt'],
      };
      h.replies['maintenance.step'] = h.snapshot();
      final owner = await h.bindings.beginMaintenance(
        h.scope(method: 'tbc_sendTransaction'),
        consent,
      );
      expect(
        () => owner.approval['approvalId'] = 'page',
        throwsUnsupportedError,
      );
      final childScope = TbcSigningRequestScope(
        operationId: 'child',
        method: 'tbc_sendTransaction',
        navigation: h.navigation,
        account: h.account,
        revision: h.revision,
      );
      final child = await owner.beginStep(
        scope: childScope,
        step: {},
        request: {},
        selectedInputs: ['a:0'],
      );
      await child.requireCurrent();
      expect(
        h.calls,
        containsAllInOrder([
          'maintenance.begin',
          'maintenance.step',
          'signing.check',
        ]),
      );
      expect(h.calls, isNot(contains('signing.begin')));
      expect(
        h.arguments[h.calls.indexOf('maintenance.step')]['parent'],
        'sign',
      );
      await child.close();
      h.replies['maintenance.finish'] = true;
      await owner.finish({'steps': []});
      expect(h.calls, contains('maintenance.finish'));
      await expectLater(
        owner.finish({'steps': []}),
        throwsA(isA<TbcWireFailure>()),
      );
      await owner.close();
      await owner.close();
      expect(h.calls.where((m) => m == 'maintenance.close').length, 1);
      await expectLater(
        owner.beginStep(
          scope: childScope,
          step: {},
          request: {},
          selectedInputs: [],
        ),
        throwsA(isA<TbcWireFailure>()),
      );
    },
  );
  test('maintenance foreign native approval is rejected and closed', () async {
    final h =
        NativeChannel()
          ..grants.addAll(['tbc_accounts', 'tbc_sendTransaction'])
          ..optionalMethods.add('tbc_sendTransaction');
    await h.open();
    h.replies['maintenance.begin'] = {
      'status': 'approved',
      'scopeHash': 'foreign',
      'approvalId': 'x',
      'approvedAt': '2026-10-14T00:00:00Z',
      'expiresAt': '2026-10-14T00:01:00Z',
    };
    await expectLater(
      h.bindings.beginMaintenance(h.scope(method: 'tbc_sendTransaction'), {
        'limits': {'expiresAt': '2099-01-01T00:00:00Z'},
      }),
      throwsA(isA<TbcWireFailure>()),
    );
    expect(
      h.calls,
      containsAllInOrder(['maintenance.begin', 'maintenance.close']),
    );
  });
  test(
    'switch grant stays chain scoped and grants no signing authority',
    () async {
      final h =
          NativeChannel()..grants.addAll(['tbc_accounts', 'tbc_switchChain']);
      final control = await h.open();
      expect(control.permits('tbc_switchChain'), isTrue);
      expect(control.permits('tbc_signMessage'), isFalse);
      expect(control.permits('tbc_signTransaction'), isFalse);
      final foreign =
          NativeChannel()..grants.addAll(['tbc_accounts', 'tbc_switchChain']);
      foreign.mutateSnapshot = (value) {
        for (final record in value['permissions'] as List) {
          if (record['parentCapability'] == 'tbc_switchChain') {
            (record['caveats'] as List).first['value'] = ['tbc:mainnet'];
          }
        }
      };
      await expectLater(foreign.open(), throwsFormatException);
    },
  );
  for (final method in [
    'tbc_encrypt',
    'tbc_signWorkflow',
    'tbc_signPreparedWorkflow',
  ]) {
    test(
      'crypto unavailable classification belongs only to workflow crypto: $method',
      () async {
        final h =
            NativeChannel()
              ..grants.addAll([
                'tbc_accounts',
                'tbc_crypto',
                'tbc_signWorkflow',
              ])
              ..optionalMethods.addAll(['tbc_encrypt', 'tbc_decrypt']);
        await h.open();
        final op =
            await h.bindings.begin(h.scope(method: method))
                as TbcCryptoSigningOperation;
        final task = TbcCryptoTask(crypto.fixture['cases'][0]['audit']['task']);
        h.failure = 'NATIVE_WORKFLOW_CRYPTO_UNAVAILABLE';
        await expectLater(
          op.executeCrypto(TbcSigningReceipt({}), task),
          method == 'tbc_encrypt'
              ? throwsA(TbcWireFailure.unauthorized)
              : throwsA(
                isA<TbcWorkflowStepUnavailable>().having(
                  (e) => e.operation,
                  'operation',
                  'crypto.execute',
                ),
              ),
        );
        await expectLater(
          op.requireCurrent(),
          throwsA(TbcWireFailure.unauthorized),
        );
        await expectLater(
          op.sign(TbcSigningReceipt({}), TbcSigningTask({})),
          throwsA(TbcWireFailure.unauthorized),
        );
        h.failure = 'NATIVE_WORKFLOW_STEP_UNAVAILABLE';
        await expectLater(
          op.executeCrypto(TbcSigningReceipt({}), task),
          throwsA(TbcWireFailure.unauthorized),
        );
        h.failure = null;
        await op.close();
      },
    );
  }
  for (final index in [0, 1]) {
    test(
      'crypto native channel preserves exact typed payload $index',
      () async {
        final h =
            NativeChannel()
              ..grants.addAll(['tbc_accounts', 'tbc_crypto'])
              ..optionalMethods.addAll(['tbc_encrypt', 'tbc_decrypt']);
        final sample = crypto.fixture['cases'][index], audit = sample['audit'];
        await h.open();
        final op =
            await h.bindings.begin(h.scope(method: sample['method']))
                as TbcCryptoSigningOperation;
        final task = TbcCryptoTask(audit['task']),
            receipt = TbcSigningReceipt(audit['approval']);
        h.replies['signing.crypto'] = audit['cryptoResult'];
        expect(
          canonical((await op.executeCrypto(receipt, task)).wire),
          canonical(audit['cryptoResult']),
        );
        expect(h.calls.last, 'signing.crypto');
        expect(canonical(h.arguments.last['task']), canonical(task.wire));
        for (final changed in [
          {...audit['cryptoResult'], 'taskId': 'other'},
          {...audit['cryptoResult'], 'algorithm': 'other'},
          {...audit['cryptoResult'], 'extra': 'not-allowed'},
          {'taskId': task.taskId, 'algorithm': task.algorithm},
        ]) {
          h.replies['signing.crypto'] = changed;
          await expectLater(
            op.executeCrypto(receipt, task),
            throwsA(TbcWireFailure.unavailable),
          );
        }
        await op.close();
      },
    );
  }
  test('crypto callback cannot be used from ordinary signing scope', () async {
    final h =
        NativeChannel()..grants.addAll(['tbc_accounts', 'tbc_signMessage']);
    await h.open();
    final op = await h.bindings.begin(h.scope()) as TbcCryptoSigningOperation;
    await expectLater(
      op.executeCrypto(
        TbcSigningReceipt({}),
        TbcCryptoTask(crypto.fixture['cases'][0]['audit']['task']),
      ),
      throwsA(TbcWireFailure.unauthorized),
    );
    expect(h.calls.contains('signing.crypto'), false);
    await op.close();
  });
  for (final method in [
    'tbc_signWorkflow',
    'tbc_signPreparedWorkflow',
    'tbc_signTransaction',
  ]) {
    test(
      'typed native step failure is signing/workflow-only: $method',
      () async {
        final h = NativeChannel();
        h.grants.addAll([
          'tbc_accounts',
          method == 'tbc_signTransaction'
              ? 'tbc_signTransaction'
              : 'tbc_signWorkflow',
        ]);
        await h.open();
        final op = await h.bindings.begin(h.scope(method: method));
        final task = TbcSigningTask({
          'taskId': 'public-fixture',
          'signatureEncoding': 'compact64',
        });
        h.failure = 'NATIVE_WORKFLOW_STEP_UNAVAILABLE';
        await expectLater(
          op.sign(TbcSigningReceipt({}), task),
          method == 'tbc_signTransaction'
              ? throwsA(TbcWireFailure.unauthorized)
              : throwsA(isA<TbcWorkflowStepUnavailable>()),
        );
        // A similarly named code on a non-sign callback is never recoverable.
        await expectLater(
          op.requireCurrent(),
          throwsA(TbcWireFailure.unauthorized),
        );
        h.failure = 'private-untrusted-error';
        await expectLater(
          op.sign(TbcSigningReceipt({}), task),
          throwsA(TbcWireFailure.unauthorized),
        );
        h.failure = null;
        await op.close();
      },
    );
  }
  for (final grant in ['tbc_signTransaction', 'tbc_signMessage', 'none']) {
    test(
      'Reviewed native channel retains base grant and private fields: $grant',
      () async {
        final h = NativeChannel();
        h.grants.add('tbc_accounts');
        if (grant != 'none') h.grants.add(grant);
        await h.open();
        final scope = h.scope(method: 'tbc_signReviewedTransaction');
        if (grant != 'tbc_signTransaction') {
          await expectLater(
            h.bindings.begin(scope),
            throwsA(TbcWireFailure.unauthorized),
          );
          expect(h.calls, ['snapshot']);
          return;
        }
        h.replies['signing.consent'] = true;
        h.replies['signing.bind'] = <String, dynamic>{};
        final op = await h.bindings.begin(scope);
        expect(
          await op.requestConsent(
            TbcBoundedSigningIntent(
              method: scope.method,
              request: const {'source': 'private-test-only'},
              context: const {},
              review: const {'reviewHash': 'trusted-test-only'},
            ),
          ),
          true,
        );
        expect(h.arguments.last['review'], {'reviewHash': 'trusted-test-only'});
        await op.bind(
          TbcSigningMaterial(
            binding: const {},
            preview: const {},
            reviewed: const {
              'kind': 'reviewed',
              'stage': {'private': 'witness-test-only'},
            },
          ),
        );
        expect(h.arguments.last['reviewed'], {
          'kind': 'reviewed',
          'stage': {'private': 'witness-test-only'},
        });
        expect(h.grants.contains('tbc_signReviewedTransaction'), false);
        await op.close();
      },
    );
  }
  for (final grant in ['tbc_signTransaction', 'tbc_signMessage', 'none']) {
    test(
      'Prepared native channel requires base transaction grant: $grant',
      () async {
        final h = NativeChannel();
        h.grants.add('tbc_accounts');
        if (grant != 'none') h.grants.add(grant);
        await h.open();
        if (grant != 'tbc_signTransaction') {
          await expectLater(
            h.bindings.begin(h.scope(method: 'tbc_signPreparedTransaction')),
            throwsA(TbcWireFailure.unauthorized),
          );
          expect(h.calls, ['snapshot']);
        } else {
          final op = await h.bindings.begin(
            h.scope(method: 'tbc_signPreparedTransaction'),
          );
          expect(h.arguments.last['method'], 'tbc_signPreparedTransaction');
          await op.requireCurrent();
          h.grants.remove(grant);
          h.revision++;
          h.bindings.authorityChanged(
            'owner',
            h.navigation.toWire(),
            h.snapshot(),
          );
          await expectLater(
            op.requireCurrent(),
            throwsA(TbcWireFailure.unauthorized),
          );
          expect(h.grants.contains('tbc_signPreparedTransaction'), false);
        }
      },
    );
  }
  TbcAccount controller() => TbcAccount(
    network: TbcNetwork.testnet,
    address: '1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',
    publicKey:
        '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
  );
  test(
    'connected roles expose only granted identities and separate metadata permission',
    () async {
      final h = NativeChannel(), role = controller();
      h.additional.add(role);
      h.grants.addAll(['tbc_accounts', 'tbc_accountMetadata']);
      h.restrictions['tbc_accounts'] = [h.account.accountId, role.accountId];
      final d = await h.open();
      expect(d.connectedAccounts.map((a) => a.accountId), [
        h.account.accountId,
        role.accountId,
      ]);
      expect(d.selectedAccount.accountId, h.account.accountId);
      expect(d.permitsAccount('tbc_accountMetadata', role), false);
      h.restrictions['tbc_accountMetadata'] = [
        h.account.accountId,
        role.accountId,
      ];
      h.revision++;
      h.bindings.authorityChanged('owner', h.navigation.toWire(), h.snapshot());
      expect(d.permitsAccount('tbc_accountMetadata', role), true);
      h.additional.clear();
      h.revision++;
      h.bindings.authorityChanged('owner', h.navigation.toWire(), h.snapshot());
      expect(d.connectedAccounts, hasLength(1));
      expect(d.permitsAccount('tbc_accountMetadata', role), false);
      h.unlocked = false;
      h.revision++;
      h.bindings.authorityChanged('owner', h.navigation.toWire(), h.snapshot());
      expect(d.connectedAccounts, isEmpty);
      expect(h.calls, ['snapshot']);
    },
  );
  for (final bad in [
    'ungranted',
    'duplicate',
    'wrong-chain',
    'reordered',
    'same-revision',
  ]) {
    test('native account catalog rejects $bad selection', () async {
      final h = NativeChannel(), role = controller();
      h.grants.add('tbc_accounts');
      final d = await h.open();
      h.mutateSnapshot = (s) {
        final list = s['connectedAccounts'] as List;
        switch (bad) {
          case 'ungranted':
            list.add(role.toKitAccount());
          case 'duplicate':
            list.add(h.account.toKitAccount());
          case 'wrong-chain':
            list.add({...role.toKitAccount(), 'chainId': 'tbc:mainnet'});
          case 'reordered':
            list.insert(0, role.toKitAccount());
          case 'same-revision':
            s['connectedAccounts'] = [];
        }
      };
      if (bad != 'same-revision') h.revision++;
      h.bindings.authorityChanged('owner', h.navigation.toWire(), h.snapshot());
      expect(d.requireCurrent, throwsA(TbcWireFailure.unauthorized));
    });
  }
  test(
    'private role resolution binds exact intent without consent or a grant write',
    () async {
      final h = NativeChannel(), role = controller();
      h.grants.addAll(['tbc_accounts', 'tbc_signTransaction']);
      h.roleReply = [role.toKitAccount()];
      await h.open();
      final op = await h.bindings.begin(h.scope(method: 'tbc_signTransaction'));
      final request = {
        'signingRoles': [
          {'role': 'pool-controller', 'accountId': role.accountId},
        ],
      };
      final selected = await (op as TbcTransactionSigningRoles)
          .resolveSigningAccounts(
            TbcBoundedSigningIntent(
              method: 'tbc_signTransaction',
              request: request,
              context: const {},
            ),
          );
      expect(selected.single.accountId, role.accountId);
      expect(canonical(h.arguments.last['request']), canonical(request));
      expect(h.calls, ['snapshot', 'signing.begin', 'signing.roles']);
      await op.close();
    },
  );
  for (final bad in [
    'non-list',
    'primary-echo',
    'wrong-chain',
    'extra-identity',
    'extra-field',
  ]) {
    test('private role response rejects $bad', () async {
      final h = NativeChannel(), role = controller();
      h.grants.addAll(['tbc_accounts', 'tbc_signTransaction']);
      await h.open();
      final op = await h.bindings.begin(h.scope(method: 'tbc_signTransaction'));
      h.roleReply = switch (bad) {
        'non-list' => {},
        'primary-echo' => [h.account.toKitAccount()],
        'wrong-chain' => [
          {...role.toKitAccount(), 'chainId': 'tbc:mainnet'},
        ],
        'extra-identity' => [role.toKitAccount(), role.toKitAccount()],
        _ => [
          {...role.toKitAccount(), 'trusted': true},
        ],
      };
      await expectLater(
        (op as TbcTransactionSigningRoles).resolveSigningAccounts(
          TbcBoundedSigningIntent(
            method: 'tbc_signTransaction',
            request: const {},
            context: const {},
          ),
        ),
        throwsA(TbcWireFailure.unavailable),
      );
      await op.close();
    });
  }
  test(
    'native commit updates cached identity and preserves provider method',
    () async {
      final h = NativeChannel();
      final d = await h.open();
      expect(d.permits('tbc_accounts'), isFalse);
      final records = await d.requestPermissions(h.permission());
      expect(d.revision, 1);
      expect(d.permits('tbc_accounts'), isTrue);
      expect(h.arguments.last['providerMethod'], 'wallet_requestPermissions');
      expect(
        () => records.single['invoker'] = 'https://forged.invalid',
        throwsUnsupportedError,
      );
      for (var i = 0; i < 20; i++) {
        expect(d.selectedAccount.accountId, h.account.accountId);
        expect(d.currentPermissions(), records);
      }
      expect(h.calls, ['snapshot', 'permissions.request']);
    },
  );
  test('native user rejection remains 4001 without native details', () async {
    final h = NativeChannel();
    final d = await h.open();
    h.failure = 'USER_REJECTED';
    await expectLater(
      d.requestPermissions(h.permission()),
      throwsA(TbcWireFailure.rejected),
    );
    h.failure = 'private-untrusted-error';
    await expectLater(
      d.beforeDelivery('tbc_accounts', 1, '{}'),
      throwsA(TbcWireFailure.unauthorized),
    );
    expect(d.revision, 0);
    expect(d.permits('tbc_accounts'), isFalse);
  });
  test('cancel while begin awaits closes the late native handle', () async {
    final h = NativeChannel();
    h.grants.addAll(['tbc_accounts', 'tbc_signMessage']);
    final d = await h.open();
    h.holdBegin = Completer<void>();
    h.beginEntered = Completer<void>();
    final pending = h.bindings.begin(h.scope());
    final rejected = expectLater(pending, throwsA(TbcWireFailure.unauthorized));
    await h.beginEntered!.future;
    await d.cancel('sign');
    h.holdBegin!.complete();
    await rejected;
    expect(h.calls, [
      'snapshot',
      'signing.begin',
      'operation.cancel',
      'signing.close',
    ]);
  });
  test(
    'native revision change fences operations, stale notifications do not roll back',
    () async {
      final h = NativeChannel();
      h.grants.addAll(['tbc_accounts', 'tbc_signMessage']);
      final d = await h.open();
      final old = h.snapshot(), op = await h.bindings.begin(h.scope());
      var notifications = 0;
      d.onAuthorityChanged = () => notifications++;
      h.revision++;
      h.unlocked = false;
      h.bindings.authorityChanged('owner', h.navigation.toWire(), h.snapshot());
      expect(d.currentPermissions(), isEmpty);
      await expectLater(
        op.requireCurrent(),
        throwsA(TbcWireFailure.unauthorized),
      );
      h.bindings.authorityChanged('owner', h.navigation.toWire(), old);
      expect(d.isUnlocked, isFalse);
      expect(notifications, 1);
      await op.close();
      await op.close();
      expect(h.calls.where((m) => m == 'signing.close').length, 1);
    },
  );
  test(
    'wrong-document event ignored, inconsistent same-revision state closes owner',
    () async {
      final h = NativeChannel();
      final d = await h.open();
      h.unlocked = false;
      h.bindings.authorityChanged(
        'other-owner',
        h.navigation.toWire(),
        h.snapshot(),
      );
      expect(d.isUnlocked, isTrue);
      h.bindings.authorityChanged('owner', h.navigation.toWire(), h.snapshot());
      expect(d.requireCurrent, throwsA(TbcWireFailure.unauthorized));
      await Future<void>.delayed(Duration.zero);
      expect(h.calls.last, 'document.invalidate');
    },
  );
  test(
    'delivery preparation is a private native call and is never a page callback',
    () async {
      final h = NativeChannel();
      final d = await h.open();
      await d.beforeDelivery('tbc_accounts', 'accounts', '{"result":[]}');
      expect(h.arguments.last['method'], 'tbc_accounts');
      expect(h.arguments.last['requestId'], 'accounts');
      expect(h.calls, ['snapshot', 'delivery.prepare']);
      d.invalidate();
      await expectLater(
        d.beforeDelivery('tbc_accounts', 'accounts', '{}'),
        throwsA(TbcWireFailure.unauthorized),
      );
    },
  );
}
