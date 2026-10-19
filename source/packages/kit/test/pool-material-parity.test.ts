import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import controlledPool from "./fixtures/controlled-pool.json";
import controlledRemove from "./fixtures/controlled-pool-remove.json";
import { createControlledTestnetFetch } from "./controlled-testnet.ts";
import {
  createPoolInitializeMaterialResolver,
  createPoolMaterialSource,
  createPoolMaterialTransactionReader,
  createPoolTransactionInspector,
  createProductionPoolMaterialSource,
} from "../src/pool-material.ts";
import {
  createTestnetClient,
  OFFICIAL_TBC_TESTNET_API_ORIGIN,
} from "../src/testnet-client.ts";
import * as validation from "../src/testnet-validation.ts";
import { createWasmTbcKeylessEngine } from "../src/keyless.ts";
import {
  parseTbcTransaction,
  turingTransactionId,
} from "../src/testnet-validation.ts";

const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const keylessArtifact = process.env.TBC_KEYLESS_WASM ?? new URL("../artifacts/wasm/tbc_keyless_wasm.wasm", import.meta.url);

it("loads historical proof bytes without decoding and keeps live confirmations separate", async () => {
  const id = "ac".repeat(32);
  const getRawTransaction = vi.fn(async () => ({
    txid: id,
    rawTransaction: "aa",
    confirmations: "2",
  }));
  const getRawTransactionBytes = vi.fn(async () => "aa");
  const reader = createPoolMaterialTransactionReader({
    getRawTransaction,
    getRawTransactionBytes,
  } as never);
  expect(await reader.readBytes(id)).toBe("aa");
  expect(await reader.readBytes(id)).toBe("aa");
  expect(getRawTransactionBytes).toHaveBeenCalledTimes(1);
  expect(getRawTransaction).not.toHaveBeenCalled();
  expect((await reader(id)).confirmations).toBe("2");
  expect(getRawTransaction).toHaveBeenCalledTimes(1);
  expect(await reader.readBytes(id)).toBe("aa");
  expect(getRawTransactionBytes).toHaveBeenCalledTimes(1);
});

afterEach(() => vi.restoreAllMocks());

it("reuses same-request native output height for the current Pool transaction without decode", async () => {
  const raw = transaction("18", [{ satoshis: 500n, script: "51" }]);
  const id = turingTransactionId(raw);
  const getRawTransaction = vi.fn(async () => {
    throw Error("UNNECESSARY_POOL_DECODE");
  });
  const getRawTransactionBytes = vi.fn(async () => raw);
  const reader = createPoolMaterialTransactionReader(
    { getRawTransaction, getRawTransactionBytes },
    async () => "100",
    async (txid) => (txid === id ? "98" : undefined),
  );
  expect((await reader(id)).confirmations).toBe("3");
  expect(getRawTransaction).not.toHaveBeenCalled();
  expect(getRawTransactionBytes).toHaveBeenCalledTimes(1);
  const conflicting = createPoolMaterialTransactionReader(
    { getRawTransaction, getRawTransactionBytes },
    async () => "100",
    async () => "97",
  );
  conflicting.observeHeight(id, "98");
  await expect(conflicting(id)).rejects.toThrow("Conflicting");
});

it("omits unknown confirmations at an explicit wallet zero floor without decode", async () => {
  const raw = transaction("21", [{ satoshis: 500n, script: "51" }]);
  const id = turingTransactionId(raw);
  const getRawTransaction = vi.fn(async () => {
    throw Error("ZERO_FLOOR_MUST_NOT_DECODE");
  });
  const getRawTransactionBytes = vi.fn(async () => raw);
  const readTipHeight = vi.fn(async () => "100");
  const readIndexedHeight = vi.fn(async () => undefined);
  const reader = createPoolMaterialTransactionReader(
    { getRawTransaction, getRawTransactionBytes },
    readTipHeight,
    readIndexedHeight,
    validation.inspectTbcTransaction,
    undefined,
    { minConfirmations: "0" },
  );

  const projected = await reader(id);
  expect(Object.hasOwn(projected, "confirmations")).toBe(false);
  expect(projected.rawTransaction).toBe(raw);
  expect(projected.outputs[0]).toMatchObject({
    satoshis: "500",
    scriptPubKey: "51",
  });
  expect(getRawTransaction).not.toHaveBeenCalled();
  expect(readTipHeight).not.toHaveBeenCalled();
  expect(readIndexedHeight).toHaveBeenCalledOnce();
  expect(getRawTransactionBytes).toHaveBeenCalledOnce();

  const wrong = transaction("22", [{ satoshis: 500n, script: "51" }]);
  const rejected = createPoolMaterialTransactionReader(
    {
      getRawTransaction,
      getRawTransactionBytes: async () => wrong,
    },
    undefined,
    undefined,
    validation.inspectTbcTransaction,
    undefined,
    { minConfirmations: "0" },
  );
  await expect(rejected(id)).rejects.toThrow("identity");
});

