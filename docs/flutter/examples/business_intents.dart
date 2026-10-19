/// Copyable request recipes, not a second transaction engine.
/// No HTTP, signing, approval, key storage, broadcast or automatic retry.
/// Amounts are decimal integer strings in the asset's smallest unit.
typedef TbcFields = Map<String, Object?>;

TbcFields _intent(String type, [TbcFields fields = const {}]) => {
  'version': '1.0',
  'type': type,
  ...fields,
};

TbcFields tbcTransfer({required String to, required String amount}) =>
    _intent('tbc.transfer', {'to': to, 'amount': amount});
TbcFields mergeTbc() => _intent('tbc.maintenance.merge');

TbcFields createToken({
  required String name,
  required String symbol,
  required int decimals,
  required String initialSupply,
  String? to,
}) => _intent('tbc20-standard-create', {
  'name': name,
  'symbol': symbol,
  'decimals': decimals,
  'initialSupply': initialSupply,
  if (to != null) 'to': to,
});

TbcFields transferToken({
  required String contractId,
  required String to,
  required String amount,
  bool stablecoin = false,
  TbcFields? payment,
}) => _intent(stablecoin ? 'tbc20Stablecoin.transfer' : 'tbc20.transfer', {
  'contractId': contractId,
  'to': to,
  'amount': amount,
  if (payment != null) 'payment': payment,
});

TbcFields transferTokenToMany({
  required String contractId,
  required List<TbcFields> receivers,
  bool stablecoin = false,
}) => _intent(stablecoin ? 'tbc20Stablecoin.transfer' : 'tbc20.transfer', {
  'contractId': contractId,
  'receivers': receivers,
});

TbcFields mergeToken({required String contractId, bool stablecoin = false}) =>
    _intent(stablecoin ? 'tbc20Stablecoin.merge' : 'tbc20.merge', {
      'contractId': contractId,
    });

TbcFields uriMedia(String uri, {String? sha256}) => {
  'kind': 'uri',
  'uri': uri,
  if (sha256 != null) 'sha256': sha256,
};
TbcFields createCollection({
  required String name,
  required String description,
  required String supply,
  required TbcFields media,
  String? to,
}) => _intent('tbc721-standard-create-collection', {
  'name': name,
  'description': description,
  'supply': supply,
  'media': media,
  if (to != null) 'to': to,
});
TbcFields nftItem({
  required int slot,
  required String name,
  required String symbol,
  required String description,
  required List<TbcFields> attributes,
  TbcFields? media,
  String? to,
}) => {
  'slot': slot,
  'name': name,
  'symbol': symbol,
  'description': description,
  'attributes': attributes,
  if (media != null) 'media': media,
  if (to != null) 'to': to,
};
TbcFields mintNft({required String collectionId, required TbcFields item}) =>
    _intent('tbc721-standard-mint', {'collectionId': collectionId, ...item});
TbcFields mintNfts({
  required String collectionId,
  required List<TbcFields> items,
}) => _intent('tbc721-standard-batch-mint', {
  'collectionId': collectionId,
  'items': items,
});
TbcFields transferNft({
  required String contractId,
  required String to,
  TbcFields? payment,
}) => _intent('tbc721.transfer', {
  'contractId': contractId,
  'to': to,
  if (payment != null) 'payment': payment,
});

