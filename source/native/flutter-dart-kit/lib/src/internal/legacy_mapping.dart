// Pure historical DTO translation. No permissions, approvals, material reads,
// signing, persistence or execution loop live here. The native Legacy channel
// must select the isolated permission namespace and trusted Bitcoin profile.
// This module is deliberately not exposed through the public Provider yet.
import 'dart:async';
import 'dart:convert';
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'transaction_profiles.dart';
import 'workflow_json.dart';

const legacyPermissionNamespace = 'legacy-window-turing/v1';
const _bie1 = 'tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1';
const _methods = {
  'sendTransaction',
  'signTransaction',
  'signAssociatedTransaction',
  'signMessage',
  'encrypt',
  'decrypt',
};
const _mergeFlags = {
  'FT_MERGE',
  'POOLNFT_MERGE',
  'FTLP_MERGE',
  'POOLNFT_LP_BURN',
  'STABLECOIN_MERGE',
};
final _hex = RegExp(r'^(?:[0-9a-fA-F]{2})+$');

Map<String, dynamic> _record(Object? value) {
  need(value is Map && value.keys.every((k) => k is String), 'LEGACY_OBJECT');
  return Map<String, dynamic>.from(value as Map);
}

void _keys(Map value, Set<String> allowed) =>
    need(value.keys.every(allowed.contains), 'LEGACY_FIELDS');

String _text(Object? value) {
  need(value is String && value.isNotEmpty, 'LEGACY_STRING');
  scalarString(value as String);
  return value;
}

bool _safeInteger(Object? value) =>
    value is int && value >= 0 && value <= 9007199254740991;

Map<String, dynamic> _boundedCopy(Object? input) {
  final value = _record(input);
  final serialized = canonical(value);
  need(utf8.encode(serialized).length <= 4 * 1024 * 1024, 'LEGACY_SIZE');
  return jsonDecode(serialized) as Map<String, dynamic>;
}

Map<String, dynamic> _legacyCopy(Map value) {
  // Legacy display amounts may be JSON decimals. Do not relax the canonical
  // protocol codec: only the mapper sees these; it emits atomic strings.
  void check(Object? v) {
    if (v == null || v is bool) return;
    if (v is String) {
      scalarString(v);
      return;
    }
    if (v is num) {
      need(v.isFinite, 'LEGACY_NUMBER');
      return;
    }
    if (v is List) {
      for (final child in v) {
        check(child);
      }
      return;
    }
    if (v is Map) {
      for (final e in v.entries) {
        need(e.key is String, 'LEGACY_KEY');
        check(e.key);
        check(e.value);
      }
      return;
    }
    throw StateError('LEGACY_JSON');
  }

  check(value);
  final text = jsonEncode(value);
  need(utf8.encode(text).length <= 4 * 1024 * 1024, 'LEGACY_SIZE');
  return jsonDecode(text) as Map<String, dynamic>;
}

String legacyDisplayAmount(Object? value, {bool allowZero = false}) {
  final text = value is num ? javascriptNumberText(value) : value;
  need(
    text is String &&
        RegExp(r'^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$').hasMatch(text) &&
        (allowZero || !RegExp(r'^0(?:\.0+)?$').hasMatch(text)),
    'LEGACY_AMOUNT',
  );
  return text as String;
}

String legacyAtomicAmount(String value, int decimals) {
  need(decimals >= 0 && decimals <= 18, 'LEGACY_DECIMALS');
  final parts = value.split('.'), fraction = parts.length == 1 ? '' : parts[1];
  need(parts.length <= 2 && fraction.length <= decimals, 'LEGACY_PRECISION');
  final atomic = '${parts[0]}${fraction.padRight(decimals, '0')}'.replaceFirst(
    RegExp(r'^0+(?=[0-9])'),
    '',
  );
  need(RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(atomic), 'LEGACY_AMOUNT');
  final amount = BigInt.parse(atomic);
  need(amount <= (BigInt.one << 64) - BigInt.one, 'LEGACY_AMOUNT_OVERFLOW');
  return '$amount';
}

