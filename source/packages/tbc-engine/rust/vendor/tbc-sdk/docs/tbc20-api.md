# TBC20 API

`Tbc20` implements the TBC20 contract introduced by `tbc-contract@1.6.6`.
Amounts are parsed without floating point, metadata is NFC-normalized, and
every signed builder finalizes its fee from the actual serialized size at
80 sat/KB with an 80 sat minimum.

```rust
use tbc_sdk::{
    Address, PrivateKey, Result, Tbc20, Tbc20Config, Tbc20Definition,
    Tbc20Spend, Utxo,
};

fn lifecycle(
    key: &PrivateKey,
    recipient: &Address,
    funding: &Utxo,
) -> Result<()> {
    let mut token = Tbc20::new(Tbc20Config {
        definition: Some(Tbc20Definition {
            name: "Example Token".into(),
            symbol: "EXT".into(),
            supply: "1000".into(),
            decimal: 2,
        }),
        ..Default::default()
    })?;
    let minted = token.mint(key, recipient, funding)?;

    let token_input = Tbc20Spend {
        parent: minted.build.transaction.clone(),
        code_vout: 0,
        ancestors: vec![minted.source_transaction.clone()],
    };
    // `fee_utxo` must be a distinct owner-controlled P2PKH output.
    // token.transfer(key, recipient, "1.25", &[token_input], &fee_utxo, None)?;
    let _ = token_input;
    Ok(())
}
```

The main lifecycle methods are:

- `Tbc20::mint`: builds the P2PKH source transaction and TBC20 genesis
  transaction, then initializes the handle with its exact Code/Tape scripts.
- `Tbc20::transfer`: accepts a human decimal amount and emits recipient plus
  token-change Code/Tape pairs as needed.
- `Tbc20::transfer_raw`: accepts a raw `u128` amount and a 21-byte address or
  contract controller.
- `Tbc20::merge`: merges two to five compatible token inputs into one owner
  output.

Each `Tbc20Spend` contains the exact parent transaction, its Code vout, and the
ancestor transactions referenced by non-zero Tape slots. Builders reject mixed
identities, altered Tape envelopes, wrong controllers, duplicate outpoints,
missing ancestry, invalid slot values, or more than six total inputs.

The lower-level helpers exported from `tbc_sdk` cover the exact 1.6.6 artifact,
Code identity/controller inspection and replacement, Tape creation/parsing,
human/raw conversion, and explicit unlock construction. Use
`Tbc20ContractControllerWitness` when spending a contract-controlled token.

See `examples/live_tbc20_flow.rs` for a source → mint → split transfer → merge
testnet lifecycle with JavaScript interpreter preflight and byte-identical API
refetch.