it.each(["index", "tip"] as const)("zero floor does not wait for deferred %s confirmation metadata", async (blocked) => {
  const raw = transaction("25", [{ satoshis: 500n, script: "51" }]);
  const id = turingTransactionId(raw);
  let release!: (value: string) => void;
  const pending = new Promise<string>((resolve) => { release = resolve; });
  const tip = vi.fn(() => blocked === "tip" ? pending : Promise.resolve("100"));
  const decode = vi.fn(async () => { throw Error("UNNECESSARY_DECODE"); });
  const bytes = vi.fn(async () => raw);
  const reader = createPoolMaterialTransactionReader(
    { getRawTransaction: decode, getRawTransactionBytes: bytes },
    tip, () => blocked === "index" ? pending : Promise.resolve("98"),
    validation.inspectTbcTransaction, undefined, { minConfirmations: "0" },
  );
  let result: Awaited<ReturnType<typeof reader>> | undefined;
  const read = reader(id).then((value) => { result = value; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(result !== undefined).toBe(true);
    expect(Object.hasOwn(result!, "confirmations")).toBe(false);
    expect(result!.txid === id).toBe(true);
    expect(bytes).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
  } finally {
    release(blocked === "index" ? "98" : "100");
    await read;
  }
  // Finishing a deferred index must not start a new tip lookup after delivery.
  if (blocked === "index") expect(tip).not.toHaveBeenCalled();
  expect(Object.hasOwn(result!, "confirmations")).toBe(false);
});

it("positive floor still waits for required metadata", async () => {
  const raw = transaction("26", [{ satoshis: 500n, script: "51" }]);
  const id = turingTransactionId(raw);
  let release!: (value: string) => void;
  const pending = new Promise<string>((resolve) => { release = resolve; });
  const bytes = vi.fn(async () => raw);
  const reader = createPoolMaterialTransactionReader(
    { getRawTransaction: async () => { throw Error("UNNECESSARY_DECODE"); }, getRawTransactionBytes: bytes },
    async () => "100", () => pending,
    validation.inspectTbcTransaction, undefined, { minConfirmations: "1" },
  );
  let done = false;
  const read = reader(id).then((node) => { done = true; return node; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    expect(bytes).not.toHaveBeenCalled();
  } finally { release("98"); }
  expect((await read).confirmations).toBe("3");
});

it.each(["-2", "101", "not-a-height"])("zero floor rejects available invalid height %s", async (height) => {
  const raw = transaction("27", [{ satoshis: 500n, script: "51" }]);
  const reader = createPoolMaterialTransactionReader(
    { getRawTransaction: async () => { throw Error("UNNECESSARY_DECODE"); }, getRawTransactionBytes: async () => raw },
    async () => "100", async () => height,
    validation.inspectTbcTransaction, undefined, { minConfirmations: "0" },
  );
  await expect(reader(turingTransactionId(raw))).rejects.toThrow();
});

it("zero floor rejects a known malformed height without waiting for tip", async () => {
  const raw = transaction("28", [{ satoshis: 500n, script: "51" }]);
  const tip = vi.fn(() => new Promise<string>(() => {}));
  const reader = createPoolMaterialTransactionReader(
    { getRawTransaction: async () => { throw Error("UNNECESSARY_DECODE"); }, getRawTransactionBytes: async () => raw },
    tip, async () => "-2",
    validation.inspectTbcTransaction, undefined, { minConfirmations: "0" },
  );
  await expect(reader(turingTransactionId(raw))).rejects.toThrow();
  expect(tip).not.toHaveBeenCalled();
});

it("keeps positive-floor reads exact and snapshots the wallet policy immutably", async () => {
  const raw = transaction("23", [{ satoshis: 500n, script: "51" }]);
  const id = turingTransactionId(raw);
  const getRawTransaction = vi.fn(async () => ({
    txid: id, rawTransaction: raw, confirmations: "3", inputs: [], outputs: [],
  }));
  const policy = { minConfirmations: "1" };
  const reader = createPoolMaterialTransactionReader(
    { getRawTransaction, getRawTransactionBytes: async () => raw },
    undefined, undefined, validation.inspectTbcTransaction, undefined, policy,
  );
  policy.minConfirmations = "0";
  expect((await reader(id)).confirmations).toBe("3");
  expect(getRawTransaction).toHaveBeenCalledOnce();
});

it.each([["98", "3"], ["0", "0"]])("retains already available height %s as an observed count at zero floor", async (height, expected) => {
  const raw = transaction("24", [{ satoshis: 500n, script: "51" }]);
  const id = turingTransactionId(raw);
  const reader = createPoolMaterialTransactionReader(
    { getRawTransaction: async () => { throw Error("UNNECESSARY_DECODE"); }, getRawTransactionBytes: async () => raw },
    async () => "100", async () => height,
    validation.inspectTbcTransaction, undefined, { minConfirmations: "0" },
  );
  expect((await reader(id)).confirmations).toBe(expected);
});

it.each([undefined, { minConfirmations: "0" }])("reuses the verified selected native parent when it is also the current Pool transaction (policy=%j)", async (policy) => {
  const raw = transaction("19", [{ satoshis: 500n, script: "51" }]);
  const id = turingTransactionId(raw);
  const getRawTransaction = vi.fn(async () => {
    throw Error("DUPLICATE_CURRENT_POOL_GET");
  });
  const getRawTransactionBytes = vi.fn(async () => {
    throw Error("DUPLICATE_CURRENT_POOL_GET");
  });
  const readSelectedParentBytes = vi.fn(async (txid: string) =>
    txid === id ? raw : undefined,
  );
  const reader = createPoolMaterialTransactionReader(
    { getRawTransaction, getRawTransactionBytes },
    async () => "100",
    async () => "98",
    validation.inspectTbcTransaction,
    readSelectedParentBytes,
    policy,
  );

  expect((await reader(id)).confirmations).toBe("3");
  expect(await reader.readBytes(id)).toBe(raw);
  expect(readSelectedParentBytes).toHaveBeenCalledOnce();
  expect(getRawTransaction).not.toHaveBeenCalled();
  expect(getRawTransactionBytes).not.toHaveBeenCalled();

  const wrong = transaction("20", [{ satoshis: 500n, script: "51" }]);
  const rejected = createPoolMaterialTransactionReader(
    { getRawTransaction, getRawTransactionBytes },
    async () => "100",
    async () => "98",
    validation.inspectTbcTransaction,
    async () => wrong,
    policy,
  );
  await expect(rejected(id)).rejects.toThrow("identity");
});

it("uses fresh indexed height and same-request tip without downloading decode again", async () => {
  const raw = transaction("17", [{ satoshis: 500n, script: "51" }]);
  const id = turingTransactionId(raw);
  const getRawTransaction = vi.fn(async () => {
    throw Error("UNNECESSARY_DECODE");
  });
  const getRawTransactionBytes = vi.fn(async () => raw);
  const reader = createPoolMaterialTransactionReader(
    { getRawTransaction, getRawTransactionBytes },
    async () => "100",
  );
  reader.observeHeight(id, "98");
  const node = await reader(id);
  expect(node.confirmations).toBe("3");
  expect(node.outputs[0]).toMatchObject({
    satoshis: "500",
    scriptPubKey: "51",
  });
  expect(node.rawTransaction).toBe(raw);
  expect(getRawTransaction).not.toHaveBeenCalled();
  expect(getRawTransactionBytes).toHaveBeenCalledTimes(1);
  expect(await reader.readBytes(id)).toBe(raw);
  expect(getRawTransactionBytes).toHaveBeenCalledTimes(1);
  expect(() => reader.observeHeight(id, "-2")).toThrow();
  const next = createPoolMaterialTransactionReader(
    { getRawTransaction, getRawTransactionBytes },
    async () => "100",
  );
  next.observeHeight(id, "101");
  await expect(next(id)).rejects.toThrow("height");
  const fresh = createPoolMaterialTransactionReader(
    { getRawTransaction, getRawTransactionBytes },
    async () => "100",
  );
  await expect(fresh(id)).rejects.toThrow("UNNECESSARY_DECODE");
});

it("shares only exact-byte parsing and identity across LP consumers, never confirmation responses or request scopes", async () => {
  const raw = transaction("17", [{ satoshis: 500n, script: "51" }]);
  const txid = turingTransactionId(raw);
  const compute = vi.spyOn(validation, "inspectTbcTransaction");
  const inspect = createPoolTransactionInspector();
  const inspected = inspect(raw);
  expect(inspected.txid).toBe(txid);
  expect(inspected.transaction.outputs[0]?.satoshis).toBe(500n);
  expect(inspect(raw)).toBe(inspected);
  let confirmations = "0";
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          code: "200",
          data: {
            txid,
            hex: raw,
            confirmations,
            vout: [
              {
                n: 0,
                valueSat: 500,
                scriptPubKey: { hex: "51", addresses: [] },
              },
            ],
          },
        }),
      ),
  );
  const client = createTestnetClient({
    baseUrl: OFFICIAL_TBC_TESTNET_API_ORIGIN,
    fetch,
    inspectTransaction: inspect,
  });
  expect((await client.getRawTransaction(txid)).confirmations).toBe("0");
  confirmations = "1";
  expect((await client.getRawTransaction(txid)).confirmations).toBe("1");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(compute).toHaveBeenCalledTimes(1);
  expect(createPoolTransactionInspector()(raw)).not.toBe(inspected);
  expect(compute).toHaveBeenCalledTimes(2);
  const changed = transaction("17", [{ satoshis: 501n, script: "51" }]);
  expect(inspect(changed).txid).not.toBe(txid);
  expect(() => inspect(`${raw}00`)).toThrow("Trailing TBC transaction bytes");
  expect(inspect(raw)).toBe(inspected);
});

