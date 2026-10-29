# TBC M of N multisig integration

`@tbc/kit/multisig` implements the address and transaction mechanism in
`tbc-contract` 1.7.3 `MultiSig` and the older mobile wallet. It is **not MuSig2**.
It keeps construction, external signing and finalization separate. The current
Flutter partner delivery does not include or enable this feature.

## Supported operations

| Kit operation | SDK or old wallet equivalent |
| --- | --- |
| `describe`, `decodeAddress`, `verifyAddress` | Address creation, validation, M/N, locking script and combine hash |
| `prepare` with `create` | `createMultiSigWallet`, including member Hold and group Tape outputs |
| `depositTbc` | `p2pkhToMultiSig_sendTBC` |
| `transferTbc` | `buildMultiSigTransaction_sendTBC`, to ordinary or multisig address |
| `mergeTbc` | Old wallet native UTXO maintenance |
| `depositFt` | `p2pkhToMultiSig_transferFT`, optionally depositing TBC in the same transaction |
| `transferFt` | `buildMultiSigTransaction_transferFT` |
| `mergeFt` | Old wallet FT UTXO maintenance |
| `review`, `sign`, `combine`, `verify`, `finalize` | Rebuilt-output approval data, detached signing, signature collection, threshold validation and SDK finalization |
| `signBatch`, `finalizeBatch` | SDK batch signing/finalization, with one local approval per participant for the batch |
| `exportProposal`, `importProposal` | Offline proposal exchange through files, QR framing or an optional coordinator |

The published policy is M=1–6, N=3–10 and M≤N. This is not a general Bitcoin
2-of-2 address factory. FT means the released old FT v3/v4 and legacy Coin
holder templates supported by SDK MultiSig, not all current TBC20, TBC721,
AMM or stablecoin administrator contracts. Unknown/new templates are rejected.
No asset minting/admin method is added by this module.

New groups default to canonical sorted compressed public keys, matching the
old Rust wallet. Use `keyOrder: "provided"` only to import the exact ordering of
an existing JavaScript SDK group. Verify the derived address against the saved
address; never silently sort an existing ordered group. An address encodes the
threshold and key count, not the full public keys; back up the group descriptor.

## Construction and signing

```ts
import { createMultisigClient } from "@tbc/kit/multisig";

const multisig = createMultisigClient(keylessEngine);
const descriptor = await multisig.describe({
  publicKeys: memberPublicKeys, requiredSignatures: 2,
});
const proposal = await multisig.prepare({
  chainId: "tbc:testnet",
  group: descriptor.group,
  maxFee: "10000",
  action: { type: "transferTbc", destination, amount: "1000000", inputs },
});
const transportText = await multisig.exportProposal(proposal);
// Each participant imports and approves the same proposal on their own wallet.
const checked = await multisig.importProposal(transportText);
const partial = await multisig.sign(checked, {
  publicKey: selectedAccountPublicKey,
  approve: showNativeMultisigReview,
  signDigest: vaultSignDigest,
});
const signatures = await multisig.combine(checked, partial, otherParticipantSignatures);
const progress = await multisig.verify(checked, signatures);
if (progress.complete) {
  const { txraw, txid, fee } = await multisig.finalize(checked, signatures);
  // Return to the existing explicit broadcast/reconciliation owner.
}
```

`keylessEngine` uses the current Rust C ABI or matching WASM. Older frozen
engines do not support the new operations. Rust receives **no private key**.
The signer receives a digest32 and returns either low-S compact `r||s` (64 bytes)
or strict DER plus `0x41` (`SIGHASH_ALL|FORKID`). Do not prefix or hash the digest
again. Recovery ID is not used. Public keys must be compressed lowercase hex.

Amounts and fee ceilings are decimal strings in atomic units. No float or
human-decimal conversion happens inside the builder. Fee calculation sizes
the complete maximum-length witnesses before signing, with the existing
80 atomic/kB rule and SDK-style 80/1000 atomic operation floors. It does not
sign repeatedly to estimate fees. Dust is 42 atomic.

For group FT spends, `publicKey` identifies a group member supplying the FT
contract-helper signature; M group signatures are separately required for
funding. The helper may be one of those M members. Group funding must be at
output 0, as required by the released witness; use explicit `mergeTbc` first
when necessary. Native merge accepts at most 1000 inputs, FT at most 5.

## Approval and proposal binding

