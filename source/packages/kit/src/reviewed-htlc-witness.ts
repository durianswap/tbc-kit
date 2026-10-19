import { ripemd160 } from "@noble/hashes/ripemd160";
import { bytesToHex, hexToBytes, sha256Bytes } from "./network-bytes.js";
import { inspectHtlcCode } from "./htlc-material.js";
import { tbcAddressFromPublicKeyHash } from "./testnet-validation.js";

const FAILURE = "Invalid associated HTLC witness";
// Matches Engine's shared unlocking budget minus compressed signature/push overhead.
const MAX_PREIMAGE_BYTES = 65_535 - 111;

/** Preview-only refund constraints from an exact Code/witness pair. Caller
 * authenticates its parent; Engine independently checks the actual signer.
 * Claim templates/preimages are never decoded or copied by this helper. */
export function associatedHtlcRefundLock(script: string, template: unknown): number | undefined {
  if (typeof template !== "string" || template.length !== 90 ||
      !template.startsWith("097369676e617475726521") || !template.endsWith("00")) return undefined;
  let code: ReturnType<typeof inspectHtlcCode>;
  try { code = inspectHtlcCode(script); } catch { return undefined; }
  if (!/^[0-9a-f]{90}$/u.test(template) || !["02", "03"].includes(template.slice(22, 24))) throw new Error(FAILURE);
  const owner = bytesToHex(ripemd160(sha256Bytes(hexToBytes(template.slice(22, 88)))));
  if (owner !== code.senderHash || code.lockTime < 1 || code.lockTime > 0x7fff_ffff) throw new Error(FAILURE);
  return code.lockTime;
}

/** Public approval terms for one authenticated HTLC prevout. This helper is
 * not an authorizer: callers must bind the full request, authenticate prevouts,
 * and use the Engine's independent prepare/finalize checks before signing.
 * Secret bytes are borrowed locally and never returned, formatted or logged.
 */
export function inspectAssociatedHtlcWitness(input: Readonly<{
  scriptPubKey: string;
  unlockingScriptTemplate: string;
  accountAddress: string;
  addressVersion: number;
  sequence: number;
  transactionLockTime: number;
}>): Readonly<{ branch: "claim" | "refund"; preimageVerified: boolean; disclosureWarning?: string }> {
  const fail = (): never => { throw new Error(FAILURE); };
  const { sequence, transactionLockTime, unlockingScriptTemplate: template } = input;
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff ||
      !Number.isInteger(transactionLockTime) || transactionLockTime < 0 || transactionLockTime > 0xffff_ffff ||
      typeof template !== "string" || template.length > (44 + MAX_PREIMAGE_BYTES + 4) * 2 ||
      !/^(?:[0-9a-f]{2})+$/u.test(template) || !template.startsWith("097369676e617475726521") || template.length < 90) fail();
  const code = inspectHtlcCode(input.scriptPubKey);
  const publicKey = hexToBytes(template.slice(22, 88));
  if (publicKey.length !== 33 || (publicKey[0] !== 2 && publicKey[0] !== 3)) fail();
  const owner = bytesToHex(ripemd160(sha256Bytes(publicKey)));
  if (tbcAddressFromPublicKeyHash(owner, input.addressVersion) !== input.accountAddress) fail();
  const suffix = hexToBytes(template.slice(88));
  if (suffix.length === 1 && suffix[0] === 0) {
    if (owner !== code.senderHash || sequence === 0xffff_ffff || code.lockTime < 1 || code.lockTime > 0x7fff_ffff ||
        transactionLockTime > 0x7fff_ffff || transactionLockTime < code.lockTime ||
        (transactionLockTime < 500_000_000) !== (code.lockTime < 500_000_000)) fail();
    return Object.freeze({ branch: "refund", preimageVerified: false });
  }
  if (suffix.length < 2 || suffix.at(-1) !== 0x51 || owner !== code.receiverHash) fail();
  const push = suffix.subarray(0, -1), op = push[0]!;
  let secret: Uint8Array;
  if (push.length === 1 && op === 0) secret = new Uint8Array(0);
  else if (push.length === 1 && (op === 0x4f || (op >= 0x51 && op <= 0x60))) secret = Uint8Array.of(op === 0x4f ? 0x81 : op - 0x50);
  else {
    let width: number, length: number;
    if (op >= 1 && op <= 75) { width = 1; length = op; }
    else if (op === 0x4c && push.length >= 2 && push[1]! >= 76) { width = 2; length = push[1]!; }
    else if (op === 0x4d && push.length >= 3) { width = 3; length = push[1]! + 256 * push[2]!; if (length < 256) fail(); }
    else return fail();
    if (length > MAX_PREIMAGE_BYTES || push.length !== width + length) fail();
    secret = push.subarray(width);
    if (length === 1 && (secret[0] === 0x81 || (secret[0]! >= 1 && secret[0]! <= 16))) fail();
  }
  if (bytesToHex(sha256Bytes(secret)) !== code.hashlock) fail();
  return Object.freeze({ branch: "claim", preimageVerified: true, disclosureWarning: "HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE" });
}