Map<String, dynamic> _sendParams(Object? input) {
  final p = _record(input is List && input.length == 1 ? input[0] : input);
  need(
    !p.containsKey('broadcastEnabled') || p['broadcastEnabled'] is bool,
    'LEGACY_BROADCAST',
  );
  return p;
}

/// Bounded private snapshot for asynchronous metadata translation. Display
/// decimals stay local to the mapper; canonical requests contain atomic strings.
Map<String, dynamic> snapshotLegacySendParams(Object? input) =>
    frozen(_legacyCopy(_sendParams(input))) as Map<String, dynamic>;

Map<String, dynamic> _businessRequest(
  LegacyMappingAccount account,
  String prefix,
  Map<String, dynamic> intent, {
  Map<String, dynamic>? constraints,
}) {
  inspectP2pkhAddress(account.address);
  final base = {
    ...account.common,
    'intent': intent,
    if (constraints != null) 'constraints': constraints,
  };
  return frozen({...base, 'clientRequestId': '$prefix:${hashJson(base)}'})
      as Map<String, dynamic>;
}

/// Pure Pool2 page DTO mapping; code/tape authentication and fee selection stay
/// in the unified material/Engine path. A page lpPlan never overrides a pool.
/// Only the sell amount needs trusted token precision, supplied by the caller.
/// Historical pool creation is intentionally not part of this partner scope.
Map<String, dynamic> mapLegacyPoolTransaction(
  Object? input,
  LegacyMappingAccount account, {
  int? ftDecimals,
  DateTime? now,
}) {
  // The Pool resolver's frozen contract accepts an object, unlike FT transfer.
  final p = _record(input), flag = p['flag'];
  final maintenance =
      const {
        'POOLNFT_MERGE': ('tbc.pool.ft.merge', 'legacy-pool-ft-merge'),
        'FTLP_MERGE': ('tbc.pool.ftlp.merge', 'legacy-ftlp-merge'),
        'POOLNFT_LP_BURN': ('tbc.pool.ftlp.burn', 'legacy-ftlp-burn'),
      }[flag];
  if (maintenance != null) {
    _keys(p, {'flag', 'nft_contract_address', 'domain'});
    return _businessRequest(account, maintenance.$2, {
      'version': '1.0',
      'type': maintenance.$1,
      'poolContractId': hash32(_text(p['nft_contract_address']).toLowerCase()),
    });
  }
  final buy = flag == 'POOLNFT_SWAP_TO_TOKEN',
      sell = flag == 'POOLNFT_SWAP_TO_TBC',
      add = flag == 'POOLNFT_LP_INCREASE',
      remove = flag == 'POOLNFT_LP_CONSUME';
  need(buy || sell || add || remove, 'LEGACY_POOL_FLAG');
  final amountField = buy || add ? 'tbc_amount' : 'ft_amount';
  _keys(p, {
    'flag',
    'nft_contract_address',
    'address',
    amountField,
    'broadcastEnabled',
    'poolNFT_version',
    if (buy || sell) 'lpPlan',
  });
  need(
    p['broadcastEnabled'] == false &&
        (!p.containsKey('poolNFT_version') || p['poolNFT_version'] == 2) &&
        (!remove || p['poolNFT_version'] == 2),
    'LEGACY_POOL_PARAMS',
  );
  if (p.containsKey('lpPlan')) {
    final plan = p['lpPlan'];
    need(plan is int && plan >= 1 && plan <= 6, 'LEGACY_POOL_PLAN');
  }
  final contract = hash32(_text(p['nft_contract_address']).toLowerCase());
  inspectP2pkhAddress(p['address']);
  var display = legacyDisplayAmount(p[amountField]);
  if (remove) {
    // Historical LP consume deliberately truncates beyond six display digits.
    // Do not apply this rule to any other amount or allow a truncated zero.
    final parts = display.split('.');
    if (parts.length == 2 && parts[1].length > 6) {
      display = '${parts[0]}.${parts[1].substring(0, 6)}';
    }
  }
  need(!sell || ftDecimals != null, 'LEGACY_POOL_DECIMALS');
  final amount = legacyAtomicAmount(display, sell ? ftDecimals! : 6);
  need(amount != '0', 'LEGACY_AMOUNT');
  final type =
      buy
          ? 'tbc.pool.swap.exactTbcForToken'
          : sell
          ? 'tbc.pool.swap.exactTokenForTbc'
          : add
          ? 'tbc.pool.liquidity.add'
          : 'tbc.pool.liquidity.remove';
  final prefix =
      buy
          ? 'legacy-pool-swap-tbc-for-token'
          : sell
          ? 'legacy-pool-swap-token-for-tbc'
          : add
          ? 'legacy-pool-add'
          : 'legacy-pool-remove';
  // Date uses millisecond precision in the frozen JS mapper; keep the same
  // request hash, including .000Z, without relaxing the shared time validator.
  final expires =
      buy || sell
          ? DateTime.fromMillisecondsSinceEpoch(
            (now ?? DateTime.now()).millisecondsSinceEpoch + 300000,
            isUtc: true,
          ).toIso8601String()
          : null;
  return _businessRequest(account, prefix, {
    'version': '1.0',
    'type': type,
    'poolContractId': contract,
    'receiver': p['address'],
    if (buy || add) 'tbcAmount': amount,
    if (sell) 'ftAmount': amount,
    if (remove) 'lpAmount': amount,
    if (buy || remove) 'minimumFtAmount': '1',
    if (sell || remove) 'minimumTbcAmount': '1',
    if (add) 'minimumLpAmount': '1',
  }, constraints: expires == null ? null : {'expiresAt': expires});
}

