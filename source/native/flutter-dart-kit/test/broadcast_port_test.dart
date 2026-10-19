// TEST-ONLY journal/client, no default runtime store and no live HTTP.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/configuration.dart';
import 'package:tbc_kit_flutter_dart/src/internal/broadcast_port.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';

Map<String, dynamic> identity(Map r) => {
  for (final k in [
    'idempotencyKey',
    'rawHash',
    'txid',
    'submitContextHash',
    'accountScopeHash',
  ])
    k: r[k],
};

class MemoryJournal implements BroadcastJournal {
  MemoryJournal(this.sourceIdentity);
  @override
  final String sourceIdentity;
  final rows = <String, Map<String, dynamic>>{};
  int writes = 0;
  bool failMark = false, failComplete = false;
  Completer<void>? markEntered, markRelease;
  @override
  Future<BroadcastReservation> begin(List<Map<String, dynamic>> ids) async {
    // Synchronous reservation before the Future resolves models native atomic
    // storage. This does NOT establish SQLite/process-crash durability.
    final old = [for (final id in ids) rows[id['idempotencyKey']]];
    for (var i = 0; i < old.length; i++)
      if (old[i] != null)
        need(
          canonical(identity(old[i]!)) == canonical(ids[i]),
          'TEST_IDENTITY_COLLISION',
        );
    if (old.any((r) => r != null))
      return BroadcastReservation(created: false, records: old);
    for (final id in ids)
      for (final r in rows.values)
        if (r['txid'] == id['txid'] || r['rawHash'] == id['rawHash'])
          need(r['state'] == 'not-submitted', 'TEST_TX_COLLISION');
    for (final id in ids) {
      rows[id['idempotencyKey']] = {
        ...copied(id),
        'state': 'prepared',
        'createdAt': '2026-10-13T08:00:00.000Z',
      };
      writes++;
    }
    return BroadcastReservation(
      created: true,
      records: [for (final id in ids) rows[id['idempotencyKey']]],
    );
  }

  @override
  Future<Map<String, dynamic>?> read(String key) async =>
      rows[key] == null ? null : copied(rows[key]!);
  @override
  Future<List<Map<String, dynamic>>> readByTxids(List<String> ids) async => [
    for (final r in rows.values)
      if (ids.contains(r['txid'])) copied(r),
  ];
  @override
  Future<void> markUncertain(List<Map<String, dynamic>> ids) async {
    if (failMark) throw StateError('TEST_STORE_FAILURE');
    for (final id in ids) {
      final r = rows[id['idempotencyKey']]!;
      need(canonical(identity(r)) == canonical(identity(id)), 'TEST_IDENTITY');
    }
    for (final id in ids) {
      final r = rows[id['idempotencyKey']]!;
      if (r['state'] == 'prepared') {
        r['state'] = 'uncertain';
        writes++;
      }
    }
    markEntered?.complete();
    await markRelease?.future;
  }

  @override
  Future<void> complete(
    Map<String, dynamic> id,
    Map<String, dynamic> result,
  ) async {
    if (failComplete) throw StateError('TEST_STORE_FAILURE');
    final r = rows[id['idempotencyKey']]!;
    need(
      canonical(identity(r)) == canonical(identity(id)) &&
          r['txid'] == result['txid'],
      'TEST_IDENTITY',
    );
    if (r['state'] == 'completed')
      need(
        canonical(r['result']) == canonical(result),
        'TEST_RESULT_COLLISION',
      );
    else {
      need(r['state'] != 'not-submitted', 'TEST_ABORTED');
      r['state'] = 'completed';
      r['result'] = copied(result);
      writes++;
    }
  }

  @override
  Future<void> abortPreflight(Map<String, dynamic> id, String code) async {
    need(
      {'INVALID_INPUT', 'NODE_RESPONSE_INVALID'}.contains(code),
      'TEST_ABORT_PROOF',
    );
    final r = rows[id['idempotencyKey']]!;
    need(r['state'] == 'prepared', 'TEST_ABORT_STATE');
    r['state'] = 'not-submitted';
    r['result'] = {
      'txid': id['txid'],
      'status': 'rejected',
      'reason': 'TBC Testnet transaction was not submitted',
    };
    writes++;
  }
}

