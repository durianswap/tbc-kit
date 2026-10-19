# Bounded multi-round merge

This example imports only the installed public `@tbc/kit/wallet` entry. It
shows the wallet-owned integration boundary for a finite consolidation. The
default session accepts TBC, FT, Pool-held FT and FTLP asset variants.

The runnable adapter is deliberately an advanced controlled invariant fixture:
it never contacts a node and never holds a private key. Production wallets use
`createTbcWallet({ multiRoundMerge: { approve }, ... })` followed by
`session.runMultiRoundMerge(...)`; Kit then owns index selection, Engine
planning, exact formal binding, execution and reconciliation. Wallet code does
not implement `prepareStep` or `executePreparedStep`.

```sh
node run.mjs
```

One bounded consent does not skip per-step verification. Each prepared step is
bound to the exact account, network, origin, session, index snapshot, fee and
material hash. An unknown submission enters `reconcile` and is never blindly
executed again.

Pool callers use `{ kind: "pool-ft", poolContractId }` or
`{ kind: "ftlp", poolContractId }`. The bounded approval reads
`scope.impact` to display Pool identity and ownership accurately: Pool-held FT
remains Pool-owned, while FTLP remains account-owned.
