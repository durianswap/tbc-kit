# Offline fungible contract recognition

```ts
import { identifyTbcFungibleContracts } from '@tbc/kit';

const identities = await identifyTbcFungibleContracts([
  { codeScript, codeSatoshis: 500, tapeScript, tapeSatoshis: 0 },
], { engine: existingKeylessEngine });
```

The root, React Native root and `/wallet` source entries export the same helper. It requires a caller-supplied keyless Native/WASM engine; it never fetches, creates an Engine, asks for an account, approves, signs or broadcasts. Wallet-built DApps do not need this helper or an Engine merely to call a wallet.

The caller supplies an adjacent Code/Tape pair from already acquired transaction material. The helper uses existing Rust exact-template codecs, snapshots before awaiting and deduplicates identical pairs within a maximum 256-item call. Results keep the original input order. No persistent or cross-network cache is introduced.

Result fields distinguish:

| Field | Meaning |
| --- | --- |
| `family` | `tbc20` or `tbc20Stablecoin`, the public business family |
| `generation` | `current` or `historical` |
| `protocol` | Exact classifier identity: `tbc20-standard`, `tbc20-stablecoin`, `legacy-ft`, `legacy-tbc20` or `legacy-stablecoin` |
| `protocolVersion` | Recognized implementation version, not an automatic support promise |
| `standardId` | Present for current templates only; old assets are not relabeled as current |
| `codeIdentity` | SDK SHA256 midstate plus ScriptNum Code length; not a txid, contract ID or ordinary SHA256(Code) |
| `balanceRaw` | Exact decimal integer from the supplied Tape, in minimum units |
| `verification` | `exact-template`, not complete transaction verification |
| `assetIdentityVerified` | Always `false` at this recognition-only boundary |

`null` means unrecognized. It must not be treated as ordinary TBC, safe-to-sign or a signal to retry another execution path. A recognized template with invalid Tape/value fails the call; it does not downgrade to a historical implementation.

Recognition alone does not authenticate the supplied parent, asset origin/ancestry, current UTXO status, owner, permission, allowed operation, fees or consensus validity. In particular, a template being recognizable does not mean this release has a builder for every historical version. The shared planner, policy, wallet-side verification and Signer binding remain mandatory.

NFT/Pool/LP recognition and automatic business routing are not provided by this fungible helper. Use the corresponding asset business interfaces for those operations. No API/indexer compensation or new remote version query is introduced.
