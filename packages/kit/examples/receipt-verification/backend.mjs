import { createTbcClient } from "@tbc/kit";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

// In production this record comes from the backend's authenticated order
// database, never from browser-supplied expectation fields.
const order = Object.freeze({
  id: required("ORDER_ID"),
  txid: required("TXID"),
  recipient: required("RECIPIENT"),
  amountAtomic: required("AMOUNT_ATOMIC"),
});

const client = createTbcClient({
  network: process.env.TBC_NETWORK === "mainnet" ? "mainnet" : "testnet",
  api: { fetch: globalThis.fetch },
});
const receipt = await client.verifyTransfer({
  txid: order.txid,
  recipient: { address: order.recipient },
  asset: { kind: "tbc" },
  amount: { mode: "exact", atomic: order.amountAtomic },
  minimumConfirmations: process.env.MIN_CONFIRMATIONS ?? "1",
});

if (receipt.content.status !== "matched" || receipt.policy.status !== "satisfied") {
  console.error(JSON.stringify(receipt, null, 2));
  process.exitCode = 2;
} else {
  // Replace with one database transaction that uniquely binds txid to order.id.
  console.log(JSON.stringify({ orderId: order.id, accepted: true, receipt }, null, 2));
}
