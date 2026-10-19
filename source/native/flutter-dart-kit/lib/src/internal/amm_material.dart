// Accepted AMM immutable identity preparation; no quote/construction/signing.
// Funding selection and contract authentication remain in the frozen Engine.
import '../configuration.dart';
import 'native_material.dart';
import 'protocol_codec.dart';
import 'tbc20_material.dart' show tbc20TemplateRevision;
import 'transaction_read.dart';

final class AmmMaterialReader {
  AmmMaterialReader({
    required this.network,
    required this.funding,
    required this.readHistory,
  });
  final TbcNetworkConfiguration network;
  final NativeMaterialReader funding;
  final Future<Map<String, dynamic>> Function(String) readHistory;

  Future<Map<String, dynamic>> resolve({
    required Map<String, dynamic> request,
    required Map<String, dynamic> account,
    required DateTime now,
    required String snapshotId,
    String minConfirmations = '0',
  }) async {
    inspectAccount(account, expectedChainId: network.chainId);
    need(
      request['chainId'] == network.chainId &&
          request['from'] == account['address'],
      'REQUEST_ACCOUNT',
    );
    final intent = request['intent'];
    need(intent is Map && intent['type'] == 'tbc-amm-create', 'AMM_PROFILE');
    final id = hash32(intent['ftContractId']);
    // These independent reads overlap consent; creating an empty pool does not
    // consume FT inputs or require the FT issuance/funding transactions.
    final native = funding.resolve(
      request: request,
      account: account,
      now: now,
      snapshotId: snapshotId,
      minConfirmations: minConfirmations,
    );
    final anchor = funding.read('/api/tbc/ft/info/contract/$id');
    native.ignore();
    anchor.ignore();
    final values = await Future.wait<Object>([native, anchor]);
    final payload = copied((values[0] as Map)['payload']);
    final info=values[1] as Map;
    payload['parents'] = [];
    payload['contracts'] = [
      {
        'contractId': id,
        'indexedFungible': {'codeScript': info['code_script'], 'tapeScript': info['tape_script'], 'totalSupply': uintString(info['amount'])},
        'family': 'ft',
        'protocolVersion': 'tbc20',
        'standardId': 'tbc20-standard',
        'templateRevision': tbc20TemplateRevision,
        'creationTxid': id,
        'genesisOutpoint': {'txid': id, 'vout': 0},
        'currentOutpoint': {'txid': id, 'vout': 0},
      },
    ];
    return {'payload': payload, 'snapshotHash': hashJson(payload)};
  }
}
