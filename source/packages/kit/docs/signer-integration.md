# Signer integration

Kit constructs and validates transactions without accepting private keys. Your
wallet or backend supplies an approved, account-bound Signer. Importing Engine
does not automatically add algorithms to an existing Vault, HSM or MPC service.

## Exact task profiles

Dispatch on **both** `task.algorithm` and `task.signatureEncoding`:

| Algorithm | Encoding | Result |
| --- | --- | --- |
| `secp256k1-ecdsa-sha256d` | `compact64` | low-S `r32 || s32` |
| `secp256k1-recoverable-ecdsa-sha256d` | `compact65-recoverable` | `(31 + recoveryId) || r32 || s32` |
| `secp256k1-schnorr-bip340` | `schnorr64` | BIP340 64-byte signature |

The digest is already a 32-byte signing digest. Do not hash it again, reverse it,
add an Ethereum prefix, or append DER/sighash bytes. Engine handles transaction
encoding. ECDSA and Schnorr are different algorithms despite sharing secp256k1
and sometimes the same result length. Do not guess the algorithm from length.
Schnorr does not use ECDSA low-S normalization or a recovery header. Native
signer ABI tags are 64, 65 and **164** respectively; 164 still returns 64 bytes.

Current Coin creation can start with ECDSA tasks and return additional ECDSA
and BIP340 tasks through finalize continuation. TBC/TBC20 transfer or creation
success alone does not verify Coin administrator signing. Continue under the
same approved operation; do not prompt for each task or manufacture a new grant.

## Connect your custody

1. Choose the key only from the approved task account and authorized role.
   A DApp-supplied public key is not authority to choose a key.
2. Recheck the existing approval, account/session revision, expiry and unconsumed
   task immediately before the actual private operation, including after an
   asynchronous password/biometric unlock. Keep current Kit binding checks.
3. Select the exact algorithm/encoding above in your existing secure executor.
   An EVM `r,s,v` callback covers ECDSA only; it does not implement Schnorr.
4. Return the original `taskId`, requested `signatureEncoding` and hex signature.
   Let Kit perform its existing signature verification and finalize checks.
5. For an unsupported profile return a non-retryable
   `{ portError: { name: 'SIGNATURE_FAILED', retryable: false,
   message: 'Unsupported signing algorithm or encoding' } }`.
   Never silently substitute ECDSA or forward raw Vault exceptions to the page.

Do not add chain queries to Signer, reconstruct the transaction there, or turn
each signing task into another approval. Material preparation/prefetch remains
in Kit. Multi-role Coin/Pool operations require separately authorized accounts;
one available account does not authorize an unrelated administrator.

## Runnable examples

From a clean package installation:

```sh
node node_modules/@tbc/kit/examples/shared/check-signer.mjs
node node_modules/@tbc/kit/examples/independent-wallet/run.mjs
node node_modules/@tbc/kit/examples/backend-node/run.mjs
node node_modules/@tbc/kit/examples/sign-in/run.mjs
```

These examples share `examples/shared/controlled-signer.mjs`. Keep that directory
when copying an example. It uses public fixtures and is not a production Vault;
do not put funds on those accounts or copy their automatic test approvals.
The checker verifies all three profiles, the official BIP340 vector, malformed
algorithm/encoding pair rejection and changed-digest rejection without any GET
or POST. Also test your actual custody adapter with public fixtures, then the
business operations you expose; testing the sample does not test your Vault.

The sign-in example deliberately exposes only message/typed-data methods. The
older `source/examples/third-party-wallet-minimal` is a TBC transfer harness,
not an all-contract signer. Swift/Kotlin and WASM signer primitives already
provide the three encodings; their caller must preserve custody and approval.
The standalone Native **Engine** SDK is keyless, not a replacement for Signer.
Flutter's selected business profile and native custody adapter are separate
from the full JS Kit profile; do not infer administrator support merely from
the underlying cryptographic kernel. The frozen Flutter delivery is unchanged.

## Troubleshooting

Record package/platform versions, method, failing Port operation, error code,
and task algorithm/encoding (no signatures or secrets). Distinguish refusal,
unsupported algorithm, material error and unknown broadcast outcome. Read
existing journals/receipts before retrying; no new broadcast is required to
diagnose an algorithm mismatch.