`prepare` returns an immutable proposal containing the network, group, action,
selected inputs, transaction, fee and signing digests. Import, signing and
finalization rebuild and bind all these fields. Changes to recipient, amount,
key order, fee or network require a new proposal and approvals. Invalid,
duplicate or wrong-proposal signatures cannot satisfy the threshold.

Each wallet displays its own native approval UI. It must show the checked
network, group/threshold, asset identity, recipients, amounts, fee and local
signer role. It must authenticate the selected account, network and input
material before approving. The proposal hash binds data; it does not prove an
input exists or remains unspent. There is no new Provider permission grant or
automatic routing of existing `window.Turing` methods in this change.

`review(proposal)` returns `{proposal, review}` from the shared Native/WASM
`reviewMultisig` operation. `sign` passes this review as the second argument to
`approve`; `signBatch` passes one review per proposal as its second argument.
This replaces the existing signing inspection, not an additional network read
or a second reconstruction. The matching updated Engine is required; there is
no fallback to an incomplete or caller-supplied summary.

Render every `review.outputs` entry, including change, member Hold deposits,
metadata and any TBC carried by a token contract. Each entry names its actual
output indexes, asset family, exact atomic amount and full recipient. FT and
legacy stablecoin are distinct families. `assetIdentity` is the authenticated
locking-code fingerprint, **not** the API origin transaction/contract ID or a
trusted ticker. Optional ticker/decimal metadata must be separately bound to
that asset; when unavailable, show exact smallest units instead of guessing.
The list includes change: do not label its total as the amount spent.

Use a scrollable, non-truncating native view with all transactions and full
addresses accessible before the single batch approval. Show the network,
group, M-of-N threshold, local signer, per-transaction fees and batch total.
There must be no enabled approval path when output classification fails.
The client snapshots and recursively freezes both proposals and review data
across the asynchronous approval boundary; changing the caller's array or
objects after review cannot change the signed digests. Finalization validates
signatures against the exact proposal again.

These checks prevent hidden replacement, not social engineering. A valid
transaction can deliberately pay an attacker; the wallet must not call an
unknown recipient safe merely because the transaction validates. Independent
batch transactions can be broadcast separately, so a batch is **not an atomic
exchange or an all-or-nothing settlement**. Display this warning; use an
appropriate atomic protocol when counterparty settlement depends on it.

`signBatch` allows up to 32 independent proposals under one network and group.
It rejects repeated proposals and inputs before approval. Each participant
approves their batch once, then signs the bound digests. Parent-child workflows
whose txid depends on future signatures need a new child proposal after parent
finalization; this batch API does not pretend those digests are known early.

## Data loading and exchange

`createMultisigMaterialLoader({chainId, api, engine})` uses the existing public
API client and an explicit network configuration. `nativeInputs` is a bounded
selection, not an assertion about the full wallet balance. `tokenInputs` loads
the group FT selection. For a legacy Coin, pass
`tokenInputs({group, contractId, asset: "legacy-stablecoin", funding})` to use
the stablecoin API directly, without probing the FT endpoints. `resolveToken`
also accepts a caller-selected ordinary
FT input list for deposits. It loads only the direct parents and ancestors
required by the SDK witness, deduplicates shared transaction reads inside that
call, and reuses supplied immutable funding raw after checking its txid.
UTXOs are not cached across operations. There is no origin-history scan,
background polling, hidden merge, automatic funding or repeated broadcast.

The existing `api.multisigAddress` can discover indexed group data. Re-derive
and compare the address before accepting any returned participant list.
Descriptor and proposal files contain public transaction data, but can reveal
balances and transaction intent: transport them privately where appropriate.
Large FT proposals require a file or multipart QR, not a promise that every
proposal fits one QR. A backend/coordinator may relay these objects but is not
required to authorize or produce the transaction.

## Verification and release scope

Run `TBC_CONTRACT_ROOT=/path/to/tbc-contract npm run check:multisig` with the
audited 1.7.3 source. The gate checks real Rust C ABI/WASM parity, SDK
finalization, independent JavaScript script VM execution, negative cases,
single approval, duplicate-read budgets and the production no-private-key
boundary. Fixed public test keys and synthetic funding are used offline.

These checks are **not real-chain broadcasts or iOS/Android wallet UI
acceptance**. The local multisig candidate does not replace any frozen
delivery. Its native resource identity and supported targets must be checked
separately from a wallet's existing Engine installation.
