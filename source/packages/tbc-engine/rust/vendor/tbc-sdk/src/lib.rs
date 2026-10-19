pub mod address;
#[cfg(feature = "network-api")]
pub mod api;
pub mod builder;
pub mod contracts;
pub mod encoding;
pub mod error;
pub mod hash;
#[cfg(feature = "internal-signing")]
pub mod hd;
#[cfg(feature = "internal-signing")]
pub mod keys;
#[cfg(not(feature = "internal-signing"))]
mod keys;
mod offline;
pub mod script;
pub mod sighash;
pub mod transaction;
pub mod validator;

pub use address::Address;
#[cfg(feature = "network-api")]
pub use api::{ApiClient, PoolNftInfo};
#[cfg(feature = "internal-signing")]
pub use builder::TransactionBuilder;
pub use builder::Utxo;
pub use contracts::ft::{BatchFtTx, Ft, FtInfo, FtReceiver, FtUtxo, MintFtTx};
pub use contracts::multisig::{MultiSig, MultiSigAddressInfo};
#[cfg(feature = "internal-signing")]
pub use contracts::multisig::{
    MultiSigDestination, MultiSigInputSignatures,
    MultiSigUnsignedTx, MultiSigUtxo,
};
pub use contracts::nft::{BatchNftTx, CollectionData, Nft, NftData, NftInfo, NftUtxo};
#[cfg(feature = "internal-signing")]
pub use contracts::orderbook::{
    BuyOrderParams, CancelBuyOrderParams, MatchOrderParams, OrderBook, OrderData, OrderUtxo,
    SellOrderParams,
};
pub use contracts::pool_nft_v2::{
    FTLP_CODE_SATOSHIS, FTLP_TAPE_SATOSHIS, FtScriptVersion, FtSpendContext, FtlpCodeParams,
    FtlpLockTimeEntry, FtlpSpendContext, FtlpTapeLayout, FtlpTapeParams, LockedLpCost,
    LockedPoolCodeParams, POOL_CODE_DUST_SAT, POOL_CODE_SATOSHIS, POOL_TAPE_SATOSHIS, PoolAmounts,
    PoolCodeParams, PoolDifference, PoolOperationContext, PoolSpendContext, PoolState, PoolUpdate,
    consume_lp, format_decimal_raw,
    ftlp_code, ftlp_lock_time_code, ftlp_tape, increase_lp, initial_lp_raw, locked_pool_code,
    parse_decimal_raw, pool_code, pool_held_ft_code, pool_tape, swap_ft_to_tbc, swap_tbc_to_ft,
};
#[cfg(feature = "internal-signing")]
pub use contracts::pool_nft_v2::{PoolFtAuthority, PoolInitContext, PoolNftV2};
pub use contracts::stable_coin::{
    AdminSighash, CoinNftData, FinalizedStableCoinCreate, StableCoin, StableCoinCreate,
    StableCoinMint,
};
pub use contracts::tbc20::{
    TBC20_AMOUNT_SLOTS, TBC20_ARTIFACT_SHA256, TBC20_CODE_BYTES, TBC20_CODE_PARTIAL_OFFSET,
    TBC20_CODE_SATOSHIS, TBC20_MAX_INPUTS, TBC20_MAX_OUTPUT_GROUPS, TBC20_MAX_OUTPUTS,
    TBC20_MAX_SLOT_AMOUNT, TBC20_MAX_TAPE_BYTES, TBC20_MIN_TAPE_BYTES, TBC20_TAPE_SATOSHIS, Tbc20,
    Tbc20Config, Tbc20Definition, Tbc20Outpoint, Tbc20ParsedTape, Tbc20Utxo,
    build_tbc20_metadata_extension, build_tbc20_tape, build_tbc20_utxo,
    encode_tbc20_original_utxo, instantiate_tbc20_code,
    is_tbc20_artifact_candidate, parse_tbc20_tape, replace_tbc20_controller,
    replace_tbc20_tape_amounts, tbc20_address_controller, tbc20_code_identity,
    tbc20_contract_controller, tbc20_controller, tbc20_human_to_raw, tbc20_raw_to_human,
    validate_tbc20_code,
};
#[cfg(feature = "internal-signing")]
pub use contracts::tbc20::{
    Tbc20AncestorResolver, Tbc20BuildResult, Tbc20ContractControllerWitness, Tbc20MintResult,
    Tbc20OutputGroup, Tbc20Spend, Tbc20TokenOutput, Tbc20UnlockOptions,
    build_tbc20_unlock_script, build_tbc20_unlock_script_with_signature,
};
pub use error::{Error, Result};
#[cfg(feature = "internal-signing")]
pub use hd::{HdNetwork, HdPrivateKey, HdPublicKey, Mnemonic, TBC_DERIVATION_PATH};
#[cfg(feature = "internal-signing")]
pub use keys::PrivateKey;
pub use keys::PublicKey;
pub use offline::{FtlpUtxo, UtxoInfo};
pub use transaction::{OutPoint, Transaction, TxIn, TxOut, Txid};
pub use validator::{
    InMemoryTokenTransactionFetcher, TokenAncestorEdge, TokenAssetEvidence, TokenInputEvidence,
    TokenOutputGroup, TokenProtocolDescriptor, TokenTransactionFetcher, TokenValidationIssue,
    TokenValidationOptions, TokenValidationPolicy, TokenValidationResult, TokenValidationSource,
    validate_on_chain_transaction_with_fetcher,
};
#[cfg(feature = "network-api")]
pub use validator::{assert_valid_on_chain_transaction, validate_on_chain_transaction};

pub const COIN: u64 = 1_000_000;
pub const TX_VERSION: i32 = 10;
pub const ADDRESS_P2PKH_PREFIX: u8 = 0x00;
pub const WIF_PREFIX: u8 = 0x80;
pub const DEFAULT_SEQUENCE: u32 = 0xffff_ffff;
pub const DEFAULT_LOCK_TIME: u32 = 0;
pub const DEFAULT_FEE_RATE_SAT_PER_KB: u64 = 80;
pub const SDK_DUST_SAT: u64 = 24;
pub const SIGHASH_ALL: u32 = 0x01;
pub const SIGHASH_FORKID: u32 = 0x40;
pub const DEFAULT_SIGHASH: u32 = SIGHASH_ALL | SIGHASH_FORKID;
