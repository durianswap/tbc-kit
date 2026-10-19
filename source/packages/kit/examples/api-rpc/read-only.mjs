import { createTbcOfficialApi } from "@tbc/kit/api";
import { createTbcReadRpcClient } from "@tbc/kit/rpc";

export async function readAddressSnapshot({ address, fetch, rpcUrl }) {
  const api = createTbcOfficialApi({ network: "testnet", fetch });
  const rpc = createTbcReadRpcClient({ url: rpcUrl, fetch });

  const [node, native, rpcHeight] = await Promise.all([
    api.nodeInfo(),
    api.utxosByAddress({ address }),
    rpc.getblockcount(),
  ]);

  return Object.freeze({
    apiHeight: node.blocks,
    rpcHeight,
    utxos: native.utxos,
  });
}

