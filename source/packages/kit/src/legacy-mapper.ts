import { hashCanonical, utf8 } from "@tbc-wallet/core";
import { createLegacyDependentBatchCoordinator } from "./legacy-dependent-batch.js";
import { resolveLegacyFtTransferIntent } from "./legacy-ft-transfer-intent.js";
import { createLegacyPoolIntentResolver } from "./legacy-pool-intent.js";
import { createLegacyNftIntentResolver } from "./legacy-nft-intent.js";
import type { KitProvider } from "./public-types.js";

const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const HASH32 = /^[0-9a-f]{64}$/u;

export interface LegacyKitOptions {
  /** Wallet-trusted Bitcoin Signed Message digest computation. */
  readonly bitcoinMessageDigest?: (input: Readonly<{
    version: "1.0";
    message: Readonly<{
      encoding: "utf8" | "hex" | "base64";
      data: string;
    }>;
  }>) => string | Promise<string>;
  readonly resolveFtDecimals?: (contractId: string) => Promise<number>;
  readonly resolvePoolFtDecimals?: (poolContractId: string) => Promise<number>;
  readonly reviewRequests?: (input: Readonly<{
    account: string;
    chainId: `tbc:${string}`;
    request: unknown;
  }>) => Promise<boolean>;
  readonly now?: () => Date;
  readonly platform?: "ios" | "android";
  readonly walletVersion?: string;
}

export interface LegacyKitFacade {
  readonly enabled: boolean;
  readonly getAddress: () => Promise<string>;
  readonly connect: () => Promise<unknown>;
  readonly disconnect: () => Promise<unknown>;
  readonly isConnected: () => Promise<boolean>;
  readonly getPubKey: () => Promise<unknown>;
  readonly getNetwork: () => Promise<unknown>;
  readonly getInfo: () => Readonly<{ name: "Turing"; platform?: "ios" | "android"; version?: string }>;
  readonly signMessage: (params: unknown) => Promise<unknown>;
  readonly sendBatchRequest: (params: unknown) => Promise<unknown>;
  readonly on: KitProvider["on"];
  readonly removeListener: KitProvider["removeListener"];
  readonly close: () => void;
  readonly sendTransaction: (params: unknown) => Promise<unknown>;
  readonly mergeUtxos: () => Promise<unknown>;
  readonly mergeFtUtxos: (params: unknown) => Promise<unknown>;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Invalid Legacy transaction request");
  }
  return value as Readonly<Record<string, unknown>>;
}

function displayAmount(value: unknown, decimals: number, truncate = false): string {
  const display = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof display !== "string" || !DECIMAL.test(display) || /^0(?:\.0+)?$/u.test(display) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Invalid Legacy amount");
  }
  const [whole = "0", supplied = ""] = display.split(".");
  if (!truncate && supplied.length > decimals) throw new Error("Invalid Legacy amount precision");
  const atomic = `${whole}${supplied.slice(0, decimals).padEnd(decimals, "0")}`.replace(/^0+(?=[0-9])/u, "");
  if (!/^[1-9][0-9]*$/u.test(atomic) || BigInt(atomic) > 0xffff_ffff_ffff_ffffn) throw new Error("Invalid Legacy amount");
  return atomic;
}

function withIdentity(chainId: `tbc:${string}`, from: string, prefix: string, intent: Readonly<Record<string, unknown>>, constraints?: Readonly<Record<string, unknown>>) {
  const base = Object.freeze({ version: "1.0", chainId, from, intent, ...(constraints === undefined ? {} : { constraints }) });
  return Object.freeze({ ...base, clientRequestId: `${prefix}:${hashCanonical(base)}` });
}

function businessError(method: "connect" | "sendTransaction" | "signMessage" | "sendBatchRequest", error: unknown): Readonly<{ error: string }> {
  const code = error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
  const message = error instanceof Error ? error.message : "Wallet request failed";
  if (code === 4001) {
    return Object.freeze({ error: method === "connect" ? "User rejected the request" : method === "sendTransaction" ? "User cancelled the transaction" : method === "signMessage" ? "User cancelled the sign message" : "User cancelled the batch request" });
  }
  return Object.freeze({ error: message || "Wallet request failed" });
}

