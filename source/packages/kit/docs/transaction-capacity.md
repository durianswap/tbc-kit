# Transaction capacity and expected rejections

Schema validation checks the request shape. Planning also checks authenticated
inputs, available balances, change, fees and contract output layout. Passing a
schema does not guarantee that a transaction fits the current inputs.

## TBC20 and Coin recipients

The current contracts allow eight **output groups**, not eight arbitrary
recipients in every transaction. A token Code/Tape pair is one group. Ordinary
TBC outputs and change also consume groups.

| Operation | Public request upper bound | Additional groups to budget |
| --- | --- | --- |
| `tbc20.transfer` | 8 receivers; 7 with `payment` | Token change if needed; non-dust TBC change if needed; optional TBC payment |
| `tbc20Stablecoin.transfer` | 7 receivers | Token change if needed; required TBC change; optional TBC payment |

For distinct token receivers, with both token and TBC change, TBC20 usually fits
six receivers, or five when an additional TBC payment is included. A Coin transfer
with token change and its required TBC change has six receiver groups available;
an additional TBC payment reduces this to five. Exact token spending can free the
token-change group. Do not assume the same capacity for every selected input set.

An over-capacity plan is rejected before signing. Kit must not discard recipients,
discard change, or turn substantial change into a fee. The current transfer method
does not automatically split a receiver list into multiple transfers. Reduce the
list or explicitly prepare a supported workflow with a complete fee budget and
one review of the entire plan. Do not retry an uncertain broadcast as a new transfer.

## AMM controller sets

`amm.create({ controllers })` accepts one to five distinct lowercase hash160
strings in any order. Omit the field for a public pool; an empty list is invalid.
Engine `normalizeRequest` sorts this authorization **set** before calculating the
request hash. Use its returned request and hash for planning and Prepared flows.
Duplicates and malformed entries remain errors. Never reorder a normalized request
after approval. This does not reorder recipients, workflow steps, or multisig keys.

## NFT inputs and slots

`tbc721.batchMint` always uses the bounded mint-job executor, including 1–100
items. Supply a whole-task fee ceiling and deadline; see [NFT jobs](./nft.md).
The 100-item schema ceiling is not an execution-chunk recommendation. The default
wallet uses at most ten items per working set with one approval and retained
materials. Expiry stops further effects and returns the accepted prefix; it does
not reset the deadline or resend already accepted transactions.

NFT minting and transfers can receive up to 256 automatic native funding candidates.
Those are alternatives, not 256 selected transaction inputs. The resolver counts
the funding role separately from NFT slots/outputs; the Engine selects and validates
actual funding, dependent transactions, fees and change. The default snapshot input
budget remains 128 for the ordinary resolver; automatic multi-NFT composition has
its existing per-asset budget. Candidate and transaction-count bounds remain in place.

`constraints.inputOutpoints` is exact, not a preference. Every explicitly requested
native input counts against the applicable bound; missing, extra, spent, or
wrong-identity inputs are not silently replaced. NFT mint slots must be unspent
outputs from the requested collection owned by the selected account. Index-lag
fallback queries only missing slots in batches of at most 25, reusing the same raw
transactions and request-local observations.

## Useful errors

- Plain LP `lock`/`unlock`: `UNSUPPORTED_POOL_OPERATION`, not a generic conflict.
- Explicit NFT slot already spent: `NFT_SLOT_SPENT` (non-retryable conflict).
- NFT slot outside the collection or owned by another account: `NFT_SLOT_MISMATCH`.
- Incomplete index/status results remain unavailable; do not treat them as unspent.
- Native and token HTLC, Coin management and LOP report a verified spent selected
  output as `SELECTED_INPUT_SPENT`. Malformed/unknown spent flags are not classified
  as spent. An exact unavailable funding output is `SELECTED_INPUT_UNAVAILABLE`.
- An exhausted collection is `NFT_NO_AVAILABLE_SLOT`. Material loaders distinguish
  `INPUT_BUDGET_EXCEEDED` from `CANDIDATE_LIMIT_EXCEEDED`; malformed API responses
  still fail closed and may use the general material-conflict category.
- Invalid normalized transaction input returns a parameter error, not an internal
  Host failure. Untrusted adapter exception text is never exposed to the DApp.

For an unexpected rejection, retain the exact redacted request, selected slots and
outpoints, Kit/Native versions, operation/reason/code, and time of failure. Do not
include private keys, HTLC preimages or raw signing credentials.

## LOP funding

Token order creation/cancellation and order matching use one fee output selected
by Engine. Up to 256 automatic funding candidates therefore consume one funding
role in the material budget. Native sell/cancel can accumulate multiple fee
inputs and keeps its existing actual-input budget. Exact `inputOutpoints` still
counts every input and must match the complete selected set. No candidate or
exact input is silently substituted to make a request pass.
