// Private-channel envelope/port/client integration with a TEST-ONLY store and
// wire double. Native SQLite/HTTP/custody proof lives in SendCustodyCheck.
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/broadcast_port.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_broadcast_binding.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';
import 'package:tbc_kit_flutter_dart/src/internal/wire_session.dart';
import 'native_wallet_binding_test.dart' show NativeChannel;
import 'broadcast_port_test.dart' show MemoryJournal;
import 'support/signing_replay.dart' as replay;

final class Channel extends NativeChannel {
  late final source = broadcastSourceIdentity(material.network);
  late final journal = MemoryJournal(source);
  final selections = <int?, Map<String, dynamic>>{};
  int posts = 0, gets = 0, authorizations = 0;
  bool unknownPost = false, foreignSource = false;
  Map? retained;
  Map? finished;
  bool refuseFinish = false;
  @override
  Future<Object?> invoke(String method, Map<String, Object?> args) async {
    if (!method.startsWith('signing.broadcast.'))
      return super.invoke(method, args);
    expect(args['ownerId'], 'owner');
    expect(canonical(args['scope']), canonical(navigation.toWire()));
    calls.add(method);
    arguments.add(args);
    Object? value;
    final index = args['index'] as int?;
    switch (method) {
      case 'signing.broadcast.authorize':
        expect(authorizations++, 0);
        retained = args['bundle'] as Map;
        value = true;
      case 'signing.broadcast.open':
        expect(retained, isNotNull);
        expect(selections.containsKey(index), false);
        selections[index] = copied(args['call'] as Map);
        value = {
          'sourceIdentity': foreignSource ? '0' * 64 : source,
          'accountScopeHash': hashJson(account.toKitAccount()),
        };
      case 'signing.broadcast.finish':
        expect(retained, isNotNull);
        expect(finished, isNull);
        expect(posts, greaterThan(0));
        if (!refuseFinish) finished = args['result'] as Map;
        value = !refuseFinish;
      case 'signing.broadcast.guard':
        expect(canonical(args['call']), canonical(selections[index]));
        value = true;
      case 'signing.broadcast.journal':
        expect(selections.containsKey(index), true);
        final p = args['arguments'] as Map;
        switch (args['action']) {
          case 'begin':
            final r = await journal.begin([
              for (final v in p['identities']) copied(v),
            ]);
            value = {'created': r.created, 'records': r.records};
          case 'read':
            value = await journal.read(p['key']);
          case 'readByTxids':
            value = await journal.readByTxids(
              (p['txids'] as List).cast<String>(),
            );
          case 'admit':
            await journal.markUncertain([
              for (final v in p['identities']) copied(v),
            ]);
            value = true;
          case 'complete':
            await journal.complete(copied(p['identity']), {
              'txid': p['identity']['txid'],
              'status': p['status'],
            });
            value = true;
          case 'abortPreflight':
            await journal.abortPreflight(copied(p['identity']), p['code']);
            value = true;
          default:
            fail('Unexpected journal action');
        }
      case 'signing.broadcast.wire':
        expect(selections.containsKey(index), true);
        expect(
          (args['url'] as String).startsWith(material.network.apiOrigin),
          true,
        );
        expect(
          DateTime.parse(args['deadline'] as String).isAfter(DateTime.now()),
          true,
        );
        Map<String, Object?> data;
        if (args['method'] == 'POST') {
          posts++;
          final body = jsonDecode(args['body'] as String);
          if (unknownPost) return {'ok': false, 'code': 'NODE_REQUEST_FAILED'};
          if (body is List) {
            data = {
              'success': body.length,
              'failed': 0,
              'results': [
                for (final tx in body) inspectTransaction(tx['txraw'])['txid'],
              ],
            };
          } else {
            data = {'txid': inspectTransaction(body['txraw'])['txid']};
          }
        } else {
          gets++;
          expect(args['method'], 'GET');
          data = {
            'txid': (args['url'] as String).split('/').last,
            'confirmations': 2,
          };
        }
        value = {
          'statusCode': 200,
          'body': base64Encode(
            utf8.encode(jsonEncode({'code': 200, 'data': data})),
          ),
        };
      default:
        fail('Unexpected native broadcast command');
    }
    return {'ok': true, 'value': value};
  }

  Future<TbcBroadcastSigningOperation> beginSend(Map sample) async {
    grants.addAll(['tbc_accounts', 'tbc_sendTransaction', 'tbc_signWorkflow']);
    optionalMethods.add(sample['method'] as String);
    await open();
    return await bindings.begin(scope(method: sample['method']))
        as TbcBroadcastSigningOperation;
  }
}

