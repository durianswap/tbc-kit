import 'dart:async';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/nft_mint_job.dart';

final now = DateTime.utc(2026, 10, 28);
NftJobMap scope(int n, {String fee = '1000'}) => nftMintJobScope(
  authority: {
    'chainId': 'tbc:testnet',
    'address': 'owner',
    'accountId': 'tbc:testnet:owner',
    'origin': 'https://wallet.example',
    'sessionId': 'session',
  },
  collectionId: 'ab' * 32,
  items: [
    for (var i = 1; i <= n; i++)
      {
        'slot': i,
        'name': 'NFT $i',
        'symbol': 'NFT',
        'description': 'test',
        'attributes': [],
      },
  ],
  limits: {
    'maxTotalFee': fee,
    'expiresAt': now.add(const Duration(minutes: 5)).toIso8601String(),
  },
  validateRequest: (r) {
    expect((r['intent']['items'] as List).length, lessThanOrEqualTo(100));
  },
);

final class Adapter extends NftMintJobAdapter {
  int approvals = 0, reads = 0, executions = 0;
  bool loaded = false;
  final ready = Completer<void>();
  final requests = <NftJobMap>[];
  String? reason;
  int? failAt;
  @override
  Future<void> requireCurrent() async {}
  @override
  Future<void> prepare(NftJobMap s) async {
    reads++;
    loaded = true;
    ready.complete();
  }

  @override
  Future<void> approve(NftJobMap s) async {
    approvals++;
    await ready.future;
    expect(loaded, true);
  }

  @override
  Future<NftJobMap> execute(NftJobMap r, int offset) async {
    executions++;
    requests.add(r);
    final count = (r['intent']['items'] as List).length;
    return {
      'status': executions == failAt ? 'uncertain' : 'complete',
      'offset': offset,
      'count': count,
      'transactions': [
        for (var i = 0; i < count; i++) {'status': 'accepted', 'fee': '1'},
      ],
    };
  }

  @override
  Future<NftJobMap> finish(String value) async {
    reason = value;
    return {'reason': value};
  }
}

void main() {
  test('Dart microseconds truncate expiry without extending authority', () {
    expect(
      nftMintJobTime('2026-10-28T01:02:03.123456Z'),
      '2026-10-28T01:02:03.123Z',
    );
    expect(
      () => nftMintJobTime('2026-02-30T01:02:03.123456Z'),
      throwsStateError,
    );
    expect(
      () => nftMintJobTime('2026-10-28T01:02:03.123456+08:00'),
      throwsStateError,
    );
  });
  for (final n in [1, 10, 100, 101, 2000])
    test('$n items preserve one approval and ordered batches', () async {
      final a = Adapter();
      await NftMintJob(a, clock: () => now).run(scope(n, fee: '3000'));
      expect(a.approvals, 1);
      expect(a.reads, 1);
      expect(a.executions, (n + 9) ~/ 10);
      expect(a.reason, 'complete');
      final all = [for (final r in a.requests) ...r['intent']['items'] as List];
      expect(
        all.map((i) => i['slot']).toList(),
        List.generate(n, (i) => i + 1),
      );
      expect(
        a.requests.last['constraints']['maxFee'],
        '${3000 - ((n - 1) ~/ 10) * 10}',
      );
    });
  test('unknown submission stops without rebuilding or replay', () async {
    final a = Adapter()..failAt = 2;
    await NftMintJob(a, clock: () => now).run(scope(101));
    expect(a.executions, 2);
    expect(a.reason, 'submission-uncertain');
    expect(a.approvals, 1);
  });
  test('scope captures mutations, recipients and duplicate slots', () {
    final s = scope(101);
    expect((s['items'] as List).every((i) => i['to'] == 'owner'), true);
    expect(() => s['items'][0]['name'] = 'changed', throwsUnsupportedError);
    expect(() => scope(2001), throwsStateError);
    expect(() => scope(0), throwsStateError);
  });
  test('expired scope starts no read or approval', () async {
    final a = Adapter();
    await expectLater(
      NftMintJob(
        a,
        clock: () => now.add(const Duration(hours: 1)),
      ).run(scope(100)),
      throwsStateError,
    );
    expect(a.reads, 0);
    expect(a.approvals, 0);
  });
  test('running task cannot share an approval with another manifest', () async {
    final a = Adapter();
    final job = NftMintJob(a, clock: () => now);
    final first = job.run(scope(101));
    await expectLater(job.run(scope(100)), throwsStateError);
    await first;
    expect(a.approvals, 1);
  });
}