function transactionResult(result: unknown, ftCreate = false): unknown {
  if (result === null || typeof result !== "object" || Object.hasOwn(result, "error")) return result;
  const transactions = Reflect.get(result, "transactions");
  if (!Array.isArray(transactions) || transactions.length === 0) return result;
  if (ftCreate) {
    const primary = transactions.filter((value) => value !== null && typeof value === "object" && Reflect.get(value, "role") === "primary" && Reflect.get(value, "status") === "submitted");
    const txid = primary.length === 1 ? Reflect.get(primary[0], "txid") : undefined;
    if (typeof txid !== "string" || !HASH32.test(txid)) throw new Error("Invalid canonical Legacy FT create result");
    return Object.freeze({ txid });
  }
  if (transactions.every((value) => value !== null && typeof value === "object" && typeof Reflect.get(value, "rawTransaction") === "string")) {
    return Object.freeze({ txraw: transactions.map((value) => Reflect.get(value, "rawTransaction")).join(",") });
  }
  if (transactions.every((value) => value !== null && typeof value === "object" && typeof Reflect.get(value, "txid") === "string")) {
    return Object.freeze({ txid: transactions.map((value) => Reflect.get(value, "txid")).join(",") });
  }
  throw new Error("Invalid canonical Legacy transaction result");
}

