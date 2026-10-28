import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tbc_kit_flutter_dart/packaged_wallet.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('io.tbc.kit.dart/package');
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final path = Platform.environment['TBC_RC16_LIBRARY'];
  final hash = Platform.environment['TBC_RC16_LIBRARY_SHA256'];
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));
  test('packaged NFT reader authenticates the native artifact before queries', () async {
    expect(path, isNotNull); expect(hash, matches(RegExp(r'^[0-9a-f]{64}$')));
    var lookups = 0;
    messenger.setMockMethodCallHandler(channel, (call) async {
      expect(call.method, 'computeArtifact'); lookups++;
      return {'path': path, 'sha256': hash};
    });
    final reader = await openTbcPackagedNftReader(
      network: TbcNetworkConfiguration.official(TbcNetwork.testnet));
    expect(lookups, 1);
    reader.close();
    expect(() => reader.getMintStatus(collectionId: 'aa' * 32,
      address: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH'), throwsStateError);
  });
  test('changed packaged compute bytes fail before network queries', () async {
    expect(path, isNotNull);
    messenger.setMockMethodCallHandler(channel, (_) async =>
      {'path': path, 'sha256': '00' * 32});
    await expectLater(openTbcPackagedNftReader(
      network: TbcNetworkConfiguration.official(TbcNetwork.testnet)), throwsStateError);
  });
}
