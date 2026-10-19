//! Native TBC HTLC keyless plans. Authenticated input material and chain context
//! are supplied by the caller; no HTTP, private key, UI or automatic submission.
use std::collections::BTreeSet;
use tbc_sdk::{PublicKey, Transaction, TxIn, TxOut, UtxoInfo, script::Script};
use crate::{EngineError, ErrorCode, signing::{PlannedInput, PlannedOutput, PlannedTransaction,
    PublicSigningContext, UnsignedPlan, MAX_SIGNING_PLAN_INPUTS, MAX_POOL_UNLOCKING_SCRIPT_BYTES}};
use super::{htlc::{Code, REFUND_SEQUENCE}, tbc20_mint::fee_for_size};

pub(crate) const CLAIM_PREFIX: &str = "tbc-htlc-claim:";
pub(crate) const REFUND_DESCRIPTOR: &str = "tbc-htlc-refund";
// Resource bound, NOT a consensus restriction. Includes maximal compressed-key
// signature prefix (107), PUSHDATA2 (3), and OP_TRUE (1) in the shared budget.
pub const MAX_PREIMAGE_BYTES: usize = MAX_POOL_UNLOCKING_SCRIPT_BYTES - 111;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const CHANGE_DUST: u64 = 42;

// Deliberately no Debug: the preimage is secret until the claim is disclosed.
pub enum SpendBranch { Claim(Vec<u8>), Refund }
impl SpendBranch {
    pub fn descriptor(&self) -> Result<String, EngineError> {
        match self {
            Self::Refund => Ok(REFUND_DESCRIPTOR.into()),
            Self::Claim(secret) => {
                if secret.len() > MAX_PREIMAGE_BYTES { return Err(invalid("HTLC preimage exceeds shared script budget")); }
                Ok(format!("{CLAIM_PREFIX}{}", hex(secret)))
            }
        }
    }
    pub(crate) fn parse(value: &str) -> Result<Self, EngineError> {
        if value == REFUND_DESCRIPTOR { return Ok(Self::Refund); }
        let bytes = value.strip_prefix(CLAIM_PREFIX).ok_or_else(|| invalid("Unsupported HTLC branch descriptor"))?;
        if bytes.len() > MAX_PREIMAGE_BYTES * 2 || bytes.len() % 2 != 0
            || !bytes.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(invalid("Invalid HTLC preimage encoding or size"));
        }
        let secret = bytes.as_bytes().chunks_exact(2).map(|b| {
            u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap()
        }).collect();
        Ok(Self::Claim(secret))
    }
    pub(crate) fn verify(&self, code: &Code, key: &[u8;20], sequence: u32, lock: u32) -> Result<(), EngineError> {
        match self {
            Self::Claim(secret) => code.verify_claim(key, secret),
            Self::Refund => code.verify_refund(key, sequence, lock),
        }.map_err(|_| invalid("HTLC branch proof, signer or lock condition does not match"))
    }
    pub(crate) fn suffix(&self) -> Result<Vec<u8>, EngineError> {
        match self {
            Self::Refund => Ok(vec![0]),
            Self::Claim(secret) => {
                if secret.len() > MAX_PREIMAGE_BYTES { return Err(invalid("HTLC preimage exceeds shared script budget")); }
                let mut out = Vec::with_capacity(secret.len()+4);
                // Minimal byte-vector encoding, including numeric one-byte data.
                match secret.as_slice() {
                    [] => out.push(0),
                    [n @ 1..=16] => out.push(0x50 + n),
                    [0x81] => out.push(0x4f),
                    data => {
                        match data.len() {
                            0..=75 => out.push(data.len() as u8),
                            76..=255 => out.extend_from_slice(&[0x4c, data.len() as u8]),
                            _ => { out.push(0x4d); out.extend_from_slice(&(data.len() as u16).to_le_bytes()); }
                        }
                        out.extend_from_slice(data);
                    }
                }
                out.push(0x51); Ok(out)
            }
        }
    }
}
pub(crate) fn is_descriptor(value: &str) -> bool { value == REFUND_DESCRIPTOR || value.starts_with(CLAIM_PREFIX) }
fn invalid(message: &str) -> EngineError { EngineError {code: ErrorCode::InvalidPlan, message: message.into(), path: None} }
fn insufficient() -> EngineError { EngineError {code: ErrorCode::InsufficientFunds, message: "HTLC inputs cannot cover amount and bounded fee".into(), path: None} }
fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
// Plans contain claim material; callers must not log or persist them as ordinary
// diagnostics. Existing plan commitment binds this material without exposing it.
pub struct HtlcPlan { pub unsigned_plan: UnsignedPlan, pub fee: u64, pub maximum_signed_bytes: usize }
fn total(inputs: &[UtxoInfo]) -> Result<u64, EngineError> {
    if inputs.is_empty() || inputs.len() > MAX_SIGNING_PLAN_INPUTS { return Err(invalid("HTLC input count outside shared bounds")); }
    let mut seen = BTreeSet::new(); let mut sum = 0u64;
    for input in inputs {
        if input.satoshis == 0 || !seen.insert((input.outpoint.txid.to_string(), input.outpoint.vout)) {
            return Err(invalid("HTLC input is zero-valued or duplicated"));
        }
        sum = sum.checked_add(input.satoshis).filter(|n| *n <= MAX_SAFE_INTEGER)
            .ok_or_else(|| invalid("HTLC input sum exceeds safe integer range"))?;
    } Ok(sum)
}
fn estimate(inputs: &[UtxoInfo], outputs: Vec<TxOut>, sequence: u32, lock_time: u32, suffix: usize) -> usize {
    Transaction {version: 10, inputs: inputs.iter().map(|u| {
        let mut input = TxIn::new(u.outpoint.clone()); input.sequence = sequence;
        input.script_sig = Script::from_bytes(vec![0;107+suffix]); input
    }).collect(), outputs, lock_time}.serialize().len()
}
#[allow(clippy::too_many_arguments)]
fn assemble(inputs: &[UtxoInfo], signer: &PublicKey, outputs: Vec<TxOut>, fee: u64, size: usize,
    sequence: u32, lock_time: u32, branch: Option<&SpendBranch>, max_fee: u64) -> Result<HtlcPlan, EngineError> {
    if fee > max_fee { return Err(EngineError {code: ErrorCode::FeeCapExceeded, message: "HTLC fee exceeds caller cap".into(), path: None}); }
    let descriptor = branch.map(SpendBranch::descriptor).transpose()?.unwrap_or_default();
    let role = match branch { None => "tbc-htlc-lock", Some(SpendBranch::Claim(_)) => "tbc-htlc-claim", _ => "tbc-htlc-refund" };
    let public = PublicSigningContext {address: signer.address().to_string(), public_key: hex(&signer.to_bytes()), public_key_hash: hex(&signer.hash160())};
    Ok(HtlcPlan {fee, maximum_signed_bytes: size, unsigned_plan: UnsignedPlan {evidence_table: vec![], transactions: vec![PlannedTransaction {
        transaction_id: role.into(), role: role.into(), stage: 0, depends_on: vec![], version: 10, lock_time,
        inputs: inputs.iter().map(|u| PlannedInput {previous_transaction_id: u.outpoint.txid.to_string(), previous_output_index: u.outpoint.vout,
            previous_output_satoshis: u.satoshis, previous_output_script: hex(u.script_pubkey.as_bytes()), sequence,
            unlocking_script: descriptor.clone(), signer: public.clone()}).collect(),
        outputs: outputs.iter().map(|o| PlannedOutput {satoshis: o.satoshis, locking_script: hex(o.script_pubkey.as_bytes())}).collect(),
    }]}})
}
pub fn build_lock_plan(inputs: &[UtxoInfo], sender: &PublicKey, code: &Code, amount: u64, max_fee: u64) -> Result<HtlcPlan, EngineError> {
    let value = total(inputs)?;
    let owner_script = Script::p2pkh(&sender.hash160());
    if code.sender_hash != sender.hash160() || inputs.iter().any(|u| u.script_pubkey != owner_script) {
        return Err(invalid("HTLC funding or refund identity differs from sender"));
    }
    code.supported_lock_time().map_err(|_| invalid("Unsupported safe HTLC lock time"))?;
    if amount == 0 || amount > MAX_SAFE_INTEGER { return Err(invalid("HTLC amount must be positive safe atomic units")); }
    let mut outputs = vec![TxOut {satoshis: amount, script_pubkey: Script::from_bytes(code.encode())}];
    let remaining = value.checked_sub(amount).ok_or_else(insufficient)?;
    let mut with_change = outputs.clone(); with_change.push(TxOut {satoshis: CHANGE_DUST, script_pubkey: owner_script.clone()});
    let size = estimate(inputs, with_change, u32::MAX, 0, 0); let fee = fee_for_size(size)?;
    let (fee, size) = if let Some(change) = remaining.checked_sub(fee).filter(|v| *v >= CHANGE_DUST) {
        outputs.push(TxOut {satoshis: change, script_pubkey: owner_script}); (fee,size)
    } else {
        let size = estimate(inputs, outputs.clone(), u32::MAX, 0, 0);
        if remaining < fee_for_size(size)? { return Err(insufficient()); } (remaining,size)
    };
    assemble(inputs,sender,outputs,fee,size,u32::MAX,0,None,max_fee)
}
/// Refund requires a supplied trusted tip/MTP; script verification alone cannot
/// establish finality. Claims have no HTLC expiry or chain-clock requirement.
pub fn build_spend_plan(inputs: &[UtxoInfo], signer: &PublicKey, branch: &SpendBranch,
    observed_height: Option<u64>, median_time_past: Option<u64>, max_fee: u64) -> Result<HtlcPlan, EngineError> {
    let value = total(inputs)?;
    let codes = inputs.iter().map(|u| Code::decode(u.script_pubkey.as_bytes())
        .map_err(|_| invalid("Unsupported HTLC input template"))).collect::<Result<Vec<_>,_>>()?;
    let (sequence,lock) = if matches!(branch,SpendBranch::Refund) {
        let lock = codes.iter().map(|c| c.supported_lock_time().map_err(|_| invalid("Unsupported HTLC refund lock")))
            .collect::<Result<Vec<_>,_>>()?.into_iter().max().unwrap();
        (REFUND_SEQUENCE,lock)
    } else { (u32::MAX,0) };
    for code in &codes {
        branch.verify(code,&signer.hash160(),sequence,lock)?;
        if matches!(branch,SpendBranch::Refund) {
            code.verify_refund_context(&signer.hash160(),sequence,lock,
                observed_height.ok_or_else(||invalid("HTLC refund requires observed chain context"))?,median_time_past)
                .map_err(|_| invalid("HTLC refund is not mature at supplied chain context"))?;
        }
    }
    let mut outputs = vec![TxOut {satoshis: 1, script_pubkey: Script::p2pkh(&signer.hash160())}];
    let size = estimate(inputs,outputs.clone(),sequence,lock,branch.suffix()?.len()); let fee = fee_for_size(size)?;
    outputs[0].satoshis = value.checked_sub(fee).filter(|v| *v > 0).ok_or_else(insufficient)?;
    assemble(inputs,signer,outputs,fee,size,sequence,lock,Some(branch),max_fee)
}
