//! Keyless, bounded TBC20 consolidation over one immutable material snapshot.
//! Every round reuses the canonical single-transaction builder. Preview txids are
//! local construction handles only: typed Planned references resolve signed IDs.
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use tbc_sdk::{OutPoint, PublicKey, Transaction, TxIn, TxOut, script::Script};
use crate::{EngineError, ErrorCode, signing::{EvidenceEntry, TransactionSource, UnsignedPlan,
    bind_funding_recipe, parse_tbc20_unlock_recipe, tbc20_unlocking_descriptor}};
use super::{tbc20::{parse_code, parse_tape}, tbc20_material::{ParentMaterial, LinkedAncestors, inspect_parent, link_ancestors},
    tbc20_transfer::{FeeInput, Receiver, TokenInput, TokenOutput, TransferOptions, TransferPlan, build_transfer_plan, build_merge_plan}};

pub struct BatchOptions<'a> {
    pub transfer: TransferOptions<'a>,
    pub max_transactions: usize,
}

#[derive(Debug)]
pub struct BatchPlan {
    pub unsigned_plan: UnsignedPlan,
    /// Final business outputs, not intermediary maintenance outputs.
    pub token_outputs: Vec<TokenOutput>,
    pub fees: Vec<u64>,
    pub maximum_signed_bytes: Vec<usize>,
}

struct Token { parent: ParentMaterial, ancestors: LinkedAncestors, key: PublicKey }
struct Fee { outpoint: OutPoint, output: TxOut, key: PublicKey }
struct Preview { raw: String, planned_id: String }
fn invalid(message: &str) -> EngineError {
    EngineError { code: ErrorCode::InvalidPlan, message: message.to_owned(), path: None }
}
fn bytes(value: &str) -> Result<Vec<u8>, EngineError> {
    if !value.is_ascii() || value.len() % 2 != 0 { return Err(invalid("invalid internal hex")); }
    (0..value.len()).step_by(2).map(|i| u8::from_str_radix(&value[i..i+2],16)
        .map_err(|_| invalid("invalid internal hex"))).collect()
}
fn preview(plan: &TransferPlan) -> Result<Transaction, EngineError> {
    let planned = &plan.unsigned_plan.transactions[0];
    let mut tx = Transaction::new(); tx.version = planned.version; tx.lock_time = planned.lock_time;
    for input in &planned.inputs {
        let mut vin = TxIn::new(OutPoint { txid: input.previous_transaction_id.parse()
            .map_err(|_| invalid("invalid preview input ID"))?, vout: input.previous_output_index });
        vin.sequence = input.sequence; tx.inputs.push(vin);
    }
    for output in &planned.outputs { tx.outputs.push(TxOut { satoshis: output.satoshis,
        script_pubkey: Script::from_bytes(bytes(&output.locking_script)?) }); }
    Ok(tx)
}
fn single(plan: TransferPlan) -> BatchPlan {
    BatchPlan { unsigned_plan: plan.unsigned_plan, token_outputs: plan.token_outputs,
        fees: vec![plan.fee], maximum_signed_bytes: vec![plan.maximum_signed_bytes] }
}

pub fn build_batch_transfer_plan(options: BatchOptions<'_>) -> Result<BatchPlan, EngineError> {
    build(options, false)
}
pub fn build_batch_merge_plan(options: BatchOptions<'_>) -> Result<BatchPlan, EngineError> {
    build(options, true)
}

