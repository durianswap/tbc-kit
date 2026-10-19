import { getTbcWallets, subscribeTbcWallets, TBC_PROVIDER_FEATURE, type TbcWallet } from "@tbc-wallet/wallet-standard";
import type { TbcProvider, TbcGetCapabilitiesResult } from "@tbc-wallet/provider";
import { formatTbcAmount, parseTbcAmount } from "./amounts.mjs";
import { makeTransfer, TESTNET_CHAIN } from "./transfer.js";

type Receipt = { requestId: string; from: string; to: string; amount: string; createdAt: string;
  status: "pending" | "submitted" | "rejected" | "unknown"; txids: string[]; fee?: string; code?: number };
function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}
const selector = element<HTMLSelectElement>("wallet");
const notice = element("notice");
const storageKey = "tbc-standard-dapp.receipts.v1";
let wallets: readonly TbcWallet[] = [];
let selected: TbcWallet | undefined;
let provider: TbcProvider | undefined;
let accounts: readonly string[] = [];
let chainId = "";
let capabilities: TbcGetCapabilitiesResult | undefined;
let busy = false;
let refreshEpoch = 0;
let receipts: Receipt[] = [];
try {
  const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
  if (Array.isArray(stored)) receipts = stored.filter((r): r is Receipt =>
    r && typeof r.requestId === "string" && typeof r.amount === "string" && /^(0|[1-9][0-9]*)$/.test(r.amount)
    && typeof r.from === "string" && typeof r.to === "string" && typeof r.createdAt === "string"
    && ["pending", "submitted", "rejected", "unknown"].includes(r.status)
    && Array.isArray(r.txids) && r.txids.every((id: unknown) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id))
    && (r.fee === undefined || typeof r.fee === "string" && /^(0|[1-9][0-9]*)$/.test(r.fee))
  ).map(r => ({ ...r, status: r.status === "pending" ? "unknown" : r.status }));
} catch { notice.textContent = "无法读取本页交易记录；请先检查钱包中的历史交易。"; }

