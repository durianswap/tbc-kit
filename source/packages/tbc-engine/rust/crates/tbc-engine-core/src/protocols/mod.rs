//! Pure protocol building blocks for the new contract integration.
//!
//! These Rust-only modules do not register transaction intents or Provider methods.
//! Decoding a template or linking its material is not proof of ownership, spendability,
//! authorized issuance, or consensus validity. The shared planner and finalizer must
//! enforce those boundaries before an operation becomes available to consumers.

pub mod tbc20;
pub mod amm;
pub mod amm_explicit;
pub mod amm_profile;
pub mod amm_math;
pub mod amm_fee_policy;
mod amm_template;
pub mod amm_code;
pub mod amm_lp;
pub mod amm_lp_proof;
pub mod amm_lp_transfer;
pub mod amm_pool_proof;
pub mod amm_state;
pub mod amm_material;
pub mod amm_lp_batch;
pub mod amm_batch;
pub mod amm_transaction;
pub mod amm_mint;
pub(crate) mod amm_genesis;
pub mod amm_business;
pub mod coin;
pub mod covenant_signature;
pub mod coin_proof;
pub mod coin_transfer;
pub mod coin_identity;
pub mod coin_issuance;
pub mod coin_admin;
pub mod tbc721;
pub mod tbc721_proof;
pub mod tbc721_transaction;
mod transaction_proof;
pub(crate) mod nft_metadata;
pub mod tbc20_material;
pub mod tbc20_mint;
pub mod tbc20_proof;
pub mod tbc20_transfer;
pub mod tbc20_batch;
pub mod fungible_change;
pub mod fungible_origin;
pub mod nft_origin;
pub mod pool_origin;
pub mod historical_nft;
pub mod historical_coin;
pub mod historical_pool;
pub mod historical_policy;
pub mod timelock;
pub mod timelock_transaction;
pub mod htlc;
pub mod htlc_transaction;
pub mod htlc_token;
pub(crate) mod controlled_token;
pub mod lop;
pub mod lop_transaction;
pub mod lop_token;
pub mod lop_settlement;
pub mod lop_proof;
pub mod lop_match;
