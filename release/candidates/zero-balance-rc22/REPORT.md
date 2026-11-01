# rc.22 zero-balance holder selection report

## Result and scope

Source fix and controlled, clean-installed package verification are complete. No real account was signed, no real transaction was broadcast, and no previously successful transaction was replayed. Published rc.21 and the current partner distribution remain unchanged.

The original failure was treating every indexed holder output as positive-balance funding. Valid zero-token Code/Tape outputs can exist (for example a zero-fee order matching output with 500 atomic native value). They must not poison automatic token selection, nor be treated as ordinary native fee UTXOs.

Changes:

1. The public FT/Coin index reader preserves well-formed zero-token rows instead of rejecting the entire response.
2. A shared holder filter validates canonical amounts and duplicate outpoints, skips automatic zero holders before parent/confirmation reads, and rejects explicitly selected zeros with the fixed `SELECTED_ZERO_BALANCE_INPUT` reason.
3. This is used in TBC20 and Coin transfer/merge, token HTLC lock, LOP token escrow selection, AMM holder FT/LP selection, and standalone LP selection.
4. Pool-owned reserve zeros remain valid state. Exact order/HTLC targets, cancellation/refund paths, ancestry, owner/contract checks and signed-plan binding are not relaxed.
5. Core safely forwards only the fixed new reason. It does not expose arbitrary internal adapter diagnostics.

## Evidence

| Gate | Result |
| --- | --- |
| Published rc.21 zero-row reproduction | All 7 targeted public paths reproduce failure; `baseline-zero-reproduction.tap` is expected RED |
| Source targeted tests | 79/79 pass |
| Core typed reason / sensitive detail rejection | 1/1 pass |
| Clean-installed rc.22 public business tests | 28/28 pass; includes repeated cases from the source gate, not 28 additional independent capabilities |
| ESM / CommonJS imports | 8 + 8 entrypoints pass |
| Wallet, backend, approval examples | 3 outputs identical to rc.21 |
| Signing profile checks | 3 profiles verified; 6 invalid combinations rejected; altered digest rejected |
| Typecheck | `tsc -p packages/kit/tsconfig.json --noEmit` passes |
| iOS / Android Native resource installation and pairing | Both pass; no device build/execution claimed |

The public-path tests run DApp client → Provider → Host → frozen WASM Engine → one approval → synthetic signing → finalize → mock submission. Transfer, merge, HTLC lock, order creation, add liquidity, FT→TBC swap and LP transfer each compare a positive-only index with the same index polluted by leading/trailing zeros. Full finalized transaction objects, read traces, signature counts and one approval are identical. Exact zero inputs fail before approval/signing. Malformed amounts, duplicate zero rows, all-zero balances, missing ancestry and existing confirmation/lock checks are covered. Concurrent read sharing and preparation reuse tests pass.

Evidence files are in `evidence/`: source-targeted.tap, core-targeted.tap, installed-business-tests.tap, installed-check.json, baseline-zero-reproduction.tap, typecheck.json, build.json, protected-before.json and protected-after.json.

## Local timing and reads

Alternating fresh Node processes, frozen WASM, same public fixtures and mocked HTTP; one warm-up round excluded, four measured samples per version. Timings cover the public business call, including synthetic approval/signing/finalization. They do **not** measure phone UI, actual API latency or chain confirmation.

| Operation | rc.21 median ms | rc.22 median ms | Difference ms | Unique GETs, unchanged |
| --- | ---: | ---: | ---: | ---: |
| TBC20 transfer | 121.48 | 121.61 | +0.13 | 5 |
| TBC20 merge | 63.11 | 63.56 | +0.45 | 5 |
| Token HTLC lock | 56.88 | 57.43 | +0.55 | 6 |
| Token-funded order | 58.58 | 56.94 | −1.64 | 5 |
| Add liquidity | 207.70 | 206.39 | −1.31 | 9 |
| FT→TBC swap | 196.66 | 195.62 | −1.04 | 9 |
| LP transfer | 102.36 | 102.68 | +0.32 | 7 |

No material local performance regression was observed. These small sample differences are not a claimed speed improvement or a guarantee for all devices. No additional network call was introduced. Original transaction IDs and read traces match in every positive-only baseline/candidate sample.

## Package and protected artifacts

- Candidate JS: `0.1.0-rc.22`, 5,544,408 bytes; 3,034 bytes more than rc.21 including the new guide and repair.
- JS SHA256: `10bb0cf19f8c0e25000fa286d587ae15ba623edd0826856111e64000439c00b3`.
- Native SDK remains `0.1.0-rc.19.native.2`; schema, registry, Rust code and protocol fingerprint are unchanged.
- All 460 retained WASM/private-parser files match baseline bytes.
- The 174 frozen partner files and all baseline distribution archives are checked before and after packaging. Final values are recorded in `protected-after.json`.
- Source snapshot, native version lock and download hashes accompany this candidate. No push, publication or replacement of the current delivery was performed.

## Boundaries

- This patch does not implement spending/cleaning up explicitly selected zero-token Code outputs; it rejects that unsupported selection explicitly. A caller must correct the selected inputs rather than silently retry without them.
- Existing index pagination/candidate limits are unchanged. This does not promise unlimited index scanning.
- All-zero holder balances still cannot fund a positive transfer. Exact cancellation/refund targets remain subject to their own material/role rules.
- Testing here is offline/controlled plus package/native resource pairing. No new iOS/Android simulator, real-device or live-chain acceptance is claimed.
- The Flutter partner package is intentionally unchanged; this is a new JS/TS Kit candidate using the existing Native compute resources.
