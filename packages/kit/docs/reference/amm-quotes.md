# AMM pure quotes

`quoteTbcAmm` is available from the Kit root (including React Native) and
`@tbc/kit/wallet`. Reuse the same keyless Engine instance as your application:

```ts
import { quoteTbcAmm } from '@tbc/kit';

const result = await quoteTbcAmm({
  pool: { txid: poolTransactionId, rawTransaction: poolTransactionHex },
  action: { kind: 'buy', amount: '10000' },
}, { engine: keylessEngine });

if (result.kind === 'buy') {
  console.log(result.quote.ftOutRaw); // Atomic amount, decimal string.
}
```

The existing Native bridge or WASM keyless instance both provide `execute`.
No account, wallet connection, approval or signing is needed. The helper does
not initialize another Engine, fetch from an API, query a node, or cache mutable
Pool state. Resolve the Pool through the application's configured network and
reuse already-fetched bytes. Quotes are not implicitly mainnet or testnet data.

Actions:

| kind | amount unit | additional input |
| --- | --- | --- |
| buy | TBC atomic | none |
| sell | FT atomic | none |
| addTbc | TBC atomic budget | `initialFtAmount` required only for the first deposit |
| addFt | FT atomic budget | existing active Pool only |
| remove | LP atomic to burn for redemption | none |

Amounts are canonical positive decimal **strings**, never display decimals or
JavaScript numbers. All returned monetary fields, including `nextState` and
`fees`, are atomic strings. Rate fields are integer basis points; boolean fields
remain booleans. Native integer arithmetic and rounding are shared with the transaction
builders; TypeScript does not reimplement AMM math.

Fee configuration is recovered from validated Pool Code/Tape. `feePolicy` in
the result is read-only information, not a new configurable fee input. Overrides
are rejected. This API reads fee configuration; it cannot modify it.

`poolOutpoint` identifies the exact quoted transaction state. `basis` is
`local-pool-transaction`: local txid/template/configuration consistency, **not**
proof of genesis ancestry, chain inclusion, current unspentness or authorization.
Use ordinary/Prepared planning with fresh material and an explicit minimum output
before signing. A quote cannot be used as an approval receipt or replace planner
checks. `nextState` predicts contract accounting; actual TBC reserves and pricing
reserves remain distinct. Swap fees are AMM fees, **not** miner fees; miner fees
depend on the final transaction inputs and witness sizes.
