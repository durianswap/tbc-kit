import { bytesToHex } from "@tbc-wallet/core";
import {
  assertHash32,
  assertRawTransaction,
  assertTestnetAddress,
  type inspectTbcTransaction,
  parseTbcTransaction,
  turingTransactionId,
} from "./testnet-validation.js";
import { OFFICIAL_TBC_TESTNET_API_ORIGIN } from "./testnet-client.js";
import { createTbcOfficialApi } from "./official-api.js";
import { collectTbcUtxoPages } from "./utxo-pages.js";
import { selectCanonicalPoolInput } from "./pool-material-helpers.js";
import type { PoolMaterialNativeProvider } from "./pool-material-native.js";
export interface LegacyPoolSigningNativeEngine {
  readonly execute: (operation: string, requestJson: string) => Promise<string>;
}

export interface LegacyPoolSigningProductionNativeEngine
  extends LegacyPoolSigningNativeEngine {
  readonly protocolInfo: () => Promise<string>;
}

export type LegacyPoolSigningLoadRequest = Readonly<{
  operation: "increaseLp";
  addressFrom: string;
  contractId: string;
  receiver: string;
  tbcAmount: string;
}>;

const UINT = /^(?:0|[1-9][0-9]*)$/u;
const HEX = /^(?:[0-9a-fA-F]{2})+$/u;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_UTXOS = 256;

/** Wallet-selected native input from this same Chain Data resolve, never a DApp DTO. */
export interface LegacyPoolFunding {
  readonly address: string;
  readonly txid: string;
  readonly vout: number;
  readonly satoshis: string;
  readonly rawTransaction: string;
  readonly tipHeight?: string;
  /** Fresh wallet-owned output heights from the same funding query. */
  readonly indexedHeights?: Readonly<Record<string, string>>;
}

