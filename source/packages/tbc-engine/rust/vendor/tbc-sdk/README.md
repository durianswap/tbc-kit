# TBC Rust SDK

Rust SDK for constructing and signing TuringBitChain transactions and implemented contracts.

## Install

```toml
[dependencies]
tbc-sdk = "0.2"
```

The Cargo package name is `tbc-sdk`; the Rust import name is `tbc_sdk`.

## Implemented modules

- Base transactions, scripts, keys, sighashes, and API access
- Random private keys, WIF import, English BIP39 mnemonics, and BIP32 xprv/xpub keys
- FT mint, transfer, batch transfer, and merge
- NFT collection creation, mint, batch mint, and transfer
- StableCoin creation, mint, transfer, batch transfer, and merge
- OrderBook buy/sell order creation, matching, and cancellation
- TBC-native MultiSig wallet creation plus distributed TBC/FT build, sign, and
  finish flows (surface and security model,
  [testnet evidence](docs/verification/2026-08-01-rust-multisig-testnet.md))
- PoolNFT v2 creation, liquidity, swaps, FTLP lifecycle, and query-backed
  explicit-context resolution ([API mapping and creation authority](docs/pool-nft-v2-api.md),
  [testnet evidence](docs/verification/2026-08-01-rust-pool-nft-v2-testnet.md));
  PoolNFT v1 is not supported
- TBC20 source/genesis mint, transfer/change, merge, address and contract
  controllers ([API](docs/tbc20-api.md))
- TBC20/FT source-graph validation with strict and relaxed-metadata policies,
  including automatic network API resolution ([API](docs/token-validator-api.md))

The managed contract surface is synchronized with `tbc-contract@1.6.6` while
retaining spends for supported older FT, NFT, StableCoin, and PoolNFT v2
outputs. PoolNFT v1, HTLC, and PiggyBank are intentionally outside the Rust
SDK's managed contract surface.

## Minimal usage

```rust
use tbc_sdk::{ApiClient, Transaction};

let api = ApiClient::main();
let tx = Transaction::new();

assert_eq!(api.base_url(), "https://api.turingbitchain.io/api/tbc/");
assert!(tx.inputs.is_empty());
```

## Wallets and HD keys

Create a standalone random private key directly from the operating system's
secure random source:

```rust
use tbc_sdk::PrivateKey;

fn main() -> tbc_sdk::Result<()> {
    let private_key = PrivateKey::generate();
    let wif = private_key.to_wif();
    let restored = PrivateKey::from_wif(&wif)?;
    assert_eq!(restored.address(), private_key.address());
    Ok(())
}
```

Generate or restore an English BIP39 mnemonic, then derive the default TBC
account path `m/44'/236'/0'/1/0`:

```rust
use tbc_sdk::{HdNetwork, HdPrivateKey, Mnemonic, TBC_DERIVATION_PATH};

fn main() -> tbc_sdk::Result<()> {
    let mnemonic = Mnemonic::generate(12)?;
    let restored = Mnemonic::from_phrase(&mnemonic.phrase())?;
    let root = HdPrivateKey::from_mnemonic(&restored, "", HdNetwork::Mainnet)?;
    let account = root.derive_path(TBC_DERIVATION_PATH)?;

    let xprv = account.to_xprv();
    let xpub = account.to_public().to_xpub();
    let imported_private = HdPrivateKey::from_xprv(&xprv)?;
    let imported_public = tbc_sdk::HdPublicKey::from_xpub(&xpub)?;
    assert_eq!(imported_private.address(), imported_public.address());
    Ok(())
}
```

`HdNetwork::Mainnet` serializes xprv/xpub and `HdNetwork::Testnet` serializes
tprv/tpub. An extended public key can derive only non-hardened children;
hardened derivation requires the extended private key.

## Development

In 0.3.0, every supported signed builder finalizes the fee from the exact
post-signature transaction size at 80 sat/KB. Signature-length changes are
handled with a non-decreasing target, and a builder returns an explicit error
instead of an under-target fallback if finalization cannot converge.

```bash
cargo test --all-targets
```

## License

MIT
