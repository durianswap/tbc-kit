# Token validator API

`validate_on_chain_transaction` reproduces the staged TokenValidator behavior
from `tbc-contract@1.6.6` for TBC20 and published FT generations. StableCoin
Code is recognized as a contract family rather than ordinary FT.

```rust
use tbc_sdk::{
    ApiClient, Result, TokenValidationOptions, validate_on_chain_transaction,
};

async fn validate(txid: &str) -> Result<()> {
    let api = ApiClient::with_base_url("https://api.tbcdev.org/api/tbc/");
    let transaction = api.fetch_raw_transaction(txid).await?;
    let report = validate_on_chain_transaction(TokenValidationOptions {
        transaction: Some(transaction),
        network: "testnet".into(),
        ..TokenValidationOptions::default()
    })
    .await;
    assert_eq!(report.status, "VALID");
    Ok(())
}
```

When `fetcher` is omitted, the async entry point resolves required parents and
ancestors through the selected network API. `testnet` uses the public testnet
API, `mainnet` uses the public mainnet API, and a URL may be supplied as a
custom network value. For offline caches and database-backed applications,
provide a `TokenTransactionFetcher` and call
`validate_on_chain_transaction_with_fetcher` synchronously.

The report distinguishes `VALID`, `INVALID`, and `UNKNOWN`. It contains:

- physical-to-logical output grouping and protocol recognition;
- the six-slot output/input contribution matrix;
- positive source and zero-balance identity-witness evidence;
- identity and amount conservation;
- parent-to-ancestor lineage edges and original-UTXO boundaries;
- queried, resolved, and required transaction ids;
- explicit assurances and staged issues.

The default `strict` policy requires exact Tape envelopes. The
`relaxed-metadata` preset reports envelope differences as warnings unless
`require_exact_tape_envelope` is explicitly enabled. Structural, identity,
amount, protocol, and lineage failures remain invalid under both presets.

`assert_valid_on_chain_transaction` returns the same report only when its
status is `VALID` and its kind is `TRANSITION`. The CLI-style example
`examples/validate_token_transaction.rs` prints a complete testnet report.
