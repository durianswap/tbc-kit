import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/queries.dart';
import 'package:tbc_kit_flutter_dart/src/internal/nft_mint_job_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/nft_mint_job.dart';
import 'package:tbc_kit_flutter_dart/src/internal/collection_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/native_material.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';

void main() {
  final f = copied(
    jsonDecode(File('test/fixtures/rc16-material.json').readAsStringSync()),
  );
  final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
  for (final n in [100, 101])
    test('$n slots share three reads, no tip or balance probes', () async {
      final now = DateTime.fromMillisecondsSinceEpoch(
            DateTime.now().millisecondsSinceEpoch,
            isUtc: true,
          ),
          account = copied(f['account']),
          counts = <String, int>{},
          promises = <String, Future<Map<String, dynamic>>>{};
      Future<Map<String, dynamic>> read(String p) =>
          promises.putIfAbsent(p, () async {
            counts[p] = (counts[p] ?? 0) + 1;
            if (p.startsWith('/api/tbc/utxo/address/'))
              return {
                'utxos': [
                  {
                    'txid': f['funding']['txid'],
                    'index': 0,
                    'value': '9000000',
                    'height': 830000,
                  },
                ],
              };
            if (p.startsWith('/api/tbc/utxo/scriptpubkeyhash/'))
              return {
                'utxos': [
                  for (var i = 1; i <= 101; i++)
                    {
                      'txid': f['collection']['txid'],
                      'index': i,
                      'value': '100',
                      'height': 830000,
                    },
                ],
              };
            if (p == '/api/tbc/txraw/txid/${f['collection']['txid']}')
              return {'txraw': f['collection']['raw']};
            throw StateError('EXTRA_READ');
          });
      final scope = nftMintJobScope(
        authority: {
          ...account,
          'origin': 'https://wallet.example',
          'sessionId': 'nft-test',
        }..remove('publicKey'),
        collectionId: f['collection']['txid'],
        items: [
          for (var i = 1; i <= n; i++)
            {
              'slot': i,
              'name': 'NFT $i',
              'symbol': 'NFT',
              'description': '',
              'attributes': [],
            },
        ],
        limits: {
          'maxTotalFee': '1000000',
          'expiresAt': now.add(const Duration(minutes: 5)).toIso8601String(),
        },
        validateRequest: (_) {},
      );
      final reader = CollectionMaterialReader(
        network: network,
        read: read,
        status: (_) async => throw StateError('EXTRA_STATUS'),
        readHistory:
            (id) async => inspectTransaction(
              (await read('/api/tbc/txraw/txid/$id'))['txraw'],
              id,
            ),
        funding: NativeMaterialReader(network: network, read: read),
      );
      final material = await NftMintJobMaterial.prepare(
        scope: scope,
        account: account,
        resolve:
            (request) => reader.resolve(
              request: request,
              account: account,
              now: now,
              snapshotId: 'mint-test',
            ),
      );
      expect(counts.length, 3);
      expect(counts.values.every((n) => n == 1), true);
      final snapshot = material.snapshot([1, 2, 3]);
      expect(snapshot['payload']['utxos'], hasLength(4));
      expect(snapshot['snapshotHash'], hashJson(snapshot['payload']));
      snapshot['payload']['utxos'].clear();
      expect(material.snapshot([1])['payload']['utxos'], hasLength(2));
      expect(() => material.snapshot([1, 1]), throwsStateError);
      expect(
        () => material.acceptValidatedBatch(
          [1],
          [
            {
              'txid': f['funding']['txid'],
              'rawTransaction': f['funding']['raw'],
            },
          ],
        ),
        throwsStateError,
      );
      expect(material.snapshot([1])['payload']['utxos'], hasLength(2));
      expect(counts.length, 3);
    });
}
