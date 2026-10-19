# Receipt verification backend example

Run this from a project that installed the candidate tarball:

```sh
ORDER_ID=order-123 \
TXID=<64-lowercase-hex> \
RECIPIENT=<testnet-address> \
AMOUNT_ATOMIC=1000000 \
MIN_CONFIRMATIONS=1 \
node backend.mjs
```

The example verifies an exact 1 TBC order because TBC has 6 decimals. Set
`TBC_NETWORK=mainnet` for mainnet; omission uses testnet. FT must
use the trusted order's `contractId` and atomic quantity; Kit obtains that
contract's decimals only for exact display formatting. NFT instead uses
`{ kind: "nft", contractId }` and has no fungible quantity input.

Do not accept recipient, asset, quantity, or confirmation policy from the same
untrusted client that submits the txid. Store those expectations with the
order, and atomically enforce a unique txid/order binding before marking paid.
This helper does not query current balance and does not prove consensus or
finality. Treat `confirmation-unknown` as unavailable even when the order
allows zero confirmations. Decode's explicit zero or exact membership from the
single bounded same-origin mempool fallback is the only mempool observation.
NFT history lookup is bounded to five 100-entry pages; an uncovered target is
reported unavailable rather than as an asset mismatch.