/// Basis points, 1 = 0.01%. Use actual pool feePolicy only at creation.
TbcFields ammFeePolicy({
  required int lpFeeRate,
  required int taxFeeRate,
  required int serviceProviderFeeRate,
  required int protocolFeeRate,
  required String feeAddress,
}) => {
  'lpFeeRate': lpFeeRate,
  'taxFeeRate': taxFeeRate,
  'serviceProviderFeeRate': serviceProviderFeeRate,
  'protocolFeeRate': protocolFeeRate,
  'feeAddress': feeAddress,
};
TbcFields createAmm({
  required String ftContractId,
  required TbcFields feePolicy,
  required bool lpTimelock,
  List<String>? controllers,
  String? serviceProviderTag,
}) => _intent('tbc-amm-create', {
  'ftContractId': ftContractId,
  'feePolicy': feePolicy,
  'lpTimelock': lpTimelock,
  if (controllers != null) 'controllers': controllers,
  if (serviceProviderTag != null) 'serviceProviderTag': serviceProviderTag,
});
TbcFields addLiquidity({
  required String poolContractId,
  required String budgetAsset,
  required String amount,
  required String minimumLpAmount,
  String? initialFtAmount,
  String? maximumTbcAmount,
  String? maximumFtAmount,
  String? lockTime,
  String? receiver,
  String? poolStateHash,
}) => _intent('amm.addLiquidity', {
  'poolContractId': poolContractId,
  'budgetAsset': budgetAsset,
  'amount': amount,
  'minimumLpAmount': minimumLpAmount,
  if (initialFtAmount != null) 'initialFtAmount': initialFtAmount,
  if (maximumTbcAmount != null) 'maximumTbcAmount': maximumTbcAmount,
  if (maximumFtAmount != null) 'maximumFtAmount': maximumFtAmount,
  if (lockTime != null) 'lockTime': lockTime,
  if (receiver != null) 'receiver': receiver,
  if (poolStateHash != null) 'poolStateHash': poolStateHash,
});
TbcFields swap({
  required String poolContractId,
  required String direction,
  required String amount,
  required String minimumOutput,
  String? receiver,
  String? poolStateHash,
}) => _intent('amm.swap', {
  'poolContractId': poolContractId,
  'direction': direction,
  'amount': amount,
  'minimumOutput': minimumOutput,
  if (receiver != null) 'receiver': receiver,
  if (poolStateHash != null) 'poolStateHash': poolStateHash,
});
TbcFields removeLiquidity({
  required String poolContractId,
  required String lpAmount,
  required String minimumTbcAmount,
  required String minimumFtAmount,
  String? receiver,
  String? poolStateHash,
}) => _intent('amm.removeLiquidity', {
  'poolContractId': poolContractId,
  'lpAmount': lpAmount,
  'minimumTbcAmount': minimumTbcAmount,
  'minimumFtAmount': minimumFtAmount,
  if (receiver != null) 'receiver': receiver,
  if (poolStateHash != null) 'poolStateHash': poolStateHash,
});
TbcFields transferLp({
  required String poolContractId,
  required String to,
  required String amount,
}) => _intent('tbc20Lp.transfer', {
  'poolContractId': poolContractId,
  'to': to,
  'amount': amount,
});
TbcFields lockLp({
  required String poolContractId,
  required String amount,
  required String lockTime,
}) => _intent('tbc20Lp.lock', {
  'poolContractId': poolContractId,
  'amount': amount,
  'lockTime': lockTime,
});
TbcFields unlockLp(String poolContractId) =>
    _intent('tbc20Lp.unlock', {'poolContractId': poolContractId});
TbcFields mergeLp(String poolContractId) =>
    _intent('tbc20Lp.merge', {'poolContractId': poolContractId});
// Historical Pool2 maintenance only; not a new AMM close-pool operation.
TbcFields mergePoolTokens(String poolContractId) =>
    _intent('amm.mergeToken', {'poolContractId': poolContractId});
TbcFields burnPoolLp(String poolContractId) =>
    _intent('tbc20Lp.burn', {'poolContractId': poolContractId});

TbcFields outpoint(String txid, int vout) => {'txid': txid, 'vout': vout};
TbcFields timelockTbc({required String amount, required String lockHeight}) =>
    _intent('tbc-timelock-lock', {'amount': amount, 'lockTime': lockHeight});
// Select the locked outputs in request.constraints.inputOutpoints.
TbcFields unlockTbc() => _intent('tbc-timelock-unlock');

