import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/wallet.dart';
import 'package:tbc_kit_flutter_dart/src/internal/transaction_read.dart';
import 'package:tbc_kit_flutter_dart/src/internal/tbc20_material.dart';

const publicAddress = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const publicKey =
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

void main() {
  test('frozen network defaults and wallet identity remain configurable', () {
    final main = TbcNetworkConfiguration.official(TbcNetwork.mainnet);
    final testnet = TbcNetworkConfiguration.official(TbcNetwork.testnet);
    expect(main.chainId, 'tbc:mainnet');
    expect(main.apiOrigin, 'https://api.turingbitchain.io');
    expect(testnet.chainId, 'tbc:testnet');
    expect(testnet.apiOrigin, 'https://api.tbcdev.org');
    final wallet = TbcWalletConfiguration(
      productId: 'partner.example',
      name: 'Partner Wallet',
      profile: 'partner',
      network: main,
    );
    expect(wallet.name, 'Partner Wallet');
    expect(wallet.legacy, isTrue);
    expect(wallet.capabilityScopes, isEmpty);
    expect(tbcDefaultDerivationPath, "m/44'/236'/0'/1/0");
  });

  test(
    'trusted custom source is exact-origin and cannot come from a URL path',
    () {
      final custom = TbcNetworkConfiguration.trustedCustom(
        network: TbcNetwork.testnet,
        apiOrigin: 'https://devapi.tbcdev.org',
        trustId: 'partner-testnet',
      );
      expect(custom.chainId, 'tbc:testnet');
      for (final bad in [
        'http://devapi.tbcdev.org',
        'https://devapi.tbcdev.org/path',
        'https://user@devapi.tbcdev.org',
        'https://devapi.tbcdev.org?network=mainnet',
      ]) {
        expect(
          () => TbcNetworkConfiguration.trustedCustom(
            network: TbcNetwork.testnet,
            apiOrigin: bad,
            trustId: 'partner',
          ),
          throwsFormatException,
        );
      }
    },
  );

  test(
    'same address is not network authority; bind account to explicit chain',
    () {
      for (final n in TbcNetwork.values) {
        final account =
            TbcAccount(
              network: n,
              address: publicAddress,
              publicKey: publicKey,
            ).toKitAccount();
        expect(
          inspectAccount(account, expectedChainId: n.chainId)['scriptPubKey'],
          '76a914751e76e8199196d454941c45d1b3a323f1433bd688ac',
        );
        final other =
            n == TbcNetwork.mainnet ? TbcNetwork.testnet : TbcNetwork.mainnet;
        expect(
          () => inspectAccount(account, expectedChainId: other.chainId),
          throwsStateError,
        );
      }
    },
  );

  test(
    'wrong configured chain stops before any material read or keyless call',
    () async {
      var reads = 0, computes = 0;
      final reader = Tbc20MaterialReader(
        network: TbcNetworkConfiguration.official(TbcNetwork.mainnet),
        read: (path) async {
          reads++;
          throw StateError('not reached');
        },
        keyless: (op, args) {
          computes++;
          throw StateError('not reached');
        },
      );
      final account =
          TbcAccount(
            network: TbcNetwork.testnet,
            address: publicAddress,
            publicKey: publicKey,
          ).toKitAccount();
      await expectLater(
        reader.resolve(
          request: {'chainId': 'tbc:testnet', 'from': publicAddress},
          account: account,
          now: DateTime.now().toUtc(),
          snapshotId: 'wrong-network',
        ),
        throwsStateError,
      );
      expect(reads, 0);
      expect(computes, 0);
    },
  );
}
