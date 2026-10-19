# LOP: DApp constructs, wallet signs

This example uses the current LOP contracts.
Importing this example makes no request and performs no signing or broadcast.

`prepareLopProposal({ request, engine, network })` uses the public
`prepareTbcTransaction` API. Supply a canonical `tbc-lop-create`,
`tbc-lop-cancel`, or `tbc-lop-match` request, the `@tbc/kit/engine` backend, and
the configured Kit chain-data/policy adapter. The account and chain must match
the connected wallet. The returned JSON contains public evidence and unsigned
transactions; treat it as a proposal, never as authorization.

```js
import { prepareLopProposal, signLopProposal } from './prepare.mjs';

// connection comes from createTbcClient(...).connect(). Do not inject a WIF.
const prepared = await prepareLopProposal({ request, engine, network });
const signed = await signLopProposal(connection, prepared);
// signed contains the completed signed bundle. Nothing has been broadcast.
```

The wallet revalidates evidence, fees, account, expiry and the complete approval
binding, then uses its own external Signer. Permissionless LOP order inputs do
not require wallet signatures; Token/funding inputs still do. Kit/Engine owns
the witness construction. The DApp does not copy a signed transaction, replace
signature placeholders, fetch every funding ancestor or recreate proof rules.

For other supported intents with internal parent/child transactions, the same
Prepared protocol represents deferred input references and binds the resolved
parent after signing. That general mechanism does not establish that arbitrary
old `signAssociatedTransaction` recipes support every new contract. Such raw
compatibility is a separately verified boundary.

`connection.wallet.sendProposal(prepared)` is a separate explicit operation
for callers that want wallet-managed broadcast; this example never calls it.
Broadcast results are not confirmations. A backend with its own custody uses
the existing backend service's `prepareTransaction`/execution adapters, not a
private key in Engine or an invisible wallet approval bypass.
