import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tbc_kit_flutter_dart/packaged_wallet.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('io.tbc.kit.dart/package');
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));
  test('package pin adapter uses only the private artifact method', () async {
    var calls = 0;
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls++;
      expect(call.method, 'computeArtifact');
      expect(call.arguments, isNull);
      return {'path': '/application/native/engine', 'sha256': 'ab' * 32};
    });
    final library = await tbcPackagedComputeLibrary();
    expect(library.sha256, 'ab' * 32);
    expect(calls, 1);
  });
  test('missing registration and malformed pins fail closed', () async {
    await expectLater(tbcPackagedComputeLibrary(), throwsA(isA<MissingPluginException>()));
    for (final value in [
      null,
      {'path': '/application/native/engine'},
      {'path': '/application/native/engine', 'sha256': 'ab' * 32, 'approved': true},
      {'path': 'https://page.example/engine', 'sha256': 'ab' * 32},
      {'path': '/application/native/engine', 'sha256': 'invalid'},
    ]) {
      messenger.setMockMethodCallHandler(channel, (_) async => value);
      await expectLater(tbcPackagedComputeLibrary(), throwsA(anyOf(isA<StateError>(), isA<FormatException>())));
    }
  });
}
