//! Local fungible asset-change evidence for the historical-issuance policy.
//!
//! This is classification, not an authorization API. Callers must bind input
//! outputs to trusted prevouts (or verified batch-local parents), classify all
//! other scripts, and apply the complete policy before signing. In particular,
//! `None` is unrecognized, not permission to sign. No HTTP, keys, or persistence.

use std::collections::{BTreeMap, BTreeSet};
use tbc_sdk::{OutPoint, TxOut, validator::inspect_published_token_pair};

use super::{tbc20, coin};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FungibleProtocol {
    HistoricalFt(u8),
    HistoricalTbc20,
    HistoricalStableCoin(u8),
    Tbc20Standard,
    Coin,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct FungibleIdentity {
    pub protocol: FungibleProtocol,
    pub code_identity: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FungiblePair {
    pub identity: FungibleIdentity,
    pub amount: u128,
}

/// Authenticate a known full Code template and its adjacent Tape. A marker
/// alone is never used to assert an asset identity or balance.
pub fn inspect_fungible_pair(
    code: &TxOut,
    tape: Option<&TxOut>,
) -> Result<Option<FungiblePair>, String> {
    if let Ok(descriptor) = coin::parse_code(code.script_pubkey.as_bytes()) {
        let tape = tape.ok_or("Coin Tape is missing")?;
        if code.satoshis != 500 || tape.satoshis != 0 {
            return Err("Coin Code/Tape values differ".into());
        }
        let tape = coin::parse_tape(tape.script_pubkey.as_bytes(), Some(descriptor.tape_size as usize))
            .map_err(|error| error.to_string())?;
        let identity = coin::code_identity(code.script_pubkey.as_bytes()).map_err(|error| error.to_string())?;
        return Ok(Some(FungiblePair {
            identity: FungibleIdentity { protocol: FungibleProtocol::Coin,
                code_identity: identity.iter().map(|byte| format!("{byte:02x}")).collect() },
            amount: tape.balance as u128,
        }));
    }
    if let Ok(descriptor) = tbc20::parse_code(code.script_pubkey.as_bytes()) {
        let tape = tape.ok_or("tbc20-standard Tape is missing")?;
        if code.satoshis != 500 || tape.satoshis != 0
            || tape.script_pubkey.as_bytes().len() != usize::from(descriptor.tape_size)
        {
            return Err("tbc20-standard Code/Tape values or Tape size differ".into());
        }
        let amount = tbc20::parse_tape(tape.script_pubkey.as_bytes())
            .map_err(|error| error.to_string())?.balance;
        let identity = tbc20::code_identity(code.script_pubkey.as_bytes())
            .map_err(|error| error.to_string())?;
        return Ok(Some(FungiblePair {
            identity: FungibleIdentity {
                protocol: FungibleProtocol::Tbc20Standard,
                code_identity: identity.iter().map(|byte| format!("{byte:02x}")).collect(),
            },
            amount,
        }));
    }
    let Some(pair) = inspect_published_token_pair(code, tape)
        .map_err(|error| error.to_string())? else { return Ok(None); };
    let protocol = match pair.protocol.family.as_str() {
        "FT" => FungibleProtocol::HistoricalFt(pair.protocol.version),
        "TBC20" => FungibleProtocol::HistoricalTbc20,
        "STABLE_COIN" => FungibleProtocol::HistoricalStableCoin(pair.protocol.version),
        _ => return Err("unhandled published fungible protocol".into()),
    };
    Ok(Some(FungiblePair {
        identity: FungibleIdentity { protocol, code_identity: pair.identity },
        amount: pair.balance,
    }))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FungibleChange {
    pub identity: FungibleIdentity,
    pub input_amount: u128,
    pub output_amount: u128,
    pub input_count: usize,
    pub output_count: usize,
}

impl FungibleChange {
    /// Zero-supply creation is still creation. An identity absent from inputs
    /// cannot be authorized by spending another asset with the same ticker.
    pub fn is_historical_issuance(&self) -> bool {
        matches!(self.identity.protocol, FungibleProtocol::HistoricalFt(_) | FungibleProtocol::HistoricalTbc20 | FungibleProtocol::HistoricalStableCoin(_))
            && self.output_count != 0
            && (self.input_count == 0 || self.output_amount > self.input_amount)
    }
}

/// Aggregate one transaction's authenticated fungible pairs. The input list
/// contains only spent Code outputs, never Tape inputs or unused sibling Code
/// outputs. Duplicate entries fail rather than crediting their value twice.
/// This deliberately does not classify NFTs, pools, or arbitrary scripts, and
/// must not be used alone as a whole-transaction "allowed" decision.
pub fn fungible_changes(
    inputs: &[(OutPoint, FungiblePair)],
    outputs: &[(u32, FungiblePair)],
) -> Result<Vec<FungibleChange>, String> {
    let mut changes = BTreeMap::<FungibleIdentity, FungibleChange>::new();
    let mut input_ids = BTreeSet::new();
    let mut output_ids = BTreeSet::new();
    for (outpoint, pair) in inputs {
        if !input_ids.insert((*outpoint.txid.as_le_bytes(), outpoint.vout)) {
            return Err("duplicate fungible input outpoint".into());
        }
        let change = changes.entry(pair.identity.clone()).or_insert_with(|| empty_change(pair));
        change.input_amount = change.input_amount.checked_add(pair.amount)
            .ok_or("fungible input sum overflow")?;
        change.input_count += 1;
    }
    for (vout, pair) in outputs {
        if !output_ids.insert(*vout) { return Err("duplicate fungible output index".into()); }
        let change = changes.entry(pair.identity.clone()).or_insert_with(|| empty_change(pair));
        change.output_amount = change.output_amount.checked_add(pair.amount)
            .ok_or("fungible output sum overflow")?;
        change.output_count += 1;
    }
    Ok(changes.into_values().collect())
}

fn empty_change(pair: &FungiblePair) -> FungibleChange {
    FungibleChange { identity: pair.identity.clone(), input_amount: 0,
        output_amount: 0, input_count: 0, output_count: 0 }
}