/** Lazy read of the same in-flight wallet funding selection, not a new query. */
export type LegacyPoolFundingSource =
  | LegacyPoolFunding
  | ((() => Promise<LegacyPoolFunding>) & {
      /** Same verified index, available before the selected fee raw download. */
      readonly readIndex?: () => Promise<
        Pick<LegacyPoolFunding, "tipHeight" | "indexedHeights"> &
          Readonly<{ selectedParentTxid?: string }>
      >;
      /** Lazy chain height, only for an operation with an actual LP time lock. */
      readonly readTipHeight?: () => Promise<string>;
    });

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function string(
  value: unknown,
  label: string,
  max = MAX_RESPONSE_BYTES,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function uint(value: unknown, label: string): string {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : value;
  if (typeof normalized !== "string" || !UINT.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function displayAmountFromRaw(
  value: string,
  decimals: number,
  label: string,
): string {
  const raw = uint(value, label);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid ${label}`);
  }
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/u, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function safeInteger(value: unknown, label: string): number {
  const parsed = BigInt(uint(value, label));
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Invalid ${label}`);
  }
  return Number(parsed);
}

function hex(value: unknown, label: string): string {
  const result = string(value, label);
  if (!HEX.test(result)) throw new Error(`Invalid ${label}`);
  return result.toLowerCase();
}

function normalizedInfo(value: unknown, contractId: string) {
  const info = record(value, "PoolNFT information");
  const result = Object.freeze({
    ftAPartialHash: string(info.ft_a_partial_hash, "Pool FT-A partial hash"),
    ftContractId: assertHash32(
      string(info.ft_contract_id, "Pool FT contract").toLowerCase(),
    ),
    ftLpPartialHash: string(info.ft_lp_partial_hash, "Pool FT-LP partial hash"),
    lpBalance: uint(info.lp_balance, "Pool LP balance"),
    poolCodeScript: hex(info.pool_code_script, "Pool code script"),
    serviceFeeRate: safeInteger(info.service_fee_rate, "Pool service fee rate"),
    serviceProvider: string(
      info.service_provider,
      "Pool service provider",
      256,
    ),
    tbcBalance: uint(info.tbc_balance, "Pool TBC balance"),
    tokenBalance: uint(info.token_balance, "Pool token balance"),
    txid: assertHash32(string(info.txid, "Pool current txid").toLowerCase()),
    value: uint(info.value, "Pool value"),
    version: safeInteger(info.version, "Pool version"),
    vout: safeInteger(info.vout, "Pool output"),
  });
  if (result.version !== 2 || result.vout !== 0 || contractId.length !== 64) {
    throw new Error("Only PoolNFT v2 output zero is supported");
  }
  return result;
}

function candidate(value: unknown, label: string) {
  const input = record(value, label);
  const lockTime = input.lockTime ?? input.lock_time;
  const script = input.script;
  return Object.freeze({
    txid: assertHash32(string(input.txid, `${label} txid`).toLowerCase()),
    outputIndex: safeInteger(
      input.outputIndex ?? input.index,
      `${label} output`,
    ),
    satoshis: safeInteger(
      input.satoshis ?? input.tbc_value ?? input.value,
      `${label} value`,
    ),
    balance: uint(input.balance ?? input.ft_value, `${label} balance`),
    ...(lockTime === undefined
      ? {}
      : { lockTime: safeInteger(lockTime, `${label} lock time`) }),
    ...(script === undefined ? {} : { script: hex(script, `${label} script`) }),
  });
}

export type LegacyPoolMaterialLoadRequest =
  | LegacyPoolSigningLoadRequest
  | Readonly<{
      operation: "consumeLp";
      addressFrom: string;
      contractId: string;
      receiver: string;
      lpAmount: string;
    }>
  | Readonly<{
      operation: "swapToToken";
      addressFrom: string;
      contractId: string;
      receiver: string;
      tbcAmount: string;
    }>
  | Readonly<{
      operation: "swapToTbc";
      addressFrom: string;
      contractId: string;
      receiver: string;
      ftAmount: string;
    }>
  | Readonly<{
      operation: "mergePoolFt";
      addressFrom: string;
      contractId: string;
    }>
  | Readonly<{
      operation: "mergeFtlp";
      addressFrom: string;
      contractId: string;
    }>
  | Readonly<{
      operation: "burnFtlp";
      addressFrom: string;
      contractId: string;
    }>
  | Readonly<{
      operation: "indexPoolFt";
      addressFrom: string;
      contractId: string;
    }>
  | Readonly<{
      operation: "indexFtlp";
      addressFrom: string;
      contractId: string;
    }>;

/** Canonical Pool material loader; the native operation surface is neutral. */
export function createPoolMaterialLoader(options: {
  readonly fetch: typeof globalThis.fetch;
  readonly native: PoolMaterialNativeProvider;
  readonly baseUrl?: string;
  readonly allowedOrigins?: readonly string[];
  /** Public Engine consumes ancestor bytes and constructs its own proof. */
  readonly purpose?: "legacy-signing" | "public-material";
  readonly requestTimeoutMs?: number;
  /** Same-request reader supplied by private composition; identity is still checked here. */
  readonly readRawTransaction?: (txid: string) => Promise<string>;
  /** Historical proof-only input; no live confirmation or ownership claim. */
  readonly readHistoricalTransaction?: (txid: string) => Promise<string>;
  /** Fresh node index metadata only; never supplied by the page or Rust output. */
  readonly observeIndexedHeight?: (txid: string, height: string) => void;
  readonly inspectTransaction?: typeof inspectTbcTransaction;
  readonly funding?: LegacyPoolFundingSource;
  /** Wallet-owned same-preparation read; still normalized and checked below. */
  readonly readPoolInfo?: ReturnType<typeof createTbcOfficialApi>["poolInfo"];
  readonly readFtInfo?: ReturnType<typeof createTbcOfficialApi>["ftInfo"];
}): (
  request: LegacyPoolMaterialLoadRequest,
) => Promise<Readonly<Record<string, unknown>>> {
  const timeoutMs = options.requestTimeoutMs ?? 15_000;
  let base: URL;
  try {
    base = new URL(options.baseUrl ?? OFFICIAL_TBC_TESTNET_API_ORIGIN);
  } catch {
    throw new Error("Invalid Legacy Pool Testnet endpoint");
  }
  const allowed = options.allowedOrigins ?? [OFFICIAL_TBC_TESTNET_API_ORIGIN];
  if (
    base.protocol !== "https:" ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== "" ||
    !allowed.includes(base.origin)
  ) {
    throw new Error("Invalid Legacy Pool Testnet endpoint");
  }
  const officialApi = createTbcOfficialApi({
    baseUrl: base.href,
    fetch: options.fetch,
    timeoutMs,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    allowedOrigins: allowed,
  });
  // These internal consumers request complete bounded indexes, not a target
  // selection. Unpaged responses retain the original one-request schedule.
  const api: typeof officialApi = {
    ...officialApi,
    ...(options.readPoolInfo === undefined ? {} : { poolInfo: options.readPoolInfo }),
    ...(options.readFtInfo === undefined ? {} : { ftInfo: options.readFtInfo }),
    utxosByAddress: (params, readOptions) => collectTbcUtxoPages(
      after => officialApi.utxosByAddress({ ...params, ...(after === undefined ? {} : { after }) }, readOptions),
      { maxRows: MAX_UTXOS }),
    ftUtxosByCombineScript: (params, readOptions) => collectTbcUtxoPages(
      after => officialApi.ftUtxosByCombineScript({ ...params, ...(after === undefined ? {} : { after }) }, readOptions),
      { maxRows: MAX_UTXOS }),
    poolLpUtxosByScriptHash: (params, readOptions) => collectTbcUtxoPages(
      after => officialApi.poolLpUtxosByScriptHash({ ...params, ...(after === undefined ? {} : { after }) }, readOptions),
      { maxRows: MAX_UTXOS }),
  };
  const inspect = options.inspectTransaction;
  const identity = inspect
    ? (raw: string) => inspect(raw).txid
    : turingTransactionId;
  const parse = inspect
    ? (raw: string) => inspect(raw).transaction
    : parseTbcTransaction;
  if (
    typeof options.fetch !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60_000
  ) {
    throw new Error("Invalid Legacy Pool loader configuration");
  }

  function observeIndex(value: unknown): void {
    if (!options.observeIndexedHeight) return;
    const data = record(value, "Pool index");
    if (!Array.isArray(data.utxos) || data.utxos.length > MAX_UTXOS)
      throw new Error("Invalid Pool index budget");
    for (const value of data.utxos) {
      const item = record(value, "Pool indexed output");
      if (item.height !== undefined)
        options.observeIndexedHeight(
          assertHash32(string(item.txid, "indexed transaction").toLowerCase()),
          item.height === -1 || item.height === "-1"
            ? "0"
            : uint(item.height, "indexed height"),
        );
    }
  }

  function normalizePoolLpIndex(value: unknown): Record<string, unknown> {
    const index = record(value, "Pool LP index");
    // The official Pool LP endpoint uses explicit null for a successful empty
    // index after the account burns its final LP output. Missing and every
    // other non-array value remain invalid and fail-closed below.
    return index.utxos === null
      ? { ...index, utxos: Object.freeze([]) }
      : index;
  }

  async function rawTransaction(
    txid: string,
    historical = false,
  ): Promise<string> {
    const normalized = assertHash32(txid.toLowerCase());
    const reader = historical
      ? (options.readHistoricalTransaction ?? options.readRawTransaction)
      : options.readRawTransaction;
    const raw = assertRawTransaction(
      string(
        reader
          ? await reader(normalized)
          : (await api.rawTransaction(
              { txid: normalized },
              { category: "txraw", retry: "none" },
            )).txraw,
        "Pool raw transaction",
      ).toLowerCase(),
    );
    if (identity(raw) !== normalized) {
      throw new Error("TBC Testnet Pool raw identity mismatch");
    }
    return raw;
  }

  async function suppliedFeeFunding(address: string) {
    const supplied =
      typeof options.funding === "function"
        ? await options.funding()
        : options.funding;
    if (!supplied) return undefined;
    const source = assertTestnetAddress(address);
    const txid = assertHash32(supplied.txid);
    const index = safeInteger(supplied.vout, "shared fee output");
    const value = safeInteger(supplied.satoshis, "shared fee value");
    const raw = assertRawTransaction(supplied.rawTransaction);
    const output = parse(raw).outputs[index];
    if (
      supplied.address !== source.address ||
      value === 0 ||
      identity(raw) !== txid ||
      output === undefined ||
      output.satoshis !== BigInt(value) ||
      bytesToHex(output.scriptPubKey) !== source.scriptPubKey
    )
      throw new Error("Invalid same-request Pool funding binding");
    return { index: { utxos: [{ txid, index, value }] }, rawTransaction: raw };
  }

  async function poolAuthority(contractId: string, ftContractId: string) {
    if (options.purpose !== "public-material") {
      const [poolCreationTxraw, ftContractTxraw] = await Promise.all([
        rawTransaction(contractId, true), rawTransaction(ftContractId, true),
      ]);
      return { poolCreationTxraw, ftContractTxraw };
    }
    const value = await api.ftInfo({ contract_id: ftContractId }, { category: "asset-index", retry: "none" });
    const indexedFt = Object.freeze({
      codeScript: hex(value.code_script, "indexed Pool FT Code"),
      tapeScript: hex(value.tape_script, "indexed Pool FT Tape"),
    });
    return { indexedFt, indexedFungible: Object.freeze({ ...indexedFt, totalSupply: uint(value.amount, "indexed FT supply") }) };
  }

  async function legacyProofData(items: readonly unknown[], label: string) {
    if (options.purpose === "public-material") return undefined;
    const proof = record(
      JSON.parse(
        await options.native.execute(
          "prepareAssetAncestry",
          JSON.stringify({ phase: "prove", items }),
        ),
      ),
      label,
    );
    if (!Array.isArray(proof.items) || proof.items.length !== items.length)
      throw new Error(`Invalid ${label}`);
    return proof.items.map((item) =>
      hex(record(item, label).prePreTxData, label),
    );
  }

  async function loadConsumeLp(
    request: Extract<LegacyPoolMaterialLoadRequest, { operation: "consumeLp" }>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const source = assertTestnetAddress(request.addressFrom);
    assertTestnetAddress(request.receiver);
    const contractId = assertHash32(request.contractId.toLowerCase());
    const lpAmount = uint(request.lpAmount, "Pool LP amount");
    if (BigInt(lpAmount) === 0n) {
      throw new Error("Pool LP amount must be positive");
    }
    const info = normalizedInfo(
      await api.poolInfo(
        { pool_id: contractId },
        { category: "pool", retry: "none" },
      ),
      contractId,
    );
    const currentRead = rawTransaction(info.txid);
    const poolPrePreRead = currentRead.then((raw) => {
      const poolParent = parse(raw).inputs[0];
      if (poolParent === undefined || poolParent.vout !== 0)
        throw new Error("Current Pool transaction has invalid state ancestry");
      return rawTransaction(poolParent.txid, true);
    });
    void poolPrePreRead.catch(() => {});
    const [poolPreTxraw, authority] = await Promise.all([
      currentRead,
      poolAuthority(contractId, info.ftContractId),
    ]);
    const descriptor = record(
      JSON.parse(
        await options.native.execute(
          "preparePoolNft",
          JSON.stringify({
            phase: "describe",
            contractId,
            ownerAddress: source.address,
            info,
            poolPreTxraw,
            ...(authority.indexedFt ? { indexedFt: authority.indexedFt } : { ftContractTxraw: authority.ftContractTxraw }),
          }),
        ),
      ),
      "Pool descriptor",
    );
    if (descriptor.stablecoin === true) {
      throw new Error("PoolNFT supports ordinary FT only");
    }
    const descriptorPool = record(descriptor.pool, "Pool descriptor state");
    if (descriptor.ftContractId !== info.ftContractId) {
      throw new Error("Pool descriptor FT identity mismatch");
    }
    const poolCombineScript = string(
      descriptor.poolCombineScript,
      "Pool combine script",
      256,
    );
    const ftlpScript = hex(descriptor.ftlpScript, "Pool FT-LP script");
    const ftlpScriptHash = assertHash32(
      string(descriptor.ftlpScriptHash, "Pool FT-LP script hash").toLowerCase(),
    );
    const [poolIndexed, ftlpIndexed] = await Promise.all([
      api.ftUtxosByCombineScript(
        {
          combine_script: poolCombineScript,
          contract_id: info.ftContractId,
        },
        { category: "asset-index", retry: "none" },
      ),
      api.poolLpUtxosByScriptHash(
        { scriptpubkeyhash: ftlpScriptHash },
        { category: "pool", retry: "none" },
      ).then(normalizePoolLpIndex),
    ]);
    observeIndex(poolIndexed);
    observeIndex(ftlpIndexed);
    if (
      !Array.isArray(poolIndexed.utxos) ||
      poolIndexed.utxos.length > MAX_UTXOS ||
      !Array.isArray(ftlpIndexed.utxos) ||
      ftlpIndexed.utxos.length > MAX_UTXOS
    ) {
      throw new Error("Invalid Pool consume asset UTXOs");
    }
    const poolFtCandidates = poolIndexed.utxos.map((value) => {
      const input = record(value, "Pool-held FT UTXO");
      return candidate(
        {
          txid: input.txid,
          outputIndex: input.index,
          satoshis: input.tbc_value,
          balance: input.ft_value,
        },
        "Pool-held FT UTXO",
      );
    });
    const ftlpCandidates = ftlpIndexed.utxos.map((value) => {
      const input = record(value, "Pool FT-LP UTXO");
      return candidate(
        {
          txid: input.txid,
          outputIndex: input.index,
          satoshis: input.tbc_balance,
          balance: input.lp_balance,
          lockTime: input.lock_time,
          script: ftlpScript,
        },
        "Pool FT-LP UTXO",
      );
    });
    let currentLockTime = 0;
    if (descriptorPool.ftlpLockTimeEnabled === true) {
      const fundingIndex =
        typeof options.funding === "function"
          ? await options.funding.readIndex?.()
          : options.funding;
      let height: number;
      if (fundingIndex?.tipHeight !== undefined) {
        // Same fresh authoritative chain tip already read for input selection.
        // Do not await the selected fee parent just to fetch this height again.
        height = safeInteger(fundingIndex.tipHeight, "funding tip height");
      } else if (typeof options.funding === "function" && options.funding.readTipHeight) {
        height = safeInteger(await options.funding.readTipHeight(), "funding tip height");
      } else {
        const blocks = await api.recentBlocks(
          { start: 0, end: 1 },
          { category: "tip", retry: "none" },
        );
        const first = Array.isArray(blocks) ? blocks[0] : undefined;
        height = safeInteger(
          record(first, "recent TBC block").height,
          "recent TBC block height",
        );
      }
      if (height < 2) throw new Error("Invalid current TBC block height");
      currentLockTime = height - 2;
    }
    const ftDecimal = safeInteger(descriptor.ftDecimal, "Pool FT decimal");
    // An unlocked Pool can spend one sufficient owned LP output directly.
    // Rust's fixed-window selector otherwise includes every indexed fragment
    // (up to its bound), introducing an unnecessary merge. Keep fragmented
    // and lock-enabled selection in Rust; this only narrows the real candidates.
    const sufficientFtlp =
      descriptorPool.ftlpLockTimeEnabled === false
        ? ftlpCandidates
            .filter((c) => BigInt(c.balance) >= BigInt(lpAmount))
            .sort((a, b) =>
              BigInt(a.balance) < BigInt(b.balance)
                ? -1
                : BigInt(a.balance) > BigInt(b.balance)
                  ? 1
                  : a.txid.localeCompare(b.txid) ||
                    a.outputIndex - b.outputIndex,
            )[0]
        : undefined;
    const selection = record(
      JSON.parse(
        await options.native.execute(
          "preparePoolNft",
          JSON.stringify({
            phase: "select",
            operation: "consumeLp",
            ftContractId: info.ftContractId,
            ftDecimal,
            pool: {
              ftLpRaw: uint(descriptorPool.ftLpRaw, "Pool FT-LP reserve"),
              ftARaw: uint(descriptorPool.ftARaw, "Pool FT-A reserve"),
              tbcSat: uint(descriptorPool.tbcSat, "Pool TBC reserve"),
              poolValueSat: uint(descriptorPool.poolValueSat, "Pool value"),
              serviceFeeRate: safeInteger(
                descriptorPool.serviceFeeRate,
                "Pool service fee rate",
              ),
              lpPlan: safeInteger(descriptorPool.lpPlan, "Pool LP plan"),
              ftlpLockTimeEnabled: descriptorPool.ftlpLockTimeEnabled === true,
              publicKeyLocked: descriptorPool.publicKeyLocked === true,
            },
            // FT-LP has its own fixed six-decimal denomination. The pooled
            // token's precision only applies to FT amounts, never LP shares.
            amount: displayAmountFromRaw(lpAmount, 6, "Pool LP amount"),
            ...(descriptorPool.ftlpLockTimeEnabled === true
              ? { currentBlockHeight: currentLockTime }
              : {}),
            ownerFtCandidates: [],
            poolFtCandidates,
            ftlpCandidates: sufficientFtlp ? [sufficientFtlp] : ftlpCandidates,
          }),
        ),
      ),
      "Pool selection",
    );
    if (
      !Array.isArray(selection.ownerFtCandidates) ||
      !Array.isArray(selection.poolFtCandidates) ||
      !Array.isArray(selection.ftlpCandidates) ||
      selection.ownerFtCandidates.length !== 0
    ) {
      throw new Error("Invalid Pool consume selection");
    }
    const selectedPoolFt = selection.poolFtCandidates.map((value) =>
      candidate(value, "selected Pool-held FT UTXO"),
    );
    const selectedFtlp = selection.ftlpCandidates.map((value) =>
      candidate(value, "selected Pool FT-LP UTXO"),
    );
    const selected = [...selectedPoolFt, ...selectedFtlp];
    if (selectedPoolFt.length === 0 || selectedFtlp.length === 0) {
      throw new Error("Pool consume requires Pool-held FT and FT-LP inputs");
    }
    const selectedRaw = await Promise.all(
      selected.map(({ txid }) => rawTransaction(txid)),
    );
    const inspect = record(
      JSON.parse(
        await options.native.execute(
          "prepareAssetAncestry",
          JSON.stringify({
            phase: "inspect",
            items: selected.map((input, index) => ({
              parentTxid: input.txid,
              outputIndex: input.outputIndex,
              parentTxraw: selectedRaw[index],
            })),
          }),
        ),
      ),
      "Pool consume ancestry inspection",
    );
    if (
      !Array.isArray(inspect.items) ||
      inspect.items.length !== selected.length
    ) {
      throw new Error("Invalid Pool consume ancestry inspection");
    }
    const ancestryRead = Promise.all(
      inspect.items.map(async (value, index) => {
        const references = record(
          value,
          "Pool consume ancestry item",
        ).references;
        if (
          !Array.isArray(references) ||
          references.length === 0 ||
          references.length > 6
        ) {
          throw new Error("Invalid Pool consume ancestry references");
        }
        const grandparents = await Promise.all(
          references.map(async (referenceValue) => {
            const reference = record(
              referenceValue,
              "Pool consume ancestry reference",
            );
            const txid = assertHash32(
              string(
                reference.txid,
                "Pool consume ancestor txid",
              ).toLowerCase(),
            );
            return Object.freeze({
              txid,
              outputIndex: safeInteger(
                reference.outputIndex,
                "Pool consume ancestor output",
              ),
              txraw: await rawTransaction(txid, true),
            });
          }),
        );
        return Object.freeze({ index, grandparents });
      }),
    );
    // The keyless FT proof does not consume the Pool predecessor. Let it run
    // while that GET is pending; still join the predecessor before returning.
    const ancestry = await ancestryRead;
    const provedItems = await legacyProofData(
      selected.map((input, index) => ({
        parentTxid: input.txid,
        outputIndex: input.outputIndex,
        parentTxraw: selectedRaw[index],
        grandparents: ancestry[index]?.grandparents,
      })),
      "Pool consume ancestry proof",
    );
    const poolPrePreTxraw = await poolPrePreRead;
    const preparedInputs = selected.map((input, index) =>
      Object.freeze({
        ...input,
        script:
          index < selectedPoolFt.length
            ? string(descriptor.poolFtScript, "Pool-held FT script")
            : ftlpScript,
        preTxraw: selectedRaw[index],
        ...(provedItems ? { prePreTxData: provedItems[index] } : {}),
        grandparentTxraws: Object.freeze(
          ancestry[index]?.grandparents.map(({ txraw }) => txraw) ?? [],
        ),
      }),
    );
    const sharedFee = await suppliedFeeFunding(source.address);
    const funding =
      sharedFee?.index ??
      (await api.utxosByAddress(
        { address: source.address },
        { category: "native-index", retry: "none" },
      ));
    if (!Array.isArray(funding.utxos) || funding.utxos.length > MAX_UTXOS) {
      throw new Error("Invalid Pool fee UTXOs");
    }
    const feeUtxo = funding.utxos
      .map((value) => {
        const input = record(value, "Pool fee UTXO");
        return Object.freeze({
          txid: assertHash32(string(input.txid, "Pool fee txid").toLowerCase()),
          outputIndex: safeInteger(input.index, "Pool fee output"),
          satoshis: safeInteger(input.value, "Pool fee value"),
          script: source.scriptPubKey,
        });
      })
      .sort(
        (left, right) =>
          right.satoshis - left.satoshis ||
          left.txid.localeCompare(right.txid) ||
          left.outputIndex - right.outputIndex,
      )[0];
    if (feeUtxo === undefined || feeUtxo.satoshis === 0) {
      throw new Error("No Pool fee UTXO is available");
    }
    const feeParentTxraw =
      sharedFee?.rawTransaction ?? (await rawTransaction(feeUtxo.txid));
    return Object.freeze({
      version: 2,
      operation: "consumeLp",
      contractId,
      receiver: request.receiver,
      lpAmount,
      currentLockTime,
      feeUtxo,
      preparedContext: Object.freeze({
        info,
        canonicalDescriptor: Object.freeze({
          poolFtScript: hex(descriptor.poolFtScript, "Pool-held FT script"),
          ftlpScript,
          lpPlan: safeInteger(descriptorPool.lpPlan, "Pool LP plan"),
          serviceFeeRate: safeInteger(
            descriptorPool.serviceFeeRate,
            "Pool service fee rate",
          ),
          serviceProviderTag: info.serviceProvider,
        }),
        poolBefore: Object.freeze({
          ftLpRaw: uint(descriptorPool.ftLpRaw, "Pool FT-LP reserve"),
          ftARaw: uint(descriptorPool.ftARaw, "Pool FT-A reserve"),
          tbcSat: uint(descriptorPool.tbcSat, "Pool TBC reserve"),
          poolValueSat: uint(descriptorPool.poolValueSat, "Pool value"),
        }),
        poolPreTxraw,
        poolPrePreTxraw,
        ...authority,
        feeParentTxraw,
        ftInputs: Object.freeze(preparedInputs.slice(0, selectedPoolFt.length)),
        ftlpInputs: Object.freeze(preparedInputs.slice(selectedPoolFt.length)),
      }),
    });
  }

  async function loadSwap(
    request: Extract<
      LegacyPoolMaterialLoadRequest,
      { operation: "swapToToken" | "swapToTbc" }
    >,
  ): Promise<Readonly<Record<string, unknown>>> {
    const source = assertTestnetAddress(request.addressFrom);
    assertTestnetAddress(request.receiver);
    const contractId = assertHash32(request.contractId.toLowerCase());
    const inputAmount =
      request.operation === "swapToToken"
        ? uint(request.tbcAmount, "Pool swap TBC amount")
        : uint(request.ftAmount, "Pool swap FT amount");
    if (BigInt(inputAmount) === 0n) {
      throw new Error("Pool swap amount must be positive");
    }
    const info = normalizedInfo(
      await api.poolInfo(
        { pool_id: contractId },
        { category: "pool", retry: "none" },
      ),
      contractId,
    );
    const [poolPreTxraw, authority] =
      await Promise.all([
        rawTransaction(info.txid),
        poolAuthority(contractId, info.ftContractId),
      ]);
    const current = parse(poolPreTxraw);
    const poolParent = current.inputs[0];
    if (poolParent === undefined || poolParent.vout !== 0) {
      throw new Error("Current Pool transaction has invalid state ancestry");
    }
    const poolPrePreTxraw = await rawTransaction(poolParent.txid, true);
    const descriptor = record(
      JSON.parse(
        await options.native.execute(
          "preparePoolNft",
          JSON.stringify({
            phase: "describe",
            contractId,
            ownerAddress: source.address,
            info,
            poolPreTxraw,
            ...(authority.indexedFt ? { indexedFt: authority.indexedFt } : { ftContractTxraw: authority.ftContractTxraw }),
          }),
        ),
      ),
      "Pool swap descriptor",
    );
    if (descriptor.stablecoin === true) {
      throw new Error("PoolNFT supports ordinary FT only");
    }
    const descriptorPool = record(descriptor.pool, "Pool swap state");
    if (descriptor.ftContractId !== info.ftContractId) {
      throw new Error("Pool swap descriptor FT identity mismatch");
    }
    const ftDecimal = safeInteger(descriptor.ftDecimal, "Pool swap FT decimal");
    const selectionAmount = displayAmountFromRaw(
      inputAmount,
      request.operation === "swapToToken" ? 6 : ftDecimal,
      "Pool swap amount",
    );
    const scriptKey =
      request.operation === "swapToToken"
        ? "poolCombineScript"
        : "ownerCombineScript";
    const combineScript = string(
      descriptor[scriptKey],
      "Pool swap combine script",
      256,
    );
    const indexed = await api.ftUtxosByCombineScript(
      { combine_script: combineScript, contract_id: info.ftContractId },
      { category: "asset-index", retry: "none" },
    );
    observeIndex(indexed);
    if (!Array.isArray(indexed.utxos) || indexed.utxos.length > MAX_UTXOS) {
      throw new Error("Invalid Pool swap FT UTXOs");
    }
    const candidates = indexed.utxos.map((value) => {
      const input = record(value, "Pool swap FT UTXO");
      return candidate(
        {
          txid: input.txid,
          outputIndex: input.index,
          satoshis: input.tbc_value,
          balance: input.ft_value,
        },
        "Pool swap FT UTXO",
      );
    });
    const selection = record(
      JSON.parse(
        await options.native.execute(
          "preparePoolNft",
          JSON.stringify({
            phase: "select",
            operation: request.operation,
            ftContractId: info.ftContractId,
            ftDecimal,
            pool: {
              ftLpRaw: uint(descriptorPool.ftLpRaw, "Pool FT-LP reserve"),
              ftARaw: uint(descriptorPool.ftARaw, "Pool FT-A reserve"),
              tbcSat: uint(descriptorPool.tbcSat, "Pool TBC reserve"),
              poolValueSat: uint(descriptorPool.poolValueSat, "Pool value"),
              serviceFeeRate: safeInteger(
                descriptorPool.serviceFeeRate,
                "Pool service fee rate",
              ),
              lpPlan: safeInteger(descriptorPool.lpPlan, "Pool LP plan"),
              ftlpLockTimeEnabled: descriptorPool.ftlpLockTimeEnabled === true,
              publicKeyLocked: descriptorPool.publicKeyLocked === true,
            },
            amount: selectionAmount,
            ownerFtCandidates:
              request.operation === "swapToTbc" ? candidates : [],
            poolFtCandidates:
              request.operation === "swapToToken" ? candidates : [],
            ftlpCandidates: [],
          }),
        ),
      ),
      "Pool swap selection",
    );
    if (
      !Array.isArray(selection.ownerFtCandidates) ||
      !Array.isArray(selection.poolFtCandidates) ||
      !Array.isArray(selection.ftlpCandidates) ||
      selection.ftlpCandidates.length !== 0 ||
      (request.operation === "swapToToken" &&
        selection.ownerFtCandidates.length !== 0) ||
      (request.operation === "swapToTbc" &&
        selection.poolFtCandidates.length !== 0)
    ) {
      throw new Error("Invalid Pool swap selection");
    }
    const selectedValues =
      request.operation === "swapToToken"
        ? selection.poolFtCandidates
        : selection.ownerFtCandidates;
    const selected = selectedValues.map((value) =>
      candidate(value, "selected Pool swap FT UTXO"),
    );
    if (selected.length === 0) {
      throw new Error("Pool swap requires selected FT inputs");
    }
    const selectedRaw = await Promise.all(
      selected.map(({ txid }) => rawTransaction(txid)),
    );
    const inspect = record(
      JSON.parse(
        await options.native.execute(
          "prepareAssetAncestry",
          JSON.stringify({
            phase: "inspect",
            items: selected.map((input, index) => ({
              parentTxid: input.txid,
              outputIndex: input.outputIndex,
              parentTxraw: selectedRaw[index],
            })),
          }),
        ),
      ),
      "Pool swap ancestry inspection",
    );
    if (
      !Array.isArray(inspect.items) ||
      inspect.items.length !== selected.length
    ) {
      throw new Error("Invalid Pool swap ancestry inspection");
    }
    const ancestry = await Promise.all(
      inspect.items.map(async (value) => {
        const references = record(value, "Pool swap ancestry item").references;
        if (
          !Array.isArray(references) ||
          references.length === 0 ||
          references.length > 6
        ) {
          throw new Error("Invalid Pool swap ancestry references");
        }
        return Promise.all(
          references.map(async (referenceValue) => {
            const reference = record(
              referenceValue,
              "Pool swap ancestry reference",
            );
            const txid = assertHash32(
              string(reference.txid, "Pool swap ancestor txid").toLowerCase(),
            );
            return Object.freeze({
              txid,
              outputIndex: safeInteger(
                reference.outputIndex,
                "Pool swap ancestor output",
              ),
              txraw: await rawTransaction(txid, true),
            });
          }),
        );
      }),
    );
    const prove = record(
      JSON.parse(
        await options.native.execute(
          "prepareAssetAncestry",
          JSON.stringify({
            phase: "prove",
            items: selected.map((input, index) => ({
              parentTxid: input.txid,
              outputIndex: input.outputIndex,
              parentTxraw: selectedRaw[index],
              grandparents: ancestry[index],
            })),
          }),
        ),
      ),
      "Pool swap ancestry proof",
    );
    if (!Array.isArray(prove.items) || prove.items.length !== selected.length) {
      throw new Error("Invalid Pool swap ancestry proof");
    }
    const provedItems = prove.items;
    const selectedScript = string(
      request.operation === "swapToToken"
        ? descriptor.poolFtScript
        : descriptor.ownerFtScript,
      "Pool swap selected FT script",
    );
    const preparedInputs = selected.map((input, index) =>
      Object.freeze({
        ...input,
        script: selectedScript,
        preTxraw: selectedRaw[index],
        prePreTxData: hex(
          record(provedItems[index], "Pool swap ancestry proof item")
            .prePreTxData,
          "Pool swap ancestry proof data",
        ),
        grandparentTxraws: Object.freeze(
          ancestry[index]?.map(({ txraw }) => txraw) ?? [],
        ),
      }),
    );
    const sharedFee = await suppliedFeeFunding(source.address);
    const funding =
      sharedFee?.index ??
      (await api.utxosByAddress(
        { address: source.address },
        { category: "native-index", retry: "none" },
      ));
    if (!Array.isArray(funding.utxos) || funding.utxos.length > MAX_UTXOS) {
      throw new Error("Invalid Pool swap fee UTXOs");
    }
    const feeUtxo = funding.utxos
      .map((value) => {
        const input = record(value, "Pool swap fee UTXO");
        return Object.freeze({
          txid: assertHash32(
            string(input.txid, "Pool swap fee txid").toLowerCase(),
          ),
          outputIndex: safeInteger(input.index, "Pool swap fee output"),
          satoshis: safeInteger(input.value, "Pool swap fee value"),
          script: source.scriptPubKey,
        });
      })
      .sort(
        (left, right) =>
          right.satoshis - left.satoshis ||
          left.txid.localeCompare(right.txid) ||
          left.outputIndex - right.outputIndex,
      )[0];
    if (feeUtxo === undefined || feeUtxo.satoshis === 0) {
      throw new Error("No Pool swap fee UTXO is available");
    }
    const feeParentTxraw =
      sharedFee?.rawTransaction ?? (await rawTransaction(feeUtxo.txid));
    return Object.freeze({
      version: 2,
      operation: request.operation,
      contractId,
      receiver: request.receiver,
      ...(request.operation === "swapToToken"
        ? { tbcAmount: inputAmount }
        : { ftAmount: inputAmount }),
      feeUtxo,
      preparedContext: Object.freeze({
        info,
        canonicalDescriptor: Object.freeze({
          ownerFtScript: hex(descriptor.ownerFtScript, "Pool owner FT script"),
          poolFtScript: hex(descriptor.poolFtScript, "Pool-held FT script"),
          ftlpScript: hex(descriptor.ftlpScript, "Pool FT-LP script"),
          lpPlan: safeInteger(descriptorPool.lpPlan, "Pool LP plan"),
          serviceFeeRate: safeInteger(
            descriptorPool.serviceFeeRate,
            "Pool service fee rate",
          ),
          serviceProviderTag: info.serviceProvider,
        }),
        poolBefore: Object.freeze({
          ftLpRaw: uint(descriptorPool.ftLpRaw, "Pool FT-LP reserve"),
          ftARaw: uint(descriptorPool.ftARaw, "Pool FT-A reserve"),
          tbcSat: uint(descriptorPool.tbcSat, "Pool TBC reserve"),
          poolValueSat: uint(descriptorPool.poolValueSat, "Pool value"),
        }),
        poolPreTxraw,
        poolPrePreTxraw,
        ...authority,
        feeParentTxraw,
        ftInputs: Object.freeze(preparedInputs),
        ftlpInputs: Object.freeze([]),
      }),
    });
  }

  async function loadMerge(
    request: Extract<
      LegacyPoolMaterialLoadRequest,
      { operation: "mergePoolFt" | "mergeFtlp" | "burnFtlp" }
    >,
  ): Promise<Readonly<Record<string, unknown>>> {
    const source = assertTestnetAddress(request.addressFrom);
    const contractId = assertHash32(request.contractId.toLowerCase());
    const info = normalizedInfo(
      await api.poolInfo(
        { pool_id: contractId },
        { category: "pool", retry: "none" },
      ),
      contractId,
    );
    const currentRead = rawTransaction(info.txid);
    const [poolPreTxraw, authority] =
      await Promise.all([
        currentRead,
        poolAuthority(contractId, info.ftContractId),
      ]);
    const poolParent = parse(poolPreTxraw).inputs[0];
    if (poolParent === undefined || poolParent.vout !== 0) {
      throw new Error("Current Pool transaction has invalid state ancestry");
    }
    const [poolPrePreTxraw, descriptorValue] = await Promise.all([
      rawTransaction(poolParent.txid, true),
      options.native.execute(
        "preparePoolNft",
        JSON.stringify({
          phase: "describe",
          contractId,
          ownerAddress: source.address,
          info,
          poolPreTxraw,
          ...(authority.indexedFt ? { indexedFt: authority.indexedFt } : { ftContractTxraw: authority.ftContractTxraw }),
        }),
      ),
    ]);
    const descriptor = record(
      JSON.parse(descriptorValue),
      "Pool merge descriptor",
    );
    const descriptorPool = record(descriptor.pool, "Pool merge state");
    if (
      descriptor.stablecoin === true ||
      descriptor.ftContractId !== info.ftContractId
    ) {
      throw new Error("Pool merge descriptor identity mismatch");
    }
    const ftlpScript = hex(descriptor.ftlpScript, "Pool FT-LP script");
    const indexed = request.operation === "mergePoolFt"
      ? await api.ftUtxosByCombineScript(
          {
            combine_script: string(
              descriptor.poolCombineScript,
              "Pool combine script",
              256,
            ),
            contract_id: info.ftContractId,
          },
          { category: "asset-index", retry: "none" },
        )
      : normalizePoolLpIndex(await api.poolLpUtxosByScriptHash(
          {
            scriptpubkeyhash: assertHash32(
              string(
                descriptor.ftlpScriptHash,
                "Pool FT-LP script hash",
              ).toLowerCase(),
            ),
          },
          { category: "pool", retry: "none" },
        ));
    observeIndex(indexed);
    if (!Array.isArray(indexed.utxos) || indexed.utxos.length > MAX_UTXOS) {
      throw new Error("Invalid Pool merge UTXOs");
    }
    const candidateLimit = request.operation === "mergePoolFt" ? 4 : 5;
    const candidates = indexed.utxos
      .map((value) => {
        const input = record(value, "Pool merge UTXO");
        return request.operation === "mergePoolFt"
          ? candidate(
              {
                txid: input.txid,
                outputIndex: input.index,
                satoshis: input.tbc_value,
                balance: input.ft_value,
              },
              "Pool-held FT merge UTXO",
            )
          : candidate(
              {
                txid: input.txid,
                outputIndex: input.index,
                satoshis: input.tbc_balance,
                balance: input.lp_balance,
                lockTime: input.lock_time,
                script: ftlpScript,
              },
              "Pool FT-LP merge UTXO",
            );
      })
      .sort((left, right) =>
        BigInt(left.balance) < BigInt(right.balance)
          ? -1
          : BigInt(left.balance) > BigInt(right.balance)
            ? 1
            : left.txid.localeCompare(right.txid) ||
              left.outputIndex - right.outputIndex,
      )
      .slice(0, candidateLimit);
    let currentBlockHeight: number | undefined;
    if (
      (request.operation === "mergeFtlp" || request.operation === "burnFtlp") &&
      descriptorPool.ftlpLockTimeEnabled === true
    ) {
      const fundingIndex =
        typeof options.funding === "function"
          ? await options.funding.readIndex?.()
          : options.funding;
      if (fundingIndex?.tipHeight !== undefined) {
        currentBlockHeight = safeInteger(
          fundingIndex.tipHeight,
          "funding tip height",
        );
      } else if (typeof options.funding === "function" && options.funding.readTipHeight) {
        currentBlockHeight = safeInteger(await options.funding.readTipHeight(), "funding tip height");
      } else {
        const blocks = await api.recentBlocks(
          { start: 0, end: 1 },
          { category: "tip", retry: "none" },
        );
        currentBlockHeight = safeInteger(
          record(
            Array.isArray(blocks) ? blocks[0] : undefined,
            "recent TBC block",
          ).height,
          "recent TBC block height",
        );
      }
    }
    const selection = record(
      JSON.parse(
        await options.native.execute(
          "preparePoolNft",
          JSON.stringify({
            phase: "select",
            operation: request.operation,
            ftContractId: info.ftContractId,
            ftDecimal: safeInteger(descriptor.ftDecimal, "Pool FT decimal"),
            pool: {
              ftLpRaw: uint(descriptorPool.ftLpRaw, "Pool FT-LP reserve"),
              ftARaw: uint(descriptorPool.ftARaw, "Pool FT-A reserve"),
              tbcSat: uint(descriptorPool.tbcSat, "Pool TBC reserve"),
              poolValueSat: uint(
                descriptorPool.poolValueSat,
                "Pool value",
              ),
              serviceFeeRate: safeInteger(
                descriptorPool.serviceFeeRate,
                "Pool service fee rate",
              ),
              lpPlan: safeInteger(descriptorPool.lpPlan, "Pool LP plan"),
              ftlpLockTimeEnabled:
                descriptorPool.ftlpLockTimeEnabled === true,
              publicKeyLocked: descriptorPool.publicKeyLocked === true,
            },
            amount: "0",
            ...(currentBlockHeight === undefined
              ? {}
              : { currentBlockHeight }),
            ownerFtCandidates: [],
            poolFtCandidates:
              request.operation === "mergePoolFt" ? candidates : [],
            ftlpCandidates:
              request.operation === "mergeFtlp" || request.operation === "burnFtlp" ? candidates : [],
          }),
        ),
      ),
      "Pool merge selection",
    );
    const selectedValues = request.operation === "mergePoolFt"
      ? selection.poolFtCandidates
      : selection.ftlpCandidates;
    if (!Array.isArray(selectedValues)) {
      throw new Error("Invalid Pool merge selection");
    }
    const selected = selectedValues.map((value) =>
      candidate(value, "selected Pool merge UTXO"),
    );
    const minimum = request.operation === "burnFtlp" ? 1 : 2;
    if (!(selected.length >= minimum && selected.length <= candidateLimit)) {
      throw new Error("Pool maintenance requires a bounded input selection");
    }
    const selectedRaw = await Promise.all(
      selected.map(({ txid }) => rawTransaction(txid)),
    );
    const inspected = record(
      JSON.parse(
        await options.native.execute(
          "prepareAssetAncestry",
          JSON.stringify({
            phase: "inspect",
            items: selected.map((input, index) => ({
              parentTxid: input.txid,
              outputIndex: input.outputIndex,
              parentTxraw: selectedRaw[index],
            })),
          }),
        ),
      ),
      "Pool merge ancestry inspection",
    );
    if (!Array.isArray(inspected.items) || inspected.items.length !== selected.length) {
      throw new Error("Invalid Pool merge ancestry inspection");
    }
    const ancestry = await Promise.all(
      inspected.items.map(async (value) => {
        const references = record(value, "Pool merge ancestry item").references;
        if (!Array.isArray(references) || references.length === 0 || references.length > 6) {
          throw new Error("Invalid Pool merge ancestry references");
        }
        return Promise.all(
          references.map(async (referenceValue) => {
            const reference = record(referenceValue, "Pool merge ancestor");
            const txid = assertHash32(
              string(reference.txid, "Pool merge ancestor txid").toLowerCase(),
            );
            return Object.freeze({
              txid,
              outputIndex: safeInteger(
                reference.outputIndex,
                "Pool merge ancestor output",
              ),
              txraw: await rawTransaction(txid, true),
            });
          }),
        );
      }),
    );
    const selectedScript = hex(
      request.operation === "mergePoolFt"
        ? descriptor.poolFtScript
        : descriptor.ftlpScript,
      "Pool merge selected script",
    );
    const preparedInputs = selected.map((input, index) =>
      Object.freeze({
        ...input,
        script: selectedScript,
        preTxraw: selectedRaw[index],
        grandparentTxraws: Object.freeze(
          ancestry[index]?.map(({ txraw }) => txraw) ?? [],
        ),
      }),
    );
    const supplied = await suppliedFeeFunding(source.address);
    const funding = supplied?.index ?? await api.utxosByAddress(
      { address: source.address },
      { category: "native-index", retry: "none" },
    );
    if (!Array.isArray(funding.utxos) || funding.utxos.length > MAX_UTXOS) {
      throw new Error("Invalid Pool merge fee UTXOs");
    }
    const feeUtxo = funding.utxos
      .map((value) => {
        const input = record(value, "Pool merge fee UTXO");
        return Object.freeze({
          txid: assertHash32(
            string(input.txid, "Pool merge fee txid").toLowerCase(),
          ),
          outputIndex: safeInteger(
            input.index ?? input.vout,
            "Pool merge fee output",
          ),
          satoshis: safeInteger(
            input.value ?? input.satoshis,
            "Pool merge fee value",
          ),
          script: source.scriptPubKey,
        });
      })
      .sort((left, right) =>
        right.satoshis - left.satoshis ||
        left.txid.localeCompare(right.txid) ||
        left.outputIndex - right.outputIndex,
      )[0];
    if (feeUtxo === undefined || feeUtxo.satoshis === 0) {
      throw new Error("No Pool merge fee UTXO is available");
    }
    const feeParentTxraw = supplied?.rawTransaction ??
      await rawTransaction(feeUtxo.txid);
    return Object.freeze({
      version: 2,
      operation: request.operation,
      contractId,
      feeUtxo,
      preparedContext: Object.freeze({
        info,
        canonicalDescriptor: Object.freeze({
          ownerFtScript: hex(descriptor.ownerFtScript, "Pool owner FT script"),
          poolFtScript: hex(descriptor.poolFtScript, "Pool-held FT script"),
          ftlpScript,
          lpPlan: safeInteger(descriptorPool.lpPlan, "Pool LP plan"),
          serviceFeeRate: safeInteger(
            descriptorPool.serviceFeeRate,
            "Pool service fee rate",
          ),
          serviceProviderTag: info.serviceProvider,
        }),
        poolBefore: Object.freeze({
          ftLpRaw: uint(descriptorPool.ftLpRaw, "Pool FT-LP reserve"),
          ftARaw: uint(descriptorPool.ftARaw, "Pool FT-A reserve"),
          tbcSat: uint(descriptorPool.tbcSat, "Pool TBC reserve"),
          poolValueSat: uint(descriptorPool.poolValueSat, "Pool value"),
        }),
        poolPreTxraw,
        poolPrePreTxraw,
        ...authority,
        feeParentTxraw,
        ftInputs: Object.freeze(
          request.operation === "mergePoolFt" ? preparedInputs : [],
        ),
        ftlpInputs: Object.freeze(
          request.operation === "mergeFtlp" || request.operation === "burnFtlp" ? preparedInputs : [],
        ),
      }),
    });
  }

  async function loadMergeIndex(
    request: Extract<
      LegacyPoolMaterialLoadRequest,
      { operation: "indexPoolFt" | "indexFtlp" }
    >,
  ): Promise<Readonly<Record<string, unknown>>> {
    const source = assertTestnetAddress(request.addressFrom);
    const contractId = assertHash32(request.contractId.toLowerCase());
    const info = normalizedInfo(
      await api.poolInfo(
        { pool_id: contractId },
        { category: "pool", retry: "none" },
      ),
      contractId,
    );
    const [poolPreTxraw, authority] = await Promise.all([
      rawTransaction(info.txid),
      poolAuthority(contractId, info.ftContractId),
    ]);
    const descriptor = record(
      JSON.parse(
        await options.native.execute(
          "preparePoolNft",
          JSON.stringify({
            phase: "describe",
            contractId,
            ownerAddress: source.address,
            info,
            poolPreTxraw,
            ...(authority.indexedFt ? { indexedFt: authority.indexedFt } : { ftContractTxraw: authority.ftContractTxraw }),
          }),
        ),
      ),
      "Pool merge index descriptor",
    );
    if (
      descriptor.stablecoin === true ||
      descriptor.ftContractId !== info.ftContractId
    ) {
      throw new Error("Pool merge index identity mismatch");
    }
    const indexed = request.operation === "indexPoolFt"
      ? await api.ftUtxosByCombineScript(
          {
            combine_script: string(
              descriptor.poolCombineScript,
              "Pool combine script",
              256,
            ),
            contract_id: info.ftContractId,
          },
          { category: "asset-index", retry: "none" },
        )
      : normalizePoolLpIndex(await api.poolLpUtxosByScriptHash(
          {
            scriptpubkeyhash: assertHash32(
              string(
                descriptor.ftlpScriptHash,
                "Pool FT-LP script hash",
              ).toLowerCase(),
            ),
          },
          { category: "pool", retry: "none" },
        ));
    observeIndex(indexed);
    if (!Array.isArray(indexed.utxos) || indexed.utxos.length > MAX_UTXOS) {
      throw new Error("Invalid Pool merge index UTXOs");
    }
    const kind = request.operation === "indexPoolFt" ? "pool-ft" : "ftlp";
    const utxos = indexed.utxos.map((value) => {
      const input = record(value, "Pool merge index UTXO");
      const normalized = request.operation === "indexPoolFt"
        ? candidate({
            txid: input.txid,
            outputIndex: input.index,
            satoshis: input.tbc_value,
            balance: input.ft_value,
          }, "Pool-held FT merge index UTXO")
        : candidate({
            txid: input.txid,
            outputIndex: input.index,
            satoshis: input.tbc_balance,
            balance: input.lp_balance,
            lockTime: input.lock_time,
          }, "Pool FT-LP merge index UTXO");
      return Object.freeze(normalized);
    });
    if (
      new Set(utxos.map(({ txid, outputIndex }) => `${txid}:${String(outputIndex)}`)).size !==
      utxos.length
    ) {
      throw new Error("Duplicate Pool merge index outpoint");
    }
    return Object.freeze({
      version: 1,
      kind,
      poolContractId: contractId,
      ftContractId: info.ftContractId,
      currentPoolTxid: info.txid,
      utxos: Object.freeze(utxos),
    });
  }

  return async (request) => {
    if (
      request.operation === "indexPoolFt" ||
      request.operation === "indexFtlp"
    ) {
      return loadMergeIndex(request);
    }
    if (request.operation === "consumeLp") {
      return loadConsumeLp(request);
    }
    if (
      request.operation === "swapToToken" ||
      request.operation === "swapToTbc"
    ) {
      return loadSwap(request);
    }
    if (
      request.operation === "mergePoolFt" ||
      request.operation === "mergeFtlp" ||
      request.operation === "burnFtlp"
    ) {
      return loadMerge(request);
    }
    const source = assertTestnetAddress(request.addressFrom);
    assertTestnetAddress(request.receiver);
    const contractId = assertHash32(request.contractId.toLowerCase());
    const info = normalizedInfo(
      await api.poolInfo(
        { pool_id: contractId },
        { category: "pool", retry: "none" },
      ),
      contractId,
    );
    // Rust defines the owner index as HASH160(account) + 00. Its GET does
    // not depend on Pool bytes or preview; verify the descriptor before use.
    const accountCombineScript = `${source.publicKeyHash}00`;
    const ownerIndexRead = api.ftUtxosByCombineScript(
      {
        combine_script: accountCombineScript,
        contract_id: info.ftContractId,
      },
      { category: "asset-index", retry: "none" },
    ).then((value) => {
      observeIndex(value);
      return value;
    });
    void ownerIndexRead.catch(() => {});
    const currentRead = rawTransaction(info.txid);
    const poolPrePreRead = currentRead.then((raw) => {
      const poolParent = parse(raw).inputs[0];
      if (poolParent === undefined || poolParent.vout !== 0)
        throw new Error("Current Pool transaction has invalid state ancestry");
      return rawTransaction(poolParent.txid, true);
    });
    void poolPrePreRead.catch(() => {});
    const [poolPreTxraw, authority] = await Promise.all([
      currentRead,
      poolAuthority(contractId, info.ftContractId),
    ]);
    const descriptor = record(
      JSON.parse(
        await options.native.execute(
          "preparePoolNft",
          JSON.stringify({
            phase: "describe",
            contractId,
            ownerAddress: source.address,
            info,
            poolPreTxraw,
            ...(authority.indexedFt ? { indexedFt: authority.indexedFt } : { ftContractTxraw: authority.ftContractTxraw }),
          }),
        ),
      ),
      "Pool descriptor",
    );
    if (descriptor.stablecoin === true) {
      throw new Error("PoolNFT supports ordinary FT only");
    }
    const descriptorPool = record(descriptor.pool, "Pool descriptor state");
    if (descriptor.ftContractId !== info.ftContractId) {
      throw new Error("Pool descriptor FT identity mismatch");
    }
    const lockedLpCost =
      descriptorPool.publicKeyLocked === true
        ? {
            lockedLpCostSatoshis: safeInteger(
              descriptorPool.lockedLpCostSatoshis,
              "Pool locked LP cost",
            ),
          }
        : {};
    const ownerCombineScript = string(
      descriptor.ownerCombineScript,
      "Pool owner combine script",
      256,
    );
    if (ownerCombineScript !== accountCombineScript) {
      throw new Error("Pool descriptor owner identity mismatch");
    }
    const previewRequest = JSON.stringify({
      operation: "increaseLp",
      ftContractId: info.ftContractId,
      ftDecimal: safeInteger(descriptor.ftDecimal, "Pool FT decimal"),
      amount: request.tbcAmount,
      lockTime: 0,
      pool: {
        ftLpRaw: uint(descriptorPool.ftLpRaw, "Pool FT-LP reserve"),
        ftARaw: uint(descriptorPool.ftARaw, "Pool FT-A reserve"),
        tbcSat: uint(descriptorPool.tbcSat, "Pool TBC reserve"),
        poolValueSat: uint(descriptorPool.poolValueSat, "Pool value"),
        publicKeyLocked: descriptorPool.publicKeyLocked === true,
        ...lockedLpCost,
      },
    });
    // Selection still waits for the fresh index and trusted Rust preview.
    const [indexed, previewJson] = await Promise.all([
      ownerIndexRead,
      options.native.execute("previewLiquidityAdd", previewRequest),
    ]);
    const preview = record(JSON.parse(previewJson), "Pool trusted preview");
    if (!Array.isArray(indexed.utxos) || indexed.utxos.length > MAX_UTXOS) {
      throw new Error("Invalid Pool owner FT UTXOs");
    }
    const ownerCandidates = indexed.utxos.map((value) => {
      const input = record(value, "Pool owner FT UTXO");
      return candidate(
        {
          txid: input.txid,
          outputIndex: input.index,
          satoshis: input.tbc_value,
          balance: input.ft_value,
        },
        "Pool owner FT UTXO",
      );
    });
    // A Rust-derived preview establishes the required balance. Prefer one
    // sufficient real coin; unrelated indexed fragments must not force a merge.
    // If no single coin suffices, preserve the existing sign-only rejection.
    const requiredOwnerFt = BigInt(
      uint(preview.ftRequiredRaw, "Pool required FT"),
    );
    const sufficientOwner = selectCanonicalPoolInput(
      ownerCandidates,
      requiredOwnerFt.toString(),
    );
    const selection = record(
      JSON.parse(
        await options.native.execute(
          "preparePoolNft",
          JSON.stringify({
            phase: "select",
            operation: "increaseLp",
            ftContractId: info.ftContractId,
            ftDecimal: safeInteger(descriptor.ftDecimal, "Pool FT decimal"),
            pool: {
              ftLpRaw: uint(descriptorPool.ftLpRaw, "Pool FT-LP reserve"),
              ftARaw: uint(descriptorPool.ftARaw, "Pool FT-A reserve"),
              tbcSat: uint(descriptorPool.tbcSat, "Pool TBC reserve"),
              poolValueSat: uint(descriptorPool.poolValueSat, "Pool value"),
              serviceFeeRate: safeInteger(
                descriptorPool.serviceFeeRate,
                "Pool service fee rate",
              ),
              lpPlan: safeInteger(descriptorPool.lpPlan, "Pool LP plan"),
              ftlpLockTimeEnabled: descriptorPool.ftlpLockTimeEnabled === true,
              publicKeyLocked: descriptorPool.publicKeyLocked === true,
            },
            amount: request.tbcAmount,
            ...lockedLpCost,
            ownerFtCandidates: sufficientOwner
              ? [sufficientOwner]
              : ownerCandidates,
            poolFtCandidates: [],
            ftlpCandidates: [],
          }),
        ),
      ),
      "Pool selection",
    );
    if (
      !Array.isArray(selection.ownerFtCandidates) ||
      !Array.isArray(selection.poolFtCandidates) ||
      !Array.isArray(selection.ftlpCandidates) ||
      selection.poolFtCandidates.length !== 0 ||
      selection.ftlpCandidates.length !== 0
    ) {
      throw new Error("Invalid Pool increase selection");
    }
    const selected = selection.ownerFtCandidates.map((value) =>
      candidate(value, "selected Pool owner FT UTXO"),
    );
    const selectedInput = selected[0];
    if (selected.length !== 1 || selectedInput === undefined) {
      throw new Error(
        "Legacy Pool sign-only rejects fragmented owner FT inputs before approval",
      );
    }
    const selectedRaw = await rawTransaction(selectedInput.txid);
    const inspect = record(
      JSON.parse(
        await options.native.execute(
          "prepareAssetAncestry",
          JSON.stringify({
            phase: "inspect",
            items: [
              {
                parentTxid: selectedInput.txid,
                outputIndex: selectedInput.outputIndex,
                parentTxraw: selectedRaw,
              },
            ],
          }),
        ),
      ),
      "Pool FT ancestry inspection",
    );
    const inspected = Array.isArray(inspect.items)
      ? inspect.items[0]
      : undefined;
    const references = record(inspected, "Pool FT ancestry item").references;
    if (
      !Array.isArray(references) ||
      references.length === 0 ||
      references.length > 6
    ) {
      throw new Error("Invalid Pool FT ancestry references");
    }
    const grandparentsRead = Promise.all(
      references.map(async (value) => {
        const reference = record(value, "Pool FT ancestry reference");
        const txid = assertHash32(
          string(reference.txid, "Pool FT ancestor txid").toLowerCase(),
        );
        const outputIndex = safeInteger(
          reference.outputIndex,
          "Pool FT ancestor output",
        );
        return Object.freeze({
          txid,
          outputIndex,
          txraw: await rawTransaction(txid, true),
        });
      }),
    );
    const grandparents = await grandparentsRead;
    const provedItems = await legacyProofData(
      [
        {
          parentTxid: selectedInput.txid,
          outputIndex: selectedInput.outputIndex,
          parentTxraw: selectedRaw,
          grandparents,
        },
      ],
      "Pool FT ancestry proof",
    );
    const poolPrePreTxraw = await poolPrePreRead;
    const sharedFee = await suppliedFeeFunding(source.address);
    const funding =
      sharedFee?.index ??
      (await api.utxosByAddress(
        { address: source.address },
        { category: "native-index", retry: "none" },
      ));
    if (!Array.isArray(funding.utxos) || funding.utxos.length > MAX_UTXOS) {
      throw new Error("Invalid Pool fee UTXOs");
    }
    const feeUtxo = funding.utxos
      .map((value) => {
        const input = record(value, "Pool fee UTXO");
        return Object.freeze({
          txid: assertHash32(string(input.txid, "Pool fee txid").toLowerCase()),
          outputIndex: safeInteger(input.index, "Pool fee output"),
          satoshis: safeInteger(input.value, "Pool fee value"),
          script: source.scriptPubKey,
        });
      })
      .sort(
        (left, right) =>
          right.satoshis - left.satoshis ||
          left.txid.localeCompare(right.txid) ||
          left.outputIndex - right.outputIndex,
      )[0];
    if (feeUtxo === undefined || feeUtxo.satoshis === 0) {
      throw new Error("No Pool fee UTXO is available");
    }
    const feeParentTxraw =
      sharedFee?.rawTransaction ?? (await rawTransaction(feeUtxo.txid));
    return Object.freeze({
      version: 2,
      operation: "increaseLp",
      contractId,
      receiver: request.receiver,
      tbcAmount: request.tbcAmount,
      feeUtxo,
      preparedContext: Object.freeze({
        info,
        canonicalDescriptor: Object.freeze({
          ownerFtScript: hex(descriptor.ownerFtScript, "Pool owner FT script"),
          poolFtScript: hex(descriptor.poolFtScript, "Pool-held FT script"),
          ftlpScript: hex(descriptor.ftlpScript, "Pool FT-LP script"),
          lpPlan: safeInteger(descriptorPool.lpPlan, "Pool LP plan"),
          serviceFeeRate: safeInteger(
            descriptorPool.serviceFeeRate,
            "Pool service fee rate",
          ),
          serviceProviderTag: info.serviceProvider,
        }),
        poolPreTxraw,
        poolPrePreTxraw,
        ...authority,
        feeParentTxraw,
        ftInputs: Object.freeze([
          Object.freeze({
            ...selected[0],
            script: string(descriptor.ownerFtScript, "Pool owner FT script"),
            preTxraw: selectedRaw,
            ...(provedItems ? { prePreTxData: provedItems[0] } : {}),
            grandparentTxraws: Object.freeze(
              grandparents.map(({ txraw }) => txraw),
            ),
          }),
        ]),
        ftlpInputs: Object.freeze([]),
      }),
      preview,
    });
  };
}