class Client implements BroadcastClient {
  Client(this.sourceIdentity, this.initial)
    : mode = initial['mode'],
      preflightCode = initial['preflight'],
      statusMode = initial['status'];
  @override
  final String sourceIdentity;
  final Map initial;
  String mode, statusMode;
  String? preflightCode;
  final trace = <Map<String, dynamic>>[];
  Completer<void>? preflightEntered,
      preflightRelease,
      statusEntered,
      statusRelease;
  int get posts =>
      trace
          .where((r) => r['kind'] == 'single-post' || r['kind'] == 'batch-post')
          .length;
  String rawHash(String raw) => sha256.convert(unhex(raw)).toString();
  @override
  Future<void> preflight(String raw) async {
    trace.add({'kind': 'preflight', 'rawHash': rawHash(raw)});
    preflightEntered?.complete();
    await preflightRelease?.future;
    if (preflightCode != null) throw BroadcastNodeFailure(preflightCode!);
  }

  @override
  Future<Map<String, dynamic>> submit(String raw) async {
    trace.add({'kind': 'single-post', 'rawHash': rawHash(raw)});
    if (mode == 'timeout') throw StateError('TEST_TIMEOUT');
    return {
      'txid': mode == 'wrong-id' ? 'f' * 64 : inspectTransaction(raw)['txid'],
    };
  }

  @override
  Future<List<Map<String, dynamic>>> submitBatch(List<String> raws) async {
    trace.add({'kind': 'batch-post', 'rawHashes': raws.map(rawHash).toList()});
    if (mode == 'timeout') throw StateError('TEST_TIMEOUT');
    return [
      for (var i = 0; i < raws.length; i++)
        {
          'txid':
              mode == 'wrong-id'
                  ? 'f' * 64
                  : inspectTransaction(raws[i])['txid'],
          'status':
              mode == 'parent-rejected' && i == 0
                  ? 'rejected'
                  : mode == 'parent-unknown' && i == 0
                  ? 'unknown'
                  : 'accepted',
          if (mode == 'parent-rejected' && i == 0)
            'reason': 'public fixture rejection',
        },
    ];
  }

  @override
  Future<Map<String, dynamic>> status(String txid) async {
    trace.add({'kind': 'status', 'txid': txid});
    statusEntered?.complete();
    await statusRelease?.future;
    if (statusMode == 'timeout')
      throw const BroadcastNodeFailure('NODE_REQUEST_FAILED');
    return {
      'txid': statusMode == 'wrong-id' ? 'f' * 64 : txid,
      'status':
          statusMode == 'wrong-id'
              ? 'confirmed'
              : statusMode == 'contradiction'
              ? 'mempool'
              : statusMode,
      if ({'confirmed', 'mempool', 'contradiction'}.contains(statusMode))
        'confirmations': statusMode == 'mempool' ? '0' : '2',
    };
  }
}

class Harness {
  Harness(Map sample) {
    final options = sample['options'];
    final n =
        options['network'] == 'mainnet'
            ? TbcNetwork.mainnet
            : TbcNetwork.testnet;
    network =
        options['endpoint'] == null
            ? TbcNetworkConfiguration.official(n)
            : TbcNetworkConfiguration.trustedCustom(
              network: n,
              apiOrigin: options['endpoint']['apiOrigin'],
              rpcOrigin: options['endpoint']['rpcOrigin'],
              trustId: options['endpoint']['trustId'],
            );
    expect(broadcastSourceIdentity(network), sample['sourceIdentity']);
    client = Client(sample['sourceIdentity'], sample['initial']);
    journal = MemoryJournal(sample['sourceIdentity']);
    account = sample['initial']['account'];
    port = TbcBroadcastPort(
      network: network,
      client: client,
      journal: journal,
      accountScopeHash: () async => account,
      authorize: (c) async {
        guardCalls++;
        need(authorized, 'TEST_REVOKED');
      },
    );
  }
  late final TbcNetworkConfiguration network;
  late final Client client;
  late final MemoryJournal journal;
  late final TbcBroadcastPort port;
  late String account;
  bool authorized = true;
  int guardCalls = 0;
  Future<Map<String, dynamic>> invoke(Map a) => switch (a['kind']) {
    'single' => port.submit(a['params'], a['call']),
    'batch' => port.submitBatch(a['params'], a['call']),
    'recover' => port.recover((a['txids'] as List).cast<String>()),
    'reconcile' => port.reconcile(a['params'], a['call']),
    _ => throw StateError('TEST_ACTION'),
  };
}