it("bounds retained inspection bytes and does not retain oversized results", () => {
  const parsed = validation.inspectTbcTransaction(
    transaction("17", [{ satoshis: 500n, script: "51" }]),
  );
  const compute = vi
    .spyOn(validation, "inspectTbcTransaction")
    .mockReturnValue(parsed);
  const inspect = createPoolTransactionInspector();
  // Cache arithmetic only; real byte/identity validation is covered above.
  const first = "aa".repeat(1_048_577);
  const second = "bb".repeat(1_048_577);
  inspect(first);
  inspect(second);
  inspect(first);
  expect(compute).toHaveBeenCalledTimes(3);
  const oversized = "cc".repeat(2_097_153);
  inspect(oversized);
  inspect(oversized);
  expect(compute).toHaveBeenCalledTimes(5);
});

it.each([
  false,
  true,
])("wires one inspection scope through production client, loader and Pool source ancestry; early index=%s", async (earlyIndex) => {
  const compute = vi.spyOn(validation, "inspectTbcTransaction");
  const native = {
    protocolInfo: async () =>
      JSON.stringify({
        operations: [
          "preparePoolNft",
          "prepareAssetAncestry",
          "previewLiquidityAdd",
        ],
      }),
    execute: vi.fn(async () => {
      throw Error("READ_ONLY_PREPARATION_STOP");
    }),
  };
  const fetch = vi.fn(
    createControlledTestnetFetch({ nativeUtxoSatoshis: 20_000_000 }),
  );
  const source = await createProductionPoolMaterialSource({ fetch, native });
  const raw = (
    controlledPool.rawTransactions as Readonly<Record<string, string>>
  )[controlledPool.poolContractId];
  const currentRaw = (
    controlledPool.rawTransactions as Readonly<Record<string, string>>
  )[controlledPool.poolInfo.txid];
  const funding = Object.assign(
    vi.fn(async () => {
      throw Error("FEE_PARENT_MUST_NOT_BLOCK_POOL_CONTEXT");
    }),
    {
      readIndex: vi.fn(async () => ({
        tipHeight: "1000",
        indexedHeights: { [controlledPool.poolInfo.txid]: "990" },
      })),
    },
  );
  if (!raw || !currentRaw) throw Error("Missing controlled Pool transaction");
  for (let run = 1; run <= 2; run++) {
    await expect(
      source.resolveLiquidityAdd(
        {
          address: controlledPool.address,
          receiver: controlledPool.address,
          poolContractId: controlledPool.poolContractId,
          tbcAmount: "2000000",
        },
        earlyIndex ? funding : undefined,
      ),
    ).rejects.toThrow("READ_ONLY_PREPARATION_STOP");
    // This fixture's creation is also the live state's direct predecessor.
    // Drain already-started read-only prefetch after the deliberate early stop.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(compute.mock.calls.filter(([value]) => value === raw)).toHaveLength(
      run,
    );
    expect(
      compute.mock.calls.filter(([value]) => value === currentRaw),
    ).toHaveLength(run);
  }
  expect(native.execute).toHaveBeenCalledTimes(2);
  if (earlyIndex) {
    expect(funding).not.toHaveBeenCalled();
    expect(funding.readIndex).toHaveBeenCalled();
  }
  const requests = fetch.mock.calls.map(
    ([url]) => new URL(String(url)).pathname,
  );
  expect(
    requests.filter((path) =>
      path.endsWith(`/txraw/txid/${controlledPool.poolContractId}`),
    ),
  ).toHaveLength(1);
  expect(
    requests.filter((path) => path.includes("/pool/poolinfo/")),
  ).toHaveLength(2);
  expect(
    requests.filter((path) => path.includes("/decode/txid/")),
  ).toHaveLength(earlyIndex ? 0 : 2); // Only live state needs confirmations; creation is immutable history.
});

it("applies the wallet zero floor only to LP construction and removes confirmation-only decode", async () => {
  const native = {
    protocolInfo: async () =>
      JSON.stringify({
        operations: [
          "preparePoolNft",
          "prepareAssetAncestry",
          "previewLiquidityAdd",
        ],
      }),
    execute: vi.fn(async () => {
      throw Error("READ_ONLY_PREPARATION_STOP");
    }),
  };
  const fetch = vi.fn(
    createControlledTestnetFetch({ nativeUtxoSatoshis: 20_000_000 }),
  );
  const source = await createProductionPoolMaterialSource({
    fetch,
    native,
    confirmationPolicy: { minConfirmations: "0" },
  });

  expect(source.confirmationPolicy).toEqual({ minConfirmations: "0" });
  await expect(
    source.resolveLiquidityAdd({
      address: controlledPool.address,
      receiver: controlledPool.address,
      poolContractId: controlledPool.poolContractId,
      tbcAmount: "2000000",
    }),
  ).rejects.toThrow("READ_ONLY_PREPARATION_STOP");

  const requests = fetch.mock.calls.map(
    ([url]) => new URL(String(url)).pathname,
  );
  expect(requests.filter((path) => path.includes("/decode/txid/"))).toHaveLength(0);
  expect(
    requests.filter((path) =>
      path.endsWith(`/txraw/txid/${controlledPool.poolInfo.txid}`),
    ),
  ).toHaveLength(1);
});

it("wires the already verified fee parent bytes into the current Pool read", async () => {
  const native = {
    protocolInfo: async () =>
      JSON.stringify({
        operations: [
          "preparePoolNft",
          "prepareAssetAncestry",
          "previewLiquidityAdd",
        ],
      }),
    execute: vi.fn(async () => {
      throw Error("READ_ONLY_PREPARATION_STOP");
    }),
  };
  const fetch = vi.fn(
    createControlledTestnetFetch({ nativeUtxoSatoshis: 20_000_000 }),
  );
  const source = await createProductionPoolMaterialSource({ fetch, native });
  const currentTxid = controlledPool.poolInfo.txid;
  const currentRaw = (
    controlledPool.rawTransactions as Readonly<Record<string, string>>
  )[currentTxid];
  if (!currentRaw) throw Error("Missing controlled current Pool transaction");
  const funding = Object.assign(
    vi.fn(async () => ({
      address: controlledPool.address,
      txid: currentTxid,
      vout: 0,
      satoshis: "1",
      rawTransaction: currentRaw,
      tipHeight: "1000",
      indexedHeights: { [currentTxid]: "990" },
    })),
    {
      readIndex: vi.fn(async () => ({
        tipHeight: "1000",
        indexedHeights: { [currentTxid]: "990" },
        selectedParentTxid: currentTxid,
      })),
    },
  );

  await expect(
    source.resolveLiquidityAdd(
      {
        address: controlledPool.address,
        receiver: controlledPool.address,
        poolContractId: controlledPool.poolContractId,
        tbcAmount: "2000000",
      },
      funding,
    ),
  ).rejects.toThrow("READ_ONLY_PREPARATION_STOP");

  const paths = fetch.mock.calls.map(
    ([url]) => new URL(String(url)).pathname,
  );
  expect(
    paths.filter((path) => path.endsWith(`/txraw/txid/${currentTxid}`)),
  ).toHaveLength(0);
  expect(funding).toHaveBeenCalledOnce();
  expect(funding.readIndex).toHaveBeenCalled();
});

