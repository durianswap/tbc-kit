//! Keyless Coin parent/ancestor binding and the pinned 123-field ABI.
//! Reference: tbc-contract 1.7.0 / af776161, coinTbc20unlock.ts (OpenTBC).
//! Shared proof encoding is intentionally identical to the fixed TBC20 ABI;
//! issuer identity, controller roles, locks and allocations are Coin-specific.
//! Compressed ECDSA and x-only BIP340 profiles share the same proof encoding,
//! with strict key/signature pairing and public-only verification.

use std::collections::{BTreeMap, BTreeSet};
use tbc_sdk::{hash, OutPoint, Transaction, DEFAULT_SIGHASH,
    script::Script, sighash::forkid_sighash};
use super::covenant_signature::CovenantPublicKey;
use crate::{EngineError, ErrorCode};
use super::coin;
use super::tbc20_material::MAX_MATERIAL_TRANSACTION_BYTES;
use super::tbc20_proof::{check_transaction, unsigned_script_num, output_fields,
    group_fields, current_output_fields};
use super::transaction_proof::{input_record, input_records, inputs_hash_data,
    unlocking_scripts_hash, output_records, vlio, push_data};
pub use super::tbc20_proof::{OutputGroup, ContractControllerWitness};

pub const UNLOCK_LEAF_COUNT: usize = 123;
const SIGNATURE_LEAF: usize = 98;

fn invalid(message: &str) -> EngineError {
    EngineError { code: ErrorCode::InvalidAncestry, message: message.into(), path: None }
}
fn parse_material(raw: &[u8]) -> Result<Transaction, EngineError> {
    if raw.is_empty() || raw.len() > MAX_MATERIAL_TRANSACTION_BYTES {
        return Err(invalid("Coin material exceeds the local raw transaction bound"));
    }
    let tx = Transaction::from_bytes(raw).map_err(|_| invalid("Coin material is malformed"))?;
    check_transaction(&tx)?;
    if tx.serialize() != raw { return Err(invalid("Coin material encoding is not canonical")); }
    Ok(tx)
}

#[derive(Clone, Debug)]
pub struct ParentMaterial {
    transaction: Transaction,
    selected: OutPoint,
    code: coin::CodeDescriptor,
    tape: coin::TapeDescriptor,
    identity: Vec<u8>,
    dependencies: Vec<OutPoint>,
}
impl ParentMaterial {
    pub fn transaction(&self) -> &Transaction { &self.transaction }
    pub fn selected(&self) -> &OutPoint { &self.selected }
    pub fn code(&self) -> &coin::CodeDescriptor { &self.code }
    pub fn tape(&self) -> &coin::TapeDescriptor { &self.tape }
    pub fn identity(&self) -> &[u8] { &self.identity }
    /// Absolute nonzero vin slots, with repeated outpoints retained for rejection.
    pub fn dependencies(&self) -> &[OutPoint] { &self.dependencies }
}

/// Identity is an optional independent anchor constraint, not an assertion that
/// parsing an untrusted parent's own identity proves a trusted issuance.
pub fn inspect_parent(raw: &[u8], selected: &OutPoint, expected_identity: Option<&[u8]>) -> Result<ParentMaterial, EngineError> {
    let transaction = parse_material(raw)?;
    if transaction.txid() != selected.txid || transaction.inputs.len() > 6 {
        return Err(invalid("Coin selected parent or six-input boundary differs"));
    }
    let index = selected.vout as usize;
    let code_output = transaction.outputs.get(index).ok_or_else(|| invalid("Coin Code output missing"))?;
    let tape_output = transaction.outputs.get(index.checked_add(1).ok_or_else(|| invalid("Coin Tape index overflow"))?)
        .ok_or_else(|| invalid("Coin adjacent Tape missing"))?;
    if code_output.satoshis != 500 || tape_output.satoshis != 0 { return Err(invalid("Coin Code/Tape amounts must be 500/0")); }
    let code = coin::parse_code(code_output.script_pubkey.as_bytes()).map_err(|_| invalid("Coin Code template invalid"))?;
    let tape = coin::parse_tape(tape_output.script_pubkey.as_bytes(), Some(code.tape_size as usize)).map_err(|_| invalid("Coin Tape invalid"))?;
    let identity = coin::code_identity(code_output.script_pubkey.as_bytes()).map_err(|_| invalid("Coin identity invalid"))?;
    if expected_identity.is_some_and(|expected| expected != identity) { return Err(invalid("Coin identity differs from the independent anchor")); }
    let mut seen = BTreeSet::new();
    for input in &transaction.inputs {
        if !seen.insert((input.previous_output.txid.to_string(), input.previous_output.vout)) { return Err(invalid("Coin parent repeats an input")); }
    }
    let mut dependencies = Vec::new();
    for (slot, amount) in tape.amounts.iter().enumerate() {
        if *amount == 0 { continue; }
        dependencies.push(transaction.inputs.get(slot).ok_or_else(|| invalid("Coin nonzero amount slot has no parent input"))?.previous_output.clone());
    }
    Ok(ParentMaterial { transaction, selected: selected.clone(), code, tape, identity, dependencies })
}

