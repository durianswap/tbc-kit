//! Pure address-holder TBC20 transfer/merge planning over caller-selected material.
//! Shares the existing staged signing protocol; no keys, HTTP, selection policy,
//! database, approvals, implicit consolidation, or broadcasting are embedded here.
//! Fixed behavior: tbc-contract af776161 / TBC20.transfer and TBC20.merge.

use std::collections::{BTreeMap, BTreeSet};
use tbc_sdk::{OutPoint, PublicKey, Transaction, TxIn, TxOut, script::Script};
use crate::{EngineError, ErrorCode, signing::{
    EvidenceEntry, PlannedInput, PlannedOutput, PlannedTransaction, ProofReference,
    PublicSigningContext, Tbc20OutputGroup, Tbc20UnlockRecipe, TransactionSource,
    UnsignedPlan, tbc20_unlocking_descriptor,
}};
use super::{
    tbc20::{MAX_SLOT_AMOUNT, build_tape, replace_controller},
    tbc20_material::{LinkedAncestors, ParentMaterial},
    tbc20_mint::fee_for_size,
    tbc20_proof::{OutputGroup, UnlockOptions, prepare_unlock},
};

pub struct TokenInput<'a> {
    pub parent: &'a ParentMaterial,
    pub ancestors: &'a LinkedAncestors,
    pub public_key: &'a PublicKey,
}

pub struct FeeInput<'a> {
    pub outpoint: OutPoint,
    pub output: &'a TxOut,
    pub public_key: &'a PublicKey,
}

#[derive(Clone, Debug)]
pub struct Receiver {
    pub controller: [u8; 21],
    pub amount: u128,
}

#[derive(Debug)]
pub struct TokenOutput {
    pub controller: [u8; 21],
    pub amount: u128,
    pub amounts_by_input: [u64; 6],
}

pub struct TransferOptions<'a> {
    pub inputs: &'a [TokenInput<'a>],
    pub fee_inputs: &'a [FeeInput<'a>],
    pub receivers: &'a [Receiver],
    /// A separate, fixed native output. Never interpreted as automatic change.
    pub payment: Option<NativePayment>,
    /// Must be bound to the selected network and independently trusted asset.
    /// An identity copied from the same untrusted input is not authentication.
    pub expected_identity: &'a [u8],
    pub token_change_controller: [u8; 21],
    pub native_change_hash: [u8; 20],
    pub max_fee: u64,
}

#[derive(Clone, Copy)]
pub struct NativePayment {
    pub recipient_hash: [u8; 20],
    pub amount: u64,
}

#[derive(Debug)]
pub struct TransferPlan {
    pub unsigned_plan: UnsignedPlan,
    pub token_outputs: Vec<TokenOutput>,
    pub fee: u64,
    pub maximum_signed_bytes: usize,
}

fn invalid(message: &str) -> EngineError {
    EngineError { code: ErrorCode::InvalidPlan, message: message.to_owned(), path: None }
}

fn insufficient(message: &str) -> EngineError {
    EngineError { code: ErrorCode::InsufficientFunds, message: message.to_owned(), path: None }
}

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() }

pub(crate) fn public_context(key: &PublicKey) -> PublicSigningContext {
    PublicSigningContext { address: key.address().to_string(), public_key: hex(&key.to_bytes()),
        public_key_hash: hex(&key.hash160()) }
}

pub(crate) fn allocate(
    remaining: &mut [u128], controller: [u8; 21], mut needed: u128,
    outputs: &mut Vec<TokenOutput>,
) -> Result<(), EngineError> {
    while needed != 0 {
        if outputs.len() == 8 { return Err(invalid("TBC20 amount allocation exceeds eight token output groups")); }
        let mut slots = [0; 6];
        let mut allocated = 0;
        for (index, available) in remaining.iter_mut().enumerate() {
            let used = (*available).min(MAX_SLOT_AMOUNT as u128).min(needed);
            slots[index] = used as u64;
            *available -= used; needed -= used; allocated += used;
            if needed == 0 { break; }
        }
        if allocated == 0 { return Err(insufficient("TBC20 receivers exceed available balance")); }
        outputs.push(TokenOutput { controller, amount: allocated, amounts_by_input: slots });
    }
    Ok(())
}