it("shares transaction reads only within one LP preparation, including concurrent callers, without retaining failures or stale confirmations across requests", async () => {
  let confirmations = "0";
  const get = vi.fn(async (txid: string) => ({ txid, confirmations }));
  const reader = createPoolMaterialTransactionReader({
    getRawTransaction: get,
  } as never);
  const id = "ab".repeat(32);
  const [one, two] = await Promise.all([reader(id), reader(id)]);
  expect(one).toBe(two);
  expect(get).toHaveBeenCalledTimes(1);
  expect(await reader(id)).toBe(one);
  confirmations = "1";
  expect(
    await createPoolMaterialTransactionReader({
      getRawTransaction: get,
    } as never)(id),
  ).toMatchObject({ confirmations: "1" });
  expect(get).toHaveBeenCalledTimes(2);
  get.mockRejectedValueOnce(Error("temporary read failure"));
  const other = "cd".repeat(32);
  await expect(reader(other)).rejects.toThrow("temporary read failure");
  await expect(reader(other)).resolves.toMatchObject({ txid: other });
  expect(get).toHaveBeenCalledTimes(4);
});

function le64(value: bigint): string {
  return Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt(index * 8)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
}

function transaction(
  marker: string,
  outputs: readonly { readonly satoshis: bigint; readonly script: string }[],
  input?: Readonly<{ readonly txid: string; readonly vout: number }>,
): string {
  const inputTxid = input?.txid ?? marker.repeat(32);
  const encodedTxid = inputTxid.match(/../gu)?.reverse().join("");
  if (encodedTxid === undefined || encodedTxid.length !== 64) {
    throw new Error("invalid fixture input txid");
  }
  const encodedVout = (input?.vout ?? 0)
    .toString(16)
    .padStart(8, "0")
    .match(/../gu)
    ?.reverse()
    .join("");
  if (encodedVout === undefined || encodedVout.length !== 8) {
    throw new Error("invalid fixture input vout");
  }
  return `0a00000001${encodedTxid}${encodedVout}00ffffffff${outputs.length
    .toString(16)
    .padStart(2, "0")}${outputs
    .map(
      ({ satoshis, script }) =>
        `${le64(satoshis)}${(script.length / 2)
          .toString(16)
          .padStart(2, "0")}${script}`,
    )
    .join("")}00000000`;
}

