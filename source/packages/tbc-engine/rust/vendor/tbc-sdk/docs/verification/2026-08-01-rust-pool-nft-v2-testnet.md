# Rust Pool NFT v2 testnet verification — 2026-08-03

This document records public evidence for the Rust SDK Pool NFT v2 live test. It intentionally excludes the test private key, raw transactions, signatures, and ephemeral locked-Pool private keys.

- Network: TBC testnet
- API: `https://api.tbcdev.org/api/tbc/`
- Broadcast runner commit: `d965a8b`
- JavaScript preflight: released `tbc-contract` 1.6.5 interpreter with released `tbc-lib-js`
- Dependency mode: zero confirmation; no block-confirmation request or wait
- Broadcast policy: exactly one POST per row; ambiguous POST results may only be reconciled by GET
- Matrix: 14 standard Pool rows + 12 locked Pool rows = 26 accepted Pool transactions

## Accepted transactions

| # | Operation | Transaction ID | Bytes | Fee paid (sat) | Fee target (sat) | Inputs/parents verified |
|---:|---|---|---:|---:|---:|---:|
| 1 | `pool_ft_source` | `f3acc2e4c50e22f60b4ad1a900ff7f74a7a94f55303c1facdc7e21179694d965` | 328 | 80 | 80 | 1 |
| 2 | `pool_ft_mint` | `4e9cdc5a074a404792c980b99a746dda343fb04ebd3ecf5782f9749066ff102d` | 2177 | 175 | 175 | 1 |
| 3 | `pool_source` | `4e1cff7efda660295813c8a6186358add45794720a4a0702a946d5df62164c86` | 243 | 80 | 80 | 1 |
| 4 | `pool_mint` | `0651f69407ff7687f0ec4ea8daec639f9672fcc99fe5a177a4bffbf9530bfdb5` | 3644 | 292 | 292 | 1 |
| 5 | `pool_init` | `2f11e1a7340704c3aafb1e1b9154d8bc5ba2dc182d75010a56a2fcf23ecfa84b` | 12733 | 1019 | 1019 | 3 |
| 6 | `pool_increase_lp_1` | `56b8cc43f170fb0cd5e243cd07ba67989ed3149f6fb097dd88854f0a8b41a8d0` | 13965 | 1118 | 1118 | 3 |
| 7 | `pool_increase_lp_2` | `351fdb8a740df14d4094151d21ee291e8b8c4e97f2cd9f2b86671dbdd4049546` | 14446 | 1156 | 1156 | 3 |
| 8 | `pool_swap_tbc_to_ft` | `63a022938af5a34b60c0852599363acfb2ced0ad4d5fafd06d6b09a59442cb98` | 12538 | 1004 | 1004 | 3 |
| 9 | `pool_swap_ft_to_tbc_online` | `6d832ac1f1a5fad7babd807bc0014def7a29f5b6550874aad33b00bc1201d890` | 11971 | 958 | 958 | 3 |
| 10 | `pool_swap_ft_to_tbc_local` | `4213e371197401354b4d1654fc28d5e5a633c56012e2efe2baddbdedc9802683` | 11969 | 958 | 958 | 3 |
| 11 | `pool_consume_lp` | `103f1d5a48709304839bf9ae680e0cb94041b0d3fb8b2eaec6cebad9431837f0` | 19771 | 1582 | 1582 | 4 |
| 12 | `pool_merge_ftlp` | `1fbf8fb8bebf776f5e4b43ff796abb8f04d244ae66b20932fb9ba6bfbf3a09ab` | 5105 | 409 | 409 | 3 |
| 13 | `pool_burn_ftlp` | `a0107469ebdb28220916dcf550b45ebbbd26e3f1ab1338a585dc8dbc27ec5a43` | 3878 | 311 | 311 | 2 |
| 14 | `pool_merge_held_ft` | `75c0ea234f63bdd45334892ca3e95e9e810f1c19136504203b408ce267b08e78` | 13160 | 1053 | 1053 | 4 |
| 15 | `locked_pool_source` | `764d49622648344b58d046b11763ce91feea8311d3df00e33a6e9871b2bc78d7` | 244 | 80 | 80 | 1 |
| 16 | `locked_pool_mint` | `bf9ba0e1dba255fa1b3e7e03a59b5a4aa755df2165dfdf3c4f984de5d7314639` | 3831 | 307 | 307 | 1 |
| 17 | `locked_pool_init_lock_time` | `0cf136698f44309af1847c33cdf10a613956e0de7328eb99fc75ba0b87972742` | 13740 | 1100 | 1100 | 3 |
| 18 | `locked_pool_increase_lp` | `4acd64db12dd70e0454473bb3fd6af8e5b1dcfdf4cd44e9a5d3a2234bb674143` | 14496 | 1160 | 1160 | 3 |
| 19 | `locked_pool_swap_tbc_to_ft` | `cf6854d9590342a8a826054e58876b89f63c09af5bbbde03a02b4c99b7e27c73` | 13186 | 1055 | 1055 | 3 |
| 20 | `locked_pool_swap_ft_to_tbc` | `398126da6d8b199fc02609105d6ec4330d1abc4c9be0e9daf7b99bf0e05c781c` | 12300 | 984 | 984 | 3 |
| 21 | `locked_pool_merge_expired_ftlp` | `5f47cee36e8bed878892a69ae08611a997ba582a7a709997c0bee9a3e9e7389c` | 4893 | 392 | 392 | 3 |
| 22 | `locked_pool_increase_after_merge` | `6d078c01401785759c7e8c3d2026578614cb408f5cfc323d63badfb3c5d70c16` | 14458 | 1157 | 1157 | 3 |
| 23 | `locked_pool_unlock_mixed_ftlp` | `95039ac55ca6089f5f9d158e6a3de2a2fe2c712b3d98fc55bc8aacf90476a7a6` | 5378 | 431 | 431 | 3 |
| 24 | `locked_pool_consume_unlocked_ftlp` | `78a0e1454ca5bd2d0a9177f06ef9c5becd2be15b35e6c94baf01d3ae373e6ef0` | 20024 | 1602 | 1602 | 4 |
| 25 | `locked_pool_burn_remaining_ftlp` | `55eeca20eb4dc9f333da344bfe31e37af9372e5aae91ee814b7dbee1c56a5dbe` | 3559 | 285 | 285 | 2 |
| 26 | `locked_pool_merge_held_ft` | `2fb4e61444f7e3309f681a211ce769cf7d0fffc12df15afdc2850ff139aceac9` | 13537 | 1083 | 1083 | 4 |

