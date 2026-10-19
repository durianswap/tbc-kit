//! Bounded, keyless parent inspection and direct-ancestor material linking.
//!
//! Semantic reference: tbc-contract 1.7.0, commit af77616121db340e15bb8b73c197bc2f8d1ee986,
//! lib/util/tbc20/tbc20unlock.ts: getTBC20PreTxData/getTBC20PrePreTxArray.
//! This does not validate the spending script or establish an asset's trusted genesis.
//! In particular, a caller-provided identity is only a constraint; extracting it from
//! the same untrusted candidate does not authenticate that candidate. No HTTP, signer,
//! UTXO-state query, recursive history walk, or persistence is performed here.

use std::collections::{BTreeMap, BTreeSet};

use tbc_sdk::{OutPoint, Transaction};

use super::tbc20::{CodeDescriptor, TapeDescriptor, code_identity, parse_code, parse_tape};
use crate::{EngineError, ErrorCode};

/// Local material-size policy, matching the existing Engine parent-raw bound.
/// This is not a TBC consensus transaction-size limit.
pub const MAX_MATERIAL_TRANSACTION_BYTES: usize = 1_048_576;
const AMOUNT_SLOTS: usize = 6;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AncestorDependency {
    pub parent_input_index: u8,
    /// The script scans slots in reverse: parent vin k maps to proof position 5-k.
    pub proof_slot_index: u8,
    pub outpoint: OutPoint,
}

/// Parsed material linked to a caller-selected outpoint, not a validated spend.
/// Private fields keep the derived dependency set tied to the inspected transaction.
#[derive(Clone, Debug)]
pub struct ParentMaterial {
    transaction: Transaction,
    selected: OutPoint,
    code: CodeDescriptor,
    tape: TapeDescriptor,
    identity: Vec<u8>,
    dependencies: Vec<AncestorDependency>,
}

impl ParentMaterial {
    pub fn transaction(&self) -> &Transaction { &self.transaction }
    pub fn selected(&self) -> &OutPoint { &self.selected }
    pub fn code(&self) -> &CodeDescriptor { &self.code }
    pub fn tape(&self) -> &TapeDescriptor { &self.tape }
    pub fn identity(&self) -> &[u8] { &self.identity }
    pub fn dependencies(&self) -> &[AncestorDependency] { &self.dependencies }
}

fn invalid(message: &str) -> EngineError {
    EngineError { code: ErrorCode::InvalidAncestry, message: message.to_owned(), path: None }
}

fn parse_material(raw: &[u8]) -> Result<Transaction, EngineError> {
    if raw.is_empty() || raw.len() > MAX_MATERIAL_TRANSACTION_BYTES {
        return Err(invalid("TBC20 material exceeds the local transaction-size bound"));
    }
    let tx = Transaction::from_bytes(raw)
        .map_err(|_| invalid("TBC20 material contains malformed transaction bytes"))?;
    if tx.serialize() != raw {
        return Err(invalid("TBC20 material transaction encoding is not canonical"));
    }
    if tx.version != 10 || tx.inputs.is_empty() || tx.outputs.is_empty() {
        return Err(invalid("TBC20 material must be a version-10 transaction with inputs and outputs"));
    }
    Ok(tx)
}

