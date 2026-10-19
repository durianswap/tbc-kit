pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid mnemonic word count")]
    InvalidMnemonicWordCount,
    #[error("invalid mnemonic phrase")]
    InvalidMnemonic,
    #[error("invalid derivation path")]
    InvalidDerivationPath,
    #[error("invalid extended key")]
    InvalidExtendedKey,
    #[error("extended key network mismatch")]
    ExtendedKeyNetworkMismatch,
    #[error("cannot derive a hardened child from an extended public key")]
    HardenedPublicDerivation,
    #[error("invalid WIF")]
    InvalidWif,
    #[error("invalid address")]
    InvalidAddress,
    #[error("unsupported address type")]
    UnsupportedAddressType,
    #[error("invalid transaction hex")]
    InvalidTransactionHex,
    #[error("invalid script: {0}")]
    InvalidScript(String),
    #[error("invalid UTXO data: {0}")]
    InvalidUtxo(String),
    #[error("insufficient funds: input {input} sat, required {required} sat")]
    InsufficientFunds { input: u64, required: u64 },
    #[error("dust output: {0} sat")]
    DustOutput(u64),
    #[error("missing private key for input")]
    MissingPrivateKey,
    #[error("signature failure")]
    SignatureFailure,
    #[error("signed transaction fee did not converge")]
    FeeDidNotConverge,
    #[error("broadcast failure: {0}")]
    BroadcastFailure(String),
    #[error("API error: {0}")]
    Api(String),
    #[error("hex error: {0}")]
    Hex(#[from] hex::FromHexError),
    #[cfg(not(target_arch = "wasm32"))]
    #[error("secp256k1 error: {0}")]
    Secp256k1(#[from] secp256k1::Error),
    #[cfg(feature = "network-api")]
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}