The fee target is `max(80, ceil(serialized_bytes * 80 / 1000))`. Every accepted row met its target exactly.

## Broadcast-time checks

Before each POST, the Rust runner executed the released JavaScript 1.6.5 interpreter against every contract input and its exact parent/grandparent context. After each POST it fetched the accepted raw transaction and all referenced parents, required local/remote byte and transaction-ID identity, and recomputed its fee from parent outputs. The online standard FT-to-TBC row was built through the indexed online facade and had to match the deterministic local transaction byte-for-byte; the following row exercised the explicit local facade.

The runner also checked indexed Pool state and exact FTLP outpoints throughout both chains. Standard Pool state used provider `rust-pool`; locked Pool state used provider `rust-pool-locked`. Presence checks bound FTLP txid, vout, locking script, satoshis, and Tape balance. Absence checks required the exact spent outpoint to disappear. The final locked Pool state matched row 26 and the final owner FTLP query was empty.

The locked lifecycle used three distinct canonically sorted public keys, a three-key single-signature allowlist containing the approved owner key and two ephemeral in-memory keys, an 81-byte released lock-time Tape, and a lock height obtained from current testnet height minus two. No private key other than the approved funding key existed outside process memory, and none is recorded here.

## Independent read-only audit

After the broadcaster exited, a separate GET-only audit fetched every accepted transaction twice and fetched every referenced parent transaction. It made 78 raw-transaction GETs: 52 subject refetches plus 26 cached unique-parent refetches. Both subject copies were identical; the released JavaScript transaction parser reproduced every recorded txid and canonical serialization. All parent vouts existed. The independently recomputed sums were:

| # | Input sum (sat) | Output sum (sat) | Paid/target (sat) |
|---:|---:|---:|---:|
| 1 | 584120797 | 584120717 | 80/80 |
| 2 | 9900 | 9725 | 175/175 |
| 3 | 584110817 | 584110737 | 80/80 |
| 4 | 9800 | 9508 | 292/292 |
| 5 | 584102437 | 584101418 | 1019/1019 |
| 6 | 584100418 | 584099300 | 1118/1118 |
| 7 | 584098300 | 584097144 | 1156/1156 |
| 8 | 584096144 | 584095140 | 1004/1004 |
| 9 | 584094640 | 584093682 | 958/958 |
| 10 | 584092633 | 584091675 | 958/958 |
| 11 | 584091465 | 584089883 | 1582/1582 |
| 12 | 584072642 | 584072233 | 409/409 |
| 13 | 584072233 | 584071922 | 311/311 |
| 14 | 584087647 | 584086594 | 1053/1053 |
| 15 | 584070869 | 584070789 | 80/80 |
| 16 | 9800 | 9493 | 307/307 |
| 17 | 584062489 | 584061389 | 1100/1100 |
| 18 | 584060389 | 584059229 | 1160/1160 |
| 19 | 584058205 | 584057150 | 1055/1055 |
| 20 | 584056650 | 584055666 | 984/984 |
| 21 | 584046690 | 584046298 | 392/392 |
| 22 | 584054672 | 584053515 | 1157/1157 |
| 23 | 584043641 | 584043210 | 431/431 |
| 24 | 584053060 | 584051458 | 1602/1602 |
| 25 | 584040608 | 584040323 | 285/285 |
| 26 | 584049116 | 584048033 | 1083/1083 |