fn build(options: BatchOptions<'_>, merge: bool) -> Result<BatchPlan, EngineError> {
    let original = options.transfer;
    if merge && original.payment.is_some() {
        return Err(invalid("TBC20 merge cannot include a native payment"));
    }
    if options.max_transactions == 0 || original.inputs.is_empty() || original.inputs.len() > 128 {
        return Err(invalid("TBC20 batch requires 1..128 token inputs and a positive bundle limit"));
    }
    if original.inputs.len() + original.fee_inputs.len() <= 6 {
        let controller = original.token_change_controller;
        return Ok(single(if merge { build_merge_plan(original, controller)? } else { build_transfer_plan(original)? }));
    }
    if original.fee_inputs.len() > 1 {
        return Err(invalid("TBC20 multi-round maintenance supports at most one selected fee input"));
    }
    let token_owner = original.inputs.iter().map(|input| input.public_key).find(|key| {
        let mut controller = [0;21]; controller[..20].copy_from_slice(&key.hash160());
        controller == original.token_change_controller
    }).ok_or_else(|| invalid("maintenance controller must match a supplied token owner"))?.clone();
    let fee_owner = original.fee_inputs.iter().map(|fee| fee.public_key)
        .chain(original.inputs.iter().map(|input| input.public_key))
        .find(|key| key.hash160() == original.native_change_hash)
        .ok_or_else(|| invalid("maintenance native change must match a supplied public owner"))?.clone();
    let mut seen = BTreeSet::new();
    for point in original.inputs.iter().map(|input| input.parent.selected())
        .chain(original.fee_inputs.iter().map(|input| &input.outpoint)) {
        if !seen.insert((point.txid.to_string(),point.vout)) { return Err(invalid("batch repeats an original outpoint")); }
    }
    let mut queue: VecDeque<_> = original.inputs.iter().map(|input| Token {
        parent: input.parent.clone(), ancestors: input.ancestors.clone(), key: input.public_key.clone(),
    }).collect();
    let mut fee = original.fee_inputs.first().map(|input| Fee {
        outpoint: input.outpoint.clone(), output: input.output.clone(), key: input.public_key.clone(),
    });
    let mut aggregate = BatchPlan { unsigned_plan: UnsignedPlan { transactions: vec![], evidence_table: vec![] },
        token_outputs: vec![], fees: vec![], maximum_signed_bytes: vec![] };
    let mut previews: BTreeMap<String, Preview> = BTreeMap::new();
    let mut global_evidence = BTreeMap::<String,u32>::new();
    let mut total_fee = 0u64;
    loop {
        if aggregate.unsigned_plan.transactions.len() >= options.max_transactions {
            return Err(invalid("TBC20 maintenance exceeds the policy bundle transaction limit"));
        }
        let capacity = 6 - usize::from(fee.is_some());
        let final_round = queue.len() <= capacity;
        let selected: Vec<_> = queue.drain(..queue.len().min(capacity)).collect();
        let inputs: Vec<_> = selected.iter().map(|input| TokenInput {
            parent: &input.parent, ancestors: &input.ancestors, public_key: &input.key,
        }).collect();
        let fees: Vec<_> = fee.iter().map(|fee| FeeInput { outpoint: fee.outpoint.clone(),
            output: &fee.output, public_key: &fee.key }).collect();
        let merge_receivers = [Receiver { controller: original.token_change_controller,
            amount: inputs.iter().map(|input| input.parent.tape().balance).sum() }];
        let round_options = TransferOptions { inputs: &inputs, fee_inputs: &fees,
            receivers: if final_round && !merge { original.receivers } else { &merge_receivers },
            payment: if final_round && !merge { original.payment } else { None },
            expected_identity: original.expected_identity, token_change_controller: original.token_change_controller,
            native_change_hash: original.native_change_hash, max_fee: original.max_fee - total_fee };
        let mut round = if final_round && !merge { build_transfer_plan(round_options)? }
            else { build_merge_plan(round_options, original.token_change_controller)? };
        if !final_round && round.token_outputs.len() >= selected.len() {
            return Err(invalid("TBC20 amount-slot capacity prevents a reducing maintenance round"));
        }
        let preview_tx = preview(&round)?;
        let preview_id = preview_tx.txid().to_string();
        if previews.contains_key(&preview_id) { return Err(invalid("maintenance preview transaction collision")); }
        let id = if final_round { if merge { "tbc20-standard-merge".to_owned() } else { "tbc20-standard-transfer".to_owned() } }
            else { format!("tbc20-standard-maintenance-{}", aggregate.fees.len()) };
        let mut local_indices = BTreeMap::new();
        for (index, entry) in round.unsigned_plan.evidence_table.iter().enumerate() {
            if previews.contains_key(&entry.txid) { continue; }
            let global = if let Some(existing) = global_evidence.get(&entry.txid) {
                if aggregate.unsigned_plan.evidence_table[*existing as usize] != *entry {
                    return Err(invalid("conflicting immutable TBC20 evidence"));
                }
                *existing
            } else {
                let global = aggregate.unsigned_plan.evidence_table.len() as u32;
                aggregate.unsigned_plan.evidence_table.push(EvidenceEntry { txid: entry.txid.clone(), raw_transaction: entry.raw_transaction.clone() });
                global_evidence.insert(entry.txid.clone(),global); global
            };
            local_indices.insert(index as u32,global);
        }
        let transaction = &mut round.unsigned_plan.transactions[0];
        transaction.transaction_id = id.clone();
        if !final_round { transaction.role = "maintenance".to_owned(); }
        let mut dependencies = Vec::new();
        for input in &mut transaction.inputs {
            if let Some(prior) = previews.get(&input.previous_transaction_id) {
                input.previous_transaction_id = prior.planned_id.clone();
                if !dependencies.contains(&prior.planned_id) { dependencies.push(prior.planned_id.clone()); }
            }
            if input.unlocking_script.is_empty() { continue; }
            for (txid, prior) in &previews {
                let indices: Vec<_> = round.unsigned_plan.evidence_table.iter().enumerate()
                    .filter(|(_,entry)| &entry.txid == txid && entry.raw_transaction == prior.raw)
                    .map(|(i,_)| i as u32).collect();
                input.unlocking_script = bind_funding_recipe(&input.unlocking_script,&prior.raw,&indices,&prior.planned_id)?;
            }
            let mut recipe = parse_tbc20_unlock_recipe(&input.unlocking_script)?;
            let remap = |source: &mut TransactionSource| -> Result<(), EngineError> {
                match source {
                    TransactionSource::Evidence(index) => *index = *local_indices.get(index)
                        .ok_or_else(|| invalid("unbound maintenance evidence index"))?,
                    // Proof-only ancestors are reachable through direct spend
                    // dependencies; they must not become extra direct edges.
                    TransactionSource::Planned(_) => {},
                    TransactionSource::Raw(_) => return Err(invalid("unexpected inline maintenance evidence")),
                } Ok(())
            };
            remap(&mut recipe.parent)?;
            for proof in &mut recipe.proof_references { remap(&mut proof.source)?; }
            if let Some(controller) = &mut recipe.contract_controller { remap(&mut controller.source)?; }
            input.unlocking_script = tbc20_unlocking_descriptor(recipe)?;
        }
        transaction.depends_on = dependencies;
        transaction.stage = transaction.depends_on.iter().map(|dependency| aggregate.unsigned_plan.transactions.iter()
            .find(|prior| &prior.transaction_id == dependency).map(|prior| prior.stage + 1)
            .ok_or_else(|| invalid("maintenance dependency is missing")))
            .collect::<Result<Vec<_>,_>>()?.into_iter().max().unwrap_or(0);
        total_fee = total_fee.checked_add(round.fee).ok_or_else(|| invalid("batch fee overflow"))?;
        aggregate.fees.push(round.fee); aggregate.maximum_signed_bytes.push(round.maximum_signed_bytes);
        aggregate.unsigned_plan.transactions.push(round.unsigned_plan.transactions.remove(0));
        if final_round { aggregate.token_outputs = round.token_outputs; return Ok(aggregate); }
        // Scan actual output structure: token allocation may create multiple pairs.
        let raw = preview_tx.serialize();
        let mut created = 0;
        fee = None;
        let mut ancestors = BTreeMap::new();
        for token in &selected { ancestors.insert(token.parent.transaction().txid().to_string(), token.parent.transaction().serialize()); }
        for (vout,output) in preview_tx.outputs.iter().enumerate() {
            if parse_code(output.script_pubkey.as_bytes()).is_ok() {
                let parent = inspect_parent(&raw,&OutPoint {txid:preview_tx.txid(),vout:vout as u32},Some(original.expected_identity))?;
                let required: BTreeSet<_> = parent.dependencies().iter().map(|d|d.outpoint.txid.to_string()).collect();
                let raws = required.iter().map(|txid| ancestors.get(txid).map(Vec::as_slice)
                    .ok_or_else(|| invalid("maintenance ancestor closure is incomplete"))).collect::<Result<Vec<_>,_>>()?;
                let linked = link_ancestors(&parent,&raws)?;
                queue.push_back(Token { parent, ancestors:linked, key:token_owner.clone() }); created += 1;
            } else if output.script_pubkey == Script::p2pkh(&original.native_change_hash) {
                if fee.is_some() { return Err(invalid("multiple native maintenance change outputs")); }
                fee = Some(Fee { outpoint:OutPoint {txid:preview_tx.txid(),vout:vout as u32},output:output.clone(),key:fee_owner.clone() });
            } else if output.satoshis != 0 || parse_tape(output.script_pubkey.as_bytes()).is_err() {
                return Err(invalid("unknown maintenance output structure"));
            }
        }
        if created != round.token_outputs.len() { return Err(invalid("maintenance output tracking disagrees with allocation")); }
        previews.insert(preview_id,Preview {raw:preview_tx.to_hex(),planned_id:id});
    }
}