pub(crate) fn intern(tx: &Transaction, table: &mut Vec<EvidenceEntry>, ids: &mut BTreeMap<String, u32>) -> TransactionSource {
    let txid = tx.txid().to_string();
    let index = *ids.entry(txid.clone()).or_insert_with(|| {
        let index = table.len() as u32;
        table.push(EvidenceEntry { txid, raw_transaction: tx.to_hex() });
        index
    });
    TransactionSource::Evidence(index)
}

/// Produces an immutable-meaning plan, not authorization. Core/Host must bind and
/// revalidate the returned plan before shared begin_signing accepts signatures.
pub fn build_transfer_plan(options: TransferOptions<'_>) -> Result<TransferPlan, EngineError> {
    let count = options.inputs.len();
    if count == 0 || count > 6 || count + options.fee_inputs.len() > 6 {
        return Err(invalid("TBC20 transfer requires one to six total selected inputs"));
    }
    if options.receivers.is_empty() || options.receivers.len() > 8 {
        return Err(invalid("TBC20 transfer requires one to eight receivers"));
    }
    let first = options.inputs[0].parent;
    let first_script = first.transaction().outputs[first.selected().vout as usize].script_pubkey.as_bytes();
    let mut seen = BTreeSet::new();
    let mut remaining = Vec::with_capacity(count);
    let mut tx = Transaction::new();
    let mut native_total = 0u64;
    for input in options.inputs {
        let parent = input.parent;
        if options.expected_identity.is_empty() || parent.identity() != options.expected_identity
            || parent.tape().extension != first.tape().extension
        { return Err(invalid("TBC20 inputs differ from the bound asset identity or Tape envelope")); }
        let mut owner = [0; 21]; owner[..20].copy_from_slice(&input.public_key.hash160());
        if parent.code().controller != owner {
            return Err(invalid("TBC20 address-holder planner requires the matching address controller"));
        }
        let outpoint = parent.selected();
        if !seen.insert((outpoint.txid.to_string(), outpoint.vout)) {
            return Err(invalid("TBC20 selected inputs repeat an outpoint"));
        }
        remaining.push(parent.tape().balance);
        tx.inputs.push(TxIn::new(outpoint.clone()));
        native_total += 500;
    }
    for fee in options.fee_inputs {
        if fee.output.script_pubkey != Script::p2pkh(&fee.public_key.hash160())
            || fee.output.satoshis > 9_007_199_254_740_991
        { return Err(invalid("TBC20 fee input must match its public owner and SDK amount range")); }
        if !seen.insert((fee.outpoint.txid.to_string(), fee.outpoint.vout)) {
            return Err(invalid("TBC20 fee input duplicates a selected input"));
        }
        native_total = native_total.checked_add(fee.output.satoshis)
            .filter(|sum| *sum <= 9_007_199_254_740_991)
            .ok_or_else(|| invalid("TBC20 native input total exceeds the SDK amount range"))?;
        tx.inputs.push(TxIn::new(fee.outpoint.clone()));
    }
    let mut token_outputs = Vec::new();
    for receiver in options.receivers {
        if receiver.amount == 0 { return Err(invalid("TBC20 receiver amount must be positive")); }
        if receiver.amount > remaining.iter().sum() {
            return Err(insufficient("TBC20 receiver amount exceeds selected token balance"));
        }
        allocate(&mut remaining, receiver.controller, receiver.amount, &mut token_outputs)?;
    }
    let change = remaining.iter().sum();
    allocate(&mut remaining, options.token_change_controller, change, &mut token_outputs)?;
    let mut groups = Vec::new();
    for output in &token_outputs {
        groups.push(OutputGroup { code_vout: tx.outputs.len(), tape_vout: Some(tx.outputs.len() + 1) });
        tx.outputs.push(TxOut { satoshis: 500, script_pubkey: Script::from_bytes(
            replace_controller(first_script, output.controller).map_err(|_| invalid("invalid TBC20 recipient controller"))?) });
        tx.outputs.push(TxOut { satoshis: 0, script_pubkey: Script::from_bytes(
            build_tape(output.amounts_by_input, &first.tape().extension).map_err(|_| invalid("invalid TBC20 output Tape"))?) });
    }
    let mut available = native_total.checked_sub(500 * token_outputs.len() as u64)
        .ok_or_else(|| insufficient("TBC20 funding cannot pay Code outputs"))?;
    if let Some(payment) = options.payment {
        if !(42..=9_007_199_254_740_991).contains(&payment.amount) {
            return Err(invalid("TBC20 payment must be non-dust and within the SDK safe amount range"));
        }
        if groups.len() >= 8 { return Err(invalid("TBC20 has no output group left for native payment")); }
        available = available.checked_sub(payment.amount)
            .ok_or_else(|| insufficient("TBC20 funding cannot pay the attached native amount"))?;
        groups.push(OutputGroup { code_vout: tx.outputs.len(), tape_vout: None });
        tx.outputs.push(TxOut { satoshis: payment.amount,
            script_pubkey: Script::p2pkh(&payment.recipient_hash) });
    }
    let change_script = Script::p2pkh(&options.native_change_hash);
    let estimate = |tx: &Transaction, groups: &[OutputGroup]| -> Result<usize, EngineError> {
        let mut sized = tx.clone();
        for (index, input) in options.inputs.iter().enumerate() {
            let prepared = prepare_unlock(UnlockOptions { current_tx: tx, input_index: index,
                parent: input.parent, ancestors: input.ancestors, output_groups: groups,
                public_key: &input.public_key.to_bytes(), contract_controller: None })?;
            sized.inputs[index].script_sig = Script::from_bytes(vec![0; prepared.max_unlocking_script_bytes()]);
        }
        for input in &mut sized.inputs[count..] { input.script_sig = Script::from_bytes(vec![0; 107]); }
        Ok(sized.serialize().len())
    };
    let can_add_change = groups.len() < 8;
    let mut selected = None;
    if can_add_change {
        let mut with_change = tx.clone(); let mut change_groups = groups.clone();
        change_groups.push(OutputGroup { code_vout: with_change.outputs.len(), tape_vout: None });
        with_change.outputs.push(TxOut { satoshis: 42, script_pubkey: change_script });
        let size = estimate(&with_change, &change_groups)?;
        let fee = fee_for_size(size)?;
        if let Some(value) = available.checked_sub(fee).filter(|value| *value >= 42) {
            with_change.outputs.last_mut().unwrap().satoshis = value;
            selected = Some((with_change, change_groups, fee, size));
        }
    }
    let (tx, groups, fee, maximum_signed_bytes) = if let Some(selected) = selected { selected } else {
        let size = estimate(&tx, &groups)?;
        let required = fee_for_size(size)?;
        if available < required { return Err(insufficient("TBC20 funding cannot pay automatic fee")); }
        if !can_add_change && available - required >= 42 {
            return Err(invalid("TBC20 has no group left for a non-dust native change output"));
        }
        (tx, groups, available, size)
    };
    if fee > options.max_fee {
        return Err(EngineError { code: ErrorCode::FeeCapExceeded,
            message: "TBC20 transfer exceeds the caller's fee cap".to_owned(), path: None });
    }
    let mut evidence_table = Vec::new(); let mut ids = BTreeMap::new();
    let mut inputs = Vec::new();
    for input in options.inputs {
        let parent = intern(input.parent.transaction(), &mut evidence_table, &mut ids);
        let mut proof_references = Vec::new(); let mut distinct = BTreeSet::new();
        for reference in input.ancestors.proof_slots().iter().flatten() {
            let ancestor = &input.ancestors.transactions()[reference.transaction_index];
            if distinct.insert((ancestor.txid().to_string(), reference.output_index)) {
                proof_references.push(ProofReference {
                    source: intern(ancestor, &mut evidence_table, &mut ids), output_index: reference.output_index,
                });
            }
        }
        let output = &input.parent.transaction().outputs[input.parent.selected().vout as usize];
        inputs.push(PlannedInput { previous_transaction_id: input.parent.selected().txid.to_string(),
            previous_output_index: input.parent.selected().vout, previous_output_script: hex(output.script_pubkey.as_bytes()),
            previous_output_satoshis: 500, sequence: tbc_sdk::DEFAULT_SEQUENCE, signer: public_context(input.public_key),
            unlocking_script: tbc20_unlocking_descriptor(Tbc20UnlockRecipe {
                parent, proof_references, output_groups: groups.iter().map(|g| Tbc20OutputGroup {
                    code_vout: g.code_vout as u32, tape_vout: g.tape_vout.map(|v| v as u32),
                }).collect(), contract_controller: None,
            })? });
    }
    for fee in options.fee_inputs {
        inputs.push(PlannedInput { previous_transaction_id: fee.outpoint.txid.to_string(),
            previous_output_index: fee.outpoint.vout, previous_output_script: hex(fee.output.script_pubkey.as_bytes()),
            previous_output_satoshis: fee.output.satoshis, sequence: tbc_sdk::DEFAULT_SEQUENCE,
            signer: public_context(fee.public_key), unlocking_script: String::new() });
    }
    Ok(TransferPlan { unsigned_plan: UnsignedPlan { evidence_table, transactions: vec![PlannedTransaction {
        transaction_id: "tbc20-standard-transfer".to_owned(), role: "tbc20-standard-transfer".to_owned(),
        stage: 0, depends_on: Vec::new(), version: 10, inputs,
        outputs: tx.outputs.iter().map(|output| PlannedOutput { satoshis: output.satoshis,
            locking_script: hex(output.script_pubkey.as_bytes()) }).collect(), lock_time: 0,
    }] }, token_outputs, fee, maximum_signed_bytes })
}

