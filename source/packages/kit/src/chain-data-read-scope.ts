import type { TestnetClient } from "./testnet-client.js";

/** One bounded preparation only. Never retain mutable observations across requests. */
export function createChainDataReadScope(client: TestnetClient): TestnetClient {
  function once<Args extends readonly unknown[], Value>(read: (...args: Args) => Promise<Value>) {
    const reads = new Map<string, Promise<Value>>();
    return (...args: Args): Promise<Value> => {
      // Omitted optional arguments and explicit trailing undefined invoke
      // the same read. Prefetch uses (address), concrete readers may use
      // (address, undefined); they must share the same in-flight request.
      let length = args.length;
      while (length > 0 && args[length - 1] === undefined) length -= 1;
      const key = JSON.stringify(args.slice(0, length));
      let result = reads.get(key);
      if (result === undefined) {
        result = Promise.resolve().then(() => read(...args));
        reads.set(key, result);
      }
      return result;
    };
  }
  const getNativeUtxos = client.getNativeUtxos === undefined ? undefined : once(client.getNativeUtxos.bind(client));
  const getTip = client.getTip === undefined ? undefined : once(client.getTip.bind(client));
  const decoded = new Map<string, ReturnType<TestnetClient["getRawTransaction"]>>();
  const getRawTransaction: TestnetClient["getRawTransaction"] = txid => {
    let pending = decoded.get(txid);
    if (pending === undefined) {
      pending = Promise.resolve().then(() => client.getRawTransaction(txid));
      decoded.set(txid, pending);
    }
    return pending;
  };
  // Decode already supplies validated raw bytes. Reuse them for a later or
  // concurrent byte consumer, but never invent fresh confirmations from raw.
  const getRawTransactionBytes = client.getRawTransactionBytes === undefined ? undefined : once(async (txid: string) => {
    const pending = decoded.get(txid);
    return pending === undefined ? client.getRawTransactionBytes!(txid) : (await pending).rawTransaction;
  });
  return Object.freeze({
    ...client,
    getUtxos: getNativeUtxos === undefined || getTip === undefined ? once(client.getUtxos.bind(client))
      : once(async (address: string) => {
          const [tip, utxos] = await Promise.all([getTip(), getNativeUtxos(address)]);
          return Object.freeze({ tip, utxos });
        }),
    ...(getNativeUtxos === undefined ? {} : { getNativeUtxos }),
    ...(getTip === undefined ? {} : { getTip }),
    getRawTransaction,
    ...(getRawTransactionBytes === undefined ? {} : { getRawTransactionBytes }),
    ...(client.getNativeUtxoParent === undefined ? {} : { getNativeUtxoParent: once(client.getNativeUtxoParent.bind(client)) }),
    getFtUtxos: once(client.getFtUtxos.bind(client)),
    ...(client.getFtInfo === undefined ? {} : { getFtInfo: once(client.getFtInfo.bind(client)) }),
    getStablecoinUtxos: once(client.getStablecoinUtxos.bind(client)),
    getStablecoinInfo: once(client.getStablecoinInfo.bind(client)),
    ...(client.api === undefined ? {} : { api: Object.freeze({
      ...client.api,
      poolInfo: once(client.api.poolInfo.bind(client.api)),
      ...(client.api.nftUtxosByScriptHash === undefined ? {} : { nftUtxosByScriptHash: once(client.api.nftUtxosByScriptHash.bind(client.api)) }),
      ...(client.api.utxosByScriptHash === undefined ? {} : { utxosByScriptHash: once(client.api.utxosByScriptHash.bind(client.api)) }),
      ftUtxosByCombineScript: once(client.api.ftUtxosByCombineScript.bind(client.api)),
      poolLpUtxosByScriptHash: once(client.api.poolLpUtxosByScriptHash.bind(client.api)),
      ...(client.api.nodeInfo === undefined ? {} : { nodeInfo: once(client.api.nodeInfo.bind(client.api)) }),
      ...(client.api.txoStatus === undefined ? {} : { txoStatus: once(client.api.txoStatus.bind(client.api)) }),
      ...(client.api.timelockUtxosByAddress === undefined ? {} : { timelockUtxosByAddress: once(client.api.timelockUtxosByAddress.bind(client.api)) }),
    }) }),
  });
}