pub struct UnlockOptions<'a> {
    pub current_tx: &'a Transaction,
    pub input_index: usize,
    pub parent: &'a ParentMaterial,
    /// Exact deduplicated set of direct ancestors; no recursive walk or fetching.
    pub ancestor_raws: &'a [&'a [u8]],
    pub output_groups: &'a [OutputGroup],
    pub public_key: &'a [u8],
    pub contract_controller: Option<ContractControllerWitness<'a>>,
}
#[derive(Clone, Debug)]
pub struct PreparedUnlock { fields: Vec<Vec<u8>>, digest: [u8; 32], public_key: CovenantPublicKey }
impl PreparedUnlock {
    pub fn signing_digest(&self) -> &[u8; 32] { &self.digest }
    pub fn public_key(&self) -> &[u8] { self.public_key.bytes() }
    pub fn proof_fields(&self) -> &[Vec<u8>] { &self.fields }
    pub fn max_unlocking_script_bytes(&self) -> usize { self.encode(&vec![0;self.public_key.maximum_transaction_signature_bytes()]).as_bytes().len() }
    fn encode(&self, signature: &[u8]) -> Script {
        let mut bytes = Vec::new();
        for (i, field) in self.fields.iter().enumerate() { push_data(&mut bytes, if i == SIGNATURE_LEAF { signature } else { field }); }
        Script::from_bytes(bytes)
    }
    pub fn finalize(&self, signature: &[u8]) -> Result<Script, EngineError> {
        self.public_key.verify_transaction_signature(&self.digest,signature)?;
        Ok(self.encode(signature))
    }
}

fn ancestor_fields(options: &UnlockOptions<'_>) -> Result<Vec<Vec<u8>>, EngineError> {
    let parent = options.parent;
    if options.ancestor_raws.len() > 6 { return Err(invalid("Coin ancestor set exceeds six required slots")); }
    let required: BTreeSet<_> = parent.dependencies.iter().map(|p| p.txid.to_string()).collect();
    let mut by_id = BTreeMap::new();
    for raw in options.ancestor_raws {
        let tx = parse_material(raw)?; let id = tx.txid().to_string();
        if !required.contains(&id) || by_id.insert(id, tx).is_some() { return Err(invalid("Coin ancestor is unrelated or duplicated")); }
    }
    let mut fields = Vec::with_capacity(48);
    for slot in (0..6).rev() {
        if parent.tape.amounts[slot] == 0 { fields.resize(fields.len()+8, Vec::new()); continue; }
        let point = &parent.transaction.inputs[slot].previous_output;
        let tx = by_id.get(&point.txid.to_string()).ok_or_else(|| EngineError {
            code: ErrorCode::MissingMaterial, message: "Coin required direct ancestor is missing".into(), path: None })?;
        let vout = point.vout as usize;
        let output = tx.outputs.get(vout).ok_or_else(|| invalid("Coin ancestor output is missing"))?;
        let same_coin = coin::code_identity(output.script_pubkey.as_bytes()).is_ok_and(|identity| identity == parent.identity);
        let issuer = slot == 0 && vout == 0 && hash::sha256(output.script_pubkey.as_bytes()) == parent.code.coin_nft_code_hash;
        if !same_coin && !issuer { return Err(invalid("Coin ancestor is neither this identity nor its bound issuance certificate")); }
        fields.push(vlio(tx)); fields.push(inputs_hash_data(tx)); fields.push(output_records(&tx.outputs[..vout]));
        fields.extend(output_fields(output)?); fields.push(output_records(&tx.outputs[vout+1..]));
    }
    Ok(fields)
}

fn controller_fields(options: &UnlockOptions<'_>, administrator: bool) -> Result<(Vec<Vec<u8>>, usize), EngineError> {
    let controller = &options.parent.code.controller;
    if administrator || controller[20] == 0 {
        if options.contract_controller.is_some() { return Err(invalid("Coin administrator/address role must not include a contract witness")); }
        if !administrator && hash::hash160(options.public_key) != controller[..20] { return Err(invalid("Coin key is not its address owner")); }
        return Ok((vec![Vec::new(); 6], 0));
    }
    let witness = options.contract_controller.as_ref().ok_or_else(|| invalid("Coin contract witness required"))?;
    if witness.current_input_index == options.input_index { return Err(invalid("Coin cannot control its own input")); }
    check_transaction(witness.transaction)?;
    let input = options.current_tx.inputs.get(witness.current_input_index).ok_or_else(|| invalid("Coin controller input is missing"))?;
    if input.previous_output.txid != witness.transaction.txid() { return Err(invalid("Coin controller transaction differs")); }
    let vout = input.previous_output.vout as usize;
    let output = witness.transaction.outputs.get(vout).ok_or_else(|| invalid("Coin controller output is missing"))?;
    let code_hash = hash::sha256(output.script_pubkey.as_bytes());
    if hash::hash160(&code_hash) != controller[..20] { return Err(invalid("Coin controller does not match the consumed contract")); }
    Ok((vec![vlio(witness.transaction), inputs_hash_data(witness.transaction), output_records(&witness.transaction.outputs[..vout]),
        output.satoshis.to_le_bytes().to_vec(), code_hash.to_vec(), output_records(&witness.transaction.outputs[vout+1..])], witness.current_input_index))
}