/// Maps a single FT/coin maintenance transaction, not the separate Legacy
/// mergeUtxos/mergeFtUtxos multi-round coordinator. No automatic broadcast here.
Map<String, dynamic> mapLegacyAssetMerge(
  Object? input,
  LegacyMappingAccount account,
) {
  final p = _sendParams(input), stable = p['flag'] == 'STABLECOIN_MERGE';
  need(stable || p['flag'] == 'FT_MERGE', 'LEGACY_MERGE_FLAG');
  _keys(p, {'flag', 'ft_contract_address', 'domain'});
  need(!p.containsKey('domain') || p['domain'] is String, 'LEGACY_DOMAIN');
  return _businessRequest(
    account,
    stable ? 'legacy-stablecoin-merge' : 'legacy-ft-merge',
    {
      'version': '1.0',
      'type': stable ? 'tbc.stablecoin.merge' : 'tbc.ft.merge',
      'contractId': hash32(_text(p['ft_contract_address']).toLowerCase()),
    },
  );
}

Map<String, dynamic> mapLegacyTbcTransfer(
  Object? input,
  LegacyMappingAccount account,
) {
  final p = _sendParams(input);
  need(p['flag'] == 'P2PKH', 'LEGACY_FLAG');
  inspectP2pkhAddress(p['address']);
  final amount = uintString(p['satoshis']);
  need(BigInt.parse(amount) > BigInt.zero, 'LEGACY_AMOUNT');
  return _businessRequest(account, 'legacy-p2pkh', {
    'version': '1.0',
    'type': 'tbc.transfer',
    'to': p['address'],
    'amount': amount,
  });
}

/// Decimals and standard identity come from the network-bound shared metadata
/// reader, never from the page. This translator performs no extra lookup.
Map<String, dynamic> mapLegacyFtTransfer(
  Object? input,
  LegacyMappingAccount account, {
  required int decimals,
  required bool currentStandard,
}) {
  final p = _sendParams(input);
  need(p['flag'] == 'FT_TRANSFER', 'LEGACY_FLAG');
  inspectP2pkhAddress(p['address']);
  final contract = hash32(_text(p['ft_contract_address']).toLowerCase());
  final amount = legacyAtomicAmount(
    legacyDisplayAmount(p['ft_amount']),
    decimals,
  );
  need(amount != '0', 'LEGACY_AMOUNT');
  final attached = legacyAtomicAmount(
    legacyDisplayAmount(p['tbc_amount'] ?? '0', allowZero: true),
    6,
  );
  need(!currentStandard || attached == '0', 'LEGACY_CURRENT_ATTACHED_TBC');
  return _businessRequest(account, 'legacy-ft-transfer', {
    'version': '1.0',
    'type': currentStandard ? 'tbc20.transfer' : 'tbc.ft.transfer',
    'contractId': contract,
    'to': p['address'],
    'amount': amount,
    if (attached != '0') 'attachedTbcAmount': attached,
  });
}

