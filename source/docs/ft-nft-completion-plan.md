# FT / NFT completion plan

## Scope and fixed boundaries

Implement the currently supported FT families (historical FT v4 and current
TBC20) and the shared NFT capabilities below. FT v3 and historical
`legacy-tbc20` are excluded. Do not add retired issuance, an independent
persistent UTXO manager, or wallet-specific execution branches.

The current delivery, rc.6 and rc.10 archives, and consuming wallet source and
lockfiles remain unchanged. Work here produces a separate candidate; no
publishing, deployment, or funds operations are part of this task.

## Work and evidence required

1. **FT fragmented material:** align the public default reader with the
   existing Engine maintenance → primary plan. Preserve each transaction's
   five-FT-input limit. Cover 1/5/6 inputs, insufficient balance, configured
   resource limits, and shared-parent/ancestor deduplication through the public
   reader and real Engine, not only prebuilt Engine snapshots.
2. **NFT batch transfer:** public shared entry, multi-contract material,
   coordinated fee inputs and parent change. Retain conflict detection rather
   than bypassing duplicate-input validation or looping independent sends.
3. **NFT batch mint:** hundreds of total items, at most 100 per construction
   sub-batch, reduced as needed by serialized-byte and resource budgets.
   Internal sub-batches consume one bounded whole-job approval binding all
   contents, quantities, recipients, total fees and expiry. Partial completion,
   cancellation and ambiguous submission must be explicit; do not claim atomic
   all-or-nothing execution. Broadcast transport limits remain independent.
4. **NFT media:** consistent construction, validation, parsing and holding-read
   budgets, including pushdata encoding boundaries and total-job byte limits.
5. **Collection mint status:** a shared read-only entry for owned available
   slots, proven exhaustion, unknown status and ownership mismatch. An API
   error or incomplete reply must not become an available count of zero.

## Performance and safety acceptance

- Existing supported normal paths add **zero network requests**.
- Read only necessary missing material. Deduplicate immutable parent reads
  and ancestry within a task; reuse signed parents/change without API rereads.
- Preserve parallel prefetch, one approval per bounded task, authority/account
  binding, independent Engine validation and exact final bytes.
- Measure request counts in representative integration tests. Extra fragments
  may need their own missing parents, but not duplicate metadata/tip/raw calls.
- Run focused positive/negative and boundary tests, affected type/build checks,
  and required Native/WASM/package verification. Offline synthetic evidence
  is not real-chain or device acceptance.
- Update public interfaces, examples and pairing/checksum evidence before
  declaring the separate candidate complete. A passing stage is not completion
  of this plan.

## Current checkpoint

Item 1 reader repair is implemented: bounded selection stops when the amount is
covered and can pass more than five fragments to Engine. Each transaction's
five-input constraint remains unchanged. Equivalent omitted/undefined optional
read parameters now share the same preparation promise (previously the unified
path could read the native index twice).

Evidence so far (offline, public synthetic signing keys only, no real network
or funds):

- 46 tests across fragmented reader, default Chain Data, read scope and real
  Engine multi-round integration passed. The six-fragment direct Provider send
  uses one approval and two controlled submissions; no duplicate read occurs.
- The 20 × 100 → 1950 reader case passes real WASM planning/validation with
  either one or four native fee inputs: four merges plus one primary transfer.
  Mock HTTP trace is 3 index/identity reads, 20 selected parents and 1 shared
  ancestor, each once. This count describes this fixture, not all ancestry
  layouts. Fewer required fragments do not load unused candidates.
- The one-fee-input failure was reproduced before the Engine change. Engine
  now consumes already-planned change only when independent sufficient fee
  inputs run out. It retains the exact parent/output/stage, reserves primary
  fees, and never spends the same outpoint twice. Already-valid independent
  funding and direct paths keep their selection order and frozen vectors.
- Rust FT suite: 40 passed, 1 pre-existing pinned-source comparator ignored.
  New 20- and 31-fragment single-fee cases sign/finalize all stages, validate
  the final bundle, enforce fee caps and reject a rehashed replacement fee
  edge. The existing 500-input bounded plan/continuation check also passed.
- Public Provider → default wallet → actual Rust/WASM Engine integration
  creates 20 genuine synthetic holder outputs, then submits their direct
  transfer under one approval. Five controlled submissions carry 29 real
  public-test-key signatures. An independent SDK script VM accepts all 29
  inputs and rejects altered recipients for each of the five transactions.
  Preparation reads are unique; signed parent/change bytes require no fetch.
