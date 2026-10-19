// Informational balance from the configured trusted API, not a spendability or
// receipt proof. Uses the same transport as transaction material, with one GET
// and no cache of mutable balances. Canonical wire amounts stay integer strings;
// only the untrusted Legacy page converts to the historical decimal display.
import '../configuration.dart';
import 'protocol_codec.dart';
import 'transaction_read.dart';
import 'tbc20_material.dart' show ApiRead;

const balanceReadMethod = 'wallet_readBalance'; // Private host method only.
String balanceReadPath(String address) {
  inspectP2pkhAddress(address);
  return '/api/tbc/balance/address/$address';
}

Future<Map<String, dynamic>> readTbcBalance({
  required TbcNetworkConfiguration network,
  required String address,
  required ApiRead read,
}) async {
  final response = await read(balanceReadPath(address));
  need(
    !response.containsKey('address') || response['address'] == address,
    'BALANCE_ACCOUNT',
  );
  final candidate = response['balance'];
  final atomic = uintString(
    candidate is double &&
            candidate.isFinite &&
            candidate >= 0 &&
            candidate <= 9007199254740991 &&
            candidate.truncateToDouble() == candidate
        ? candidate.toInt()
        : candidate,
  );
  // Match the frozen Kit's public Legacy number range exactly. Wider balances
  // must not silently round through the historical number-valued result.
  need(
    atomic.length <= 16 &&
        BigInt.parse(atomic) <= BigInt.from(9007199254740991),
    'BALANCE_RANGE',
  );
  return {
    'chainId': network.chainId,
    'address': address,
    'balanceAtomic': atomic,
    'decimals': 6,
  };
}