Map<String, dynamic> mapLegacyStablecoinTransfer(
  Object? input,
  LegacyMappingAccount account, {
  required int decimals,
}) {
  final p = _sendParams(input);
  _keys(p, {
    'flag',
    'ft_contract_address',
    'address',
    'ft_amount',
    'tbc_amount',
    'broadcastEnabled',
    'domain',
  });
  need(
    p['flag'] == 'STABLECOIN_TRANSFER' &&
        (!p.containsKey('domain') || p['domain'] is String),
    'LEGACY_FLAG',
  );
  inspectP2pkhAddress(p['address']);
  final contract = hash32(_text(p['ft_contract_address']).toLowerCase());
  final amount = legacyAtomicAmount(
    legacyDisplayAmount(p['ft_amount']),
    decimals,
  );
  final attached = legacyAtomicAmount(
    legacyDisplayAmount(p['tbc_amount'] ?? '0', allowZero: true),
    6,
  );
  return _businessRequest(account, 'legacy-stablecoin-transfer', {
    'version': '1.0',
    'type': 'tbc.stablecoin.transfer',
    'contractId': contract,
    'to': p['address'],
    'amount': amount,
    if (attached != '0') 'attachedTbcAmount': attached,
  });
}

Map<String, dynamic> mapLegacyNftTransfer(
  Object? input,
  LegacyMappingAccount account,
) {
  final p = _sendParams(input);
  _keys(p, {
    'flag',
    'nft_contract_address',
    'address',
    'broadcastEnabled',
    'domain',
  });
  need(
    p['flag'] == 'NFT_TRANSFER' &&
        (!p.containsKey('domain') || p['domain'] is String),
    'LEGACY_NFT_FLAG',
  );
  inspectP2pkhAddress(p['address']);
  return _businessRequest(account, 'legacy-nft', {
    'version': '1.0',
    'type': 'tbc.nft.transfer',
    'contractId': hash32(p['nft_contract_address']),
    'to': p['address'],
  });
}

/// Preserves the historical detached-signature matrix. Engine/Reviewed still
/// validates ownership, prevouts, outputs and signature semantics at execution.
Map<String, dynamic> legacyRawToReviewed(Object? input) {
  final p = _boundedCopy(input);
  _keys(p, {'txraws', 'utxos_satoshis', 'script_pubkeys'});
  final raws = p['txraws'],
      amounts = p['utxos_satoshis'],
      scripts = p['script_pubkeys'];
  need(
    raws is List &&
        raws.isNotEmpty &&
        raws.length <= 32 &&
        amounts is List &&
        amounts.length == raws.length &&
        scripts is List &&
        scripts.length == raws.length,
    'LEGACY_RAW_MATRIX',
  );
  final transactions = <Map<String, dynamic>>[];
  for (var i = 0; i < (raws as List).length; i++) {
    final raw = raws[i], row = amounts[i], scriptRow = scripts[i];
    need(
      raw is String &&
          _hex.hasMatch(raw) &&
          row is List &&
          row.isNotEmpty &&
          row.length <= 1000 &&
          row.every(_safeInteger) &&
          scriptRow is List &&
          scriptRow.length == row.length &&
          scriptRow.every((s) => s is String && _hex.hasMatch(s)),
      'LEGACY_RAW_ROW',
    );
    // Reuse the shared transaction reader, never introduce another parser.
    final tx = inspectTransaction(raw as String);
    need((tx['inputs'] as List).length == row.length, 'LEGACY_RAW_INPUT_COUNT');
    transactions.add({
      'rawTransaction': raw,
      'inputs': [
        for (var j = 0; j < row.length; j++)
          {'satoshis': '${row[j]}', 'scriptPubKey': scriptRow[j]},
      ],
    });
  }
  return frozen({
        'payload': {'format': 'raw', 'transactions': transactions},
      })
      as Map<String, dynamic>;
}