- Full Kit build/type generation and local macOS Native + WASM builds passed.
  Cross-platform artifact pairing and independent candidate packaging were
  subsequently completed in rc.11 below. Device/chain acceptance is not part
  of this no-funds source-candidate task. Test runtime is not production latency.

The prior six-fragment integration case exercised explicit multi-round merge,
not a direct transfer needing six fragments. Its synthetic index helper also
needed to sum all six FT amount slots rather than slot zero when inspecting
multi-input results.

Item 5 now has a public `client.tbc721.getMintStatus` and standalone
`createTbc721Reader` implementation. Shared Rust collection inspection is used
by both the builder and the read-only keyless bridge. It distinguishes complete
availability, proven indexed exhaustion, unknown state and owner mismatch.
It caches immutable collection bytes only, coalesces concurrent calls, queries
only missing slots and adds nothing to existing transaction paths. See
`../packages/kit/docs/nft.md` for the packaged interface and observation limits.

Directed evidence: 15 JS tests (query, NFT three-step and timelock query) passed;
2 keyless collection tests and 20 Rust NFT builder/public/proof/signing/historical
tests passed. The shared Tape decoder now accepts bounded PUSHDATA4 metadata;
the later media/holding-budget checkpoint is detailed below. The initial
ESM root-entry check caught a missing build entry for `nft-query`; the common
runtime build list was repaired and the public imports now execute.

Additional media checkpoint:

- Reproduced a 70KB media failure after successful Engine construction: Kit
  structural parsing and Core Prepared projection imposed an unrelated 10KB
  script ceiling. Both now retain the 2MiB whole-transaction bound, canonical
  lengths, truncation and other existing checks without that false ceiling.
- New-profile Base64 input is bounded by stored text, not decoded file size;
  Schema/Rust early limit is 1MiB text, with exact transaction and signing-plan
  budgets still enforced. Historical creation declarations are not expanded.
- A 2000-slot collection exposed a distinct first-transfer proof failure:
  TBC721 used the Pool 65535-byte proof budget. NFT now uses its 1MiB family
  budget for ECDSA/Schnorr sizing, finalization and proof checking; Pool retains
  its exact previous ceiling. Independent VM checks cover the actual scripts.
- 24 ordinary/Prepared/Workflow Host cases passed, including 70KB media:
  one approval, no read after approval, immutable raw reuse, and unchanged
  current counts (create 1, mint 3, transfer 5 in these fixtures). The source
  check's old expected tip/Hold reads were corrected to the existing zero-floor
  loader behavior, not restored in production.
- Public reader→Engine mint→transfer with 70KB media preserves the same read
  counts as 4-byte media. Rust large-media and 2000-slot cases sign collection,
  mint and two transfers. Independent VM: 12 transactions, 27 signed inputs,
  12 output-tamper rejections, zero network/broadcast.
- Collection inspection also passed 3 local macOS Native/WASM parity vectors,
  including PUSHDATA4. Current Native/WASM rebuild/pairing remains required
  after the subsequent NFT signing-budget correction.

## Shared NFT batch and whole-job checkpoint

- `tbc721.batchTransfer` now resolves multiple current/historical NFT contracts
  in one shared plan. Engine coordinates independent fee inputs and signed
  change, preserving unique-input and exact-recipient validation. Sixteen
  controlled Host cases covered current/mixed/collection/funding paths; the
  independent VM accepted 141 signed inputs and rejected 33 changed outputs.
- A single NFT construction supports at most 100 items. Ordinary workflow
  steps (5) and broadcast POST batches (32) retain their existing bounds.
  Read-only journal reconciliation accepts up to 100 outcomes; it does not
  enlarge POST or silently retry submission.
- `tbc721.batchMint({ collectionId, items, limits })` now enters the shared
  `tbc_runNftMintJob` route; native callers use `session.runNftMintJob`.
  Existing calls using `constraints` keep their single-plan route and read
  counts. The two limit models cannot be mixed.
- Wallets supply one `nftMintJob.approve` UI and an `authorizeBatch` callback
  to issue the existing exact Core credential without another UI. The private
  execution channel reuses the production Core/Host, Engine validation,
  Signer and normal broadcaster. It is not a second transaction builder or
  a persistent UTXO manager; unrelated page requests cannot borrow its consent.
- All items, order, explicit recipients, total fees and expiry are owned and
  hashed before approval. Material reads start in parallel with review and
  share one job scope. Every subset retains the original observation deadline.
  Only proven resource excess can downsize an unsigned batch; semantic errors
  never trigger resizing. Later subsets use already-validated signed change.
