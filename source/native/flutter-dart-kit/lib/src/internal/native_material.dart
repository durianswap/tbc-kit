// TBC transfer/maintenance and current creation read plans from frozen Kit.
// No parent reads, signing, UI, broadcast or local UTXO reservation. Exact input
// selection, signed-size fee and change calculation remain in the Rust Engine.
import '../configuration.dart';
import '../host_environment.dart';
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'tbc20_material.dart' show ApiRead;
import 'utxo_pages.dart';

final class NativeMaterialReader {
  NativeMaterialReader({
    required this.network,
    required this.read,
    this.maxInputs = 128,
  }) {
    need(maxInputs >= 1 && maxInputs <= 256, 'INPUT_LIMIT');
  }
  final TbcNetworkConfiguration network;
  final ApiRead read;
  final int maxInputs;

  Future<Map<String, dynamic>> resolve({
    required Map<String, dynamic> request,
    required Map<String, dynamic> account,
    required DateTime now,
    required String snapshotId,
    String minConfirmations = '0',
  }) async {
    final owner = inspectAccount(account, expectedChainId: network.chainId);
    need(
      request['chainId'] == network.chainId &&
          request['from'] == account['address'],
      'REQUEST_ACCOUNT',
    );
    final intent = request['intent'];
    need(
      intent is Map &&
          [
            'tbc.transfer',
            'tbc.maintenance.merge',
            'tbc-timelock-lock',
            'tbc-htlc-lock',
            'tbc-htlc-claim',
            'tbc-htlc-refund',
            'tbc20-standard-create',
            'tbc721-standard-create-collection',
            'tbc721-standard-mint',
            'tbc721-standard-batch-mint',
            'tbc-amm-create',
            'tbc-amm-add-liquidity',
            'tbc-amm-remove-liquidity',
            'tbc-amm-swap',
            'tbc20-lp-transfer',
            'tbc20-lp-merge',
            'tbc20-lp-lock',
            'tbc20-lp-unlock',
            'tbc.pool.swap.exactTbcForToken',
            'tbc.pool.swap.exactTokenForTbc',
            'tbc.pool.liquidity.add',
            'tbc.pool.liquidity.remove',
            'tbc.pool.ft.merge',
            'tbc.pool.ftlp.merge',
            'tbc.pool.ftlp.burn',
          ].contains(intent['type']),
      'NATIVE_PROFILE',
    );
    final transfer = intent['type'] == 'tbc.transfer';
    final timelock = intent['type'] == 'tbc-timelock-lock';
    final htlc = [
      'tbc-htlc-lock',
      'tbc-htlc-claim',
      'tbc-htlc-refund',
    ].contains(intent['type']);
    need(
      !htlc ||
          intent['type'] == 'tbc-htlc-lock' ||
          [
            'tbc20-standard',
            'tbc20-stablecoin',
          ].contains(intent['assetStandard']),
      'NATIVE_HTLC_TOKEN_FUNDING_ONLY',
    );
    final pool2 = (intent['type'] as String).startsWith('tbc.pool.');
    final ammBusiness = [
      'tbc-amm-add-liquidity',
      'tbc-amm-remove-liquidity',
      'tbc-amm-swap',
    ].contains(intent['type']);
    final lp = [
      'tbc20-lp-transfer',
      'tbc20-lp-merge',
      'tbc20-lp-lock',
      'tbc20-lp-unlock',
    ].contains(intent['type']);
    final amm = intent['type'] == 'tbc-amm-create' || ammBusiness || lp;
    final mint = [
      'tbc721-standard-mint',
      'tbc721-standard-batch-mint',
    ].contains(intent['type']);
    final creation = [
      'tbc20-standard-create',
      'tbc721-standard-create-collection',
      'tbc-amm-create',
    ].contains(intent['type']);
    final amount =
        transfer ? BigInt.parse(uintString(intent['amount'])) : BigInt.zero;
    need(!transfer || amount > BigInt.zero, 'NATIVE_AMOUNT');
    uintString(
      minConfirmations,
    ); // Engine enforces the floor on the descriptors.
    final points = (request['constraints'] as Map?)?['inputOutpoints'];
    if (points != null) {
      need(
        (transfer ||
                creation ||
                mint ||
                ammBusiness ||
                lp ||
                timelock ||
                htlc) &&
            points is List &&
            points.isNotEmpty &&
            points.length <= maxInputs,
        'REQUESTED_INPUTS',
      );
      final seen = <String>{};
      for (final p in points) {
        need(
          p is Map &&
              p.length == 2 &&
              p['vout'] is int &&
              p['vout'] >= 0 &&
              p['vout'] <= 0xffffffff,
          'REQUESTED_INPUTS',
        );
        need(seen.add('${hash32(p['txid'])}:${p['vout']}'), 'REQUESTED_INPUTS');
      }
    }
    final needsTip = minConfirmations != '0' || timelock ||
        (htlc && intent['type'] != 'tbc-htlc-claim');
    final replies = await Future.wait([
      needsTip ? read('/api/tbc/nodeinfo') : Future<Map<String, dynamic>>.value({}),
      collectUtxoPages(
        read,
        '/api/tbc/utxo/address/${account['address']}',
        maxRows: 256,
      ),
    ]);
    final tip = replies[0], height = needsTip ? BigInt.parse(uintString(tip['blocks'])) : null;
    if (needsTip) hash32(tip['bestblockhash']);
    final raw = replies[1]['utxos'];
    need(raw is List && raw.length <= 256, 'NATIVE_CANDIDATE_BOUND');
    final seen = <String>{}, candidates = <Map<String, dynamic>>[];
    for (final row in raw) {
      need(row is Map, 'UTXO_ROW');
      final id = hash32(row['txid']),
          v = BigInt.parse(uintString(row['index'])),
          value = BigInt.parse(uintString(row['value']));
      final h =
          row['height'] == -1 || row['height'] == '-1'
              ? BigInt.zero
              : BigInt.parse(uintString(row['height']));
      need(
        v <= BigInt.from(0xffffffff) &&
            value > BigInt.zero &&
            value <= BigInt.parse('18446744073709551615') &&
            (height == null || h <= height),
        'NATIVE_DESCRIPTOR',
      );
      need(seen.add('$id:$v'), 'DUPLICATE_UTXO');
      candidates.add({
        'txid': id,
        'vout': v.toInt(),
        'satoshis': '$value',
        'height': '$h',
      });
    }
    int outpoint(Map a, Map b) {
      final c = (a['txid'] as String).compareTo(b['txid']);
      return c != 0 ? c : (a['vout'] as int).compareTo(b['vout']);
    }

    int ascending(Map a, Map b) {
      final c = BigInt.parse(
        a['satoshis'],
      ).compareTo(BigInt.parse(b['satoshis']));
      return c != 0 ? c : outpoint(a, b);
    }

    candidates.sort(outpoint);
    late List<Map<String, dynamic>> selected;
    if (pool2) {
      // Historical Pool2 supplies all largest-first alternatives. Its Engine
      // selects one funding coin; do not apply current AMM's 100-coin window.
      selected =
          candidates.toList()..sort((a, b) {
            final value = BigInt.parse(
              b['satoshis'],
            ).compareTo(BigInt.parse(a['satoshis']));
            return value != 0 ? value : outpoint(a, b);
          });
    } else if (ammBusiness && points == null) {
      // Frozen AMM authenticates only the preferred funding parent. Keep its
      // largest-first confirmed alternatives, bounded at 100, not LP/creation
      // outpoint order or a full-parent read for every fee candidate.
      final floor = BigInt.parse(minConfirmations);
      selected =
          candidates
              .where(
                (c) =>
                    floor == BigInt.zero || (c['height'] == '0'
                        ? BigInt.zero
                        : height! - BigInt.parse(c['height']) + BigInt.one) >=
                    floor,
              )
              .toList()
            ..sort((a, b) {
              final value = BigInt.parse(
                b['satoshis'],
              ).compareTo(BigInt.parse(a['satoshis']));
              return value != 0 ? value : outpoint(a, b);
            });
      selected = selected.take(maxInputs < 100 ? maxInputs : 100).toList();
    } else if (creation || mint || ammBusiness || lp || timelock || htlc) {
      // Frozen creation policy supplies all candidates, sorted by outpoint.
      // Engine chooses funding/consolidation; do not reuse transfer selection.
      selected =
          candidates
              .where(
                (c) =>
                    points == null ||
                    (points as List).any(
                      (p) => p['txid'] == c['txid'] && p['vout'] == c['vout'],
                    ),
              )
              .toList();
      need(
        mint ||
            lp ||
            ammBusiness ||
            points == null ||
            selected.length == (points as List).length,
        'REQUESTED_INPUT_MISSING',
      );
      need(!ammBusiness || selected.length == 1, 'AMM_EXPLICIT_NATIVE_INPUT');
    } else if (transfer && points != null) {
      selected = [
        for (final p in points)
          candidates.singleWhere(
            (c) => c['txid'] == p['txid'] && c['vout'] == p['vout'],
          ),
      ];
    } else if (transfer) {
      final single =
          candidates
              .where(
                (u) => BigInt.parse(u['satoshis']) >= amount + BigInt.from(104),
              )
              .toList()
            ..sort(ascending);
      if (single.isNotEmpty) {
        selected = [single.first];
      } else {
        selected =
            (candidates.toList()..sort((a, b) {
                  final c = BigInt.parse(
                    b['satoshis'],
                  ).compareTo(BigInt.parse(a['satoshis']));
                  return c != 0 ? c : outpoint(a, b);
                }))
                .take(maxInputs)
                .toList();
        need(
          selected.fold<BigInt>(
                BigInt.zero,
                (sum, u) => sum + BigInt.parse(u['satoshis']),
              ) >=
              amount + BigInt.from(80),
          'NATIVE_INSUFFICIENT',
        );
      }
    } else {
      selected =
          (candidates.toList()..sort(ascending))
              .take(maxInputs < 100 ? maxInputs : 100)
              .toList();
      need(selected.length >= 2, 'MERGE_REQUIRES_TWO_INPUTS');
    }
    // AMM supplies bounded funding alternatives; the Engine selects one, not
    // all alternatives as transaction inputs. Business material counts assets.
    need(
      selected.isNotEmpty &&
          selected.length <=
              (amm || pool2 || timelock || htlc ? 256 : maxInputs),
      'INPUT_BUDGET',
    );
    final payload = <String, dynamic>{
      'version': '1.0',
      'snapshotId': snapshotId,
      'chainId': network.chainId,
      if (needsTip) 'block': {
        'height': '$height',
        'hash': tip['bestblockhash'],
        if ((ammBusiness || lp || htlc) && tip['mediantime'] != null)
          'medianTimePast': uintString(tip['mediantime']),
      },
      'capturedAt': tbcProtocolTimestamp(now),
      'expiresAt': tbcProtocolTimestamp(now.add(const Duration(minutes: 2))),
      'account': account,
      'utxos': [
        for (final u in selected)
          {
            'txid': u['txid'],
            'vout': u['vout'],
            'satoshis': u['satoshis'],
            'scriptPubKey': owner['scriptPubKey'],
            if (height != null || u['height'] == '0') 'confirmations':
                u['height'] == '0'
                    ? '0'
                    : '${height! - BigInt.parse(u['height']) + BigInt.one}',
            'classification': 'native',
          },
      ],
      'parents': <Object>[],
      'contracts': <Object>[],
    };
    return {'payload': payload, 'snapshotHash': hashJson(payload)};
  }
}
