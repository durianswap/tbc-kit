# Private wallet runtime performance

Native Engine execution does not automatically accelerate Core's JavaScript
SHA-256 checks. An Android wallet running Kit in its own Hermes VM should wire
the optional synchronous byte-view hash backend before constructing its runtime:

```ts
import { configureTbcKitSha256Backend } from '@tbc/kit/wallet';
import { createTbcKitMemoryHostStore } from '@tbc/kit/sqlite';

// Supplied by the wallet's private native runtime, never by the DApp.
const sha256 = (bytes: Uint8Array): Uint8Array =>
  privateNativeSha256(bytes.buffer, bytes.byteOffset, bytes.byteLength);
configureTbcKitSha256Backend(sha256);
const hostStore = createTbcKitMemoryHostStore({ sha256 });
// Inject hostStore only where a session-memory store is appropriate.
// Keep the existing durable store/recovery policy for wallet-owned broadcasts.
```

The paired source archive includes `source/native/runtime-support/sha256-jsi.hpp`
and `native-sha256.mjs`. In an owned Android Hermes VM, include the header and
call `installTbcSha256(runtime, env)` on the runtime's owner thread before loading
Kit; wrap the installed primitive with `createNativeSha256Backend`. It calls
Android's SHA-256 implementation with the exact byte-view offset and length.
It does not sign, hold keys, fetch, cache results or change the hash algorithm.
Do not install these private hooks in a DApp WebView. An Expo Engine module alone
does not install a private Hermes hook; integrate through the application's
native runtime or an equivalent trusted synchronous byte-view implementation.

Kit checks independent startup vectors and rejects malformed output. Keep those
checks, all binding/expiry/ownership checks, and the same backend on an externally
created Host store. Do not wrap an asynchronous bridge as a synchronous function,
serialize large byte arrays through JSON, or silently treat a failed configured
backend as success. Without an optional backend, portable SHA-256 is correct but
may be substantially slower for large batches on an interpreter.

Acceptance should record the actual runtime, whether the hook was installed,
package/native identities, payload size, approval and Signer counts, API counts,
and complete signed-transaction equality. Compare the same work on the same
device, distinguishing pure local replay from API, user wait and broadcast time.
Packaging the JS archive does not install a native hook in an existing wallet;
that adapter change requires rebuilding the wallet, not changing the Engine ABI.