Map<String, dynamic> _associatedInput(Object? value) {
  final p = _record(value);
  _keys(p, {
    'txId',
    'outputIndex',
    'satoshis',
    'script',
    'scriptSigType',
    'preTx',
    'prePreTxData',
    'contractTx',
    'ftVersion',
    'unfinishedScriptSig',
  });
  need(_safeInteger(p['outputIndex']), 'LEGACY_ASSOCIATED_INDEX');
  final profile =
      const {
        'p2pkh': 'p2pkh',
        'tbc20': 'ft',
        'tbc20_contract': 'ft-contract',
        'other': 'contract-template',
      }[p['scriptSigType']];
  need(profile != null, 'LEGACY_ASSOCIATED_PROFILE');
  final out = <String, dynamic>{
    'outputIndex': p['outputIndex'],
    'signingProfile': profile,
  };
  if (p.containsKey('txId')) out['txid'] = _text(p['txId']).toLowerCase();
  if (p.containsKey('satoshis')) out['satoshis'] = uintString(p['satoshis']);
  for (final entry
      in const {
        'script': 'scriptPubKey',
        'preTx': 'previousTransaction',
        'prePreTxData': 'previousOutputContext',
        'contractTx': 'contractTransaction',
        'unfinishedScriptSig': 'unlockingScriptTemplate',
      }.entries) {
    if (p.containsKey(entry.key)) out[entry.value] = _text(p[entry.key]);
  }
  if (p.containsKey('ftVersion')) {
    need(
      p['ftVersion'] is int && p['ftVersion'] >= 1 && p['ftVersion'] <= 3,
      'LEGACY_ASSOCIATED_VERSION',
    );
    out['contractVersion'] = p['ftVersion'];
  }
  return out;
}

Map<String, dynamic> legacyAssociatedToReviewed(Object? input) {
  final p = _boundedCopy(input);
  _keys(p, {'sourceTxraw', 'sourceUtxos', 'inputs', 'outputs'});
  need(
    p['sourceTxraw'] is String &&
        _hex.hasMatch(p['sourceTxraw']) &&
        p['sourceUtxos'] is List &&
        p['sourceUtxos'].length <= 1000 &&
        p.containsKey('inputs') == p.containsKey('outputs'),
    'LEGACY_ASSOCIATED_MATRIX',
  );
  final inputs = p['inputs'] ?? [], outputs = p['outputs'] ?? [];
  need(
    inputs is List &&
        outputs is List &&
        inputs.length == outputs.length &&
        inputs.length <= 32,
    'LEGACY_ASSOCIATED_CHILDREN',
  );
  final children = <Map<String, dynamic>>[];
  for (var i = 0; i < (inputs as List).length; i++) {
    need(inputs[i] is List && outputs[i] is List, 'LEGACY_ASSOCIATED_ROW');
    children.add({
      'inputs': (inputs[i] as List).map(_associatedInput).toList(),
      'outputs': [
        for (final item in outputs[i])
          (() {
            final value = _record(item);
            _keys(value, {'satoshis', 'script'});
            return {
              'satoshis': uintString(value['satoshis']),
              'scriptPubKey': _text(value['script']),
            };
          })(),
      ],
    });
  }
  return frozen({
        'payload': {
          'format': 'associated',
          'sourceTransaction': p['sourceTxraw'],
          'sourceInputs':
              (p['sourceUtxos'] as List).map(_associatedInput).toList(),
          'children': children,
        },
      })
      as Map<String, dynamic>;
}

Map<String, dynamic> legacyMessage(Object? input) {
  final p = _record(input);
  final encoding = p['encoding'] == 'utf-8' ? 'utf8' : p['encoding'];
  need({'utf8', 'hex', 'base64'}.contains(encoding), 'LEGACY_MESSAGE_ENCODING');
  return {'encoding': encoding, 'data': _text(p['message'])};
}

/// Historical digest only; this is NOT signing authority. Never select this
/// profile based on a page-supplied digest/clientRequestId on Standard calls.
String legacyBitcoinDigest(Map message) {
  return messageDigest({
    'type': 'tbc.message',
    'version': '1.0',
    'message': message,
  }, profile: MessageSigningProfile.legacyBitcoin);
}

