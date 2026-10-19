// Comparator-local structural fixtures. No SDK, producer imports, or generated artifacts.
// Tape chunks/output order follow the pinned builders. Code and ancestry data are
// structural fixtures, with real test-only ECDSA (not chain or producer evidence).
import { PIN, SCENARIOS } from "./protocol.mjs";
import { parseRawTransaction } from "./raw-comparator.mjs";
import { assetContext, exactFtTape, fixtureTxid, fixtureSerialize, parentSuffix, signFromParent } from "./spent-script-fixtures.mjs";

export const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
export const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const compact = (n) => n < 253 ? Buffer.from([n]) : Buffer.from([253, n & 255, n >> 8]);
export function push(bytes) {
  const prefix = bytes.length <= 75 ? Buffer.from([bytes.length])
    : bytes.length <= 255 ? Buffer.from([0x4c, bytes.length])
      : Buffer.from([0x4d, bytes.length & 255, bytes.length >> 8]);
  return Buffer.concat([prefix, bytes]);
}
export const tape = (chunks) => Buffer.concat([Buffer.from([0, 0x6a]), ...chunks.map(push)]).toString("hex");
export function code(family, coin = false) {
  return assetContext({ coin }).parents[family].outputs[0].script;
}
export const poolTape = (locked = false) => tape([
  Buffer.alloc(64, 0x11), Buffer.concat([u64(100), u64(200), u64(300)]),
  Buffer.alloc(32, 0x22), Buffer.from([35, 0]), Buffer.from([1]),
  Buffer.from([Number(locked)]), Buffer.from([Number(locked)]), Buffer.from("NTape"),
]);
export const ftTape = (coin = false) => tape([
  Buffer.concat([u64(10), Buffer.alloc(40)]), Buffer.from([6]),
  Buffer.from("Local FT"), Buffer.from("LFT"), ...(coin ? [u32(0)] : []), Buffer.from("FTape"),
]);
export const lpTape = (locked = false) => locked
  ? tape([Buffer.concat([u64(10), Buffer.alloc(40)]), u32(800_000), Buffer.alloc(0), Buffer.alloc(0), Buffer.from("FTape")])
  : tape([Buffer.concat([u64(10), Buffer.alloc(40)]), Buffer.from([6]), Buffer.from("Local LP"), Buffer.from("LLP"), Buffer.from("FTape")]);
const p2pkh = `76a914${"44".repeat(20)}88ac`;
const output = (script, satoshis = "0") => ({ script, satoshis });
const pair = (family, script, coin = false) => [output(code(family, coin), "500"), output(script)];

export function serialize(tx) {
  return Buffer.concat([
    u32(tx.version), compact(tx.inputs.length), ...tx.inputs.flatMap((input) => {
      const script = Buffer.from(input.script, "hex");
      return [Buffer.from(input.txid, "hex").reverse(), u32(input.vout), compact(script.length), script, u32(input.sequence)];
    }), compact(tx.outputs.length), ...tx.outputs.flatMap((item) => {
      const script = Buffer.from(item.script, "hex");
      return [u64(item.satoshis), compact(script.length), script];
    }), u32(tx.lockTime),
  ]).toString("hex");
}

export function editRaw(transaction, edit, phase = "unsignedRaw") {
  const parsed = parseRawTransaction(transaction[phase]);
  edit(parsed);
  transaction[phase] = serialize(parsed);
}
export function flipOutput(transaction, outputIndex, offset) {
  editRaw(transaction, (tx) => {
    const bytes = Buffer.from(tx.outputs[outputIndex].script, "hex");
    bytes[offset] ^= 1;
    tx.outputs[outputIndex].script = bytes.toString("hex");
  });
}

// ft/unlock.rs::pre_tx_data: header, inputs, unlock hash, preceding outputs,
// four code-output pushes, two Tape-output pushes, following outputs.
export function ftPreTx(coin = false) {
  return parentSuffix(assetContext({ coin }).parents.ft);
}
export function signatureHead(marker) {
  return Buffer.concat([push(Buffer.from([0x30, 6, 2, 1, 1, 2, 1, marker, 0x41])), push(Buffer.concat([Buffer.from([2]), Buffer.alloc(32, 0x21)]))]);
}
export function ftInputScript(marker, swap = true, coin = false) {
  // Minimal local prefix preserves the existing guard's signature-head convention.
  // The locator region after the public key is the pinned sign_ft_swap_input layout:
  // current_inputs_data, contract_tx_data (header + 2 hashes + 15 output pairs),
  // index tag, optional coin flag, pre_tx_data. Standard sign_ft_input has no contract region.
  const contract = Buffer.concat([
    push(Buffer.alloc(40, 0x77)), push(Buffer.concat([u32(2), u32(0), u32(1), u32(2)])),
    push(Buffer.alloc(32, 0x88)), push(Buffer.alloc(32, 0x99)),
    ...Array.from({ length: 15 }, () => [push(u64(0)), push(Buffer.alloc(32, 0x22))]).flat(),
    Buffer.from([0]),
  ]);
  return Buffer.concat([signatureHead(marker), ...(swap ? [contract] : []),
    ...(coin ? [Buffer.from([swap ? 0x51 : 0])] : []), ftPreTx(coin)]).toString("hex");
}

