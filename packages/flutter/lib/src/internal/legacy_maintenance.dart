// DTO mapping only. No approval, chain I/O, fee selection or execution loop.
// Mirrors the frozen Kit's three standalone Legacy merge aliases.
const legacyMergeMethods = {
  'mergeUtxos',
  'mergeFtUtxos',
  'mergeStableCoinUtxos',
};

Map<String, dynamic> legacyMergeAsset(String method, Object? params) {
  if (!legacyMergeMethods.contains(method))
    throw UnsupportedError('Legacy merge');
  if (method == 'mergeUtxos') {
    // Private wire encodes absent as null. Page rejects explicit null before
    // sending; none of this is authorization or a different execution path.
    if (params != null && !(params is Map && params.isEmpty)) {
      throw const FormatException('Invalid Legacy merge input');
    }
    return const {'kind': 'tbc'};
  }
  Object? id = params;
  if (params is Map &&
      params.length == 1 &&
      const {
        'contract_id',
        'ft_contract_address',
      }.contains(params.keys.single)) {
    id = params.values.single;
  }
  if (id is! String || !RegExp(r'^[a-fA-F0-9]{64}$').hasMatch(id)) {
    throw const FormatException('Invalid Legacy contract');
  }
  return Map.unmodifiable({
    'kind': method == 'mergeFtUtxos' ? 'ft' : 'stablecoin',
    'contractId': id.toLowerCase(),
  });
}