List<Map<String, dynamic>> normalizeLegacyBatch(Object? input) {
  need(
    input is List && input.isNotEmpty && input.length <= 5,
    'LEGACY_BATCH_LENGTH',
  );
  final requests = <Map<String, dynamic>>[];
  for (var i = 0; i < (input as List).length; i++) {
    final p = _record(input[i]);
    _keys(p, {'id', 'method', 'params', 'dependsOn'});
    need(
      _methods.contains(p['method']) && p.containsKey('params'),
      'LEGACY_BATCH_METHOD',
    );
    if (p.containsKey('dependsOn')) {
      final field = p['dependsOn'], m = _record(p['params']);
      need(
        p['method'] == 'signMessage' &&
            i > 0 &&
            field is String &&
            RegExp(r'^[A-Za-z][A-Za-z0-9_]{0,63}$').hasMatch(field) &&
            !{'__proto__', 'prototype', 'constructor'}.contains(field) &&
            m['encoding'] == 'utf8' &&
            m['message'] is String,
        'LEGACY_DEPENDENCY',
      );
      final decoded = _record(jsonDecode(m['message']));
      need(
        (!decoded.containsKey(field) || decoded[field] is List) &&
            !decoded.keys.any(
              {'__proto__', 'prototype', 'constructor'}.contains,
            ),
        'LEGACY_DEPENDENCY_OBJECT',
      );
    }
    if (p['method'] == 'sendTransaction') {
      final raw = p['params'];
      final params = _record(raw is List && raw.length == 1 ? raw[0] : raw);
      need(
        params['broadcastEnabled'] == false &&
            !_mergeFlags.contains(params['flag']),
        'LEGACY_BATCH_SIGN_ONLY',
      );
    }
    requests.add(
      _legacyCopy({
        'method': p['method'],
        'params': p['params'],
        if (p.containsKey('dependsOn')) 'dependsOn': p['dependsOn'],
      }),
    );
  }
  return List.unmodifiable(
    requests.map((p) => frozen(p) as Map<String, dynamic>),
  );
}

/// Internal caller supplies an account captured from native authority. This
/// data object grants nothing; the shared lifecycle rechecks that authority.
final class LegacyMappingAccount {
  LegacyMappingAccount({
    required this.chainId,
    required this.address,
    required String accountId,
  }) {
    need(
      {'tbc:mainnet', 'tbc:testnet'}.contains(chainId) &&
          address.isNotEmpty &&
          accountId == '$chainId:$address',
      'LEGACY_ACCOUNT',
    );
  }
  final String chainId, address;
  Map<String, dynamic> get common => {
    'version': '1.0',
    'chainId': chainId,
    'from': address,
  };
}

/// This callback translates a business request only, using shared metadata
/// resolution. It must not execute/approve/sign or return an alternate account.
typedef LegacyBusinessMapper =
    FutureOr<Map<String, dynamic>> Function(Object? params);

