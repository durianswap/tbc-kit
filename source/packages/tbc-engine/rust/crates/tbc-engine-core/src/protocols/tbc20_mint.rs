//! Keyless TBC20 Source -> Genesis construction using the existing staged signer.
//!
//! Pinned semantics: tbc-contract af776161, TBC20.mint; tbc-lib-js 1.0.31.
//! This builder consumes caller-bound funding material, not an unspentness proof.
//! It does not perform account selection, network access, approval or signing.
//! Metadata policy and the public Engine/Kit intent are integrated separately.

use serde::{Deserialize, Serialize};
use tbc_sdk::{OutPoint, PublicKey, Transaction, TxIn, TxOut, Txid, script::Script};

use super::tbc20::{CodeDescriptor, build_tape, instantiate_code};
use crate::{EngineError, ErrorCode, signing::{
    PlannedInput, PlannedOutput, PlannedTransaction, PublicSigningContext, UnsignedPlan,
}};

pub(crate) const OUTPUT_PREFIX: &str = "tbc20-standard-genesis:";
const SOURCE_ID: &str = "tbc20-standard-source";
// This is the pinned JS policy, NOT the historical vendor SDK_DUST_SAT (24).
const CHANGE_DUST: u64 = 42;
const CODE_VALUE: u64 = 500;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
pub struct MintPlan {
    pub unsigned_plan: UnsignedPlan,
    pub source_fee: u64,
    pub genesis_fee: u64,
    pub maximum_signed_bytes: [usize; 2],
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GenesisOutput {
    pub parent_id: String,
    pub source_vout: u32,
    pub tape_size: u8,
    pub controller: [u8; 21],
}

fn invalid(message: &str) -> EngineError {
    EngineError { code: ErrorCode::InvalidPlan, message: message.to_owned(), path: None }
}

fn insufficient() -> EngineError {
    EngineError { code: ErrorCode::InsufficientFunds,
        message: "TBC20 funding cannot pay Code output and automatic fees".to_owned(), path: None }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn parse_output(value: &str) -> Result<GenesisOutput, EngineError> {
    let json = value.strip_prefix(OUTPUT_PREFIX)
        .filter(|json| json.len() <= 1024)
        .ok_or_else(|| invalid("TBC20 genesis descriptor exceeds its bound or has wrong prefix"))?;
    let result: GenesisOutput = serde_json::from_str(json)
        .map_err(|_| invalid("TBC20 genesis descriptor is malformed"))?;
    if result.parent_id.is_empty() || result.parent_id.len() > 128 {
        return Err(invalid("TBC20 genesis parent identifier is invalid"));
    }
    instantiate_output(&result, Txid::from_le_bytes([0; 32]))?;
    Ok(result)
}

pub(crate) fn instantiate_output(value: &GenesisOutput, txid: Txid) -> Result<Script, EngineError> {
    let mut original_outpoint = [0; 36];
    original_outpoint[..32].copy_from_slice(txid.as_le_bytes());
    original_outpoint[32..].copy_from_slice(&value.source_vout.to_le_bytes());
    instantiate_code(&CodeDescriptor {
        original_outpoint, tape_size: value.tape_size, controller: value.controller,
    }).map(Script::from_bytes).map_err(|_| invalid("TBC20 genesis Code parameters are invalid"))
}

/// ceil(bytes * 80 / 1000), minimum 80 atomic: never 80 atomic per byte.
pub fn fee_for_size(bytes: usize) -> Result<u64, EngineError> {
    if bytes == 0 { return Err(invalid("TBC20 fee size must be positive")); }
    let fee = (bytes as u128 * 80).div_ceil(1000).max(80);
    u64::try_from(fee).ok().filter(|fee| *fee <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("TBC20 fee exceeds the supported integer range"))
}

fn estimated_bytes(outputs: Vec<TxOut>) -> usize {
    // 71-byte maximum low-S DER + sighash + 33-byte compressed key + two pushes.
    // Only length is used; this placeholder is never emitted as a signed result.
    let mut input = TxIn::new(OutPoint { txid: Txid::from_le_bytes([0; 32]), vout: 0 });
    input.script_sig = Script::from_bytes(vec![0; 107]);
    Transaction { version: 10, inputs: vec![input], outputs, lock_time: 0 }.serialize().len()
}

/// Public-key-only mint. The signed Source ID is resolved by the shared signing
/// continuation before Genesis is materialized. No speculative child txid, no
/// private-key callback, and no second fetch of the newly created Source.
pub fn build_mint_plan(
    funding: OutPoint,
    funding_output: &TxOut,
    fee_public_key: &PublicKey,
    recipient: [u8; 21],
    amount: u64,
    tape_extension: &[u8],
    max_total_fee: u64,
) -> Result<MintPlan, EngineError> {
    if amount == 0 { return Err(invalid("TBC20 mint amount must be positive")); }
    let owner_script = Script::p2pkh(&fee_public_key.hash160());
    if funding_output.script_pubkey != owner_script || funding_output.satoshis > MAX_SAFE_INTEGER {
        return Err(invalid("TBC20 funding must be the fee signer's P2PKH output with safe integer value"));
    }
    let tape = build_tape([amount, 0, 0, 0, 0, 0], tape_extension)
        .map_err(|_| invalid("TBC20 mint amount or Tape is invalid"))?;
    let descriptor = GenesisOutput { parent_id: SOURCE_ID.to_owned(), source_vout: 0,
        tape_size: tape.len() as u8, controller: recipient };
    let code = instantiate_output(&descriptor, Txid::from_le_bytes([0; 32]))?;
    let source_bytes = estimated_bytes(vec![TxOut { satoshis: 1, script_pubkey: owner_script.clone() }]);
    let source_fee = fee_for_size(source_bytes)?;
    let source_value = funding_output.satoshis.checked_sub(source_fee).ok_or_else(insufficient)?;
    let available = source_value.checked_sub(CODE_VALUE).ok_or_else(insufficient)?;
    let mut genesis_outputs = vec![
        TxOut { satoshis: CODE_VALUE, script_pubkey: code },
        TxOut { satoshis: 0, script_pubkey: Script::from_bytes(tape) },
    ];
    let mut estimate = genesis_outputs.clone();
    estimate.push(TxOut { satoshis: CHANGE_DUST, script_pubkey: owner_script.clone() });
    let with_change_bytes = estimated_bytes(estimate);
    let with_change_fee = fee_for_size(with_change_bytes)?;
    let (genesis_fee, genesis_bytes) = match available.checked_sub(with_change_fee) {
        Some(change) if change >= CHANGE_DUST => {
            genesis_outputs.push(TxOut { satoshis: change, script_pubkey: owner_script.clone() });
            (with_change_fee, with_change_bytes)
        }
        _ => {
            let size = estimated_bytes(genesis_outputs.clone());
            if available < fee_for_size(size)? { return Err(insufficient()); }
            (available, size)
        }
    };
    if source_fee.checked_add(genesis_fee).is_none_or(|total| total > max_total_fee) {
        return Err(EngineError { code: ErrorCode::FeeCapExceeded,
            message: "TBC20 mint exceeds the caller's total fee cap".to_owned(), path: None });
    }
    let public = PublicSigningContext {
        address: fee_public_key.address().to_string(), public_key: hex(&fee_public_key.to_bytes()),
        public_key_hash: hex(&fee_public_key.hash160()),
    };
    let input = |id: String, vout, satoshis| PlannedInput {
        previous_transaction_id: id, previous_output_index: vout,
        previous_output_script: hex(owner_script.as_bytes()), previous_output_satoshis: satoshis,
        sequence: tbc_sdk::DEFAULT_SEQUENCE, unlocking_script: String::new(), signer: public.clone(),
    };
    let mut outputs: Vec<PlannedOutput> = genesis_outputs.iter().map(|output| PlannedOutput {
        satoshis: output.satoshis, locking_script: hex(output.script_pubkey.as_bytes()),
    }).collect();
    outputs[0].locking_script = format!("{OUTPUT_PREFIX}{}", serde_json::to_string(&descriptor)
        .map_err(|_| invalid("could not encode TBC20 genesis descriptor"))?);
    Ok(MintPlan {
        unsigned_plan: UnsignedPlan { evidence_table: Vec::new(), transactions: vec![
            PlannedTransaction { transaction_id: SOURCE_ID.to_owned(), role: "tbc20-standard-source".to_owned(),
                stage: 0, depends_on: Vec::new(), version: 10,
                inputs: vec![input(funding.txid.to_string(), funding.vout, funding_output.satoshis)],
                outputs: vec![PlannedOutput { satoshis: source_value, locking_script: hex(owner_script.as_bytes()) }],
                lock_time: 0 },
            PlannedTransaction { transaction_id: "tbc20-standard-genesis".to_owned(), role: "tbc20-standard-create".to_owned(),
                stage: 1, depends_on: vec![SOURCE_ID.to_owned()], version: 10,
                inputs: vec![input(SOURCE_ID.to_owned(), 0, source_value)], outputs, lock_time: 0 },
        ] },
        source_fee, genesis_fee, maximum_signed_bytes: [source_bytes, genesis_bytes],
    })
}