- Public Client → Provider → wallet → Engine controlled acceptance passed for
  250 items: 100/100/50, one transaction review, three exact Core credentials,
  500 signatures and 250 ordered controlled submissions. There were exactly
  three unique mocked reads and zero real network requests or broadcasts.
  The independent SDK VM accepted all 500 Host-signed inputs plus the 200-input
  Native reference, and rejected 350 changed outputs.
- The first public-job harness used a two-minute approval and stopped after
  the completed 100-item prefix. The successful test explicitly authorized ten
  minutes up front; no expiry was renewed in the executor. Its 248,522 ms
  includes source Host orchestration and independent JS VM work per submission,
  with controlled clocks and API. This is not device latency or a guarantee
  that every job fits the default snapshot lifetime. Real expired material
  stops rather than being refreshed without a new job/authorization.
- Fourteen job tests cover whole-scope mutation, resource-only resizing,
  remaining fees, aggregate bytes, invalid late items, rejection, cancellation,
  expiry, authority changes, strict shared UTC calendar/millisecond validation
  and ambiguous/malformed executor replies.
  Client route tests, affected schema/broadcast/read-scope tests and current
  Kit build/type checks passed. The rebuilt keyless Native/WASM artifacts also
  agree on three collection vectors including PUSHDATA4.

- Directed production-job checks now also pass: review rejection produces zero
  formal credentials/signatures/POSTs; a wrong exact credential produces zero
  signatures/POSTs; a rejected second submission retains the accepted prefix;
  a lost second response reports uncertain and performs no third submission or
  retry. Each retains the same three unique reads and one transaction review.

## Local candidate completion

Independent `release/candidates/ft-nft-rc11/tbc-kit-0.1.0-rc.11.tgz`:
SHA256 `35da6e9326bddf6c076fb23d50df3c5c0e4e67a82e09c48e2b69e70d39bdce1d`.
The candidate is built, verified and locally delivered; it does not replace
the current distribution or claim device/chain acceptance.

- Final affected JS run: 353 passed, zero skipped/failed. Focused FT Provider/
  wallet/Engine run: 8 passed. Reader/job subset: 33 passed before the extra
  UTC case, which passed in the 353-case final run. These counts overlap.
- Focused Rust: 57 passed, one pre-existing external-source comparator ignored.
- Actual host C ABI/WASM: 6 NFT vectors, 24 exact plan/validate/finalize/rejection
  comparisons. Keyless collection inspection: 3 exact vectors. Both iOS
  archives and all three Android ABIs were rebuilt; building is not running
  those devices. Android uses API 24 and 16KiB link alignment; iOS archives
  passed the existing object-by-object 15.1 minimum deployment audit.
- Repeated public 250-item run: 100/100/50, one approval, 3 unique reads,
  500 signatures, 250 controlled submissions; independent VM accepts 700
  inputs including the Native reference and rejects 350 changed outputs.
  Its 265,964 ms source-harness time is not product/device performance.
- Real production composition with a restrictive byte budget also downsizes
  3 items to 1/1/1: one approval, 3 unique reads, no extra reads while replanning.
- Final transfer run: 16 Host cases, 141 independent VM inputs, 33 tamper
  rejections. Media run: 12 transactions, 27 VM inputs, 12 tamper rejections,
  including 70KB/500KB media and a 2000-slot collection. Ordinary/Prepared/
  workflow regression: 24 cases, unchanged fixture reads (create 1, mint 3,
  transfer 5), one approval, no new post-approval reads.
- Clean npm installation checked all 8 public entries, ESM/CJS/browser/RN
  resolution, exact artifacts/protocol identity, complete declarations and
  the new public batch/query interfaces and example. Consecutive packs are
  byte-identical. A separate 879-file build-input checkpoint is retained.
- The older 32-item assertion was replaced with 100-pass/101-reject tests.
  Strict portability budgets were adjusted only after a fixed-dependency
  source comparison: Core +8441 raw/+966 gzip bytes, Provider +5902/+712.
  No validation was removed; both full portability and packed Provider checks
  passed. The first direct Node invocation lacked npm's required test context;
  the final affected suite ran under npm and passed.

The candidate's `README.md`, `TEST_RESULTS.json`, `SHA256SUMS`, source checkpoint
and executable `verify.mjs` record all five scope items and evidence limits.
All 13 protected delivery/archive checksums remain unchanged. No wallet edits,
funds, real broadcasts, push, publishing or deployment occurred.
