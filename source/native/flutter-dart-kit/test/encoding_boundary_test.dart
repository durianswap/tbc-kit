import 'dart:convert';
import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/protocol_codec.dart';

void main() {
  test('base64 linear grammar preserves all short alphabet and padding cases', () {
    final previous=RegExp(r'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$');
    const alphabet=['A','/','=','!','\n'];
    void visit(String s,int remaining) {
      expect(base64Text(s),previous.hasMatch(s),reason:jsonEncode(s));
      if(remaining>0)for(final c in alphabet)visit(s+c,remaining-1);
    }
    visit('',6);
    for(final size in [0,1,2,3,65535,65536,65537,131136]) {
      final encoded=base64Encode(List.generate(size,(i)=>i%256));
      expect(base64Text(encoded),isTrue);
      expect(base64Text(encoded+'!'),isFalse);
    }
    expect(base64Text('AB=='),isTrue); // Existing nonzero padding bits allowed.
    // Dart's canonical decoder rejects nonzero padding bits before the
    // explicit round-trip guard. Preserve that rejection, including its type.
    expect(() => messageBytes({'encoding':'base64','data':'AB=='}),throwsFormatException);
  });
  test('hex grammar remains lowercase and even, including long crypto input', () {
    for(final input in ['', '00','abcdef','a','AB','0g','00\n']) {
      expect(lowerHexText(input),RegExp(r'^(?:[0-9a-f]{2})*$').hasMatch(input));
    }
    expect(unhex('01'*65536),hasLength(65536));
  });
}
