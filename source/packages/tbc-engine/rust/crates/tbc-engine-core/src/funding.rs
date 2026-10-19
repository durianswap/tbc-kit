use std::collections::BTreeSet;

use tbc_sdk::{Transaction, script::Script};

use crate::model::{ChainSnapshot, error};
use crate::normalize::parse_decimal_u64;
use crate::{EngineError, ErrorCode};

const MIN_TRANSACTION_FEE_SAT: u64 = tbc_sdk::DEFAULT_FEE_RATE_SAT_PER_KB;
#[allow(dead_code)]
const MAX_LOW_S_DER_WITH_SIGHASH_BYTES: usize = 72;

#[derive(Clone, Debug)]
pub(crate) struct NativeFundingUtxo {
    pub txid: String,
    pub vout: u32,
    pub satoshis: u64,
    pub script: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(dead_code)]
pub(crate) struct FundingPlan {
    pub required_funding_sat: u64,
    pub miner_fee_sat: u64,
    pub transaction_count: usize,
    pub funding_output_count: usize,
}

pub(crate) fn conservative_transaction_fee(
    serialized_bytes: usize,
    signature_headroom_bytes: u64,
    fee_rate_sat_per_kb: u64,
) -> Result<u64, EngineError> {
    let serialized_bytes = u64::try_from(serialized_bytes)
        .map_err(|_| invalid("funding plan size overflow"))?;
    let planned_bytes = serialized_bytes
        .checked_add(signature_headroom_bytes)
        .ok_or_else(|| invalid("funding plan size overflow"))?;
    let scaled_fee = planned_bytes
        .checked_mul(fee_rate_sat_per_kb)
        .ok_or_else(|| invalid("funding plan fee overflow"))?;
    Ok(scaled_fee.div_ceil(1_000).max(MIN_TRANSACTION_FEE_SAT))
}

#[allow(dead_code)]
pub(crate) fn conservative_chain_fee(
    transactions: impl IntoIterator<Item = (usize, u64)>,
    fee_rate_sat_per_kb: u64,
) -> Result<u64, EngineError> {
    transactions.into_iter().try_fold(0u64, |total, (size, headroom)| {
        total
            .checked_add(conservative_transaction_fee(size, headroom, fee_rate_sat_per_kb)?)
            .ok_or_else(|| invalid("funding plan fee overflow"))
    })
}

#[allow(dead_code)]
pub(crate) fn signed_transaction_headroom(transaction: &Transaction) -> Result<u64, EngineError> {
    transaction.inputs.iter().try_fold(0u64, |total, input| {
        let script_len = input.script_sig.as_bytes().len();
        let growth = MAX_LOW_S_DER_WITH_SIGHASH_BYTES
            .checked_add(1 + 33)
            .and_then(|signed| signed.checked_sub(script_len))
            .unwrap_or_default();
        total
            .checked_add(u64::try_from(growth).map_err(|_| invalid("signature size overflow"))?)
            .ok_or_else(|| invalid("signature size overflow"))
    })
}

#[allow(dead_code)]
pub(crate) fn required_funding(
    business_principal_sat: u64,
    fees: impl IntoIterator<Item = u64>,
    transaction_count: usize,
    funding_output_count: usize,
) -> Result<FundingPlan, EngineError> {
    if transaction_count == 0 || funding_output_count == 0 {
        return Err(invalid("funding plan counts must be positive"));
    }
    let mut counted = 0usize;
    let miner_fee_sat = fees.into_iter().try_fold(0u64, |total, fee| {
        counted = counted.checked_add(1).ok_or_else(|| invalid("transaction count overflow"))?;
        total.checked_add(fee).ok_or_else(|| invalid("funding fee overflow"))
    })?;
    if counted != transaction_count {
        return Err(invalid("funding plan transaction count mismatch"));
    }
    Ok(FundingPlan {
        required_funding_sat: business_principal_sat
            .checked_add(miner_fee_sat)
            .ok_or_else(|| invalid("funding amount overflow"))?,
        miner_fee_sat,
        transaction_count,
        funding_output_count,
    })
}