/// The frozen Legacy DTO mapper names some historical intents. Route those to
/// the already implemented unified holder strategies, including native payment,
/// rather than adding historical executors to Flutter. Engine authenticates the
/// actual Code/Tape generation. This conversion itself grants no capability.
Map<String, dynamic> legacySharedBusinessRequest(Map request) {
  final value = copied(request), intent = _record(value['intent']);
  final alias =
      const {
        'tbc.ft.transfer': 'tbc20.transfer',
        'tbc.ft.merge': 'tbc20.merge',
        'tbc.stablecoin.transfer': 'tbc20Stablecoin.transfer',
        'tbc.stablecoin.merge': 'tbc20Stablecoin.merge',
        'tbc.nft.transfer': 'tbc721.transfer',
        'tbc.pool.swap.exactTbcForToken': 'amm.swap',
        'tbc.pool.swap.exactTokenForTbc': 'amm.swap',
        'tbc.pool.liquidity.add': 'amm.addLiquidity',
        'tbc.pool.liquidity.remove': 'amm.removeLiquidity',
        'tbc.pool.ft.merge': 'amm.mergeToken',
        'tbc.pool.ftlp.merge': 'tbc20Lp.merge',
        'tbc.pool.ftlp.burn': 'tbc20Lp.burn',
      }[intent['type']];
  if (alias != null) {
    if (alias == 'amm.swap') {
      final buy = intent['type'] == 'tbc.pool.swap.exactTbcForToken';
      intent['direction'] = buy ? 'tbc-to-ft' : 'ft-to-tbc';
      intent['amount'] = intent.remove(buy ? 'tbcAmount' : 'ftAmount');
      intent['minimumOutput'] = intent.remove(
        buy ? 'minimumFtAmount' : 'minimumTbcAmount',
      );
    } else if (alias == 'amm.addLiquidity') {
      intent['budgetAsset'] = 'tbc';
      intent['amount'] = intent.remove('tbcAmount');
      if (intent.containsKey('lockUntilHeight')) {
        intent['lockTime'] = intent.remove('lockUntilHeight');
      }
    }
    if (intent.containsKey('attachedTbcAmount')) {
      need(
        alias.endsWith('.transfer') &&
            intent['to'] is String &&
            !intent.containsKey('payment'),
        'LEGACY_PAYMENT_CONFLICT',
      );
      final amount = uintString(intent.remove('attachedTbcAmount'));
      if (amount != '0')
        intent['payment'] = {'to': intent['to'], 'amount': amount};
    }
    intent['type'] = alias;
  }
  need(
    transactionTaskLimits.containsKey(intent['type']),
    'LEGACY_UNSUPPORTED_BUSINESS',
  );
  value['intent'] = intent;
  return frozen(value) as Map<String, dynamic>;
}

Future<Map<String, dynamic>> mapLegacyWorkflow(
  Object? input,
  LegacyMappingAccount account, {
  required LegacyBusinessMapper mapBusiness,
}) async {
  final requests = normalizeLegacyBatch(input);
  final steps = await Future.wait([
    for (var i = 0; i < requests.length; i++)
      (() async {
        final r = requests[i], p = r['params'], method = r['method'];
        final out = <String, dynamic>{
          'id': 'legacy-${i + 1}',
          'dependsOn': <String>[],
        };
        switch (method) {
          case 'sendTransaction':
            final tx = copied(await mapBusiness(p));
            need(
              tx['version'] == '1.0' &&
                  tx['chainId'] == account.chainId &&
                  tx['from'] == account.address &&
                  tx['intent'] is Map,
              'LEGACY_BUSINESS_SCOPE',
            );
            out.addAll({
              'kind': 'transaction',
              'intent': tx['intent'],
              if (tx.containsKey('constraints'))
                'constraints': tx['constraints'],
            });
          case 'signTransaction':
            out.addAll({
              'kind': 'reviewedTransaction',
              'request': legacyRawToReviewed(p),
            });
          case 'signAssociatedTransaction':
            out.addAll({
              'kind': 'reviewedTransaction',
              'request': legacyAssociatedToReviewed(p),
            });
          case 'signMessage':
            out.addAll({'kind': 'message', 'message': legacyMessage(p)});
            if (r.containsKey('dependsOn')) {
              out['dependsOn'] = ['legacy-$i'];
              out['bindings'] = [
                {
                  'target': r['dependsOn'],
                  'source': {'stepId': 'legacy-$i', 'output': 'transactionIds'},
                },
              ];
            }
          case 'encrypt':
            out.addAll({
              'kind': 'encrypt',
              'algorithm': _bie1,
              'message': {
                'encoding': 'utf8',
                'data': _text(_record(p)['message']),
              },
            });
          case 'decrypt':
            out.addAll({
              'kind': 'decrypt',
              'algorithm': _bie1,
              'ciphertext': _text(_record(p)['encryptedMessage']),
            });
        }
        return out;
      })(),
  ]);
  String? feeCap;
  if (requests.length == 2 &&
      requests[0]['method'] == 'sendTransaction' &&
      requests[1]['method'] == 'signMessage' &&
      requests[1].containsKey('dependsOn')) {
    feeCap =
        const {
          'tbc.transfer': '1000',
          'tbc.ft.transfer': '10000',
          'tbc20.transfer': '10000',
        }[steps[0]['intent']['type']];
  }
  return frozen({
        ...account.common,
        'failureMode': 'continue-independent',
        if (feeCap != null) 'maxTotalFee': feeCap,
        'steps': steps,
      })
      as Map<String, dynamic>;
}