/// Merge is the same allocation/proof/fee path with the complete balance as one
/// recipient request. Very large balances may still require several legal groups.
pub fn build_merge_plan(options: TransferOptions<'_>, controller: [u8; 21]) -> Result<TransferPlan, EngineError> {
    if options.payment.is_some() { return Err(invalid("TBC20 merge does not accept a native payment")); }
    if options.inputs.is_empty() || options.inputs.len() > 6
        || options.fee_inputs.len() > 6 - options.inputs.len()
    { return Err(invalid("TBC20 merge requires one to six total selected inputs")); }
    let total = options.inputs.iter().map(|input| input.parent.tape().balance).sum();
    let receivers = [Receiver { controller, amount: total }];
    let mut result = build_transfer_plan(TransferOptions { receivers: &receivers, ..options })?;
    result.unsigned_plan.transactions[0].transaction_id = "tbc20-standard-merge".to_owned();
    result.unsigned_plan.transactions[0].role = "tbc20-standard-merge".to_owned();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tbc20_allocation_splits_single_input_above_slot_max_without_losing_amount() {
        let cap = MAX_SLOT_AMOUNT as u128;
        let mut remaining = [cap + 1, 7];
        let mut outputs = Vec::new();
        allocate(&mut remaining, [0; 21], cap + 8, &mut outputs).unwrap();
        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[0].amounts_by_input, [MAX_SLOT_AMOUNT, 7, 0, 0, 0, 0]);
        assert_eq!(outputs[1].amounts_by_input, [1, 0, 0, 0, 0, 0]);
        assert_eq!(remaining, [0, 0]);
        assert_eq!(outputs.iter().map(|o| o.amount).sum::<u128>(), cap + 8);
    }
}