export function fixturePair({ coin = false } = {}) {
  const make = (producer, marker) => ({
    pin: PIN, producer, scenarios: SCENARIOS.map((name, scenarioIndex) => {
      const locked = name.includes("locked"), create = name.startsWith("create-");
      const context = assetContext({ coin, locked });
      const multi = name.includes("multi-round") || name.startsWith("simultaneous-");
      const merge = name.includes("merge") && !name.includes("no-merge");
      const count = create ? 2 : multi ? 3 : merge ? 2 : 1;
      const transactions = [];
      const finalizedParents = [];
      for (let index = 0; index < count; index++) {
        const role = index === count - 1 ? "primary" : create ? "prerequisite" : "maintenance";
        const seed = 1 + (scenarioIndex * 5 + index) % 240;
        const standalone = role === "maintenance" && (name.startsWith("ftlp-") || (name.startsWith("simultaneous-") && index === 1)
          || name === "remove-locked" || name === "close-locked");
        const lpFamily = locked ? "ftlp-locked" : "ftlp";
        const lpPair = () => context.parents[lpFamily].outputs.map((o) => ({ ...o }));
        const ftPair = () => context.parents["pool-held-ft"].outputs.map((o) => ({ ...o }));
        const poolPair = () => context.parents.pool.outputs.map((o) => ({ ...o }));
        let outputs;
        if (standalone) outputs = lpPair();
        else if (role === "prerequisite") outputs = poolPair();
        else if (role === "maintenance") outputs = [...poolPair(), ...ftPair()];
        else if (create || name.startsWith("add-")) outputs = [...poolPair(), ...ftPair(), ...lpPair()];
        else if (name.startsWith("swap-tbc-")) outputs = [...poolPair(), ...ftPair()];
        else if (name.startsWith("swap-token-")) outputs = [...poolPair(), output(p2pkh, "2000"), ...ftPair()];
        else outputs = [...poolPair(), ...ftPair(), output(p2pkh, "2000"), ...lpPair()];
        outputs.push(output(p2pkh, String(7000 + seed)));
        const families = role === "prerequisite" ? ["p2pkh"] : standalone ? [lpFamily, "p2pkh"]
          : role === "maintenance" ? ["pool", "pool-held-ft", "pool-held-ft", "p2pkh"]
            : name.startsWith("swap-tbc-") ? ["pool", "p2pkh", "pool-held-ft"]
              : create || name.startsWith("add-") || name.startsWith("swap-token-") ? ["pool", "ft", "p2pkh"]
                : ["pool", lpFamily, "pool-held-ft", "p2pkh"];
        const parentRaws = [...context.parentRaws];
        const spentParents = families.map((family, inputIndex) => {
          const planned = [...finalizedParents].reverse().find((p) => p.family === family);
          if (planned && ["pool", "ftlp", "ftlp-locked"].includes(family)) return planned.tx;
          const parent = structuredClone(context.parents[family]);
          // Distinct real parent outpoints for repeated Pool-held FT inputs.
          if (inputIndex > 1 && families.indexOf(family) < inputIndex) {
            parent.lockTime = inputIndex;
            parentRaws.push(fixtureSerialize(parent));
          }
          return parent;
        });
        const inputs = spentParents.map((parent) => ({ txid: fixtureTxid(parent), vout: 0, sequence: 0xfffffffe, script: "" }));
        const parsed = { version: 2, inputs, outputs, lockTime: locked ? 800000 : 0 };
        const unsignedRaw = serialize(parsed), signingRequests = [];
        for (const [i, family] of families.entries()) {
          if (family === "pool" && !(locked && name.startsWith("swap-") && role === "primary")) {
            inputs[i].script = push(Buffer.from([0xaa, 0xbb, seed])).toString("hex");
            continue;
          }
          const recipe = family === "p2pkh" ? { kind: "p2pkh" } : family === "pool" ? { kind: "pool-signed" }
            : { kind: family === "ft" ? "ft-transfer" : family === "pool-held-ft" ? "ft-swap" : family === "ftlp" ? "ftlp-transfer" : "ftlp-locked-transfer", version: 3, coin: family.startsWith("ftlp") ? false : coin };
          const suffix = family === "p2pkh" ? Buffer.alloc(0) : family === "pool" ? push(Buffer.from([0xaa, 0xbb, seed]))
            : parentSuffix(spentParents[i], family === "pool-held-ft", recipe.coin, 3);
          signingRequests.push(signFromParent(parsed, i, spentParents[i], recipe, role === "primary" ? marker : 1, suffix));
        }
        const dependencies = Array.from({ length: index }, (_, parent) => `${name}-${parent}`);
        transactions.push({
          templateId: `${name}-${index}`, stage: index, role, dependencies, auxiliaryParents: [...dependencies],
          publicIntent: role === "primary" ? name : null, unsignedRaw, finalizedRaw: serialize(parsed), parentRaws,
          changeIndex: outputs.length - 1, fee: "500", poolState: { reserveTbc: "300", reserveFt: "200" },
          reserveAndValueDeltas: { tbc: String(seed), ft: String(-seed) }, signingRequests,
          fieldLocators: { poolTape: { outputIndex: 1, offset: 0 }, ftSwapIndexTag: { outputIndex: 1, offset: 1 }, ftCoinFlag: { outputIndex: 1, offset: 2 }, ftlpLock: { outputIndex: 1, offset: 3 } },
        });
        finalizedParents.push({ family: standalone ? lpFamily : "pool", tx: structuredClone(parsed) });
      }
      return { name, capabilities: [...(count >= 3 ? ["multiple-maintenance", "ordered-auxiliary-parents"] : [])], transactions };
    }),
  });
  return [make("pinned-source", 1), make("production-core", 2)];
}

export const transaction = (evidence, name, role = "primary") => evidence.scenarios.find((s) => s.name === name).transactions.find((tx) => tx.role === role);