/// Omit BOTH assetStandard/contractId for TBC; supply BOTH for a token.
TbcFields lockHtlc({
  required String to,
  required String amount,
  required String hashlock,
  required String lockTime,
  String? assetStandard,
  String? contractId,
}) => _intent('tbc-htlc-lock', {
  'to': to,
  'amount': amount,
  'hashlock': hashlock,
  'lockTime': lockTime,
  if (assetStandard != null) 'assetStandard': assetStandard,
  if (contractId != null) 'contractId': contractId,
});

/// Do not log this request or its signed bytes: a claim reveals the preimage.
TbcFields claimHtlc({
  required String preimage,
  String? assetStandard,
  String? contractId,
  List<TbcFields>? targetOutpoints,
}) => _intent('tbc-htlc-claim', {
  'preimage': preimage,
  if (assetStandard != null) 'assetStandard': assetStandard,
  if (contractId != null) 'contractId': contractId,
  if (targetOutpoints != null) 'targetOutpoints': targetOutpoints,
});
TbcFields refundHtlc({
  String? assetStandard,
  String? contractId,
  List<TbcFields>? targetOutpoints,
}) => _intent('tbc-htlc-refund', {
  if (assetStandard != null) 'assetStandard': assetStandard,
  if (contractId != null) 'contractId': contractId,
  if (targetOutpoints != null) 'targetOutpoints': targetOutpoints,
});

TbcFields orderAsset({required String standard, required String contractId}) =>
    {'standard': standard, 'contractId': contractId};
TbcFields createOrder({
  required String market,
  required String side,
  required TbcFields assetA,
  TbcFields? assetB,
  required String saleVolume,
  required String unitPrice,
  required String feeRate,
  required String feeRecipient,
}) => _intent('tbc-lop-create', {
  'order': {
    'market': market,
    'side': side,
    'assetA': assetA,
    if (assetB != null) 'assetB': assetB,
    'saleVolume': saleVolume,
    'unitPrice': unitPrice,
    'feeRate': feeRate,
    'feeRecipient': feeRecipient,
  },
});
TbcFields cancelOrder(TbcFields target) => _intent('tbc-lop-cancel', {
  'targetOutpoints': [target],
});
TbcFields matchOrders(TbcFields buy, TbcFields sell) =>
    _intent('tbc-lop-match', {
      'targetOutpoints': [buy, sell],
    });

/// Ordinary workflow: one explicit transfer, then a typed receipt bound to its
/// actual transaction IDs. It does NOT call sendTransaction separately.
TbcFields transferAndReceipt({
  required String chainId,
  required String from,
  required TbcFields intent,
  required String maxFee,
  required String expiresAt,
}) => {
  'version': '1.0',
  'chainId': chainId,
  'from': from,
  'expiresAt': expiresAt,
  'maxTotalFee': maxFee,
  'failureMode': 'atomic',
  'steps': [
    {
      'id': 'transfer',
      'kind': 'transaction',
      'dependsOn': <String>[],
      'intent': intent,
      'constraints': {'maxFee': maxFee},
    },
    {
      'id': 'receipt',
      'kind': 'typedData',
      'dependsOn': ['transfer'],
      'data': {
        'domain': {'name': 'Wallet transfer receipt', 'chainId': chainId},
        'types': {
          'TransferReceipt': [
            {'name': 'txids', 'type': 'bytes32[]'},
          ],
        },
        'primaryType': 'TransferReceipt',
        'message': {
          'txids': {r'$tbcBinding': 'unresolved'},
        },
      },
      'bindings': [
        {
          'target': '/message/txids',
          'source': {'stepId': 'transfer', 'output': 'transactionIds'},
        },
      ],
    },
  ],
};

/// The caller supplies complete fresh Prepared steps; proposal bytes, hashes
/// and per-proposal expiry are passed unchanged. No builders or reads here.
TbcFields preparedBatch({
  required String chainId,
  required String from,
  required List<TbcFields> steps,
  required String maxTotalFee,
  required String expiresAt,
}) => {
  'version': '1.0',
  'chainId': chainId,
  'from': from,
  'steps': steps,
  'maxTotalFee': maxTotalFee,
  'expiresAt': expiresAt,
  'failureMode': 'atomic',
};
