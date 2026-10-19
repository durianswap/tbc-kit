import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/workflow_json.dart';

void main() {
  final fixture = jsonDecode(
    File('test/fixtures/workflow-json.json').readAsStringSync(),
  );
  for (var i = 0; i < (fixture['cases'] as List).length; i++) {
    test('embedded JSON binding matches JavaScript stringify $i', () {
      final c = fixture['cases'][i];
      expect(
        bindWorkflowJsonMessage(
          c['input'],
          c['field'],
          (c['txids'] as List).cast<String>(),
        ),
        c['expected'],
      );
    });
  }
  test('binding does not reinterpret unsafe keys or scalar targets', () {
    for (final text in ['[]', '{"constructor":{}}', '{"txids":1}']) {
      expect(
        () => bindWorkflowJsonMessage(text, 'txids', []),
        throwsStateError,
      );
    }
  });
}
