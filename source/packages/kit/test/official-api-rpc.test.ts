import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  TBC_OFFICIAL_API_ENDPOINTS,
  createTbcOfficialApi,
} from "../src/official-api.ts";
import {
  TBC_NODE_SOURCE,
  TBC_RPC_METHODS,
  createTbcNodeAdminRpcClient,
  createTbcReadRpcClient,
  createTbcRpcTransport,
  createTbcWalletRpcClient,
} from "../src/official-rpc.ts";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("official REST coverage", () => {
  it("normalizes a present null LP list without another request or hiding API errors", async () => {
    const fetch=vi.fn(async()=>response({code:200,data:{utxos:null}}));
    const api=createTbcOfficialApi({network:"testnet",fetch});
    const result=await api.poolLpUtxosByScriptHash({scriptpubkeyhash:"22".repeat(32)});
    expect(result.utxos).toEqual([]);expect(Object.isFrozen(result.utxos)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const failed=createTbcOfficialApi({network:"testnet",fetch:async()=>response({code:500,message:"index unavailable",data:{utxos:null}})});
    await expect(failed.poolLpUtxosByScriptHash({scriptpubkeyhash:"22".repeat(32)})).rejects.toThrow();
  });
  it("normalizes documented LP amounts once without precision loss or extra requests", async () => {
    const fetch = vi.fn(async () => new Response('{"code":"200","data":{"utxos":[{"txid":"'+'11'.repeat(32)+'","index":4,"tbc_balance":500,"lp_balance":9007199254740993,"height":-1}]}}'));
    const api=createTbcOfficialApi({network:"testnet",fetch});
    const {utxos}=await api.poolLpUtxosByScriptHash({scriptpubkeyhash:'22'.repeat(32)});
    expect(utxos[0]).toMatchObject({index:'4',ft_value:'9007199254740993',tbc_value:'500',lp_balance:'9007199254740993',tbc_balance:'500',height:'0'});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("accepts equal canonical LP aliases and refuses conflicting or malformed amounts", async () => {
    for(const extra of [{ft_value:'12',tbc_value:'500'},{balance:'12',value:'500'},{}]){
      const api=createTbcOfficialApi({network:'testnet',fetch:async()=>response({code:200,data:{utxos:[{txid:'11'.repeat(32),index:4,lp_balance:'12',tbc_balance:500,...extra}]}})});
      expect((await api.poolLpUtxosByScriptHash({scriptpubkeyhash:'22'.repeat(32)})).utxos[0]).toMatchObject({ft_value:'12',tbc_value:'500'});
    }
    for(const extra of [{ft_value:'13'},{balance:'13'},{tbc_value:'499'},{value:'499'},{lp_balance:'-1'},{lp_balance:1.5},{lp_balance:null}]){
      const api=createTbcOfficialApi({network:'testnet',fetch:async()=>response({code:200,data:{utxos:[{txid:'11'.repeat(32),index:4,lp_balance:'12',tbc_balance:500,...extra}]}})});
      await expect(api.poolLpUtxosByScriptHash({scriptpubkeyhash:'22'.repeat(32)})).rejects.toThrow();
    }
  });
  it("ships a per-endpoint and per-method coverage matrix", () => {
    const matrix = JSON.parse(readFileSync(
      new URL("../artifacts/api-rpc-coverage.json", import.meta.url),
      "utf8",
    ));
    expect(matrix.api.map((entry: { name: string }) => entry.name)).toEqual(
      TBC_OFFICIAL_API_ENDPOINTS.map((entry) => entry.method),
    );
    expect(matrix.rpc.map((entry: { name: string }) => entry.name)).toEqual(
      TBC_RPC_METHODS.map((entry) => entry.method),
    );
  });

  it("maps every documented endpoint to one exact typed method without eager IO", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      return response({ code: "200", message: "OK", data: url.includes("/api/tbc/txo/status") ? { results: [] } : {} });
    });
    const api = createTbcOfficialApi({ network: "testnet", fetch });
    expect(fetch).not.toHaveBeenCalled();
    for (const endpoint of TBC_OFFICIAL_API_ENDPOINTS) {
      const input: Record<string, unknown> = {};
      for (const name of [...endpoint.path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]!))
        input[name] = name.includes("height") || name === "start" || name === "end" ? 1 : `${name}-value`;
      if ("query" in endpoint) input.limit = 10;
      const method = api[endpoint.method] as (...args: unknown[]) => Promise<unknown>;
      if (endpoint.http === "POST") {
        const body = endpoint.method === "broadcastTransactions" ? [{ txraw: "00" }]
          : endpoint.method === "txoStatus" ? { txos: [{ txid: "11".repeat(32), index: 0 }] }
          : { txraw: "00" };
        await method(body);
      } else if (Object.keys(input).length === 0) await method();
      else await method(input);
      const call = calls.at(-1)!;
      const expectedPath = endpoint.path.replace(/\{([^}]+)\}/gu, (_match, name: string) => encodeURIComponent(String(input[name])));
      expect(new URL(call.url).origin).toBe("https://api.tbcdev.org");
      expect(new URL(call.url).pathname).toBe(`/${expectedPath}`);
      expect(call.init?.method).toBe(endpoint.http);
      if (endpoint.http === "POST") expect(call.init?.body).toBeDefined();
    }
    expect(calls).toHaveLength(TBC_OFFICIAL_API_ENDPOINTS.length);
    expect(new Set(TBC_OFFICIAL_API_ENDPOINTS.map((entry) => entry.method)).size).toBe(TBC_OFFICIAL_API_ENDPOINTS.length);
  });

  it("preserves every integer as a decimal string while retaining floats and zero", async () => {
    const api = createTbcOfficialApi({
      baseUrl: "https://lossless.example/root",
      fetch: async () => new Response('{"code":200,"message":"OK","data":{"value":9007199254740993,"zero":0,"ratio":1.25}}'),
    });
    await expect(api.chainState()).resolves.toEqual({ value: "9007199254740993", zero: "0", ratio: 1.25 });
  });

  it("normalizes official mempool heights and the deployed TXO status response without another request", async () => {
    const calls: string[] = [];
    const txid = "12".repeat(32);
    const api = createTbcOfficialApi({
      baseUrl: "https://shape.example",
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/api/tbc/txo/status")) {
          return new Response(`{"code":200,"message":"OK","data":{"results":[{"txid":"${txid}","index":1,"value":9007199254740993,"scriptpubkey":"76a9","status":{"spent":false}}]}}`);
        }
        if (url.includes("/api/tbc/nft/utxo/")) {
          return new Response(`{"code":200,"message":"OK","data":{"utxos":[{"txid":"${txid}","vout":0,"value":200,"height":-1,"nft_contract_id":"${txid}","collection_id":"${"34".repeat(32)}","script_pubkey":"76a9"}]}}`);
        }
        return new Response(`{"code":200,"message":"OK","data":{"utxos":[{"txid":"${txid}","index":1,"value":100,"height":-1}]}}`);
      },
    });
    await expect(api.utxosByScriptHash({ scriptpubkeyhash: "34".repeat(32) })).resolves.toEqual({
      utxos: [{ txid, index: "1", value: "100", height: "0" }],
    });
    await expect(api.txoStatus({ txos: [{ txid, index: 1 }] })).resolves.toEqual({
      txos: [{ txid, index: "1", value: "9007199254740993", scriptPubKey: "76a9", spent: false }],
    });
    await expect(api.nftUtxosByScriptHash({ scriptpubkeyhash: "56".repeat(32) })).resolves.toMatchObject({
      utxos: [{
        txid, vout: "0", index: "0", value: "200", height: "0",
        nft_contract_id: txid, nft_id: txid, collection_id: "34".repeat(32),
        script_pubkey: "76a9", scriptPubKey: "76a9",
      }],
    });
    await expect(api.timelockUtxosByAddress({ address: "timelock-owner" })).resolves.toEqual({
      utxos: [{ txid, index: "1", value: "100", height: "0" }],
    });
    expect(calls).toHaveLength(4);
  });

  it("rejects conflicting deployed and canonical NFT UTXO aliases", async () => {
    const txid = "12".repeat(32);
    const api = createTbcOfficialApi({
      baseUrl: "https://shape.example",
      fetch: async () => response({ code: "200", message: "OK", data: { utxos: [{
        txid, vout: 0, index: 1, value: 200, height: -1,
        nft_contract_id: txid, nft_id: "34".repeat(32),
        script_pubkey: "76a9", scriptPubKey: "76a8",
      }] } }),
    });
    await expect(api.nftUtxosByScriptHash({ scriptpubkeyhash: "56".repeat(32) })).rejects.toThrow(
      /Conflicting TBC NFT UTXO index/u,
    );
  });

  it("rejects an official endpoint from the other selected network before I/O", () => {
    const fetch = vi.fn();
    expect(() => createTbcOfficialApi({
      network: "mainnet",
      baseUrl: "https://api.tbcdev.org",
      fetch,
    })).toThrow(/network does not match/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors a pre-aborted request without starting network I/O", async () => {
    const fetch = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error("controlled cancellation"));
    const api = createTbcOfficialApi({ fetch });
    await expect(api.health({ signal: controller.signal })).rejects.toThrow(
      /controlled cancellation/u,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps writes single-attempt and retries only classified reads", async () => {
    let writes = 0;
    const writing = createTbcOfficialApi({
      fetch: async () => { writes += 1; return response({ code: "503", message: "temporary", data: {} }, 503); },
    });
    await expect(writing.broadcastTransaction({ txraw: "00" })).rejects.toThrow(/HTTP 503/u);
    expect(writes).toBe(1);

    let reads = 0;
    const reading = createTbcOfficialApi({
      fetch: async () => {
        reads += 1;
        return reads === 1
          ? response({ code: "503", data: {} }, 503)
          : response({ code: "200", message: "OK", data: { txos: [] } });
      },
    });
    await expect(reading.txoStatus({ txos: [] })).resolves.toEqual({ txos: [] });
    expect(reads).toBe(2);
  });
});

