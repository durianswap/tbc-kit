# Rust MultiSig testnet verification — 2026-08-01

This document records the public evidence for the Rust SDK MultiSig live test. It intentionally does not contain the test private key, raw transactions, or signatures.

- Network: TBC testnet
- API: `https://api.tbcdev.org/api/tbc/`
- Reviewed runner commit: `ef09744`
- JavaScript preflight: `tbc-contract` 1.6.5 with `tbc-lib-js` 1.0.31
- Dependency mode: zero confirmation; no block-confirmation wait
- Broadcast policy: every transaction was fully built and every input was preflighted before the first POST; each transaction then received exactly one POST in dependency order, with no POST retry

## Accepted transactions

| # | Operation | Transaction ID | Bytes | Fee paid (sat) | Fee target (sat) | Parent transactions verified |
|---:|---|---|---:|---:|---:|---:|
| 1 | `multisig_ft_source` | `470a167abf80f72d94ef0f43a05b590bc85c490dff6c374fb27fd7bf630b32d8` | 328 | 80 | 80 | 1 |
| 2 | `multisig_ft_mint` | `c8ee549fdf6e266ecd00db5a932d4a6e8928623a99596e5fe316f24330b6aa02` | 2177 | 175 | 175 | 1 |
| 3 | `multisig_wallet_create` | `c2c957bbbc6072c3d4bd35a1897fdc06b3548411e068d491bbc3066d8e559fd0` | 662 | 80 | 80 | 1 |
| 4 | `p2pkh_to_multisig_tbc` | `c721cca3b6df1a4871eadb7537452c1f37dff5182de4787ba9ceeadfdc3250a6` | 241 | 80 | 80 | 1 |
| 5 | `multisig_to_p2pkh_tbc` | `b44bea1f8f4aa4fbf102d89e6f01e693550cb2331432ef1380abd934dd026d79` | 383 | 1000 | 80 | 1 |
| 6 | `multisig_to_multisig_tbc` | `553cf19428345b9df83b107beccf62fd1925d87b0289ada679c21da1908b65eb` | 397 | 1000 | 80 | 1 |
| 7 | `p2pkh_to_multisig_ft` | `8c3f2a325677b9ab80945838b2f9fabc9ec0363a0229faece5d1ba6c33cb2f04` | 5204 | 417 | 417 | 2 |
| 8 | `multisig_to_p2pkh_ft` | `b5ed186e4e64458468aad5ca9442d90e41f27bb54879e43f813437f59065b0b5` | 5957 | 2000 | 477 | 2 |
| 9 | `multisig_to_multisig_ft` | `0bca442dd37c7f113c09df1971f116d84e57e817035cd4af4ab0d83d90ef2c38` | 5998 | 2000 | 480 | 2 |

The target fee is `max(80, ceil(serialized_bytes * 80 / 1000))`. A paid fee above the target is valid and results from deliberately selected whole UTXOs rather than introducing an extra change output into the contract flow.

## Post-broadcast verification

After all nine POSTs were accepted, the runner fetched every transaction and all referenced parent transactions, parsed their canonical serialization, checked the locally computed transaction ID, and recomputed input value, output value, and paid fee.

An independent read-only audit then fetched every transaction twice and established all of the following for all nine transactions:

- both fetched raw serializations were identical;
- the canonical parse produced the recorded transaction ID;
- every referenced parent output existed and was spendable by the corresponding input;
- input and output sums were in range and the recomputed fee met the target shown above.

No block confirmation was requested or awaited. Transactions 2–9 exercised the intended zero-confirmation dependency chain.

## Reproducibility fingerprints

- `tests/fixtures/multisig-js-165.json`: `c5cb7277d4d13cf4a577606d96628a517ddffbefc5613ddee9cd693ec875a7b2`
- `scripts/verify-multisig-inputs.js`: `590eb01fb5b6e4bf6cd8aa6a288be0e5e7a00b5438d70142c85af6bc2f357a77`

The JavaScript preflight child process was launched with the WIF removed from its environment. Failure output is designed not to include raw transactions, signatures, or key material.

## Reverification — 2026-08-03

Candidate commit `043c58f` was reverified with a separately supplied testnet key. The key was provided through non-echoing stdin, existed only in the runner environment, and was not printed or persisted.

| Operation | Transaction ID | Bytes | Paid/target (sat) |
|---|---|---:|---:|
| `multisig_ft_source` | `1cbde8193d5f3e50fbbb7d298e14d4a41d4dbab4ba0c11b28ff0691407b78724` | 328 | 80/80 |
| `multisig_ft_mint` | `43792faf1fc8d706a32c8f09007a084242d92550779cca813e6cb585d704f2fc` | 2177 | 175/175 |
| `multisig_wallet_create` | `19702e45eac1a4b01af447a8652970e12d1910b41967def89e7f99d9925e187c` | 663 | 80/80 |
| `p2pkh_to_multisig_tbc` | `ad9d3ffaa3eb14ef56ecf4836fe4c05cd4a225e2ae021b63952a758dea9cc4a4` | 242 | 80/80 |
| `multisig_to_p2pkh_tbc` | `a7215f96e880595af68a4aac4bbba4fcf4e54600111beb476448b190571a6091` | 382 | 1000/80 |
| `multisig_to_multisig_tbc` | `63b3392a6df17e44767726a72a5e7ef6fda57bb0a8bc02600e235fd8e84de41e` | 398 | 1000/80 |
| `p2pkh_to_multisig_ft` | `d4ac55ea36dc10519ff18386297fd635ac79063c14d285aa562b3e7f81ae1efa` | 5204 | 417/417 |
| `multisig_to_p2pkh_ft` | `b1a648019042039cdb62b872a86077144efb44816912ea53193521d9644e5ef9` | 5958 | 2000/477 |
| `multisig_to_multisig_ft` | `c72bed03dfe003f71d1c8613b72fc4071be9bba0b45e05b6bb2575de81b66cbb` | 5996 | 2000/480 |

All nine transactions were built and preflighted before the first POST, accepted with one POST per row, refetched byte-for-byte, and parent/fee verified by the runner.
