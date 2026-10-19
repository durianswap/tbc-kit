// Mapping -> existing production worker/readers -> current pinned Rust Engine.
// Native-shaped test custody replays only recorded matching public signatures.
// This is NOT the native Legacy channel, private Vault or real-chain acceptance.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/host_adapters.dart';
import 'package:tbc_kit_flutter_dart/signer_adapters.dart';
import 'package:tbc_kit_flutter_dart/src/internal/legacy_mapping.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';
import 'package:tbc_kit_flutter_dart/src/internal/signing_worker.dart';
import 'native_signing_test.dart' show FixtureOperation, FixtureBackend;

import 'support/trusted_index_candidate.dart';
import 'support/indexed_fixture.dart';

void main() {
  late Map<String, dynamic> library;
  setUpAll(() {
    final build = jsonDecode(
      File(
        Platform.environment['TBC173_BUILD_REPORT'] ??
            '/private/tmp/tbc-contract173-compute-20261014-a/build-report.json',
      ).readAsStringSync(),
    );
    library = Map<String, dynamic>.from(
      (build['builds'] as List).singleWhere(
        (v) => v['target'] == 'aarch64-apple-darwin',
      ),
    );
    expect(
      library['sha256'],
      '413559859a0fa0fed61220485ea482ca8c28f305b4145f600ff706ca3a8bd0db',
    );
    expect(
      sha256.convert(File(library['path']).readAsBytesSync()).toString(),
      library['sha256'],
    );
  });
  setUpAll(() { library = trustedIndexCandidateLibrary(); });
  for (final family
      in {
        'fungible': [
          'current-transfer-multiple-inputs',
          'historical-transfer',
          'historical-transfer-payment',
          'current-merge',
          'historical-merge',
        ],
        'stablecoin': [
          'current-coin-transfer',
          'historical-stablecoin-transfer',
          'historical-stablecoin-payment',
          'current-coin-merge',
          'historical-stablecoin-merge',
        ],
        'nft': ['historical-nft-v1'],
        'unified-pool': [
          'unified-pool2-buy',
          'unified-pool2-sell',
          'unified-pool2-add',
          'unified-pool2-remove',
          'unified-pool2-merge-ft-maintenance',
          'unified-pool2-merge-lp-maintenance',
          'unified-pool2-burn-lp-maintenance',
          'unified-lp-plain-merge',
          'unified-lp-locked-merge',
        ],
      }.entries) {
    final data = jsonDecode(
      File('test/fixtures/${family.key}-signing.json').readAsStringSync(),
    );
    for (final name in family.value) {
      test(
        '$name mapped into shared worker; one consent, same reads/bytes/fee',
        () async {
          final s = copied(
            (data['cases'] as List).singleWhere((v) => v['name'] == name),
          );
          IndexedFixture((data['cases'] as List).cast<Map>()).enrich(s);
          final old = s['request']['intent'] as Map, a = s['account'] as Map;
          final account = LegacyMappingAccount(
            chainId: a['chainId'],
            address: a['address'],
            accountId: a['accountId'],
          );
          Map<String, dynamic> mapped;
          if (family.key == 'unified-pool') {
            String display(Object amount) {
              final text = (amount as String).padLeft(7, '0');
              return '${text.substring(0, text.length - 6)}.${text.substring(text.length - 6)}';
            }

            final kind = old['type'];
            final flag = switch (kind) {
              'amm.swap' =>
                old['direction'] == 'tbc-to-ft'
                    ? 'POOLNFT_SWAP_TO_TOKEN'
                    : 'POOLNFT_SWAP_TO_TBC',
              'amm.addLiquidity' => 'POOLNFT_LP_INCREASE',
              'amm.removeLiquidity' => 'POOLNFT_LP_CONSUME',
              'amm.mergeToken' => 'POOLNFT_MERGE',
              'tbc20Lp.merge' => 'FTLP_MERGE',
              'tbc20Lp.burn' => 'POOLNFT_LP_BURN',
              _ => throw StateError('Unexpected fixture operation'),
            };
            final maintenance =
                kind == 'amm.mergeToken' || kind.startsWith('tbc20Lp.');
            mapped = mapLegacyPoolTransaction(
              {
                'flag': flag,
                'nft_contract_address': old['poolContractId'],
                if (!maintenance) ...{
                  'address': old['receiver'],
                  'broadcastEnabled': false,
                  'poolNFT_version': 2,
                  if (flag == 'POOLNFT_SWAP_TO_TOKEN' ||
                      flag == 'POOLNFT_LP_INCREASE')
                    'tbc_amount': display(old['amount']),
                  if (flag == 'POOLNFT_SWAP_TO_TBC')
                    'ft_amount': display(old['amount']),
                  if (flag == 'POOLNFT_LP_CONSUME')
                    'ft_amount': display(old['lpAmount']),
                },
              },
              account,
              ftDecimals: 6,
            );
          } else if ((old['type'] as String).endsWith('.merge')) {
            mapped = mapLegacyAssetMerge([
              {
                'flag':
                    family.key == 'fungible' ? 'FT_MERGE' : 'STABLECOIN_MERGE',
                'ft_contract_address': old['contractId'],
              },
            ], account);
          } else if (family.key == 'nft') {
            mapped = mapLegacyNftTransfer({
              'flag': 'NFT_TRANSFER',
              'nft_contract_address': old['contractId'],
              'address': old['to'],
            }, account);
          } else {
            final params = {
              'flag':
                  family.key == 'fungible'
                      ? 'FT_TRANSFER'
                      : 'STABLECOIN_TRANSFER',
              'ft_contract_address': old['contractId'],
              'address': old['to'],
              'ft_amount': old['amount'],
              'broadcastEnabled': false,
              if (old.containsKey('payment')) 'tbc_amount': '0.001',
            };
            mapped =
                family.key == 'fungible'
                    ? mapLegacyFtTransfer(
                      params,
                      account,
                      decimals: 0,
                      currentStandard: name.startsWith('current'),
                    )
                    : mapLegacyStablecoinTransfer(params, account, decimals: 0);
          }
          final request = copied(legacySharedBusinessRequest(mapped));
          expect(request['intent'], old);
          // Fixture wallet policy, not a page authority field or bypass.
          request['constraints'] = s['request']['constraints'];
          if (family.key == 'unified-pool') {
            request['constraints']['expiresAt'] = tbcProtocolTimestamp(
              DateTime.now().add(const Duration(minutes: 2)),
            );
          }
          var statusReads = 0;
          final operation = FixtureOperation(s),
              paths = <String>[],
              release = Completer<void>();
          operation.duringConsent = () async {
            // The existing worker must still overlap the initial independent reads
            // with its single consent. This translation adds no read of its own.
            final expectedInitial =
                family.key == 'unified-pool' ? 2 : 1;
            for (var i = 0; paths.length < expectedInitial && i < 300; i++) {
              await Future<void>.delayed(const Duration(milliseconds: 1));
            }
            expect(paths.length, greaterThanOrEqualTo(expectedInitial));
            expect(operation.binds, 0);
            release.complete();
          };
          final network = TbcNetworkConfiguration.official(TbcNetwork.testnet);
          final worker = await TbcSigningWorker.start(
            library: TbcPinnedComputeLibrary(
              path: library['path'],
              sha256: library['sha256'],
            ),
            network: network,
            backend: FixtureBackend(operation),
            read: (path) async {
              paths.add(path);
              await release.future;
              return copied(s['replies'][path]);
            },
            txoStatus:
                family.key == 'nft'
                    ? (txos) async {
                      statusReads++;
                      expect(txos, s['statusBody']['txos']);
                      return copied(s['statusReply']);
                    }
                    : null,
          );
          addTearDown(worker.close);
          final result = await worker.execute(
            scope: TbcSigningRequestScope(
              operationId: 'legacy-shared-$name',
              method: 'tbc_signTransaction',
              account: TbcAccount(
                network: TbcNetwork.testnet,
                address: a['address'],
                publicKey: a['publicKey'],
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
            request: request,
            requireAuthorized: () {},
            isUnlocked: () => true,
          );
          expect(result['transactions'], s['result']['transactions']);
          expect(result['totalFee'], s['result']['totalFee']);
          final expected = [
            for (final item in s['coldTrace'] as List)
              if (item is String)
                item
              else if (item['method'] == 'GET')
                item['path'],
          ];
          expect(statusReads, 0);
          // Immutable signed bytes and exact digests above remain the oracle.
          // Removed history audits/tip reads must not reappear as duplicated I/O.
          // This locked-LP fixture already carries its genesis as a direct
          // proof, so trusted poolinfo replaces no raw on this cold sample.
          // The configured index now supplies ID -> current-pool identity.
          expect(paths.length, lessThanOrEqualTo(expected.length +
              (name == 'unified-lp-locked-merge' ? 1 : 0)));
          expect(paths.length, paths.toSet().length);
          expect(operation.consents, 1);
          expect(operation.binds, 1);
          expect(operation.closes, 1);
          expect(operation.signs, (s['audit']['signatures'] as List).length);
        },
      );
    }
  }
  test(
    'excluded creation and conflicting attached payment do not get remapped',
    () {
      for (final kind in [
        'tbc.ft.create',
        'tbc.pool.create',
        'tbc.collection.create',
        'tbc.nft.mint',
      ]) {
        expect(
          () => legacySharedBusinessRequest({
            'intent': {'type': kind},
          }),
          throwsStateError,
        );
      }
      expect(
        () => legacySharedBusinessRequest({
          'intent': {
            'type': 'tbc.ft.transfer',
            'to': 'address',
            'attachedTbcAmount': '1',
            'payment': {'to': 'other', 'amount': '2'},
          },
        }),
        throwsStateError,
      );
    },
  );
}