describe("canonical Pool material source", () => {
  it.each(["add", "remove", "swap-to-token", "swap-to-tbc", "initialize"] as const)("resolves complete %s material at zero floor without decode and preserves all other evidence", async (operation) => {
    const native = await createWasmTbcKeylessEngine(
      await readFile(keylessArtifact),
    );
    const fixture = operation === "add" || operation === "initialize" ? controlledPool : controlledRemove;
    const traces: string[][] = [];
    const materials = [];
    for (const zeroFloor of [false, true]) {
      const trace: string[] = [];
      traces.push(trace);
      const baseFetch = createControlledTestnetFetch({
        nativeUtxoSatoshis: 20_000_000,
        ...(operation === "remove" || operation === "swap-to-token" || operation === "swap-to-tbc" ? { poolOperation: operation } : {}),
        ...(operation === "initialize" ? { poolState: "uninitialized" as const } : {}),
      });
      const fetch: typeof globalThis.fetch = async (input, init) => {
        expect(init?.method ?? "GET").toBe("GET");
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        trace.push(path);
        if (zeroFloor && path.includes("/decode/")) throw Error("UNNECESSARY_DECODE");
        return baseFetch(input, init);
      };
      const source = await createProductionPoolMaterialSource({
        fetch, native,
        ...(zeroFloor ? { confirmationPolicy: { minConfirmations: "0" } } : {}),
      });
      const common = { address: fixture.address, receiver: fixture.address, poolContractId: fixture.poolContractId };
      const material = operation === "add"
        ? await source.resolveLiquidityAdd({ ...common, tbcAmount: "1000" })
        : operation === "remove" ? await source.resolveLiquidityRemove!({ ...common, lpAmount: "1000" })
        : operation === "swap-to-token" ? await source.resolveSwapTbcForToken!({ ...common, tbcAmount: "1000" })
        : operation === "swap-to-tbc" ? await source.resolveSwapTokenForTbc!({ ...common, ftAmount: "250000" })
        : await source.resolveCreateInitialize!({ ...common, tbcAmount: "1000", ftAmount: "250000" });
      if (zeroFloor) expect(material.utxos.every((u) => !Object.hasOwn(u, "confirmations"))).toBe(true);
      materials.push({ ...material, utxos: material.utxos.map(({ confirmations, ...identity }) => identity) });
    }
    expect(materials[1]).toEqual(materials[0]);
    expect(traces[0]!.filter((p) => p.includes("/decode/")).length).toBeGreaterThan(0);
    expect(traces[1]!.filter((p) => p.includes("/decode/"))).toHaveLength(0);
  });

  it("still obtains the fresh chain tip for lock-enabled remove under a zero confirmation floor", async () => {
    const engine = await createWasmTbcKeylessEngine(
      await readFile(keylessArtifact),
    );
    let selectedHeight: unknown;
    const native = {
      protocolInfo: engine.protocolInfo,
      async execute(operation: string, input: string) {
        const request = JSON.parse(input);
        if (request.phase === "select") {
          selectedHeight = request.currentBlockHeight;
          throw Error("STOP_BEFORE_LOCK_SELECTION");
        }
        const result = JSON.parse(await engine.execute(operation, input));
        if (request.phase === "describe") result.pool.ftlpLockTimeEnabled = true;
        return JSON.stringify(result);
      },
    };
    const trace: string[] = [];
    const baseFetch = createControlledTestnetFetch({ nativeUtxoSatoshis: 20_000_000, poolOperation: "remove" });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      trace.push(path);
      if (path === "/api/tbc/recentblocks/start/0/end/1")
        return new Response(JSON.stringify({ code: "200", data: [{ height: 1000 }] }));
      if (path.includes("/decode/")) throw Error("UNNECESSARY_DECODE");
      return baseFetch(input, init);
    };
    const source = await createProductionPoolMaterialSource({ fetch, native, confirmationPolicy: { minConfirmations: "0" } });
    await expect(source.resolveLiquidityRemove!({
      address: controlledRemove.address, receiver: controlledRemove.address,
      poolContractId: controlledRemove.poolContractId, lpAmount: "1000",
    })).rejects.toThrow("STOP_BEFORE_LOCK_SELECTION");
    expect(selectedHeight).toBe(998);
    expect(trace.filter((p) => p.includes("/recentblocks/"))).toHaveLength(1);
    expect(trace.filter((p) => p.includes("/decode/"))).toHaveLength(0);
  });

  it("rejects a Pool tip with omitted confirmations without mempool inference", async () => {
    const native = await createWasmTbcKeylessEngine(
      await readFile(keylessArtifact),
    );
    const baseFetch = createControlledTestnetFetch({ nativeUtxoSatoshis: 20_000_000 });
    const currentTxid = controlledPool.poolInfo.txid;
    const trace: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      trace.push(url.pathname);
      const response = await baseFetch(input, init);
      if (url.pathname !== `/api/tbc/decode/txid/${currentTxid}`) return response;
      const envelope = await response.json() as { code: string; data: Record<string, unknown> };
      const { confirmations: _omitted, ...withoutConfirmations } = envelope.data;
      return new Response(JSON.stringify({ ...envelope, data: withoutConfirmations }));
    });
    const source = await createProductionPoolMaterialSource({ fetch, native });
    await expect(source.resolveLiquidityAdd({
      address: controlledPool.address,
      receiver: controlledPool.address,
      poolContractId: controlledPool.poolContractId,
      tbcAmount: "1000",
    })).rejects.toMatchObject({ code: "NODE_RESPONSE_INVALID" });
    expect(trace.filter((path) => path === `/api/tbc/decode/txid/${currentTxid}`)).toHaveLength(1);
    expect(trace.filter((path) => path === "/api/tbc/mempooltxs")).toHaveLength(0);
  });

  it("resolves controlled LP material with the bundled public keyless WASM", async () => {
    const native = await createWasmTbcKeylessEngine(
      await readFile(keylessArtifact),
    );
    const fetch = vi.fn(
      createControlledTestnetFetch({ nativeUtxoSatoshis: 20_000_000 }),
    );
    const source = await createProductionPoolMaterialSource({ fetch, native });
    const material = await source.resolveLiquidityAdd({
      address: controlledPool.address,
      receiver: controlledPool.address,
      poolContractId: controlledPool.poolContractId,
      tbcAmount: "1000",
    });
    expect(material.review).toMatchObject({
      ftContractId: controlledPool.ftContractId,
      ftRequiredRaw: "250000",
      ftlpDeltaRaw: "1000",
    });
    expect(material.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: "pool", contractId: controlledPool.poolContractId }),
      expect.objectContaining({ family: "ft", contractId: controlledPool.ftContractId }),
    ]));
    expect(material.parents.length).toBeGreaterThan(0);
    expect(fetch.mock.calls.every(([url]) => new URL(String(url)).origin === OFFICIAL_TBC_TESTNET_API_ORIGIN)).toBe(true);
  });

  it("resolves the controlled uninitialized Pool through exact public ancestry", async () => {
    const fetch = createControlledTestnetFetch({
      nativeUtxoSatoshis: 20_000_000,
      poolState: "uninitialized",
    });
    const client = createTestnetClient({
      baseUrl: OFFICIAL_TBC_TESTNET_API_ORIGIN,
      allowedOrigins: [OFFICIAL_TBC_TESTNET_API_ORIGIN],
      fetch,
    });
    const rawTransactions = controlledPool.rawTransactions as Readonly<
      Record<string, string>
    >;
    const ownerRaw = rawTransactions[controlledPool.ownerCandidate.txid];
    if (ownerRaw === undefined) throw new Error("missing controlled FT owner");
    const ownerOutput = parseTbcTransaction(ownerRaw).outputs[0];
    if (ownerOutput === undefined)
      throw new Error("missing controlled FT output");
    const native = {
      protocolInfo: async () => "{}",
      execute: vi.fn(async () =>
        JSON.stringify({
          stablecoin: false,
          ftContractId: controlledPool.ftContractId,
          ownerFtScript: Buffer.from(ownerOutput.scriptPubKey).toString("hex"),
          pool: {
            ftLpRaw: "0",
            ftARaw: "0",
            tbcSat: "0",
            lpPlan: 2,
            serviceFeeRate: 35,
          },
        }),
      ),
    };
    const resolve = createPoolInitializeMaterialResolver({
      client,
      fetch,
      native,
    });

    await expect(
      resolve({
        address: controlledPool.address,
        receiver: controlledPool.address,
        poolContractId: controlledPool.poolContractId,
        tbcAmount: "10000000",
        ftAmount: "500000",
      }),
    ).resolves.toMatchObject({
      policy: { lpPlan: 2, serviceFeeRate: 35 },
      contracts: expect.arrayContaining([
        expect.objectContaining({
          family: "pool",
          contractId: controlledPool.poolContractId,
        }),
        expect.objectContaining({
          family: "ft",
          contractId: controlledPool.ftContractId,
        }),
      ]),
    });
  });

  it("authenticates an uninitialized Pool substitute without a private builder", async () => {
    const poolSourceRaw = transaction("20", [
      { satoshis: 9900n, script: "55" },
    ]);
    const poolSourceTxid = turingTransactionId(poolSourceRaw);
    const poolRaw = transaction(
      "21",
      [
        { satoshis: 1000n, script: "51" },
        { satoshis: 0n, script: "52" },
      ],
      { txid: poolSourceTxid, vout: 0 },
    );
    const poolContractId = turingTransactionId(poolRaw);
    const ftContractRaw = transaction("22", [{ satoshis: 500n, script: "54" }]);
    const ftContractId = turingTransactionId(ftContractRaw);
    const ownerRaw = transaction("23", [{ satoshis: 500n, script: "54" }], {
      txid: ftContractId,
      vout: 0,
    });
    const ownerTxid = turingTransactionId(ownerRaw);
    const decoded = new Map([
      [
        poolSourceTxid,
        {
          txid: poolSourceTxid,
          rawTransaction: poolSourceRaw,
          confirmations: "0",
          inputs: [],
          outputs: [
            {
              vout: 0,
              satoshis: "9900",
              scriptPubKey: "55",
              addresses: [],
            },
          ],
        },
      ],
      [
        poolContractId,
        {
          txid: poolContractId,
          rawTransaction: poolRaw,
          confirmations: "0",
          inputs: [{ txid: poolSourceTxid, vout: 0 }],
          outputs: [
            {
              vout: 0,
              satoshis: "1000",
              scriptPubKey: "51",
              addresses: [],
            },
            {
              vout: 1,
              satoshis: "0",
              scriptPubKey: "52",
              addresses: [],
            },
          ],
        },
      ],
      [
        ftContractId,
        {
          txid: ftContractId,
          rawTransaction: ftContractRaw,
          confirmations: "0",
          inputs: [],
          outputs: [
            {
              vout: 0,
              satoshis: "500",
              scriptPubKey: "54",
              addresses: [],
            },
          ],
        },
      ],
      [
        ownerTxid,
        {
          txid: ownerTxid,
          rawTransaction: ownerRaw,
          confirmations: "0",
          inputs: [{ txid: ftContractId, vout: 0 }],
          outputs: [
            {
              vout: 0,
              satoshis: "500",
              scriptPubKey: "54",
              addresses: [ADDRESS],
            },
          ],
        },
      ],
    ] as const);
    const compute = vi.spyOn(validation, "inspectTbcTransaction");
    const inspectTransaction = createPoolTransactionInspector();
    let releasePool!: () => void;
    const poolPending = new Promise<void>((resolve) => {
      releasePool = resolve;
    });
    const client = {
      getFtUtxos: vi.fn(async () => [
        {
          txid: ownerTxid,
          vout: 0,
          satoshis: "500",
          ftAmount: "2500000",
        },
      ]),
      getRawTransaction: vi.fn(async (txid: string) => {
        const value = decoded.get(txid);
        if (value === undefined) throw new Error("unexpected txid");
        inspectTransaction(value.rawTransaction);
        if (txid === poolContractId) await poolPending;
        return value;
      }),
    };
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "200",
            data: {
              ft_a_partial_hash: "aa",
              ft_contract_id: ftContractId,
              ft_lp_partial_hash: "bb",
              lp_balance: "0",
              pool_code_script: "51",
              service_fee_rate: 35,
              service_provider: "durian",
              tbc_balance: "0",
              token_balance: "0",
              txid: poolContractId,
              value: "1000",
              version: 2,
              vout: 0,
            },
          }),
          { status: 200 },
        ),
    );
    const native = {
      protocolInfo: async () => "{}",
      execute: vi.fn(async () =>
        JSON.stringify({
          stablecoin: false,
          ftContractId,
          ownerFtScript: "54",
          pool: {
            ftLpRaw: "0",
            ftARaw: "0",
            tbcSat: "0",
            lpPlan: 1,
            serviceFeeRate: 35,
          },
        }),
      ),
    };
    const resolve = createPoolInitializeMaterialResolver({
      client,
      fetch,
      native,
      inspectTransaction,
    });

    const resolving = resolve({
      address: ADDRESS,
      receiver: ADDRESS,
      poolContractId,
      tbcAmount: "10000",
      ftAmount: "2500000",
    });
    await vi.waitFor(() => {
      expect(client.getFtUtxos).toHaveBeenCalledTimes(1);
    });
    releasePool();
    const result = await resolving;

    expect(result.utxos.map(({ classification }) => classification)).toEqual([
      "pool-source",
      "pool",
      "ft",
    ]);
    expect(result.contracts).toEqual([
      expect.objectContaining({ family: "ft", contractId: ftContractId }),
      expect.objectContaining({ family: "pool", contractId: poolContractId }),
    ]);
    expect(result.policy).toEqual({
      lpPlan: 1,
      serviceProviderTag: "durian",
      serviceFeeRate: 35,
    });
    expect(native.execute).toHaveBeenCalledTimes(1);
    expect(compute).toHaveBeenCalledTimes(decoded.size);
  });

  it("turns the trusted read-only Pool loader result into Engine snapshot material", async () => {
    const poolSourceRaw = transaction("10", [
      { satoshis: 9900n, script: "55" },
    ]);
    const poolSourceTxid = turingTransactionId(poolSourceRaw);
    const creationRaw = transaction("11", [{ satoshis: 1000n, script: "51" }], {
      txid: poolSourceTxid,
      vout: 0,
    });
    const poolContractId = turingTransactionId(creationRaw);
    const currentRaw = transaction("12", [
      { satoshis: 11000n, script: "51" },
      { satoshis: 500n, script: "52" },
      { satoshis: 500n, script: "53" },
    ]);
    const currentTxid = turingTransactionId(currentRaw);
    const ftContractRaw = transaction("13", [{ satoshis: 500n, script: "54" }]);
    const ftContractId = turingTransactionId(ftContractRaw);
    const ownerRaw = transaction("14", [{ satoshis: 500n, script: "54" }]);
    const ownerTxid = turingTransactionId(ownerRaw);
    const previousRaw = transaction("15", [{ satoshis: 1000n, script: "51" }]);
    const feeRaw = transaction("16", [{ satoshis: 5000n, script: "51" }]);
    const grandparentRaw = transaction("17", [
      { satoshis: 500n, script: "54" },
    ]);
    const load = vi.fn(async () => ({
      version: 2,
      operation: "increaseLp",
      contractId: poolContractId,
      receiver: ADDRESS,
      tbcAmount: "0.001",
      feeUtxo: { satoshis: 5000 },
      preview: {
        ftContractId,
        tbcAmountSat: "1000",
        ftRequiredRaw: "250000",
        ftlpMintedRaw: "1000",
        lockTime: 0,
        before: {
          tbcSat: "10000",
          ftARaw: "2500000",
          ftLpRaw: "10000",
          poolValueSat: "11000",
        },
        after: {
          tbcSat: "11000",
          ftARaw: "2750000",
          ftLpRaw: "11000",
          poolValueSat: "12000",
        },
      },
      preparedContext: {
        info: {
          ftContractId,
          txid: currentTxid,
          vout: 0,
          value: "11000",
          poolCodeScript: "51",
        },
        canonicalDescriptor: {
          ownerFtScript: "54",
          poolFtScript: "52",
          ftlpScript: "53",
          lpPlan: 1,
          serviceFeeRate: 35,
          serviceProviderTag: "controlled-pool",
        },
        poolPreTxraw: currentRaw,
        poolPrePreTxraw: previousRaw,
        poolCreationTxraw: creationRaw,
        ftContractTxraw: ftContractRaw,
        feeParentTxraw: feeRaw,
        ftInputs: [
          {
            txid: ownerTxid,
            outputIndex: 0,
            satoshis: 500,
            preTxraw: ownerRaw,
            grandparentTxraws: [grandparentRaw],
          },
        ],
      },
    }));
    const getRawTransaction = vi.fn(async (txid: string) => {
      const rawTransaction =
        txid === currentTxid
          ? currentRaw
          : txid === ownerTxid
            ? ownerRaw
            : txid === poolSourceTxid
              ? poolSourceRaw
              : txid === poolContractId
                ? creationRaw
                : undefined;
      if (rawTransaction === undefined) throw new Error("unexpected txid");
      return {
        txid,
        rawTransaction,
        confirmations: "0",
        inputs: [],
        outputs:
          txid === poolSourceTxid
            ? [
                {
                  vout: 0,
                  satoshis: "9900",
                  scriptPubKey: "55",
                  addresses: [],
                },
              ]
            : [],
      };
    });
    const source = createPoolMaterialSource({
      client: { getRawTransaction },
      load,
    });

    const identity = vi.spyOn(validation, "inspectTbcTransaction");
    const result = await source.resolveLiquidityAdd({
      address: ADDRESS,
      receiver: ADDRESS,
      poolContractId,
      tbcAmount: "1000",
    });

    for (const { rawTransaction } of result.parents) {
      expect(
        identity.mock.calls.filter(([raw]) => raw === rawTransaction).length,
      ).toBe(1);
    }
    identity.mockClear();

    const originalLoad = load.getMockImplementation();
    if (!originalLoad) throw Error("missing loader fixture");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    load.mockImplementationOnce(async () => {
      await gate;
      return originalLoad();
    });
    const before = getRawTransaction.mock.calls.filter(
      ([id]) => id === poolSourceTxid,
    ).length;
    const pending = source.resolveLiquidityAdd({
      address: ADDRESS,
      receiver: ADDRESS,
      poolContractId,
      tbcAmount: "1000",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const overlapping =
      getRawTransaction.mock.calls.filter(([id]) => id === poolSourceTxid)
        .length - before;
    release();
    await pending;
    expect(overlapping).toBe(0); // Historical source funding is no longer queried.
    for (const { rawTransaction } of result.parents) {
      expect(
        identity.mock.calls.filter(([raw]) => raw === rawTransaction).length,
      ).toBe(1);
    }
    identity.mockRestore();

    expect(load).toHaveBeenCalledWith({
      operation: "increaseLp",
      addressFrom: ADDRESS,
      contractId: poolContractId,
      receiver: ADDRESS,
      tbcAmount: "0.001",
    });
    expect(result.policy).toEqual({
      lpPlan: 1,
      serviceFeeRate: 35,
      serviceProviderTag: "controlled-pool",
    });
    expect(result.review).toEqual({
      ftContractId,
      ftRequiredRaw: "250000",
      ftlpDeltaRaw: "1000",
      lockTime: "0",
      feeFundingCapAtomic: "5000",
      poolBefore: {
        tbcSat: "10000",
        ftARaw: "2500000",
        ftLpRaw: "10000",
        poolValueSat: "11000",
      },
      poolAfter: {
        tbcSat: "11000",
        ftARaw: "2750000",
        ftLpRaw: "11000",
        poolValueSat: "12000",
      },
    });
    expect(result.utxos.map(({ classification }) => classification)).toEqual([
      "pool",
      "pool-ft",
      "ftlp",
      "ft",
    ]);
    expect(result.contracts).toEqual([
      expect.objectContaining({ contractId: ftContractId, family: "ft" }),
      expect.objectContaining({ contractId: poolContractId, family: "pool" }),
    ]);
    expect(result.parents.map(({ txid }) => txid)).toHaveLength(7);
    expect(getRawTransaction).not.toHaveBeenCalledWith(poolSourceTxid);
    load.mockImplementationOnce(async () => {
      const prepared = await originalLoad();
      return {
        ...prepared,
        preparedContext: {
          ...prepared.preparedContext,
          poolPreTxraw: creationRaw,
        },
      };
    });
    await expect(
      source.resolveLiquidityAdd({
        address: ADDRESS,
        receiver: ADDRESS,
        poolContractId,
        tbcAmount: "1000",
      }),
    ).rejects.toThrow("Invalid canonical Pool transaction identity");
  });

  it("turns trusted consume material into exact Pool/FT-LP snapshot authority", async () => {
    const poolSourceRaw = transaction("30", [
      { satoshis: 9900n, script: "55" },
    ]);
    const poolSourceTxid = turingTransactionId(poolSourceRaw);
    const creationRaw = transaction("31", [{ satoshis: 1000n, script: "51" }], {
      txid: poolSourceTxid,
      vout: 0,
    });
    const poolContractId = turingTransactionId(creationRaw);
    const currentRaw = transaction("32", [
      { satoshis: 11000n, script: "51" },
      { satoshis: 500n, script: "52" },
    ]);
    const currentTxid = turingTransactionId(currentRaw);
    const ftContractRaw = transaction("33", [{ satoshis: 500n, script: "54" }]);
    const ftContractId = turingTransactionId(ftContractRaw);
    const poolFtRaw = transaction("34", [{ satoshis: 500n, script: "52" }]);
    const poolFtTxid = turingTransactionId(poolFtRaw);
    const ftlpRaw = transaction("35", [{ satoshis: 500n, script: "53" }]);
    const ftlpTxid = turingTransactionId(ftlpRaw);
    const previousRaw = transaction("36", [{ satoshis: 1000n, script: "51" }]);
    const feeRaw = transaction("37", [{ satoshis: 5000n, script: "51" }]);
    const grandparentRaw = transaction("38", [
      { satoshis: 500n, script: "54" },
    ]);
    const load = vi.fn(async () => ({
      version: 2,
      operation: "consumeLp",
      contractId: poolContractId,
      receiver: ADDRESS,
      lpAmount: "1000",
      currentLockTime: 0,
      feeUtxo: { satoshis: 5000 },
      preparedContext: {
        info: {
          ftContractId,
          txid: currentTxid,
          vout: 0,
          value: "11000",
          poolCodeScript: "51",
        },
        canonicalDescriptor: {
          poolFtScript: "52",
          ftlpScript: "53",
          lpPlan: 1,
          serviceFeeRate: 35,
          serviceProviderTag: "controlled-pool",
        },
        poolBefore: {
          tbcSat: "10000",
          ftARaw: "2500000",
          ftLpRaw: "10000",
          poolValueSat: "11000",
        },
        poolPreTxraw: currentRaw,
        poolPrePreTxraw: previousRaw,
        poolCreationTxraw: creationRaw,
        ftContractTxraw: ftContractRaw,
        feeParentTxraw: feeRaw,
        ftInputs: [
          {
            txid: poolFtTxid,
            outputIndex: 0,
            satoshis: 500,
            balance: "2500000",
            preTxraw: poolFtRaw,
            grandparentTxraws: [grandparentRaw],
          },
        ],
        ftlpInputs: [
          {
            txid: ftlpTxid,
            outputIndex: 0,
            satoshis: 500,
            balance: "1000",
            preTxraw: ftlpRaw,
            grandparentTxraws: [grandparentRaw],
          },
        ],
      },
    }));
    const raws = new Map([
      [poolSourceTxid, poolSourceRaw],
      [poolContractId, creationRaw],
      [currentTxid, currentRaw],
      [poolFtTxid, poolFtRaw],
      [ftlpTxid, ftlpRaw],
    ]);
    const getRawTransaction = vi.fn(async (txid: string) => {
      const rawTransaction = raws.get(txid);
      if (rawTransaction === undefined) throw new Error("unexpected txid");
      const parsed = parseTbcTransaction(rawTransaction);
      return {
        txid,
        rawTransaction,
        confirmations: "0",
        inputs: parsed.inputs,
        outputs: parsed.outputs.map((output, vout) => ({
          vout,
          satoshis: output.satoshis.toString(),
          scriptPubKey: Buffer.from(output.scriptPubKey).toString("hex"),
          addresses: [],
        })),
      };
    });
    const source = createPoolMaterialSource({
      client: { getRawTransaction },
      load,
    });

    const identity = vi.spyOn(validation, "inspectTbcTransaction");
    const result = await source.resolveLiquidityRemove?.({
      address: ADDRESS,
      receiver: ADDRESS,
      poolContractId,
      lpAmount: "1000",
    });

    for (const { rawTransaction } of result?.parents ?? []) {
      expect(
        identity.mock.calls.filter(([raw]) => raw === rawTransaction).length,
      ).toBe(1);
    }
    identity.mockClear();

    const originalLoad = load.getMockImplementation();
    if (!originalLoad) throw Error("missing loader fixture");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    load.mockImplementationOnce(async () => {
      await gate;
      return originalLoad();
    });
    const before = getRawTransaction.mock.calls.filter(
      ([id]) => id === poolSourceTxid,
    ).length;
    const pending = source.resolveLiquidityRemove?.({
      address: ADDRESS,
      receiver: ADDRESS,
      poolContractId,
      lpAmount: "1000",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const overlapping =
      getRawTransaction.mock.calls.filter(([id]) => id === poolSourceTxid)
        .length - before;
    release();
    await pending;
    expect(overlapping).toBe(0); // Historical source funding is no longer queried.
    for (const { rawTransaction } of result?.parents ?? []) {
      expect(
        identity.mock.calls.filter(([raw]) => raw === rawTransaction).length,
      ).toBe(1);
    }
    identity.mockRestore();

    expect(load).toHaveBeenCalledWith({
      operation: "consumeLp",
      addressFrom: ADDRESS,
      contractId: poolContractId,
      receiver: ADDRESS,
      lpAmount: "1000",
    });
    expect(result?.utxos.map(({ classification }) => classification)).toEqual([
      "pool",
      "pool-ft",
      "ftlp",
    ]);
    expect(result?.contracts).toEqual([
      expect.objectContaining({
        contractId: ftContractId,
        family: "ft",
        currentOutpoint: { txid: poolFtTxid, vout: 0 },
      }),
      expect.objectContaining({
        contractId: poolContractId,
        family: "pool",
      }),
    ]);
    expect(result?.review).toEqual({
      ftContractId,
      lpAmountRaw: "1000",
      currentLockTime: "0",
      feeFundingCapAtomic: "5000",
      poolBefore: {
        tbcSat: "10000",
        ftARaw: "2500000",
        ftLpRaw: "10000",
        poolValueSat: "11000",
      },
    });
    load.mockImplementationOnce(async () => {
      const prepared = await originalLoad();
      return {
        ...prepared,
        preparedContext: {
          ...prepared.preparedContext,
          poolPreTxraw: creationRaw,
        },
      };
    });
    await expect(
      source.resolveLiquidityRemove?.({
        address: ADDRESS,
        receiver: ADDRESS,
        poolContractId,
        lpAmount: "1000",
      }),
    ).rejects.toThrow("Invalid canonical Pool remove transaction identity");
  });

  it.each([
    ["swapToToken", "tbc-for-token", "1000"],
    ["swapToTbc", "token-for-tbc", "2500"],
  ] as const)("turns trusted %s material into exact %s Pool authority", async (operation, direction, inputAmount) => {
    const poolSourceRaw = transaction("40", [
      { satoshis: 9900n, script: "55" },
    ]);
    const poolSourceTxid = turingTransactionId(poolSourceRaw);
    const creationRaw = transaction("41", [{ satoshis: 1000n, script: "51" }], {
      txid: poolSourceTxid,
      vout: 0,
    });
    const poolContractId = turingTransactionId(creationRaw);
    const currentRaw = transaction("42", [
      { satoshis: 11000n, script: "51" },
      { satoshis: 500n, script: "52" },
    ]);
    const currentTxid = turingTransactionId(currentRaw);
    const ftContractRaw = transaction("43", [{ satoshis: 500n, script: "54" }]);
    const ftContractId = turingTransactionId(ftContractRaw);
    const ownerRaw = transaction("44", [{ satoshis: 500n, script: "54" }]);
    const ownerTxid = turingTransactionId(ownerRaw);
    const previousRaw = transaction("45", [{ satoshis: 1000n, script: "51" }]);
    const feeRaw = transaction("46", [{ satoshis: 5000n, script: "51" }]);
    const selectedRaw = operation === "swapToToken" ? currentRaw : ownerRaw;
    const selectedTxid = operation === "swapToToken" ? currentTxid : ownerTxid;
    const selectedVout = operation === "swapToToken" ? 1 : 0;
    const load = vi.fn(async () => ({
      version: 2,
      operation,
      contractId: poolContractId,
      receiver: ADDRESS,
      ...(operation === "swapToToken"
        ? { tbcAmount: inputAmount }
        : { ftAmount: inputAmount }),
      feeUtxo: { satoshis: 5000 },
      preparedContext: {
        info: {
          ftContractId,
          txid: currentTxid,
          vout: 0,
          value: "11000",
          poolCodeScript: "51",
        },
        canonicalDescriptor: {
          ownerFtScript: "54",
          poolFtScript: "52",
          ftlpScript: "53",
          lpPlan: 1,
          serviceFeeRate: 35,
          serviceProviderTag: "controlled-pool",
        },
        poolBefore: {
          tbcSat: "10000",
          ftARaw: "2500000",
          ftLpRaw: "10000",
          poolValueSat: "11000",
        },
        poolPreTxraw: currentRaw,
        poolPrePreTxraw: previousRaw,
        poolCreationTxraw: creationRaw,
        ftContractTxraw: ftContractRaw,
        feeParentTxraw: feeRaw,
        ftInputs: [
          {
            txid: selectedTxid,
            outputIndex: selectedVout,
            satoshis: 500,
            balance: operation === "swapToToken" ? "2500000" : "5000",
            preTxraw: selectedRaw,
            grandparentTxraws: [],
          },
        ],
        ftlpInputs: [],
      },
    }));
    const raws = new Map([
      [poolSourceTxid, poolSourceRaw],
      [currentTxid, currentRaw],
      [ownerTxid, ownerRaw],
    ]);
    const getRawTransaction = vi.fn(async (txid: string) => {
      const rawTransaction = raws.get(txid);
      if (rawTransaction === undefined) throw new Error("unexpected txid");
      const parsed = parseTbcTransaction(rawTransaction);
      return {
        txid,
        rawTransaction,
        confirmations: "0",
        inputs: parsed.inputs,
        outputs: parsed.outputs.map((output, vout) => ({
          vout,
          satoshis: output.satoshis.toString(),
          scriptPubKey: Buffer.from(output.scriptPubKey).toString("hex"),
          addresses: [],
        })),
      };
    });
    const source = createPoolMaterialSource({
      client: { getRawTransaction },
      load,
    });

    const result =
      operation === "swapToToken"
        ? await source.resolveSwapTbcForToken?.({
            address: ADDRESS,
            receiver: ADDRESS,
            poolContractId,
            tbcAmount: inputAmount,
          })
        : await source.resolveSwapTokenForTbc?.({
            address: ADDRESS,
            receiver: ADDRESS,
            poolContractId,
            ftAmount: inputAmount,
          });

    expect(load).toHaveBeenCalledWith({
      operation,
      addressFrom: ADDRESS,
      contractId: poolContractId,
      receiver: ADDRESS,
      ...(operation === "swapToToken"
        ? { tbcAmount: inputAmount }
        : { ftAmount: inputAmount }),
    });
    expect(result?.review).toEqual({
      direction,
      ftContractId,
      inputAmount,
      feeFundingCapAtomic: "5000",
      poolBefore: {
        tbcSat: "10000",
        ftARaw: "2500000",
        ftLpRaw: "10000",
        poolValueSat: "11000",
      },
    });
    expect(result?.utxos.map(({ classification }) => classification)).toEqual(
      operation === "swapToToken"
        ? ["pool", "pool-ft"]
        : ["pool", "pool-ft", "ft"],
    );
    expect(result?.contracts).toEqual([
      expect.objectContaining({ contractId: ftContractId, family: "ft" }),
      expect.objectContaining({ contractId: poolContractId, family: "pool" }),
    ]);
  });
});
