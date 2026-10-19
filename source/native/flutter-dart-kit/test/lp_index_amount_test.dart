import 'package:test/test.dart';
import 'package:tbc_kit_flutter_dart/src/internal/lp_material.dart';
void main(){
 test('official LP REST balances and canonical fixture fields agree',(){
  for(final row in [
   {'lp_balance':90000,'tbc_balance':500},
   {'ft_value':'90000','tbc_value':'500'},
   {'balance':'90000','value':500},
   {'lp_balance':90000,'ft_value':'90000','tbc_balance':500,'tbc_value':'500'},
  ]){expect(lpIndexAmount(row),'90000');expect(lpIndexAmount(row,native:true),'500');}
 });
 test('conflicting aliases and malformed amounts reject',(){
  for(final row in <Map>[
   {},{'lp_balance':-1},{'lp_balance':1.5},{'lp_balance':'1.0'},
   {'lp_balance':'1','ft_value':'2'},
  ])expect(()=>lpIndexAmount(row),throwsStateError);
  expect(()=>lpIndexAmount({'tbc_balance':500,'tbc_value':499},native:true),throwsStateError);
 });
 test('large atomic amounts remain exact strings',(){
  expect(lpIndexAmount({'lp_balance':'9007199254740993'}),'9007199254740993');
 });
}