void main() {
  final bytes = File('test/fixtures/broadcast-port.json').readAsBytesSync();
  if (sha256.convert(bytes).toString() !=
      '2486ddf4794c64c250749ca0030c14b6fce896ad1646aa8ca0a95a8137ddbe8d') {
    throw StateError('Frozen broadcast reference changed');
  }
  final oracle = jsonDecode(utf8.decode(bytes)) as Map;
  Map sample(String name) =>
      (oracle['cases'] as List).firstWhere((s) => s['name'] == name) as Map;
  for (final s in oracle['cases'])
    test('frozen broadcast port ${s['name']}', () async {
      final h = Harness(s), results = <Map<String, dynamic>>[];
      for (final a in s['actions']) {
        if (a['kind'] == null) {
          if (a.containsKey('mode')) h.client.mode = a['mode'];
          if (a.containsKey('preflight'))
            h.client.preflightCode = a['preflight'];
          if (a.containsKey('status')) h.client.statusMode = a['status'];
          if (a.containsKey('account')) h.account = a['account'];
        } else
          results.add(await h.invoke(a));
      }
      expect(canonical(results), canonical(s['results']));
      expect(canonical(h.client.trace), canonical(s['trace']));
      expect(
        canonical(h.journal.rows.values.toList()),
        canonical(s['records']),
      );
      for (final r in h.journal.rows.values) {
        expect(r.containsKey('rawTransaction'), false);
        expect(r.containsKey('signature'), false);
      }
    });
  test('source mismatch rejects before adapter use', () {
    final h = Harness(sample('single-accepted-replay'));
    expect(
      () => TbcBroadcastPort(
        network: h.network,
        client: h.client,
        journal: MemoryJournal('f' * 64),
        accountScopeHash: () async => h.account,
        authorize: (_) async {},
      ),
      throwsStateError,
    );
    expect(h.client.trace, isEmpty);
  });
  test('opposite official endpoint cannot claim selected chain', () {
    expect(
      () => broadcastSourceIdentity(
        TbcNetworkConfiguration.trustedCustom(
          network: TbcNetwork.testnet,
          apiOrigin: TbcNetwork.mainnet.officialApiOrigin,
          trustId: 'bad',
        ),
      ),
      throwsStateError,
    );
  });
  test('native denial precedes any journal or network action', () async {
    final s = sample('single-accepted-replay'),
        h = Harness(s)..authorized = false;
    expect((await h.invoke(s['actions'][0]))['portError']['name'], 'CONFLICT');
    expect(h.journal.writes, 0);
    expect(h.client.trace, isEmpty);
  });
  test('concurrent same submit has one POST', () async {
    final s = sample('single-accepted-replay'), h = Harness(s);
    h.client.preflightEntered = Completer();
    h.client.preflightRelease = Completer();
    final first = h.invoke(s['actions'][0]);
    await h.client.preflightEntered!.future;
    final replay = await h.invoke(s['actions'][0]);
    expect(replay['portError']['name'], 'UNAVAILABLE');
    h.client.preflightRelease!.complete();
    expect((await first)['status'], 'accepted');
    expect(h.client.posts, 1);
  });
  test('mark uncertainty failure prevents POST', () async {
    final s = sample('single-accepted-replay'), h = Harness(s);
    h.journal.failMark = true;
    expect((await h.invoke(s['actions'][0]))['portError']['name'], 'CONFLICT');
    expect(h.client.posts, 0);
  });
  test(
    'result store failure leaves uncertainty and never retries POST',
    () async {
      final s = sample('single-accepted-replay'), h = Harness(s);
      h.journal.failComplete = true;
      expect(
        (await h.invoke(s['actions'][0]))['portError']['name'],
        'CONFLICT',
      );
      expect(h.journal.rows.values.single['state'], 'uncertain');
      expect(
        (await h.invoke(s['actions'][0]))['portError']['name'],
        'UNAVAILABLE',
      );
      expect(h.client.posts, 1);
    },
  );
  test('batch duplicate race cannot split into extra single POSTs', () async {
    final s = sample('batch-accepted-replay'), h = Harness(s);
    final results = await Future.wait([
      h.invoke(s['actions'][0]),
      h.invoke(s['actions'][0]),
    ]);
    expect(results.every((r) => r['transactions'] is List), true);
    expect(h.client.posts, 1);
    expect(h.client.trace.where((r) => r['kind'] == 'single-post'), isEmpty);
  });
  test('account switch while querying cannot commit recovery', () async {
    final s = sample('single-unknown-confirmed'), h = Harness(s);
    await h.invoke(s['actions'][0]);
    h.client.statusEntered = Completer();
    h.client.statusRelease = Completer();
    final recovery = h.invoke(s['actions'][1]);
    await h.client.statusEntered!.future;
    h.account = '2' * 64;
    h.client.statusRelease!.complete();
    expect((await recovery)['portError']['name'], 'CONFLICT');
    expect(h.journal.rows.values.single['state'], 'uncertain');
    expect(h.client.posts, 1);
  });
}