export function createLegacyKitFacade(input: Readonly<{
  provider: KitProvider;
  chainId: `tbc:${string}`;
  /** Wallet-owned active Provider Session chain; never derived from page input. */
  readChainId?: () => `tbc:${string}`;
  /** Detect A -> B -> A changes while Legacy is preparing an operation. */
  readSessionRevision?: () => string;
  enabled: boolean;
  options?: LegacyKitOptions;
  readAccount?: () => Promise<string>;
  requestLegacyMessage?: (
    params: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
}>): LegacyKitFacade {
  const options = input.options ?? {};
  const nftResolvers = new Map<string, ReturnType<typeof createLegacyNftIntentResolver>>();
  const poolResolvers = new Map<string, ReturnType<typeof createLegacyPoolIntentResolver>>();
  const nftIntentsFor = (chainId: `tbc:${string}`) => {
    let resolver = nftResolvers.get(chainId);
    if (resolver === undefined) {
      resolver = createLegacyNftIntentResolver({ chainId });
      nftResolvers.set(chainId, resolver);
    }
    return resolver;
  };
  const poolIntentsFor = (chainId: `tbc:${string}`) => {
    let resolver = poolResolvers.get(chainId);
    if (resolver === undefined) {
      resolver = createLegacyPoolIntentResolver({
        chainId,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.resolvePoolFtDecimals === undefined
          ? {}
          : { resolvePoolFtDecimals: options.resolvePoolFtDecimals }),
      });
      poolResolvers.set(chainId, resolver);
    }
    return resolver;
  };
  const dependentBatches = createLegacyDependentBatchCoordinator();
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new Error("Legacy wallet session closed");
    if (!input.enabled) throw new Error("Legacy compatibility is disabled");
  };
  const currentChainId = (): `tbc:${string}` => input.readChainId?.() ?? input.chainId;
  type LegacyActiveAccount = Readonly<{ chainId: `tbc:${string}`; from: string; revision?: string }>;
  const assertActive = (active: LegacyActiveAccount): void => {
    if (currentChainId() !== active.chainId ||
        (active.revision !== undefined && input.readSessionRevision?.() !== active.revision)) {
      throw new Error("Legacy wallet authority changed during operation");
    }
  };
  async function activeAccount(): Promise<LegacyActiveAccount> {
    ensureOpen();
    const chainId = currentChainId();
    const revision = input.readSessionRevision?.();
    let from: string;
    if (input.readAccount !== undefined) {
      from = await input.readAccount();
    } else {
      const accounts = await input.provider.request<readonly string[]>({ method: "tbc_accounts" });
      if (accounts[0] === undefined) throw new Error("User not connected");
      from = accounts[0];
    }
    const active = Object.freeze({ chainId, from, ...(revision === undefined ? {} : { revision }) });
    assertActive(active);
    return active;
  }
  async function getAddress() { return (await activeAccount()).from; }
  const requestForActive = async (active: LegacyActiveAccount, request: Parameters<KitProvider["request"]>[0]): Promise<unknown> => {
    assertActive(active);
    return input.provider.request(request);
  };
  async function signMessage(rawParams: unknown): Promise<unknown> {
    ensureOpen();
    const params = record(rawParams);
    if (params.encoding !== "utf8" || typeof params.message !== "string" || params.message.length === 0 || utf8(params.message).length > 64 * 1024) {
      return Object.freeze({ error: "Missing required parameters" });
    }
    if (options.bitcoinMessageDigest === undefined) {
      return Object.freeze({ error: "Unsupported legacy operation" });
    }
    const active = await activeAccount();
    const { chainId, from } = active;
    try {
      const message = Object.freeze({
        encoding: "utf8" as const,
        data: params.message,
      });
      const digest = await options.bitcoinMessageDigest(Object.freeze({
        version: "1.0" as const,
        message,
      }));
      if (!/^[0-9a-f]{64}$/u.test(digest)) {
        throw new Error("Invalid trusted Legacy Bitcoin message digest");
      }
      const request = Object.freeze({
        version: "1.0",
        chainId,
        from,
        clientRequestId: `legacy-bitcoin:${digest}`,
        message,
      });
      assertActive(active);
      const result = input.requestLegacyMessage === undefined
        ? await input.provider.request({
            method: "tbc_signMessage",
            params: request,
          })
        : await input.requestLegacyMessage(request);
      if (result === null || typeof result !== "object" || Object.hasOwn(result, "error")) return result;
      const address = Reflect.get(result, "address");
      const publicKey = Reflect.get(result, "publicKey");
      const signature = Reflect.get(result, "signature");
      if (typeof address !== "string" || typeof publicKey !== "string" || typeof signature !== "string") throw new Error("Invalid canonical Legacy signMessage result");
      return Object.freeze({ address, maddress: address, pubkey: publicKey, pubKey: publicKey, message: params.message, sig: signature });
    } catch (error) {
      return businessError("signMessage", error);
    }
  }
  let facade: LegacyKitFacade;
  facade = Object.freeze({
    enabled: input.enabled,
    getAddress,
    async connect() {
      ensureOpen();
      try {
        const chainId = currentChainId();
        const revision = input.readSessionRevision?.();
        await input.provider.request({ method: "wallet_requestPermissions", params: [{
          tbc_accounts: { chains: [chainId], maxAccounts: 1 },
          tbc_accountMetadata: { chains: [chainId] },
          tbc_signTransaction: { chains: [chainId] },
          tbc_signWorkflow: { chains: [chainId] },
          tbc_crypto: { chains: [chainId] },
          tbc_signMessage: { chains: [chainId] },
        }] });
        const active = await activeAccount();
        if (active.chainId !== chainId ||
            (revision !== undefined && active.revision !== revision)) {
          throw new Error("Legacy wallet authority changed during connection");
        }
        return Object.freeze({ tbcAddress: active.from });
      } catch (error) { return businessError("connect", error); }
    },
    async disconnect() {
      ensureOpen();
      await input.provider.request({ method: "tbc_disconnect", params: [] });
      return true;
    },
    async isConnected() {
      try { await getAddress(); return true; } catch { return false; }
    },
    async getPubKey() {
      try {
        const active = await activeAccount();
        const result = await requestForActive(active, { method: "tbc_getAccount", params: { address: active.from } });
        assertActive(active);
        const publicKey = result !== null && typeof result === "object" ? Reflect.get(result, "publicKey") : undefined;
        return typeof publicKey === "string" && publicKey.length > 0 ? Object.freeze({ tbcPubKey: publicKey }) : Object.freeze({ error: "User not connected" });
      } catch { return Object.freeze({ error: "User not connected" }); }
    },
    async getNetwork() {
      ensureOpen();
      const expectedChainId = currentChainId();
      const chainId = await input.provider.request({ method: "tbc_chainId", params: [] });
      return (expectedChainId === "tbc:mainnet" || expectedChainId === "tbc:testnet") &&
        chainId === expectedChainId && currentChainId() === expectedChainId
        ? Object.freeze({ network: "tbc", type: expectedChainId === "tbc:mainnet" ? "mainnet" : "testnet" })
        : Object.freeze({ error: "Unsupported legacy operation" });
    },
    getInfo: () => Object.freeze({ name: "Turing" as const, ...(options.platform === undefined ? {} : { platform: options.platform }), ...(options.walletVersion === undefined ? {} : { version: options.walletVersion }) }),
    signMessage,
    async sendBatchRequest(params: unknown) {
      ensureOpen();
      const batchChainId = currentChainId();
      const batchRevision = input.readSessionRevision?.();
      const assertBatchCurrent = () => {
        if (currentChainId() !== batchChainId ||
            (batchRevision !== undefined && input.readSessionRevision?.() !== batchRevision)) {
          throw new Error("Legacy batch authority changed");
        }
      };
      if (!Array.isArray(params) || params.length !== 2) return Object.freeze({ error: "Unsupported legacy operation" });
      const first = params[0];
      const second = params[1];
      if (first === null || typeof first !== "object" || Array.isArray(first) || Reflect.get(first, "method") !== "sendTransaction" ||
        second === null || typeof second !== "object" || Array.isArray(second) || Reflect.get(second, "method") !== "signMessage" || Reflect.get(second, "dependsOn") !== "txids") {
        return Object.freeze({ error: "Unsupported legacy operation" });
      }
      const outcome = await dependentBatches.run({
        messageTemplate: Reflect.get(second, "params"),
        async executeFirst() {
          assertBatchCurrent();
          const transaction = await facade.sendTransaction(Reflect.get(first, "params"));
          assertBatchCurrent();
          if (transaction !== null && typeof transaction === "object" && Object.hasOwn(transaction, "error")) {
            return { value: transaction, result: transaction, rawTransactions: [] };
          }
          const raw = transaction !== null && typeof transaction === "object" ? Reflect.get(transaction, "txraw") : undefined;
          if (typeof raw !== "string") throw new Error("Invalid Legacy batch transaction result");
          return { value: transaction, result: transaction, rawTransactions: raw.split(",") };
        },
        async executeSecond(message) {
          assertBatchCurrent();
          const result = await signMessage(message);
          assertBatchCurrent();
          return { value: result, result };
        },
      });
      if (outcome.status === "invalid-template") return Object.freeze({ error: "Missing required parameters" });
      if (outcome.status === "first-error" || outcome.status === "second-error") return businessError("sendBatchRequest", { code: 4001 });
      return Object.freeze([outcome.first.value, outcome.second.value]);
    },
    on: input.provider.on.bind(input.provider),
    removeListener: input.provider.removeListener.bind(input.provider),
    close() { closed = true; },
    async mergeUtxos() {
      ensureOpen();
      const active = await activeAccount();
      const { chainId, from } = active;
      const request = withIdentity(
        chainId,
        from,
        "legacy-merge-utxos",
        Object.freeze({ version: "1.0", type: "tbc.maintenance.merge" }),
      );
      try {
        return transactionResult(await requestForActive(active, {
          method: "tbc_sendTransaction",
          params: request,
        }));
      } catch (error) {
        return businessError("sendTransaction", error);
      }
    },
    async mergeFtUtxos(rawParams: unknown) {
      ensureOpen();
      const active = await activeAccount();
      const { chainId, from } = active;
      const value = typeof rawParams === "string"
        ? rawParams
        : rawParams !== null && typeof rawParams === "object" && !Array.isArray(rawParams)
          ? Reflect.get(rawParams, "ft_contract_address")
          : undefined;
      if (typeof value !== "string" || !HASH32.test(value.toLowerCase())) {
        throw new Error("Invalid Legacy FT merge");
      }
      const request = withIdentity(
        chainId,
        from,
        "legacy-merge-ft-utxos",
        Object.freeze({
          version: "1.0",
          type: "tbc.ft.merge",
          contractId: value.toLowerCase(),
        }),
      );
      try {
        return transactionResult(await requestForActive(active, {
          method: "tbc_sendTransaction",
          params: request,
        }));
      } catch (error) {
        return businessError("sendTransaction", error);
      }
    },
    async sendTransaction(rawParams: unknown) {
      ensureOpen();
      const active = await activeAccount();
      const { chainId, from } = active;
      if (options.reviewRequests !== undefined && !(await options.reviewRequests({ account: from, chainId, request: rawParams }))) {
        throw new Error("User cancelled the Legacy request list");
      }
      assertActive(active);
      const wrapped = Array.isArray(rawParams) && rawParams.length === 1 ? rawParams[0] : rawParams;
      const params = record(wrapped);
      if (["COLLECTION_CREATE", "NFT_CREATE", "NFT_TRANSFER"].includes(String(params.flag))) {
        try {
          const request = await nftIntentsFor(chainId).resolve(params, from);
          return transactionResult(await requestForActive(active, { method: params.broadcastEnabled === false ? "tbc_signTransaction" : "tbc_sendTransaction", params: request }));
        } catch (error) { return businessError("sendTransaction", error); }
      }
      if (params.flag === "P2PKH") {
        const amount = typeof params.satoshis === "number" && Number.isSafeInteger(params.satoshis) ? String(params.satoshis) : params.satoshis;
        if (typeof params.address !== "string" || typeof amount !== "string" || !/^[1-9][0-9]*$/u.test(amount)) throw new Error("Invalid Legacy P2PKH request");
        const request = withIdentity(chainId, from, "legacy-p2pkh", Object.freeze({ version: "1.0", type: "tbc.transfer", to: params.address, amount }));
        try { return transactionResult(await requestForActive(active, { method: params.broadcastEnabled === false ? "tbc_signTransaction" : "tbc_sendTransaction", params: request })); }
        catch (error) { return businessError("sendTransaction", error); }
      }
      if (params.flag === "FT_MINT") {
        if (typeof params.ft_data !== "string" || params.ft_data.length > 4096) throw new Error("Invalid Legacy FT mint");
        const metadata = record(JSON.parse(params.ft_data) as unknown);
        if (typeof metadata.name !== "string" || metadata.name === "" || utf8(metadata.name).length > 256 || typeof metadata.symbol !== "string" || metadata.symbol === "" || utf8(metadata.symbol).length > 256 || metadata.decimal !== 6 || typeof metadata.amount !== "number") throw new Error("Invalid Legacy FT mint");
        const initialSupply = displayAmount(metadata.amount, 6);
        const request = withIdentity(chainId, from, "legacy-ft-create", Object.freeze({ version: "1.0", type: "tbc.ft.create", name: metadata.name, symbol: metadata.symbol, decimals: 6, initialSupply }));
        try { return transactionResult(await requestForActive(active, { method: "tbc_sendTransaction", params: request }), true); }
        catch (error) { return businessError("sendTransaction", error); }
      }
      if (params.flag === "FT_MERGE") {
        const keys = Reflect.ownKeys(params);
        const contractValue = params.ft_contract_address;
        if (
          typeof contractValue !== "string" ||
          !HASH32.test(contractValue.toLowerCase()) ||
          !keys.every((key) =>
            typeof key === "string" &&
            ["flag", "ft_contract_address", "domain"].includes(key)
          )
        ) {
          throw new Error("Invalid Legacy FT merge");
        }
        const request = withIdentity(
          chainId,
          from,
          "legacy-ft-merge",
          Object.freeze({
            version: "1.0",
            type: "tbc.ft.merge",
            contractId: contractValue.toLowerCase(),
          }),
        );
        try {
          return transactionResult(await requestForActive(active, {
            method: "tbc_sendTransaction",
            params: request,
          }));
        } catch (error) {
          return businessError("sendTransaction", error);
        }
      }
      if (params.flag === "FT_TRANSFER") {
        if (options.resolveFtDecimals === undefined) throw new Error("Legacy FT metadata resolver is required");
        const contractValue = params.ft_contract_address;
        if (typeof contractValue !== "string" || !HASH32.test(contractValue.toLowerCase())) {
          throw new Error("Invalid Legacy FT transfer");
        }
        const decimals = await options.resolveFtDecimals(contractValue.toLowerCase());
        const request = resolveLegacyFtTransferIntent({
          chainId,
          request: params,
          addressFrom: from,
          decimals,
        });
        try { return transactionResult(await requestForActive(active, { method: "tbc_signTransaction", params: request })); }
        catch (error) { return businessError("sendTransaction", error); }
      }
      const request = await poolIntentsFor(chainId).resolve(params, from);
      const directSend = params.flag === "POOLNFT_MERGE" || params.flag === "FTLP_MERGE" || params.flag === "POOLNFT_LP_BURN";
      try { return transactionResult(await requestForActive(active, { method: directSend ? "tbc_sendTransaction" : "tbc_signTransaction", params: request })); }
      catch (error) { return businessError("sendTransaction", error); }
    },
  });
  return facade;
}
