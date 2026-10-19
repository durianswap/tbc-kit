# API and RPC read-only example

`read-only.mjs` shows independent official REST and TBCNODE JSON-RPC reads.
Constructing either client performs no I/O. The three independent reads start
together, all integer results remain decimal strings, and neither client falls
back to the other protocol.

The RPC URL must be an explicitly configured read-only endpoint. Browser code
must not receive node or wallet credentials. Administration and wallet methods
belong in a trusted non-browser host through their separate factories.

## Timelock deposits (new-standard source integration)

The shared read-only helper works in a DApp, wallet or Node backend. It requires
no wallet connection, approval, private key, Engine/WASM or RPC credentials:

```ts
import { createTbcOfficialApi, createTimelockReader } from "@tbc/kit/api";

const api = createTbcOfficialApi({ network: "testnet" }); // or "mainnet"
const timelock = createTimelockReader({ api });
const observation = await timelock.listDeposits({ address });
for (const deposit of observation.deposits) {
  // amountAtomic and lockHeight are exact decimal strings.
  console.log(deposit.amountAtomic, deposit.lockHeight, deposit.maturity);
}
```

With the main DApp client, use `client.timelock.listDeposits({ address })`.
It inherits the client's selected network and `api` configuration and does not
call `connect()`. This query namespace is separate from a connected wallet's
`wallet.timelock.lock(...)` / `unlock(...)` transaction helpers.

The helper fetches a fresh tip and deposit index concurrently, then verifies
each unique direct parent locally: computed txid, output amount, owner and
supported height-lock script. Two deposits sharing one parent need only one
raw fetch. Reusing the reader retains bounded immutable bytes, never the old
index or confirmations. No native fee index, balance, ancestor or metadata
request is added. Missing index height leaves `confirmations` absent, not zero;
the display query does not fetch decode data merely to fill that field.

`mature` means only that the observed height reaches the script's lock height.
`availability: "indexed-unspent"` records the trusted index's observation; it
does not prove unspent state independently, reserve an input or guarantee a
later broadcast. Submit an explicit selection through the ordinary/Prepared
Engine path, which obtains and validates its own current material.

For accounts with more than 128 deposits, provide a bounded exact selection:

```ts
await timelock.listDeposits({
  address,
  inputOutpoints: [{ txid, vout: 0 }],
});
```

Missing selected deposits fail instead of falling back to all deposits.
Unsupported timestamp/sign-bit lock domains and malformed or wrong-owner
index entries fail explicitly. This query supports the current reviewed
height profile, not every possible historical custom script.