pub fn prepare_unlock(options: UnlockOptions<'_>) -> Result<PreparedUnlock, EngineError> {
    let tx = options.current_tx; let parent = options.parent;
    check_transaction(tx)?;
    if tx.inputs.len() > 6 || options.input_index >= 6 { return Err(invalid("Coin current transaction exceeds six inputs")); }
    let input = tx.inputs.get(options.input_index).ok_or_else(|| invalid("Coin current input is missing"))?;
    if input.previous_output != parent.selected { return Err(invalid("Coin current input does not spend the inspected parent")); }
    let mut seen = BTreeSet::new();
    for input in &tx.inputs { if !seen.insert((input.previous_output.txid.to_string(), input.previous_output.vout)) { return Err(invalid("Coin current transaction repeats an input")); } }
    let public_key=CovenantPublicKey::parse(options.public_key)?;
    let administrator = hash::hash160(public_key.bytes()) == parent.code.admin_pubkey_hash;
    let selected = parent.selected.vout as usize;
    coin::verify_input_lock(input.sequence, tx.lock_time, parent.transaction.outputs[selected+1].script_pubkey.as_bytes(), Some(parent.code.tape_size as usize), administrator)
        .map_err(|_| invalid("Coin input lock domain, maturity requirement or sequence is invalid"))?;
    let (controller, controller_vin) = controller_fields(&options, administrator)?;
    let mut fields = current_output_fields(tx, options.output_groups)?;
    let mut allocated = 0u128;
    for group in options.output_groups {
        let output = &tx.outputs[group.code_vout]; let bytes = output.script_pubkey.as_bytes();
        if bytes.len() == parent.code.tape_size as usize && bytes.ends_with(b"TBC20TAPE") { return Err(invalid("Coin Tape must not be hidden in a Code field")); }
        let Some(tape_vout) = group.tape_vout else { continue; };
        let tape = &tx.outputs[tape_vout]; let raw = tape.script_pubkey.as_bytes();
        if raw.len() != parent.code.tape_size as usize { continue; }
        // Same envelope/amount check as upstream readTBC20TapeAmounts, before
        // stricter Coin metadata/lock validation on nonzero allocations.
        if !raw.starts_with(&[0, 0x6a, 0x30]) || !raw.ends_with(b"TBC20TAPE") { return Err(invalid("Coin allocation Tape envelope invalid")); }
        let mut amounts = [0u64; 6];
        for (i, amount) in amounts.iter_mut().enumerate() {
            *amount = u64::from_le_bytes(raw[3+i*8..11+i*8].try_into().unwrap());
            if *amount > super::tbc20::MAX_SLOT_AMOUNT { return Err(invalid("Coin allocation amount exceeds one slot")); }
        }
        let amount = amounts[options.input_index]; allocated += amount as u128;
        if amount == 0 { continue; }
        if output.satoshis != 500 || tape.satoshis != 0 || coin::code_identity(bytes).map_err(|_| invalid("Coin recipient template invalid"))? != parent.identity {
            return Err(invalid("Coin output changes identity or Code/Tape amounts"));
        }
        coin::parse_tape(raw, Some(parent.code.tape_size as usize)).map_err(|_| invalid("Coin output Tape invalid"))?;
    }
    if allocated != parent.tape.balance { return Err(invalid("Coin output allocations do not conserve the absolute input slot")); }
    fields.push(input_records(tx)); fields.push(unsigned_script_num(options.input_index));
    fields.extend(ancestor_fields(&options)?); fields.push(Vec::new()); fields.push(public_key.bytes().to_vec());
    fields.extend(controller); fields.push(unsigned_script_num(controller_vin));
    fields.push(vlio(&parent.transaction));
    for vin in 0..6 { fields.push(if vin < parent.transaction.inputs.len() { input_record(&parent.transaction, vin) } else { Vec::new() }); }
    fields.push(unlocking_scripts_hash(&parent.transaction)); fields.push(output_records(&parent.transaction.outputs[..selected]));
    fields.extend(group_fields(&parent.transaction.outputs[selected], Some(&parent.transaction.outputs[selected+1]))?);
    fields.push(output_records(&parent.transaction.outputs[selected+2..]));
    if fields.len() != UNLOCK_LEAF_COUNT { return Err(invalid("Coin proof ABI count is not 123")); }
    let previous = &parent.transaction.outputs[selected];
    let digest = forkid_sighash(tx, options.input_index, &previous.script_pubkey, previous.satoshis, DEFAULT_SIGHASH).map_err(|_| invalid("Coin digest cannot be formed"))?;
    Ok(PreparedUnlock { fields, digest, public_key })
}