void main() {
  setUpAll(replay.loadReplay);
  final fixture = jsonDecode(
    File('test/fixtures/send-lifecycle.json').readAsStringSync(),
  );
  final cases =
      (fixture['cases'] as List)
          .where((c) => c['scenario'] == 'accepted')
          .cast<Map>()
          .toList();
  TbcSigningReceipt receipt(Map s) => TbcSigningReceipt(s['audit']['approval']);
  TbcBroadcastMaterial material(Map s) => TbcBroadcastMaterial(
    bundle: s['audit']['bundle'],
    workflow: s['audit']['workflow'],
  );
  for (final s in cases) {
    test('shared port and REST through native binding: ${s['name']}', () async {
      final h = Channel();
      final sender = await h.beginSend(s);
      await sender.authorizeBroadcast(receipt(s), material(s));
      final rows = s['audit']['bundle']['transactions'] as List;
      if (s['workflow'] == true) {
        final r = (await sender.submitBatch(receipt(s))).wire;
        expect(
          (r['transactions'] as List).every((t) => t['status'] == 'accepted'),
          true,
        );
        expect(h.posts, 1);
      } else {
        for (var i = 0; i < rows.length; i++) {
          expect(
            (await sender.submitTransaction(receipt(s), i)).wire['status'],
            'accepted',
          );
        }
        expect(h.posts, rows.length);
      }
      expect(h.gets, 0);
      expect(h.authorizations, 1);
      expect(
        h.journal.rows.values.every((r) => r['state'] == 'completed'),
        true,
      );
      expect(h.calls.where((c) => c == 'signing.consent'), isEmpty);
      await sender.close();
      await expectLater(
        sender.submitTransaction(receipt(s), 0),
        throwsA(anything),
      );
    });
  }
  final single = cases.first;
  test(
    'private worker command cannot override its native operation or owner',
    () async {
      final h = Channel(), op = await h.beginSend(single);
      final channel = op as NativeBroadcastCommands;
      final before = h.calls.length;
      for (final fields in [
        {'ownerId': 'foreign'},
        {'scope': <String, String>{}},
        {'operation': 'foreign'},
      ]) {
        expect(
          () => channel.invokeBroadcast('signing.broadcast.guard', fields),
          throwsA(TbcWireFailure.unauthorized),
        );
      }
      expect(
        () => channel.invokeBroadcast('signing.sign', {}),
        throwsA(TbcWireFailure.unauthorized),
      );
      expect(h.calls.length, before);
      expect(h.posts, 0);
      await op.close();
    },
  );
  test(
    'one ambiguous POST reconciles with one GET and never resends',
    () async {
      final h = Channel()..unknownPost = true;
      final op = await h.beginSend(single);
      await op.authorizeBroadcast(receipt(single), material(single));
      expect(
        (await op.submitTransaction(
          receipt(single),
          0,
        )).wire['portError']['retryable'],
        true,
      );
      final ids = [
        single['audit']['bundle']['transactions'][0]['txid'] as String,
      ];
      expect(
        (await op.reconcileSubmitted(
          receipt(single),
          ids,
        )).wire['transactions'][0]['status'],
        'confirmed',
      );
      expect(
        (await op.submitTransaction(receipt(single), 0)).wire['status'],
        'known',
      );
      expect(h.posts, 1);
      expect(h.gets, 1);
      await op.close();
    },
  );
  test(
    'source mismatch, grant loss, replacement receipt and non-prefix deny',
    () async {
      final h = Channel();
      final op = await h.beginSend(single);
      await op.authorizeBroadcast(receipt(single), material(single));
      await expectLater(
        op.submitTransaction(TbcSigningReceipt({}), 0),
        throwsA(anything),
      );
      await expectLater(
        op.reconcileSubmitted(receipt(single), ['0' * 64]),
        throwsA(anything),
      );
      h.grants.remove('tbc_sendTransaction');
      h.bindings.authorityChanged(
        'owner',
        h.navigation.toWire(),
        h.snapshot()..['revision'] = 1,
      );
      await expectLater(
        op.submitTransaction(receipt(single), 0),
        throwsA(anything),
      );
      expect(h.posts, 0);
      await op.close();
      final foreign = Channel()..foreignSource = true;
      final other = await foreign.beginSend(single);
      await other.authorizeBroadcast(receipt(single), material(single));
      await expectLater(
        other.submitTransaction(receipt(single), 0),
        throwsA(anything),
      );
      expect(foreign.posts, 0);
      expect(foreign.journal.writes, 0);
      await other.close();
    },
  );
  test('send permission is not implied by workflow signing grant', () async {
    final h =
        Channel()
          ..grants.addAll(['tbc_accounts', 'tbc_signWorkflow'])
          ..optionalMethods.add('tbc_sendWorkflow');
    await h.open();
    await expectLater(
      h.bindings.begin(h.scope(method: 'tbc_sendWorkflow')),
      throwsA(TbcWireFailure.unauthorized),
    );
    expect(h.calls.contains('signing.begin'), false);
  });
  test('send grants cannot enable an unregistered native sender', () async {
    final h = Channel()..grants.addAll(['tbc_accounts', 'tbc_sendTransaction']);
    await h.open();
    await expectLater(
      h.bindings.begin(h.scope(method: 'tbc_sendTransaction')),
      throwsA(TbcWireFailure.unauthorized),
    );
    expect(h.calls.contains('signing.begin'), false);
  });
}
