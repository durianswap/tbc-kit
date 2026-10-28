import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';

void main() {
  test('owned serialization matches uncached mutable input and hash', () {
    final input = {'z': ['中文🌍', 'ab' * 40000, 42, true], 'a': {'b': null}};
    final owned = frozen(input);
    final expected = canonical(input), hash = hashJson(input);
    for (var i = 0; i < 10; i++) {
      expect(canonical(owned), expected);
      expect(hashJson(owned), hash);
    }
    expect(identical(frozen(owned), owned), true);
    expect(() => (owned as Map)['z'] = [], throwsUnsupportedError);
    expect(() => ((owned as Map)['z'] as List).clear(), throwsUnsupportedError);
  });
  test('mutable caller changes are never hidden by a serialization cache', () {
    final input = {'value': [1]};
    final owned = frozen(input), previous = hashJson(input);
    input['value']!.add(2);
    expect(hashJson(input), isNot(previous));
    expect(hashJson(owned), previous);
    // A read-only outer map is not proof that its children are immutable.
    final wrapper = Map<String, dynamic>.unmodifiable(input);
    final before = canonical(wrapper);
    input['value']!.add(3);
    expect(canonical(wrapper), isNot(before));
  });
  test('bad JSON, Unicode and cycles retain rejection', () {
    final cyclic = <Object?>[];
    cyclic.add(cyclic);
    for (final value in [cyclic, double.nan, 9007199254740992,
      String.fromCharCode(0xd800), {'x': String.fromCharCode(0xdc00)}, {1: 'x'}]) {
      expect(() => canonical(value), throwsStateError);
    }
    expect(() => canonical(frozen({'x': double.nan})), throwsStateError);
  });
  test('cache eviction changes reuse only, never bytes or validation', () {
    final first = frozen({'x': 'ab' * 20000});
    final text = canonical(first);
    for (var i = 0; i < 4200; i++) { canonical(frozen({'i': i})); }
    expect(canonical(first), text);
    for (var i = 0; i < 60; i++) { canonical(frozen({'s': 'abcd' * 20000, 'i': i})); }
    expect(canonical(first), text);
  });
}