This audit did not have a broadcast path or access to the WIF. Its fee verdict was 26/26 present, canonical, fully parent-resolved, and at or above target.

A second independent Rust SDK auditor then made 97 GET requests: 26 accepted raws, 68 per-input parent raws, two Pool-info queries, and one final FTLP query. It independently reproduced the same per-row byte lengths and value sums above. It found two valid Pool v2 `2Code`/`NTape` chains with continuous input-0 state ancestry, 29 valid FT Code/Tape pairs, and 15 valid FTLP Code/Tape pairs. Its state and marker results were:

- Standard Pool contract `0651f69407ff7687f0ec4ea8daec639f9672fcc99fe5a177a4bffbf9530bfdb5` ended at row 14, txid `75c0ea234f63bdd45334892ca3e95e9e810f1c19136504203b408ce267b08e78`, vout 0, version 2, provider `rust-pool`, fee rate 35, LP plan 2, with LP/FT/TBC reserves `14000/13781/14222`.
- Locked Pool contract `bf9ba0e1dba255fa1b3e7e03a59b5a4aa755df2165dfdf3c4f984de5d7314639` ended at row 26, txid `2fb4e61444f7e3309f681a211ce769cf7d0fffc12df15afdc2850ff139aceac9`, vout 0, version 2, provider `rust-pool-locked`, fee rate 35, LP plan 2, with LP/FT/TBC reserves `6899/6530/7289`.
- The standard chain had both lock flags clear; the locked chain had public-key locking and FTLP lock-time enabled.
- The expired testnet lock height was `832820`. Rows 17, 18, and 22 carried exact 81-byte FTLP Tapes with that lock height. Rows 21, 23, and 24 carried unlocked height zero. Row 25 correctly used an FTLP eater Code with the released 81-byte authority-format burn Tape, which is not a lock-time Tape.
- The expired merge and mixed unlock transactions used `nLockTime=832820` with the relevant non-final input sequences. Row 24 genuinely spent row 23's unlocked FTLP with `nLockTime=0`; row 25 genuinely spent row 24's remaining FTLP.
- The final locked owner FTLP endpoint returned `utxos: null`; the SDK normalized this to the required empty set.

The standalone auditor contained no POST route and never loaded the WIF. The successful audit pass performed 97 GETs and zero POSTs.

## Combined verification count

The Rust MultiSig testnet matrix records 9 accepted broadcasts in `2026-08-01-rust-multisig-testnet.md`. Together with these 26 Pool NFT v2 broadcasts, the combined real-broadcast matrix is **35 accepted transactions**.

## Reverification — 2026-08-03

Candidate commit `043c58f` was reverified with a separately supplied testnet key. The key was provided through non-echoing stdin, existed only in the runner environment, and was not printed or persisted.

