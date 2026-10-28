# NFT three-step example

`batch.mjs` exports `mintNftJob` and `transferNftBatch` using the same public
client. Importing it does not request permissions or perform transactions.
For hundreds of mints, pass the entire ordered item list, `maxTotalFee` in
atomic units and an explicit `expiresAt`. The wallet must configure the
whole-job review and exact per-plan credential hooks described in
[the NFT guide](../../docs/nft.md). Inspect partial/uncertain results rather
than automatically running the job again. Batch transfers share one plan;
neither helper promises atomic chain execution or block confirmation.

`run.mjs` uses only the public `@tbc/kit` DApp API:

1. `wallet.tbc721.createCollection(...)`
2. `wallet.tbc721.mint({ collectionId, slot: 1, ... })`
3. `wallet.tbc721.transfer(...)`

Creation and minting use the current TBC721 standard; transfer uses shared current/historical routing. The single-item collection uses its first slot, numbered 1. Do not substitute the retained historical `wallet.nft.mint` helper: old NFT issuance is blocked.

The collection identity is the submitted collection-create primary transaction ID. The NFT contract identity is the submitted mint primary transaction ID and remains stable across transfers. Submitted does not mean confirmed. The example transfers back to the connected account and uses placeholder metadata; replace those values for your application.

The wallet remains responsible for approval, keys, signing, official-index visibility and broadcast reconciliation. The example stops on rejection, unknown submission or an ambiguous primary result; it performs no automatic retries. A real integration should retain completed step identities and show an indexing/reconciliation state when a just-submitted output is not yet queryable. Do not restart the whole example to retry a dependent step, guess an outpoint or rebroadcast an uncertain transaction.
