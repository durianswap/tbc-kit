# Local TBC Sign-In frontend/backend example

Run this non-production example from an installed `@tbc/kit` package:

```sh
node node_modules/@tbc/kit/examples/sign-in/run.mjs
```

`run.mjs` forks `backend.mjs`, so the frontend and backend have separate
process state. The backend issues a random challenge bound to one login attempt,
keeps the challenge private, atomically changes it from `issued` to `consumed`,
rejects replay, and creates the login session only after `verifySignIn`
succeeds. The frontend exercises `tbc_signMessage`, `tbc_signTypedData`, and
the one-request Sign-In helper through a real local Kit wallet.

The in-memory Maps and single-process compare-and-set in `backend.mjs` are only
an executable boundary example. Production services must replace them with a
durable database transaction whose conditional `issued -> consumed` update
affects exactly one row before they create a session.