/// Single secure calls retain their direct action route, not a one-step
/// workflow. A real batch remains one shared workflow (no Legacy executor).
Map<String, dynamic> mapLegacyStandalone(
  String method,
  Object? params,
  LegacyMappingAccount account,
) {
  final common = account.common;
  switch (method) {
    case 'signTransaction':
    case 'signAssociatedTransaction':
      return frozen({
            'method': 'tbc_signReviewedTransaction',
            'params': {
              ...common,
              'request':
                  method == 'signTransaction'
                      ? legacyRawToReviewed(params)
                      : legacyAssociatedToReviewed(params),
            },
          })
          as Map<String, dynamic>;
    case 'encrypt':
      return frozen({
            'method': 'tbc_encrypt',
            'params': {
              ...common,
              'algorithm': _bie1,
              'message': {
                'encoding': 'utf8',
                'data': _text(_record(params)['message']),
              },
            },
          })
          as Map<String, dynamic>;
    case 'decrypt':
      return frozen({
            'method': 'tbc_decrypt',
            'params': {
              ...common,
              'algorithm': _bie1,
              'ciphertext': _text(_record(params)['encryptedMessage']),
            },
          })
          as Map<String, dynamic>;
    default:
      throw UnsupportedError('Unsupported legacy operation');
  }
}

Object? mapLegacySecureResult(String method, Object? params, Object? result) {
  final value = _record(result);
  switch (method) {
    case 'signTransaction':
      final request = legacyRawToReviewed(params);
      final txs = request['payload']['transactions'] as List,
          sigs = value['detachedSignatures'];
      need(
        sigs is List && sigs.length == txs.length,
        'LEGACY_SIGNATURE_MATRIX',
      );
      for (var i = 0; i < txs.length; i++) {
        need(
          sigs[i] is List &&
              sigs[i].length == txs[i]['inputs'].length &&
              sigs[i].every(
                (s) => s is String && _hex.hasMatch(s) && s.length <= 1024,
              ),
          'LEGACY_SIGNATURE_ROW',
        );
      }
      return frozen({'sigs': sigs});
    case 'sendTransaction':
    case 'signAssociatedTransaction':
      final txs = value['transactions'];
      need(txs is List, 'LEGACY_TRANSACTION_RESULT');
      final raws = [
        for (final tx in txs as List) _text(_record(tx)['rawTransaction']),
      ];
      return frozen(
        method == 'sendTransaction'
            ? {'txraw': raws.join(',')}
            : {'txraws': raws},
      );
    case 'encrypt':
      return frozen({'encryptedMessage': _text(value['ciphertext'])});
    case 'decrypt':
      return frozen({
        'decryptedMessage': utf8.decode(
          messageBytes(_record(value['message'])),
          allowMalformed: false,
        ),
      });
    case 'signMessage':
      return frozen({
        'address': value['address'],
        'maddress': value['address'],
        'pubkey': value['publicKey'],
        'pubKey': value['publicKey'],
        'message': _record(_record(value['envelope'])['message'])['data'],
        'sig': value['signature'],
      });
    default:
      throw UnsupportedError('Unsupported legacy operation');
  }
}

List<Object?> mapLegacyWorkflowResult(Object? input, Object? result) {
  final requests = normalizeLegacyBatch(input), value = _record(result);
  final steps = value['steps'];
  need(steps is List && steps.length == requests.length, 'LEGACY_RESULT_COUNT');
  return List.unmodifiable([
    for (var i = 0; i < requests.length; i++)
      (() {
        final step = _record(steps[i]);
        if (step['status'] == 'failed' || step['status'] == 'skipped') {
          final error = step['error'];
          return frozen({
            'error':
                step['status'] == 'skipped'
                    ? 'Previous request failed or produced no txids'
                    : error is Map && error['message'] is String
                    ? error['message']
                    : 'Workflow step failed',
          });
        }
        return mapLegacySecureResult(
          requests[i]['method'],
          requests[i]['params'],
          step['result'],
        );
      })(),
  ]);
}
