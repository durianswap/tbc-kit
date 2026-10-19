// Immutable identity from the configured trusted index and local templates.
// Cache metadata, not balances, UTXOs, permissions or Pool reserves.
import 'dart:convert';
import 'dart:typed_data';
import '../configuration.dart';
import 'protocol_codec.dart';
import 'tbc20_material.dart';
import 'transaction_read.dart';

final class FungibleMetadata {
  const FungibleMetadata({
    required this.contractId,
    required this.family,
    required this.current,
    required this.decimals,
    required this.name,
    required this.symbol,
  });
  final String contractId, family, name, symbol;
  final bool current;
  final int decimals;
}

final class PoolTokenIdentity {
  const PoolTokenIdentity({
    required this.poolContractId,
    required this.ftContractId,
    required this.current,
  });
  final String poolContractId, ftContractId;
  final bool current;
}

/// One instance shares one material-reader/network/source lifetime. Parsed
/// immutable identity is bounded separately from the shared raw-parent cache.
final class AssetMetadataReader {
  AssetMetadataReader({required this.history});
  final Tbc20MaterialReader history;
  TbcNetworkConfiguration get network => history.network;
  final _tokens = <String, FungibleMetadata>{};
  final _pools = <String, PoolTokenIdentity>{};
  final _tokenPending = <String, Future<FungibleMetadata>>{};
  final _poolPending = <String, Future<PoolTokenIdentity>>{};

  Future<FungibleMetadata> ft(String id) async {
    final result = await _indexedMetadata(id, false);
    need(result.family == 'tbc20', 'METADATA_FT_FAMILY');
    return result;
  }

  Future<FungibleMetadata> stablecoin(String id) async {
    final result = await _indexedMetadata(id, true);
    need(result.family == 'tbc20Stablecoin', 'METADATA_COIN_FAMILY');
    return result;
  }

  Future<FungibleMetadata> poolFt(String id) async =>
      ft((await poolToken(id)).ftContractId);

  final _indexedPending=<String,Future<FungibleMetadata>>{};
  Future<FungibleMetadata> _indexedMetadata(String id,bool coin){
    hash32(id);
    final family=coin?'tbc20Stablecoin':'tbc20';
    final cached=_tokens[id];
    if(cached!=null){need(cached.family==family,'METADATA_FAMILY');return Future.value(cached);}
    final key='$family:$id';
    if(_indexedPending.containsKey(key))return _indexedPending[key]!;
    need(_indexedPending.length<32,'METADATA_IN_FLIGHT_BOUND');
    return _indexedPending[key]=()async{
      try{
        final indexed=await readIndexedFungible(history.read,history.keyless,id,coin:coin),info=indexed['info'];
        final decimals=int.parse(uintString(info['decimal'])),name=info['name'],symbol=info['symbol'];
        need(decimals<=18&&name is String&&symbol is String&&name.isNotEmpty&&symbol.isNotEmpty&&
            utf8.encode(name).length<=256&&utf8.encode(symbol).length<=256,'METADATA_IDENTITY');
        final result=FungibleMetadata(contractId:id,family:family,current:indexed['identity']['generation']=='current',
            decimals:decimals,name:name,symbol:symbol);
        if(_tokens.length>=128)_tokens.remove(_tokens.keys.first);
        return _tokens[id]=result;
      }finally{_indexedPending.remove(key);}
    }();
  }

  Future<FungibleMetadata> fungible(String id) {
    hash32(id);
    final cached = _tokens[id];
    if (cached != null) return Future.value(cached);
    final pending = _tokenPending[id];
    if (pending != null) return pending;
    need(_tokenPending.length < 32, 'METADATA_IN_FLIGHT_BOUND');
    return _tokenPending[id] = () async {
      try {
        final origin = await history.parent(id),
            hint = await history.fungibleOrigin(id);
        final family = hint['family'] as String,
            current = hint['generation'] == 'current';
        final outputs = origin['outputs'] as List;
        final tape = outputs[family == 'tbc20' ? 1 : 2] as Map;
        need(tape['satoshis'] == '0', 'METADATA_TAPE_VALUE');
        final fields = _pushes(
          unhex(tape['scriptPubKey']),
          start: 2,
          opReturn: true,
        );
        late int decimals;
        late String name, symbol;
        if (family == 'tbc20Stablecoin') {
          need(
            fields.length == 2 && hex(fields.last) == '4e54617065',
            'METADATA_CERTIFICATE',
          );
          final data = jsonDecode(utf8.decode(fields.first));
          need(
            data is Map &&
                data['coinDecimal'] is int &&
                data['coinTotalSupply'] == '0' &&
                data['nftName'] is String &&
                data['nftSymbol'] is String,
            'METADATA_CERTIFICATE',
          );
          decimals = data['coinDecimal'];
          final n = data['nftName'] as String, s = data['nftSymbol'] as String;
          need(n.endsWith(' NFT') && s.endsWith(' NFT'), 'METADATA_COIN_NAME');
          name = n.substring(0, n.length - 4);
          symbol = s.substring(0, s.length - 4);
        } else if (current) {
          // Current TBC20 origin metadata is a single structured data push,
          // NOT the older separate decimal/name/symbol pushes. The leading1
          // identifies its metadata layout, not a public protocol method name.
          need(
            fields.length == 3 &&
                fields[0].length == 48 &&
                hex(fields.last) == '544243323054415045',
            'METADATA_TBC20_LAYOUT',
          );
          final m = fields[1];
          need(m.length >= 14 && m[0] == 1, 'METADATA_TBC20_LAYOUT');
          decimals = m[1];
          final nameLength = m[10], symbolLength = m[11];
          need(
            nameLength > 0 &&
                symbolLength > 0 &&
                nameLength + symbolLength <= 53 &&
                m.length == 12 + nameLength + symbolLength,
            'METADATA_TBC20_LENGTH',
          );
          name = utf8.decode(m.sublist(12, 12 + nameLength));
          symbol = utf8.decode(m.sublist(12 + nameLength));
          var supply = BigInt.zero;
          for (var i = 0; i < 8; i++)
            supply |= BigInt.from(m[2 + i]) << (8 * i);
          need(
            supply > BigInt.zero && supply < (BigInt.one << 63),
            'METADATA_TBC20_SUPPLY',
          );
          need(
            RegExp(r'^[\x21-\x7e]+$').hasMatch(symbol),
            'METADATA_TBC20_SYMBOL',
          );
        } else {
          need(
            fields.length == 5 &&
                fields[0].length == 48 &&
                fields[1].length == 1 &&
                hex(fields.last) == '4654617065',
            'METADATA_FT_LAYOUT',
          );
          decimals = fields[1][0];
          name = utf8.decode(fields[2]);
          symbol = utf8.decode(fields[3]);
        }
        need(
          decimals >= 0 &&
              decimals <= 18 &&
              name.isNotEmpty &&
              symbol.isNotEmpty &&
              utf8.encode(name).length <= 256 &&
              utf8.encode(symbol).length <= 256,
          'METADATA_IDENTITY',
        );
        final result = FungibleMetadata(
          contractId: id,
          family: family,
          current: current,
          decimals: decimals,
          name: name,
          symbol: symbol,
        );
        if (_tokens.length >= 128) _tokens.remove(_tokens.keys.first);
        return _tokens[id] = result;
      } finally {
        _tokenPending.remove(id);
      }
    }();
  }