/// Inspect only the selected Code/Tape output and discover the required ancestors.
/// The optional identity must come from a separately trusted asset anchor if used
/// for authentication. Passing None supports discovery, not authorization.
pub fn inspect_parent(
    raw: &[u8],
    selected: &OutPoint,
    expected_identity: Option<&[u8]>,
) -> Result<ParentMaterial, EngineError> {
    let transaction = parse_material(raw)?;
    // Reuse TBC's transaction ID algorithm, not Bitcoin sha256d(raw).
    if transaction.txid() != selected.txid {
        return Err(invalid("TBC20 parent transaction does not match the selected outpoint"));
    }
    if transaction.inputs.len() > AMOUNT_SLOTS {
        return Err(invalid("TBC20 parent transaction exceeds six inputs"));
    }
    let index = usize::try_from(selected.vout)
        .map_err(|_| invalid("TBC20 selected output index is out of range"))?;
    let tape_index = index.checked_add(1)
        .ok_or_else(|| invalid("TBC20 selected output index overflows"))?;
    let code_output = transaction.outputs.get(index)
        .ok_or_else(|| invalid("TBC20 selected Code output is missing"))?;
    let tape_output = transaction.outputs.get(tape_index)
        .ok_or_else(|| invalid("TBC20 selected Code output is not followed by Tape"))?;
    if code_output.satoshis != 500 || tape_output.satoshis != 0 {
        return Err(invalid("TBC20 Code/Tape values must be exactly 500/0 atomic"));
    }
    let code = parse_code(code_output.script_pubkey.as_bytes())
        .map_err(|_| invalid("TBC20 Code does not match the fixed template"))?;
    let tape = parse_tape(tape_output.script_pubkey.as_bytes())
        .map_err(|_| invalid("TBC20 Tape is malformed"))?;
    if usize::from(code.tape_size) != tape_output.script_pubkey.as_bytes().len() {
        return Err(invalid("TBC20 embedded Tape size does not match the adjacent output"));
    }
    let identity = code_identity(code_output.script_pubkey.as_bytes())
        .map_err(|_| invalid("TBC20 Code identity could not be derived"))?;
    if expected_identity.is_some_and(|expected| expected != identity) {
        return Err(invalid("TBC20 Code identity does not match the expected asset constraint"));
    }
    let mut dependencies = Vec::new();
    for (slot, amount) in tape.amounts.iter().enumerate() {
        if *amount == 0 { continue; }
        let input = transaction.inputs.get(slot)
            .ok_or_else(|| invalid("TBC20 nonzero Tape slot has no corresponding parent input"))?;
        dependencies.push(AncestorDependency {
            parent_input_index: slot as u8,
            proof_slot_index: (AMOUNT_SLOTS - 1 - slot) as u8,
            outpoint: input.previous_output.clone(),
        });
    }
    Ok(ParentMaterial {
        transaction, selected: selected.clone(), code, tape, identity, dependencies,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AncestorReference {
    pub transaction_index: usize,
    pub output_index: u32,
    pub parent_input_index: u8,
}

/// Each raw transaction is parsed once even when several nonzero slots reference it.
#[derive(Clone, Debug)]
pub struct LinkedAncestors {
    transactions: Vec<Transaction>,
    proof_slots: [Option<AncestorReference>; AMOUNT_SLOTS],
}

impl LinkedAncestors {
    pub fn transactions(&self) -> &[Transaction] { &self.transactions }
    pub fn proof_slots(&self) -> &[Option<AncestorReference>; AMOUNT_SLOTS] { &self.proof_slots }
}

/// Link an exact, deduplicated set of required ancestor raws. This deliberately
/// accepts ancestors with more than six inputs: the six-input rule applies to the
/// parent, not to these direct ancestor transactions. It does not establish token
/// issuance, amount ancestry, script execution, confirmation, or unspent status.
pub fn link_ancestors(
    parent: &ParentMaterial,
    ancestor_raws: &[&[u8]],
) -> Result<LinkedAncestors, EngineError> {
    let required: BTreeSet<String> = parent.dependencies.iter()
        .map(|entry| entry.outpoint.txid.to_string()).collect();
    if ancestor_raws.len() > AMOUNT_SLOTS {
        return Err(invalid("TBC20 ancestor material exceeds the six-slot bound"));
    }
    let mut transactions = Vec::new();
    let mut indices = BTreeMap::new();
    for raw in ancestor_raws {
        let transaction = parse_material(raw)?;
        let txid = transaction.txid().to_string();
        if !required.contains(&txid) || indices.contains_key(&txid) {
            return Err(invalid("TBC20 ancestor material is unrelated or duplicated"));
        }
        indices.insert(txid, transactions.len());
        transactions.push(transaction);
    }
    let mut proof_slots = std::array::from_fn(|_| None);
    for dependency in &parent.dependencies {
        let index = indices.get(&dependency.outpoint.txid.to_string())
            .copied().ok_or_else(|| EngineError {
                code: ErrorCode::MissingMaterial,
                message: "TBC20 required direct ancestor material is missing".to_owned(),
                path: None,
            })?;
        let output = transactions[index].outputs.get(dependency.outpoint.vout as usize)
            .ok_or_else(|| invalid("TBC20 ancestor reference points to a missing output"))?;
        if output.script_pubkey.as_bytes().is_empty() {
            return Err(invalid("TBC20 ancestor referenced output has an empty locking script"));
        }
        proof_slots[usize::from(dependency.proof_slot_index)] = Some(AncestorReference {
            transaction_index: index,
            output_index: dependency.outpoint.vout,
            parent_input_index: dependency.parent_input_index,
        });
    }
    Ok(LinkedAncestors { transactions, proof_slots })
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::tbc20::{build_tape, instantiate_code};
    use tbc_sdk::{TxIn, TxOut, Txid, script::Script};

    fn ancestor(inputs: usize) -> Transaction {
        let mut tx = Transaction::new();
        tx.version = 10;
        for i in 0..inputs {
            tx.inputs.push(TxIn::new(OutPoint { txid: Txid::from_le_bytes([i as u8 + 1; 32]), vout: 0 }));
        }
        tx.outputs.push(TxOut { satoshis: 1000, script_pubkey: Script::p2pkh(&[7; 20]) });
        tx.outputs.push(TxOut { satoshis: 1000, script_pubkey: Script::p2pkh(&[8; 20]) });
        tx
    }

    fn parent(ancestor: &Transaction, amounts: [u64; 6]) -> Transaction {
        let mut tx = Transaction::new();
        tx.version = 10;
        tx.inputs.push(TxIn::new(OutPoint { txid: ancestor.txid(), vout: 0 }));
        tx.inputs.push(TxIn::new(OutPoint { txid: ancestor.txid(), vout: 1 }));
        let descriptor = CodeDescriptor { original_outpoint: [1; 36], tape_size: 61, controller: [0; 21] };
        tx.outputs.push(TxOut { satoshis: 500, script_pubkey: Script::from_bytes(instantiate_code(&descriptor).unwrap()) });
        tx.outputs.push(TxOut { satoshis: 0, script_pubkey: Script::from_bytes(build_tape(amounts, &[9]).unwrap()) });
        tx
    }

    fn inspect(tx: &Transaction) -> Result<ParentMaterial, EngineError> {
        inspect_parent(&tx.serialize(), &OutPoint { txid: tx.txid(), vout: 0 }, None)
    }

    #[test]
    fn tbc20_material_links_only_nonzero_slots_in_reverse_proof_order() {
        let ancestor = ancestor(7); // Parent bound must not leak into ancestor validation.
        let parent = inspect(&parent(&ancestor, [11, 22, 0, 0, 0, 0])).unwrap();
        let linked = link_ancestors(&parent, &[&ancestor.serialize()]).unwrap();
        assert_eq!(linked.transactions().len(), 1);
        assert_eq!(parent.tape().balance, 33);
        assert_eq!(parent.dependencies().len(), 2);
        assert_eq!(linked.proof_slots()[5].as_ref().unwrap().parent_input_index, 0);
        assert_eq!(linked.proof_slots()[4].as_ref().unwrap().output_index, 1);
        assert_eq!(linked.proof_slots()[4].as_ref().unwrap().transaction_index, 0);
        assert!(linked.proof_slots()[0..4].iter().all(Option::is_none));
    }

    #[test]
    fn tbc20_material_rejects_wrong_selected_outpoint_or_identity() {
        let tx = parent(&ancestor(1), [1, 0, 0, 0, 0, 0]);
        let wrong = OutPoint { txid: Txid::from_le_bytes([9; 32]), vout: 0 };
        assert!(inspect_parent(&tx.serialize(), &wrong, None).is_err());
        let selected = OutPoint { txid: tx.txid(), vout: 0 };
        assert!(inspect_parent(&tx.serialize(), &selected, Some(&[0; 33])).is_err());
        let discovered = inspect(&tx).unwrap();
        assert!(inspect_parent(&tx.serialize(), &selected, Some(discovered.identity())).is_ok());
        assert!(inspect_parent(&tx.serialize(), &OutPoint { vout: u32::MAX, ..selected }, None).is_err());
    }

    #[test]
    fn tbc20_material_rejects_layout_value_version_and_slot_mismatch() {
        let tx = parent(&ancestor(1), [1, 0, 0, 0, 0, 0]);
        let mut bad = tx.clone(); bad.outputs[0].satoshis = 499; assert!(inspect(&bad).is_err());
        let mut bad = tx.clone(); bad.outputs[1].satoshis = 1; assert!(inspect(&bad).is_err());
        let mut bad = tx.clone(); bad.outputs.pop(); assert!(inspect(&bad).is_err());
        let mut bad = tx.clone(); bad.version = 9; assert!(inspect(&bad).is_err());
        let mut bad = tx.clone(); bad.inputs.clear(); assert!(inspect(&bad).is_err());
        let mut bad = tx.clone(); bad.inputs.resize(7, tx.inputs[0].clone()); assert!(inspect(&bad).is_err());
        let mut bad = tx.clone();
        bad.outputs[1].script_pubkey = Script::from_bytes(build_tape([1, 0, 1, 0, 0, 0], &[9]).unwrap());
        assert!(inspect(&bad).is_err());
        let mut bad = tx;
        bad.outputs[1].script_pubkey = Script::from_bytes(build_tape([1, 0, 0, 0, 0, 0], &[0, 9]).unwrap());
        assert!(inspect(&bad).is_err());
    }

    #[test]
    fn tbc20_material_requires_exact_ancestor_set_and_existing_nonempty_output() {
        let source = ancestor(1);
        let p = inspect(&parent(&source, [1, 0, 0, 0, 0, 0])).unwrap();
        assert_eq!(link_ancestors(&p, &[]).unwrap_err().code, ErrorCode::MissingMaterial);
        assert!(link_ancestors(&p, &[&ancestor(2).serialize()]).is_err());
        let raw = source.serialize();
        assert!(link_ancestors(&p, &[&raw, &raw]).is_err());
        let mut empty = source.clone(); empty.outputs[0].script_pubkey = Script::empty();
        let p = inspect(&parent(&empty, [1, 0, 0, 0, 0, 0])).unwrap();
        assert!(link_ancestors(&p, &[&empty.serialize()]).is_err());
        let mut tx = parent(&source, [1, 0, 0, 0, 0, 0]);
        tx.inputs[0].previous_output.vout = 99;
        assert!(link_ancestors(&inspect(&tx).unwrap(), &[&raw]).is_err());
    }

    #[test]
    fn tbc20_material_zero_slots_do_not_require_ancestor_reads() {
        let p = inspect(&parent(&ancestor(1), [0; 6])).unwrap();
        assert!(p.dependencies().is_empty());
        let linked = link_ancestors(&p, &[]).unwrap();
        assert!(linked.transactions().is_empty());
        assert!(linked.proof_slots().iter().all(Option::is_none));
        // Structural parsing deliberately does not certify a nonzero or valid asset supply.
    }

    #[test]
    fn tbc20_material_raw_limits_and_trailing_bytes_fail_before_linking() {
        let tx = parent(&ancestor(1), [1, 0, 0, 0, 0, 0]);
        let selected = OutPoint { txid: tx.txid(), vout: 0 };
        let mut trailing = tx.serialize(); trailing.push(0);
        assert!(inspect_parent(&trailing, &selected, None).is_err());
        assert!(inspect_parent(&[], &selected, None).is_err());
        assert!(inspect_parent(&vec![0; MAX_MATERIAL_TRANSACTION_BYTES + 1], &selected, None).is_err());
    }
}