function persist() { localStorage.setItem(storageKey, JSON.stringify(receipts)); }
function history() {
  const container = element("history"); container.replaceChildren();
  if (!receipts.length) { container.textContent = "还没有本页发起的交易。"; return; }
  for (const receipt of [...receipts].reverse()) {
    const row = document.createElement("div"); row.className = "record";
    const label = document.createElement("p");
    const states = { pending: "等待钱包结果", submitted: "钱包报告已提交", rejected: "请求已拒绝", unknown: "结果未确定，请在钱包中核对" };
    label.textContent = `${formatTbcAmount(receipt.amount)} TBC · ${states[receipt.status]}`;
    const details = document.createElement("p"); details.className = "mono";
    details.textContent = `${receipt.from} → ${receipt.to}\n请求 ${receipt.requestId}\n${receipt.createdAt}`;
    row.append(label, details);
    for (const txid of receipt.txids) { const tx = document.createElement("p"); tx.className = "mono"; tx.textContent = `txid ${txid}`; row.append(tx); }
    if (receipt.fee !== undefined) { const fee = document.createElement("p"); fee.textContent = `费用 ${formatTbcAmount(receipt.fee)} TBC`; row.append(fee); }
    container.append(row);
  }
}
function render() {
  element("account").textContent = accounts.length ? accounts.join("\n") : "尚未授权账户";
  element("network").textContent = chainId ? chainId === TESTNET_CHAIN ? "当前网络：TBC Testnet" : "当前钱包不在测试网，请在钱包内切换。" : "";
  element("connection").textContent = provider ? `已选择 ${selected?.name ?? "钱包"}` : "请先选择并连接钱包";
  element("capabilities").textContent = capabilities ? JSON.stringify(capabilities, null, 2) : "连接后查看";
  const supported = capabilities?.chainId === TESTNET_CHAIN && capabilities.methods.tbc_sendTransaction !== undefined
    && capabilities.intents["tbc.transfer"]?.includes("1.0");
  element<HTMLButtonElement>("send").disabled = busy || !provider || !accounts.length || chainId !== TESTNET_CHAIN || !supported;
  selector.disabled = busy;
  for (const id of ["connect", "disconnect", "refresh"]) element<HTMLButtonElement>(id).disabled = busy;
}
function discover() {
  wallets = getTbcWallets(); selector.replaceChildren();
  const option = document.createElement("option"); option.value = ""; option.textContent = wallets.length ? "请选择钱包" : "未发现钱包，请在兼容钱包中打开"; selector.append(option);
  wallets.forEach((wallet, index) => { const item = document.createElement("option"); item.value = String(index); item.textContent = `${wallet.name} · ${wallet.chains.includes(TESTNET_CHAIN) ? "支持测试网" : "请核验网络"}`; selector.append(item); if (wallet === selected) selector.value = String(index); });
  if (selected && !wallets.includes(selected)) { detach(); selected = undefined; render(); }
}
function report(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : undefined;
  const messages: Record<number, string> = { 4001: "已取消授权或交易。", 4100: "当前账户或操作尚未授权。", 4200: "钱包尚未支持该公开能力。", 4900: "钱包连接已断开，请重新连接。", 4901: "钱包当前链不可用。", [-32602]: "请求参数不符合标准。", [-32000]: "钱包未完成本次执行，请查看钱包中的交易状态。" };
  notice.textContent = code !== undefined ? `${messages[code] ?? "钱包返回执行错误。"}（${code}）` : error instanceof TypeError ? error.message : "操作未完成，请检查钱包和本页交易记录。";
}
async function refresh() {
  const current = provider; if (!current) return;
  const epoch = ++refreshEpoch;
  const nextChain = await current.request({ method: "tbc_chainId" });
  const nextAccounts = await current.request({ method: "tbc_accounts" });
  const nextCapabilities = await current.request({ method: "tbc_getCapabilities", params: { chainId: nextChain } });
  if (provider !== current || epoch !== refreshEpoch) return;
  chainId = nextChain; accounts = nextAccounts; capabilities = nextCapabilities; render();
}
const onAccounts = (value: readonly string[]) => { accounts = value; capabilities = undefined; render(); void refresh().catch(report); };
const onChain = (value: string) => { chainId = value; capabilities = undefined; render(); void refresh().catch(report); };
const onDisconnect = () => { accounts = []; capabilities = undefined; ++refreshEpoch; render(); notice.textContent = "钱包已断开。请重新连接后核对交易状态。"; };
function detach() {
  provider?.removeListener("accountsChanged", onAccounts);
  provider?.removeListener("chainChanged", onChain);
  provider?.removeListener("disconnect", onDisconnect);
  provider = undefined; accounts = []; capabilities = undefined; chainId = ""; ++refreshEpoch;
}
async function action(run: () => Promise<void>) {
  if (busy) return; busy = true; notice.textContent = ""; render();
  try { await run(); } catch (error) { report(error); } finally { busy = false; render(); history(); }
}
element("connect").addEventListener("click", () => void action(async () => {
  if (selector.value === "") throw new TypeError("请先选择钱包。");
  const wallet = wallets[Number(selector.value)]; if (!wallet) throw new TypeError("所选钱包已不可用。");
  detach(); selected = wallet; provider = wallet.features[TBC_PROVIDER_FEATURE].provider;
  provider.on("accountsChanged", onAccounts).on("chainChanged", onChain).on("disconnect", onDisconnect);
  accounts = await provider.request({ method: "tbc_requestAccounts" });
  await refresh();
}));
element("refresh").addEventListener("click", () => void action(refresh));
element("disconnect").addEventListener("click", () => void action(async () => {
  if (provider) await provider.request({ method: "tbc_disconnect" });
  detach(); selected = undefined; selector.value = "";
}));
element("transfer").addEventListener("submit", event => {
  event.preventDefault();
  void action(async () => {
    const current = provider; if (!current) throw new TypeError("请先连接钱包。");
    await refresh();
    const from = accounts[0];
    if (!from || chainId !== TESTNET_CHAIN || current !== provider) throw new TypeError("请在测试网授权账户后发送。");
    if (!capabilities?.intents["tbc.transfer"]?.includes("1.0")) throw new TypeError("钱包尚未声明普通 TBC 转账能力。");
    const params = makeTransfer({ from, to: element<HTMLInputElement>("to").value.trim(),
      amount: element<HTMLInputElement>("amount").value.trim(), maxFee: element<HTMLInputElement>("fee").value.trim(),
      requestId: crypto.randomUUID(), now: Date.now() });
    const permissions = await current.request({ method: "wallet_getPermissions" });
    if (!permissions.some(permission => permission.parentCapability === "tbc_sendTransaction")) {
      await current.request({ method: "wallet_requestPermissions", params: [{ tbc_sendTransaction: { chains: [TESTNET_CHAIN] } }] });
    }
    if (params.intent.type !== "tbc.transfer") throw new TypeError("请求必须是 TBC 转账。");
    const receipt: Receipt = { requestId: params.clientRequestId!, from, to: params.intent.to,
      amount: params.intent.amount, createdAt: new Date().toISOString(), status: "pending", txids: [] };
    receipts.push(receipt); persist(); history(); notice.textContent = "请在钱包中核对金额并确认。";
    try {
      const result = await current.request({ method: "tbc_sendTransaction", params });
      const txids = result.transactions.map(tx => {
        if (typeof tx !== "object" || tx === null || !("txid" in tx) || typeof tx.txid !== "string" || !/^[0-9a-f]{64}$/.test(tx.txid)) {
          throw new TypeError("钱包返回的交易结果缺少有效 txid，请在钱包中核对。");
        }
        return tx.txid;
      });
      receipt.txids = txids; receipt.fee = result.totalFee; receipt.status = "submitted";
      notice.textContent = "钱包报告交易已提交。链上与余额验收需进一步核对。";
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : undefined;
      receipt.status = code !== undefined && [4001, 4100, 4200, -32602].includes(code) ? "rejected" : "unknown";
      if (code !== undefined) receipt.code = code;
      throw error;
    } finally { persist(); history(); }
  });
});
function previewAmount() { try { element("atomic").textContent = `${parseTbcAmount(element<HTMLInputElement>("amount").value.trim())} atomic`; } catch { element("atomic").textContent = "金额须大于 0，最多 6 位小数。"; } }
element("amount").addEventListener("input", previewAmount);
const unsubscribe = subscribeTbcWallets(discover);
window.addEventListener("pagehide", () => { unsubscribe(); detach(); }, { once: true });
discover(); previewAmount(); history(); render();