  Future<PoolTokenIdentity> poolToken(String id) {
    hash32(id);
    final cached = _pools[id];
    if (cached != null) return Future.value(cached);
    final pending = _poolPending[id];
    if (pending != null) return pending;
    need(_poolPending.length < 32, 'METADATA_IN_FLIGHT_BOUND');
    return _poolPending[id] = () async {
      try {
        final info = await history.read('/api/tbc/pool/poolinfo/poolid/$id');
        final currentId = hash32(info['txid']);
        final origin = await history.parent(currentId);
        final raw = {'txid': currentId, 'rawTransaction': origin['rawTransaction']};
        final hint = history.keyless('inspectAmmMaterial', {
          'phase': 'identifyPoolState',
          'pool': raw,
        });
        need(
          hint.length == 4 &&
              hint['family'] == 'amm' &&
              ['current', 'historical'].contains(hint['generation']) &&
              hint['verification'] == 'state-template' &&
              hint['assetIdentityVerified'] == false,
          'METADATA_POOL_ORIGIN',
        );
        final current = hint['generation'] == 'current';
        late String token;
        if (current) {
          final descriptor = history.keyless('inspectAmmMaterial', {
            'phase': 'inspectPool',
            'pool': raw,
          });
          need(
            descriptor['txid'] == currentId && descriptor['standardId'] == 'tbc-amm',
            'METADATA_POOL_ID',
          );
          token = hash32(descriptor['ftContractId']);
        } else {
          final tape = (origin['outputs'] as List)[1] as Map;
          need(tape['satoshis'] == '0', 'METADATA_TAPE_VALUE');
          final fields = _pushes(
            unhex(tape['scriptPubKey']),
            start: 2,
            opReturn: true,
          );
          need(
            fields.length == 8 &&
                fields[2].length == 32 &&
                hex(fields.last) == '4e54617065',
            'METADATA_POOL_TAPE',
          );
          // Pool2 stores displayed FT txid bytes directly, unlike an OutPoint.
          token = hash32(hex(fields[2]));
        }
        final result = PoolTokenIdentity(
          poolContractId: id,
          ftContractId: token,
          current: current,
        );
        if (_pools.length >= 128) _pools.remove(_pools.keys.first);
        return _pools[id] = result;
      } finally {
        _poolPending.remove(id);
      }
    }();
  }
}

// Metadata extraction only, after shared Rust origin/template recognition.
// Never use marker/length alone to select a contract or grant authority.
List<Uint8List> _pushes(
  Uint8List bytes, {
  required int start,
  required bool opReturn,
}) {
  need(
    bytes.length >= start &&
        bytes.length <= 10000 &&
        (!opReturn || (start == 2 && bytes[0] == 0 && bytes[1] == 0x6a)),
    'METADATA_PUSH_HEADER',
  );
  final result = <Uint8List>[];
  var at = start;
  while (at < bytes.length) {
    need(result.length < 128, 'METADATA_PUSH_COUNT');
    final opcode = bytes[at++];
    var length = opcode;
    if (opcode >= 76 && opcode <= 78) {
      final width = 1 << (opcode - 76);
      need(at + width <= bytes.length, 'METADATA_PUSH_LENGTH');
      length = 0;
      for (var i = 0; i < width; i++) length |= bytes[at++] << (8 * i);
    } else {
      need(opcode <= 75, 'METADATA_PUSH_OPCODE');
    }
    need(length <= bytes.length - at, 'METADATA_PUSH_TRUNCATED');
    result.add(Uint8List.sublistView(bytes, at, at + length));
    at += length;
  }
  return result;
}