pub(crate) fn native_funding_candidates(
    snapshot: &ChainSnapshot,
    account_script: &str,
    minimum_confirmations: u64,
) -> Result<Vec<NativeFundingUtxo>, EngineError> {
    let mut native_outpoints = BTreeSet::new();
    for (index, utxo) in snapshot
        .payload
        .utxos
        .iter()
        .enumerate()
        .filter(|(_, utxo)| utxo.classification == "native")
    {
        // Parent-free funding must still be safe for all later Txid parsers.
        // Canonical spelling also keeps duplicate-outpoint checks unambiguous.
        utxo.txid
            .parse::<tbc_sdk::Txid>()
            .ok()
            .filter(|txid| txid.to_string() == utxo.txid)
            .ok_or_else(|| {
                error(
                    ErrorCode::InvalidInput,
                    "native funding txid must be a canonical transaction id",
                    &format!("snapshot.payload.utxos[{index}].txid"),
                )
            })?;
        if !native_outpoints.insert((utxo.txid.as_str(), utxo.vout)) {
            return Err(error(
                ErrorCode::InvalidAncestry,
                "native funding snapshot contains a duplicate outpoint",
                "snapshot.payload.utxos",
            ));
        }
    }
    let mut result = Vec::new();
    for (index, utxo) in snapshot.payload.utxos.iter().enumerate() {
        match utxo.classification.as_str() {
            "native" => {
                if utxo.contract_id.is_some() || utxo.script_pub_key != account_script {
                    return Err(error(
                        ErrorCode::InvalidAncestry,
                        "native funding UTXO ownership or classification is inconsistent",
                        &format!("snapshot.payload.utxos[{index}]"),
                    ));
                }
                if !crate::confirmations::meets_minimum(
                    utxo.confirmations.as_deref(),
                    minimum_confirmations,
                    &format!("snapshot.payload.utxos[{index}].confirmations"),
                )? {
                    continue;
                }
                let satoshis = parse_decimal_u64(
                    &utxo.satoshis,
                    &format!("snapshot.payload.utxos[{index}].satoshis"),
                )?;
                // Native funding follows the address-UTXO descriptor flow. Asset ancestry
                // is separate; verify a native parent only when the caller supplied it.
                if let Some(parent) = snapshot
                    .payload
                    .parents
                    .iter()
                    .find(|parent| parent.txid == utxo.txid) {
                    let transaction = Transaction::from_hex(&parent.raw_transaction).map_err(|_| {
                        error(
                            ErrorCode::InvalidAncestry,
                            "native funding parent is malformed",
                            "snapshot.payload.parents",
                        )
                    })?;
                    let output = transaction.outputs.get(utxo.vout as usize).ok_or_else(|| {
                        error(
                            ErrorCode::InvalidAncestry,
                            "native funding parent output is missing",
                            "snapshot.payload.parents",
                        )
                    })?;
                    if transaction.txid().to_string() != parent.txid
                        || output.satoshis != satoshis
                        || output.script_pubkey != Script::from_bytes(decode_hex(account_script)?)
                    {
                        return Err(error(
                            ErrorCode::InvalidAncestry,
                            "native funding UTXO does not match its parent",
                            "snapshot.payload.utxos",
                        ));
                    }
                }
                result.push(NativeFundingUtxo {
                    txid: utxo.txid.clone(),
                    vout: utxo.vout,
                    satoshis,
                    script: utxo.script_pub_key.clone(),
                });
            }
            "ft" | "collection-slot" | "nft" | "stablecoin" | "pool" | "pool-source"
            | "pool-ft" | "ftlp" | "htlc" | "lop" => {}
            _ => {
                return Err(error(
                    ErrorCode::InvalidAncestry,
                    "unknown UTXO classification",
                    &format!("snapshot.payload.utxos[{index}].classification"),
                ));
            }
        }
    }
    result.sort_by(|left, right| {
        left.satoshis
            .cmp(&right.satoshis)
            .then_with(|| left.txid.cmp(&right.txid))
            .then_with(|| left.vout.cmp(&right.vout))
    });
    Ok(result)
}

fn decode_hex(value: &str) -> Result<Vec<u8>, EngineError> {
    if !value.len().is_multiple_of(2) {
        return Err(invalid("funding script is not hexadecimal"));
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |byte| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            };
            Ok((digit(pair[0]).ok_or_else(|| invalid("funding script is not hexadecimal"))? << 4)
                | digit(pair[1]).ok_or_else(|| invalid("funding script is not hexadecimal"))?)
        })
        .collect()
}

fn invalid(message: &str) -> EngineError {
    error(ErrorCode::InvalidInput, message, "funding")
}