| Operation | Transaction ID | Bytes | Paid/target (sat) |
|---|---|---:|---:|
| `pool_ft_source` | `e990b1ecf1eb49c07a5f08bbc8ab84325e72308bda2c87663728e0e4d38a2695` | 328 | 80/80 |
| `pool_ft_mint` | `5ccdabe9a7a24907578e0fa3c75750ef73745eb95fe2cc7b57f6200bcd555213` | 2175 | 175/174 |
| `pool_source` | `b3068fb345b2d810f150320246dfc4f59fa4e8bf29c8330e839aec6830cd8677` | 243 | 80/80 |
| `pool_mint` | `0fd22b793774017850b111dbd8146b11f9949efba62f1173561f79a0582ab38b` | 3644 | 292/292 |
| `pool_init` | `7137d5b641c858330f6e81ef7ecbc0ce7f1ada9a6c8641e97f94e85e390acae5` | 12734 | 1019/1019 |
| `pool_increase_lp_1` | `0dda263a9a13141bae88abe9ffee861a459740dc43dfe13b49f36846c9aef6b7` | 13965 | 1118/1118 |
| `pool_increase_lp_2` | `cc8d3e764e05e6f25c87fbe9828fdfbb12f157473a03b6c637de210a6168677a` | 14446 | 1156/1156 |
| `pool_swap_tbc_to_ft` | `401284263b615a0076f10b0b195d6d60474c1458f78634066fb37f6d72eec12c` | 12538 | 1004/1004 |
| `pool_swap_ft_to_tbc_online` | `22ce3de50bbc7600ab7e63c4284b86f4b864c5b06ca5aa4a150b0c5778087794` | 11971 | 958/958 |
| `pool_swap_ft_to_tbc_local` | `264ccea788f0a8f63f7a62a34a4ecb8a18faabb91617e22c8dfd93eea7e38e33` | 11970 | 958/958 |
| `pool_consume_lp` | `9e169ef55697c443c1744be13c9c64e5ff90469e09b2acde72af939a494b16fd` | 19773 | 1582/1582 |
| `pool_merge_ftlp` | `4d948ec078d99155fcfe27e3be676a2052477b544e379f47c3a8d9f1c4d4b45c` | 5106 | 409/409 |
| `pool_burn_ftlp` | `018b1b869c9a04841841ec087ea089f05a46f5beee139d5dca278ba19e5fa818` | 3878 | 311/311 |
| `pool_merge_held_ft` | `b25dbba01862143e086e4953cd77a4c7ed9f11632527f1b4da9dd4ac99d4d609` | 13159 | 1053/1053 |
| `locked_pool_source` | `f90522d834c1d69f8328d7a818d365a173385ac196a9d430b829658e0f64146c` | 244 | 80/80 |
| `locked_pool_mint` | `bc70a6aa95d3995cf3ee7c7873bbf910ab8238f354a2fe1e0d6f970cc5c13595` | 3831 | 307/307 |
| `locked_pool_init_lock_time` | `11ebb0a9b9a5aea5d76a38c29e042a8a03793faa1e7f5014e2298e50eb5f7853` | 13742 | 1100/1100 |
| `locked_pool_increase_lp` | `ef8acdc26a9ad7177f92d6ed354ac698b93c6d56509840ef7b7e4d0a440ef7d1` | 14498 | 1160/1160 |
| `locked_pool_swap_tbc_to_ft` | `85f0b78ee700495161bd2b6775ba24838983d906c74c947a1635c2ec24d5403b` | 13186 | 1055/1055 |
| `locked_pool_swap_ft_to_tbc` | `a2484add710fefab22caf6df8025137c963c2e37ad72de6814c63fc59f3ca53b` | 12298 | 984/984 |
| `locked_pool_merge_expired_ftlp` | `6ecf0cb60d430cde0b2199d6750f5fc2c235eceb121b67a3af6e43236f1d6d05` | 4894 | 392/392 |
| `locked_pool_increase_after_merge` | `00ca4af3b3c230c798d8d713955c316dff740bb2320d4596b725731f89f52cc7` | 14457 | 1157/1157 |
| `locked_pool_unlock_mixed_ftlp` | `b89323eae3dbf53f3873d80f99d3ae077cdfd8ae0febfa344c14121f11a100cb` | 5378 | 431/431 |
| `locked_pool_consume_unlocked_ftlp` | `3a2bc27a6325b4bc9ec4f8b1b3cc3ee15f7c43c2b2b3ca86f7c7cc3dd8989571` | 20024 | 1602/1602 |
| `locked_pool_burn_remaining_ftlp` | `2f64f276f6c8e67693eb189afc1e9e4d0e6fd6be94cd5d604cefb829431618cd` | 3560 | 285/285 |
| `locked_pool_merge_held_ft` | `1ed318a4e11e03d8440e4ab777fed042d6bbf6372e36f7025142a56fa9533c4c` | 13539 | 1084/1084 |

All 26 Pool transactions were accepted and runner-verified. A separate process with no private key and no POST route then audited the combined 35 MultiSig/Pool transactions: 35/35 double-fetch byte identity, 35/35 canonical txids, and 35/35 fully resolved parents with paid fee at or above target. The independent audit made 103 GET requests and zero POST requests.

## Static verification

At runner commit `d965a8b`, all mandatory gates exited zero:

- `cargo fmt --check`
- `cargo test --all-targets` (252 library tests, 28 Pool live-flow tests, and all other example targets)
- `cargo clippy --all-targets -- -D warnings`
- `node scripts/generate-pool-v2-js-fixtures.js | cmp - tests/fixtures/pool-v2-js-165.json`
- `git diff --check`