describe("TBCNODE v3.3.1 RPC coverage", () => {
  it("pins the official release and exposes every unique registered source method", () => {
    expect(TBC_NODE_SOURCE).toEqual({
      repository: "https://github.com/TuringBitChain/TBCNODE",
      release: "v3.3.1",
      commit: "6ddea88c57e9bc9390c1730657ac766b56c4a670",
      publishedAt: "2026-08-12T08:42:14Z",
    });
    expect(TBC_RPC_METHODS).toHaveLength(127);
    expect(new Set(TBC_RPC_METHODS.map((entry) => entry.method)).size).toBe(127);
    expect(TBC_RPC_METHODS.find((entry) => entry.method === "getblockbyheight")?.args).toEqual(["blockhash", "verbosity|verbose"]);
    expect(TBC_RPC_METHODS.some((entry) => entry.method === "getrawnonfinalmempool")).toBe(true);
    expect(TBC_RPC_METHODS.find((entry) => entry.method === "waitaftervalidatingblock")).toMatchObject({
      networks: ["regtest"],
    });
    for (const method of ["getaccountaddress", "getnewaddress", "getrawchangeaddress", "getminingcandidate"])
      expect(TBC_RPC_METHODS.find((entry) => entry.method === method)?.effect).toBe("write");
  });

  it("uses exact original method names, named params and lossless integer results", async () => {
    const requests: unknown[] = [];
    const rpc = createTbcReadRpcClient({
      url: "https://rpc.example.test",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        requests.push(request);
        return new Response(`{"jsonrpc":"2.0","id":"${request.id}","result":9007199254740993}`);
      },
    });
    await expect(rpc.getblockcount()).resolves.toBe("9007199254740993");
    await rpc.getblock({ blockhash: "11".repeat(32), verbosity: true });
    expect("call" in rpc).toBe(false);
    expect("callExtension" in rpc).toBe(false);
    expect("getminingcandidate" in rpc).toBe(false);
    expect("waitaftervalidatingblock" in rpc).toBe(false);
    expect(requests).toEqual([
      { jsonrpc: "1.0", id: "1", method: "getblockcount", params: [] },
      { jsonrpc: "1.0", id: "2", method: "getblock", params: { blockhash: "11".repeat(32), verbosity: true } },
    ]);
  });

  it("isolates trusted node/wallet surfaces and never retries mutations", async () => {
    expect(() => createTbcNodeAdminRpcClient({ url: "https://rpc.example", trustedServer: false as true })).toThrow(/trusted/u);
    vi.stubGlobal("window", {});
    expect(() => createTbcWalletRpcClient({
      url: "https://rpc.example/wallet/primary",
      trustedServer: true,
    })).toThrow(/non-browser/u);
    vi.unstubAllGlobals();
    let attempts = 0;
    const admin = createTbcNodeAdminRpcClient({
      url: "https://rpc.example",
      trustedServer: true,
      fetch: async () => { attempts += 1; return response({ error: "temporary" }, 503); },
    });
    await expect(admin.stop({ retry: "idempotent-read" })).rejects.toThrow(/HTTP 503/u);
    expect(attempts).toBe(1);

    let walletUrl = "";
    const wallet = createTbcWalletRpcClient({
      url: "https://rpc.example/wallet/primary",
      trustedServer: true,
      fetch: async (input, init) => {
        walletUrl = String(input);
        const request = JSON.parse(String(init?.body));
        return response({ jsonrpc: "2.0", id: request.id, result: [] });
      },
    });
    await wallet.listwallets();
    expect(walletUrl).toBe("https://rpc.example/wallet/primary");
  });

  it("keeps an explicit extension call without silently falling back to REST", async () => {
    const rpc = createTbcRpcTransport({
      url: "https://extension.example",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        return response({ jsonrpc: "2.0", id: request.id, result: { method: request.method } });
      },
    });
    await expect(rpc.callExtension("vendor_method", { exact: "value" })).resolves.toEqual({ method: "vendor_method" });
  });
});
