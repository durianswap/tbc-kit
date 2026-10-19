//! Fixed TBC20 parent/ancestor proof and 123-leaf unlocking ABI, without keys.
//!
//! Semantic reference: tbc-contract 1.7.0 / af77616121db340e15bb8b73c197bc2f8d1ee986,
//! lib/util/tbc20/tbc20unlock.ts. Upstream declares OpenTBC; release permission
//! remains a separate gate. This extraction does not relicense upstream as CC0.
//!
//! The existing vendor's older TBC20 template is NOT the reference for this ABI.
//! Only shared transaction/hash/ECDSA verification primitives are reused.
//! Encoding a proof is not executing the covenant or certifying genesis/unspent
//! status. The planner/validator must separately establish those business facts.

use std::collections::BTreeSet;

use tbc_sdk::{
    DEFAULT_SIGHASH, PublicKey, Transaction, TxOut, hash,
    contracts::ft::partial_sha256::calculate_partial_hash,
    script::Script,
    sighash::{forkid_sighash, verify_low_s_ecdsa},
};

use super::tbc20_material::{LinkedAncestors, MAX_MATERIAL_TRANSACTION_BYTES, ParentMaterial};
use crate::{EngineError, ErrorCode};
use super::transaction_proof::{input_record, input_records, unlocking_scripts_hash, inputs_hash_data, vlio, output_records, push_data};

pub const UNLOCK_LEAF_COUNT: usize = 123;
const SIGNATURE_LEAF: usize = 98;
const MAX_SAFE_SATOSHIS: u64 = 9_007_199_254_740_991;
// Maximum-size low-S DER+0x41 reservation, not a valid signature for the spend.
pub(crate) const MAX_SIGNATURE: [u8; 72] = [
    0x30, 0x45, 0x02, 0x21, 0x00, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x20, 0x01,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x41,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OutputGroup {
    pub code_vout: usize,
    pub tape_vout: Option<usize>,
}

#[derive(Clone, Copy, Debug)]
pub struct ContractControllerWitness<'a> {
    pub transaction: &'a Transaction,
    pub current_input_index: usize,
}

pub struct UnlockOptions<'a> {
    pub current_tx: &'a Transaction,
    pub input_index: usize,
    pub parent: &'a ParentMaterial,
    pub ancestors: &'a LinkedAncestors,
    pub output_groups: &'a [OutputGroup],
    pub public_key: &'a [u8],
    pub contract_controller: Option<ContractControllerWitness<'a>>,
}

/// All fields derive from one immutable preparation snapshot. Finalize consumes
/// only an external signature and does not revisit parent/ancestor resolvers.
#[derive(Clone, Debug)]
pub struct PreparedUnlock {
    fields: Vec<Vec<u8>>,
    digest: [u8; 32],
    public_key: [u8; 33],
}

impl PreparedUnlock {
    /// Shared 123-leaf ECDSA ABI container. Protocol-specific planners must have
    /// validated parent, ancestors, allocation and role before calling this.
    pub(crate) fn from_parts(fields: Vec<Vec<u8>>, digest: [u8;32], public_key: [u8;33]) -> Result<Self,EngineError> {
        if fields.len()!=UNLOCK_LEAF_COUNT || !fields[SIGNATURE_LEAF].is_empty()
            || fields[SIGNATURE_LEAF+1]!=public_key {
            return Err(invalid("Prepared covenant proof has an inconsistent signature/key slot"));
        }
        PublicKey::from_slice(&public_key).map_err(|_|invalid("Prepared covenant public key is invalid"))?;
        Ok(Self {fields,digest,public_key})
    }
    pub fn signing_digest(&self) -> &[u8; 32] { &self.digest }
    pub fn public_key(&self) -> &[u8; 33] { &self.public_key }
    /// Read-only ABI inspection; signature leaf 98 is deliberately empty.
    pub fn proof_fields(&self) -> &[Vec<u8>] { &self.fields }
    /// Pre-sign fee bound only. No fake signed transaction is returned.
    pub fn max_unlocking_script_bytes(&self) -> usize {
        self.encode_with_signature(&MAX_SIGNATURE).as_bytes().len()
    }
    /// Strict external signature verification before returning the filled ABI.
    /// Covenant execution remains the responsibility of the final validator.
    pub fn finalize(&self, signature: &[u8]) -> Result<Script, EngineError> {
        if !canonical_signature(signature) {
            return Err(invalid("TBC20 signature must be canonical DER with SIGHASH_ALL|FORKID"));
        }
        let public_key = PublicKey::from_slice(&self.public_key)
            .map_err(|_| invalid("TBC20 prepared public key is invalid"))?;
        let verified = verify_low_s_ecdsa(&public_key, &self.digest, &signature[..signature.len() - 1])
            .map_err(|_| invalid("TBC20 signature could not be verified"))?;
        if !verified { return Err(invalid("TBC20 signature does not match the prepared digest or low-S rule")); }
        Ok(self.encode_with_signature(signature))
    }

    fn encode_with_signature(&self, signature: &[u8]) -> Script {
        let mut bytes = Vec::new();
        for (index, field) in self.fields.iter().enumerate() {
            push_data(&mut bytes, if index == SIGNATURE_LEAF { signature } else { field });
        }
        Script::from_bytes(bytes)
    }
}

fn invalid(message: &str) -> EngineError {
    EngineError { code: ErrorCode::InvalidAncestry, message: message.to_owned(), path: None }
}

pub(crate) fn check_transaction(tx: &Transaction) -> Result<(), EngineError> {
    if tx.version != 10 || tx.inputs.is_empty() || tx.outputs.is_empty()
        || tx.inputs.len() > i32::MAX as usize || tx.outputs.len() > i32::MAX as usize
    { return Err(invalid("TBC20 proof requires a nonempty version-10 transaction")); }
    // Same local material bound as the parent inspector, not a consensus limit.
    if tx.serialize().len() > MAX_MATERIAL_TRANSACTION_BYTES {
        return Err(invalid("TBC20 proof transaction exceeds the local material bound"));
    }
    if tx.outputs.iter().any(|output| output.satoshis > MAX_SAFE_SATOSHIS) {
        return Err(invalid("TBC20 proof output exceeds the fixed SDK safe-integer amount range"));
    }
    Ok(())
}

pub(crate) fn unsigned_script_num(mut value: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    while value > 0 { bytes.push((value & 255) as u8); value >>= 8; }
    if bytes.last().is_some_and(|byte| byte & 0x80 != 0) { bytes.push(0); }
    bytes
}


pub(crate) fn output_fields(output: &TxOut) -> Result<Vec<Vec<u8>>, EngineError> {
    let script = output.script_pubkey.as_bytes();
    if script.is_empty() { return Err(invalid("TBC20 proven output script must not be empty")); }
    let offset = script.len() / 64 * 64;
    Ok(vec![
        output.satoshis.to_le_bytes().to_vec(),
        script[offset..].to_vec(),
        if offset == 0 { Vec::new() } else { calculate_partial_hash(&script[..offset]).to_vec() },
        unsigned_script_num(script.len()),
    ])
}

pub(crate) fn group_fields(code: &TxOut, tape: Option<&TxOut>) -> Result<Vec<Vec<u8>>, EngineError> {
    let mut fields = output_fields(code)?;
    fields.push(tape.map(|output| output.satoshis.to_le_bytes().to_vec()).unwrap_or_default());
    fields.push(tape.map(|output| output.script_pubkey.as_bytes().to_vec()).unwrap_or_default());
    Ok(fields)
}

pub(crate) fn current_output_fields(tx: &Transaction, groups: &[OutputGroup]) -> Result<Vec<Vec<u8>>, EngineError> {
    if tx.outputs.len() > 16 || groups.is_empty() || groups.len() > 8 {
        return Err(invalid("TBC20 outputs exceed eight logical groups or sixteen physical outputs"));
    }
    let mut fields = Vec::with_capacity(48);
    let mut next = 0;
    for group in groups {
        if group.code_vout != next || next >= tx.outputs.len() {
            return Err(invalid("TBC20 output groups do not preserve physical output order"));
        }
        let tape = if let Some(index) = group.tape_vout {
            if index != next + 1 || index >= tx.outputs.len() {
                return Err(invalid("TBC20 grouped Tape must immediately follow Code"));
            }
            Some(&tx.outputs[index])
        } else { None };
        fields.extend(group_fields(&tx.outputs[next], tape)?);
        next += if tape.is_some() { 2 } else { 1 };
    }
    if next != tx.outputs.len() { return Err(invalid("TBC20 output groups leave uncovered physical outputs")); }
    fields.resize(48, Vec::new());
    Ok(fields)
}

/// Parent proof's 16 ABI leaves, from the already inspected Code/Tape outpoint.
pub fn parent_proof_fields(parent: &ParentMaterial) -> Result<Vec<Vec<u8>>, EngineError> {
    let tx = parent.transaction();
    check_transaction(tx)?;
    let index = parent.selected().vout as usize;
    let mut fields = vec![vlio(tx)];
    for vin in 0..6 { fields.push(if vin < tx.inputs.len() { input_record(tx, vin) } else { Vec::new() }); }
    fields.push(unlocking_scripts_hash(tx));
    fields.push(output_records(&tx.outputs[..index]));
    fields.extend(group_fields(&tx.outputs[index], Some(&tx.outputs[index + 1]))?);
    fields.push(output_records(&tx.outputs[index + 2..]));
    Ok(fields)
}

/// Six reverse-indexed ancestor proofs, eight leaves each. Rebinds a supplied
/// LinkedAncestors object to this parent; passing another parent's object fails.
pub fn ancestor_proof_fields(parent: &ParentMaterial, linked: &LinkedAncestors) -> Result<Vec<Vec<u8>>, EngineError> {
    let mut fields = Vec::with_capacity(48);
    let mut used = BTreeSet::new();
    for proof_slot in 0..6 {
        let vin = 5 - proof_slot;
        let reference = &linked.proof_slots()[proof_slot];
        if parent.tape().amounts[vin] == 0 {
            if reference.is_some() { return Err(invalid("TBC20 zero slot has unrelated ancestor proof")); }
            fields.resize(fields.len() + 8, Vec::new());
            continue;
        }
        let reference = reference.as_ref().ok_or_else(|| invalid("TBC20 nonzero slot has no ancestor proof"))?;
        let input = parent.transaction().inputs.get(vin).ok_or_else(|| invalid("TBC20 parent slot has no input"))?;
        let ancestor = linked.transactions().get(reference.transaction_index)
            .ok_or_else(|| invalid("TBC20 ancestor reference is out of range"))?;
        if reference.parent_input_index as usize != vin || reference.output_index != input.previous_output.vout
            || ancestor.txid() != input.previous_output.txid
        { return Err(invalid("TBC20 ancestor proof does not match this parent input")); }
        if used.insert(reference.transaction_index) { check_transaction(ancestor)?; }
        let index = reference.output_index as usize;
        let output = ancestor.outputs.get(index).ok_or_else(|| invalid("TBC20 ancestor output is missing"))?;
        fields.push(vlio(ancestor));
        fields.push(inputs_hash_data(ancestor));
        fields.push(output_records(&ancestor.outputs[..index]));
        fields.extend(output_fields(output)?);
        fields.push(output_records(&ancestor.outputs[index + 1..]));
    }
    if used.len() != linked.transactions().len() {
        return Err(invalid("TBC20 ancestor proof contains unrelated transactions"));
    }
    Ok(fields)
}

fn controller_fields(options: &UnlockOptions<'_>) -> Result<(Vec<Vec<u8>>, usize), EngineError> {
    let controller = &options.parent.code().controller;
    if controller[20] == 0 {
        if options.contract_controller.is_some() {
            return Err(invalid("TBC20 address controller must not include contract witness"));
        }
        return Ok((vec![Vec::new(); 6], 0));
    }
    let witness = options.contract_controller.as_ref()
        .ok_or_else(|| invalid("TBC20 contract controller witness is required"))?;
    check_transaction(witness.transaction)?;
    let input = options.current_tx.inputs.get(witness.current_input_index)
        .ok_or_else(|| invalid("TBC20 controlling current input index is invalid"))?;
    if input.previous_output.txid != witness.transaction.txid() {
        return Err(invalid("TBC20 controlling current input references a different transaction"));
    }
    let index = input.previous_output.vout as usize;
    let output = witness.transaction.outputs.get(index)
        .ok_or_else(|| invalid("TBC20 controlling output is missing"))?;
    let script = output.script_pubkey.as_bytes();
    if script.is_empty() || hash::hash160(&hash::sha256(script)) != controller[..20] {
        return Err(invalid("TBC20 contract controller does not match the controlling script"));
    }
    Ok((vec![
        vlio(witness.transaction), inputs_hash_data(witness.transaction),
        output_records(&witness.transaction.outputs[..index]),
        output.satoshis.to_le_bytes().to_vec(), hash::sha256(script).to_vec(),
        output_records(&witness.transaction.outputs[index + 1..]),
    ], witness.current_input_index))
}

pub fn prepare_unlock(options: UnlockOptions<'_>) -> Result<PreparedUnlock, EngineError> {
    check_transaction(options.current_tx)?;
    // The public transaction builder must produce spendable new TBC20 outputs:
    // unlike the low-level JS helper, never accept >6 total current inputs.
    if options.current_tx.inputs.len() > 6 || options.input_index >= 6 {
        return Err(invalid("TBC20 current transaction exceeds the six-input bound"));
    }
    let input = options.current_tx.inputs.get(options.input_index)
        .ok_or_else(|| invalid("TBC20 input index is out of range"))?;
    if &input.previous_output != options.parent.selected() {
        return Err(invalid("TBC20 current input does not spend the inspected parent outpoint"));
    }
    let mut outpoints = BTreeSet::new();
    for input in &options.current_tx.inputs {
        if !outpoints.insert((input.previous_output.txid.to_string(), input.previous_output.vout)) {
            return Err(invalid("TBC20 current transaction repeats an input outpoint"));
        }
    }
    let public_key: [u8; 33] = options.public_key.try_into()
        .map_err(|_| invalid("TBC20 public key must be compressed and 33 bytes"))?;
    PublicKey::from_slice(&public_key).map_err(|_| invalid("TBC20 public key is invalid"))?;
    let controller = &options.parent.code().controller;
    if controller[20] == 0 && hash::hash160(&public_key) != controller[..20] {
        return Err(invalid("TBC20 public key does not match the address controller"));
    }
    let (contract, contract_input_index) = controller_fields(&options)?;
    let mut fields = current_output_fields(options.current_tx, options.output_groups)?;
    fields.push(input_records(options.current_tx));
    fields.push(unsigned_script_num(options.input_index));
    fields.extend(ancestor_proof_fields(options.parent, options.ancestors)?);
    fields.push(Vec::new()); // Signature supplied later, after exact digest approval.
    fields.push(public_key.to_vec());
    fields.extend(contract);
    fields.push(unsigned_script_num(contract_input_index));
    fields.extend(parent_proof_fields(options.parent)?);
    if fields.len() != UNLOCK_LEAF_COUNT { return Err(invalid("TBC20 internal proof ABI count differs from 123")); }
    let previous = &options.parent.transaction().outputs[options.parent.selected().vout as usize];
    let digest = forkid_sighash(options.current_tx, options.input_index, &previous.script_pubkey, previous.satoshis, DEFAULT_SIGHASH)
        .map_err(|_| invalid("TBC20 signing digest could not be formed"))?;
    Ok(PreparedUnlock { fields, digest, public_key })
}

pub(crate) fn canonical_signature(signature: &[u8]) -> bool {
    // Match upper bound and 65-byte prohibition in the fixed upstream helper.
    if !(9..=72).contains(&signature.len()) || signature.len() == 65
        || signature.last() != Some(&0x41) || signature[0] != 0x30
        || usize::from(signature[1]) != signature.len() - 3 || signature[2] != 2
    { return false; }
    let r_len = usize::from(signature[3]);
    if r_len == 0 || 5 + r_len >= signature.len() || signature[4] & 0x80 != 0
        || (r_len > 1 && signature[4] == 0 && signature[5] & 0x80 == 0)
        || signature[4 + r_len] != 2
    { return false; }
    let s_len = usize::from(signature[5 + r_len]);
    let s = 6 + r_len;
    s_len > 0 && r_len + s_len + 7 == signature.len()
        && signature[s] & 0x80 == 0
        && !(s_len > 1 && signature[s] == 0 && signature[s + 1] & 0x80 == 0)
}


#[cfg(test)]
mod tests {
    use super::*;
    use super::super::{tbc20::replace_controller, tbc20_material::{inspect_parent, link_ancestors}};
    use tbc_sdk::{OutPoint, TxIn, Txid};

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../../fixtures/tbc20-standard-transaction.json")).unwrap()
    }

    fn unhex(value: &serde_json::Value) -> Vec<u8> {
        let hex = value.as_str().unwrap();
        assert_eq!(hex.len() % 2, 0);
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
    }

    struct Case {
        current: Transaction,
        parent: ParentMaterial,
        ancestors: LinkedAncestors,
        groups: Vec<OutputGroup>,
        key: Vec<u8>,
        input_index: usize,
    }

    impl Case {
        fn load(vector: &serde_json::Value) -> Self {
            let raw = unhex(&vector["parentRaw"]);
            let parent_tx = Transaction::from_bytes(&raw).unwrap();
            let selected = OutPoint {
                txid: parent_tx.txid(), vout: vector["parentCodeVout"].as_u64().unwrap() as u32,
            };
            let parent = inspect_parent(&raw, &selected, None).unwrap();
            let ancestor_raws: Vec<_> = vector["ancestorsRaw"].as_array().unwrap().iter().map(unhex).collect();
            let ancestors = link_ancestors(&parent, &ancestor_raws.iter().map(Vec::as_slice).collect::<Vec<_>>()).unwrap();
            Self {
                current: Transaction::from_bytes(&unhex(&vector["currentRaw"])).unwrap(),
                parent, ancestors,
                groups: vector["outputGroups"].as_array().unwrap().iter().map(|group| OutputGroup {
                    code_vout: group["codeVout"].as_u64().unwrap() as usize,
                    tape_vout: group["tapeVout"].as_u64().map(|n| n as usize),
                }).collect(),
                key: unhex(&vector["pubkeyHex"]), input_index: vector["inputIndex"].as_u64().unwrap() as usize,
            }
        }
        fn options(&self) -> UnlockOptions<'_> {
            UnlockOptions {
                current_tx: &self.current, input_index: self.input_index,
                parent: &self.parent, ancestors: &self.ancestors,
                output_groups: &self.groups, public_key: &self.key, contract_controller: None,
            }
        }
    }

    #[test]
    fn tbc20_proof_matches_upstream_all_123_leaves_script_txid_and_sighash() {
        let fixture = fixture();
        let vectors = fixture["vectors"].as_array().unwrap();
        assert_eq!(vectors.len(), 2);
        for vector in vectors {
            let id = vector["id"].as_str().unwrap();
            let case = Case::load(vector);
            assert_eq!(case.current.txid().to_string(), vector["currentUnsignedTxid"].as_str().unwrap(), "{id}");
            assert_eq!(case.parent.transaction().txid().to_string(), vector["parentTxid"].as_str().unwrap(), "{id}");
            let prepared = prepare_unlock(case.options()).unwrap();
            let expected = vector["unlockPushesHex"].as_array().unwrap();
            assert_eq!(expected.len(), UNLOCK_LEAF_COUNT);
            for (index, leaf) in prepared.proof_fields().iter().enumerate() {
                if index == SIGNATURE_LEAF { assert!(leaf.is_empty()); continue; }
                assert_eq!(leaf, &unhex(&expected[index]), "{id}: leaf {index}");
            }
            let signature = unhex(&vector["signatureHex"]);
            assert_eq!(prepared.encode_with_signature(&signature).as_bytes(), unhex(&vector["unlockHex"]), "{id}");
            // JS Sighash.sighash returns reversed SHA256d and signs with 'little'.
            // Rust's Signer receives the unreversed 32 digest bytes for secp256k1.
            let mut upstream_digest = unhex(&vector["digestHex"]); upstream_digest.reverse();
            assert_eq!(prepared.signing_digest().as_slice(), upstream_digest, "{id}");
            assert!(prepared.max_unlocking_script_bytes() >= unhex(&vector["unlockHex"]).len());
            // The fixture's r=1/s=1 DER is an ABI placeholder, not a real signature.
            assert!(prepared.finalize(&signature).is_err());
        }
    }

    #[test]
    fn tbc20_proof_rejects_mismatched_material_output_coverage_and_signer() {
        let fixture = fixture();
        let mut first = Case::load(&fixture["vectors"][0]);
        let second = Case::load(&fixture["vectors"][1]);
        let mut options = first.options(); options.ancestors = &second.ancestors;
        assert!(prepare_unlock(options).is_err());
        let mut options = first.options(); options.input_index = 6;
        assert!(prepare_unlock(options).is_err());
        let mut options = first.options(); options.output_groups = &first.groups[..1];
        assert!(prepare_unlock(options).is_err());
        let wrong_groups = [OutputGroup { code_vout: 0, tape_vout: Some(2) }];
        let mut options = first.options(); options.output_groups = &wrong_groups;
        assert!(prepare_unlock(options).is_err());
        let wrong_key = [0u8; 33];
        let mut options = first.options(); options.public_key = &wrong_key;
        assert!(prepare_unlock(options).is_err());
        let mut another_valid_key = first.key.clone(); another_valid_key[0] ^= 1;
        let mut options = first.options(); options.public_key = &another_valid_key;
        assert!(prepare_unlock(options).is_err());
        let mut options = first.options(); options.contract_controller = Some(ContractControllerWitness {
            transaction: first.parent.transaction(), current_input_index: 0,
        });
        assert!(prepare_unlock(options).is_err());
        first.current.inputs[0].previous_output.vout += 1;
        assert!(prepare_unlock(first.options()).is_err());
        let mut first = Case::load(&fixture["vectors"][0]);
        first.current.inputs.push(first.current.inputs[0].clone());
        assert!(prepare_unlock(first.options()).is_err());
        first.current.version = 9;
        assert!(prepare_unlock(first.options()).is_err());
    }

    #[test]
    fn tbc20_proof_contract_witness_is_bound_to_input_and_double_hashed_script() {
        let fixture = fixture();
        let mut case = Case::load(&fixture["vectors"][0]);
        let mut controlling = Transaction::new();
        controlling.inputs.push(TxIn::new(OutPoint { txid: Txid::from_le_bytes([9; 32]), vout: 3 }));
        controlling.outputs.push(TxOut { satoshis: 1000, script_pubkey: Script::from_bytes(vec![0x51]) });
        let mut controller = [0; 21];
        controller[..20].copy_from_slice(&hash::hash160(&hash::sha256(controlling.outputs[0].script_pubkey.as_bytes())));
        controller[20] = 1;
        let mut parent = case.parent.transaction().clone();
        let vout = case.parent.selected().vout;
        parent.outputs[vout as usize].script_pubkey = Script::from_bytes(replace_controller(
            parent.outputs[vout as usize].script_pubkey.as_bytes(), controller,
        ).unwrap());
        let selected = OutPoint { txid: parent.txid(), vout };
        case.parent = inspect_parent(&parent.serialize(), &selected, None).unwrap();
        case.current.inputs[0].previous_output = selected;
        case.current.inputs.push(TxIn::new(OutPoint { txid: controlling.txid(), vout: 0 }));
        assert!(prepare_unlock(case.options()).is_err()); // witness is required
        let mut options = case.options(); options.contract_controller = Some(ContractControllerWitness {
            transaction: &controlling, current_input_index: 2,
        });
        let prepared = prepare_unlock(options).unwrap();
        assert_eq!(prepared.proof_fields()[106], vec![2]);
        assert_eq!(prepared.proof_fields()[104], hash::sha256(controlling.outputs[0].script_pubkey.as_bytes()));
        let mut options = case.options(); options.contract_controller = Some(ContractControllerWitness {
            transaction: &controlling, current_input_index: 1,
        });
        assert!(prepare_unlock(options).is_err());
        // Rebind the current outpoint to changed material but retain the old controller.
        controlling.outputs[0].script_pubkey = Script::from_bytes(vec![0x52]);
        case.current.inputs[2].previous_output.txid = controlling.txid();
        let mut options = case.options(); options.contract_controller = Some(ContractControllerWitness {
            transaction: &controlling, current_input_index: 2,
        });
        assert!(prepare_unlock(options).is_err());
    }

    #[test]
    fn tbc20_proof_push_encoding_preserves_zero_byte_and_canonical_numbers() {
        for (value, expected) in [(vec![], vec![0]), (vec![0], vec![1, 0]), (vec![1], vec![0x51]),
            (vec![16], vec![0x60]), (vec![0x81], vec![0x4f]), (vec![17], vec![1, 17])]
        { let mut actual = Vec::new(); push_data(&mut actual, &value); assert_eq!(actual, expected); }
        for length in [75, 76, 255, 256, 65535, 65536] {
            let mut script = Vec::new(); push_data(&mut script, &vec![3; length]);
            assert_eq!(&script[script.len() - length..], vec![3; length]);
        }
        assert_eq!(unsigned_script_num(127), [127]);
        assert_eq!(unsigned_script_num(128), [128, 0]);
        assert!(unsigned_script_num(0).is_empty());
    }

    #[test]
    fn tbc20_proof_der_format_rejects_truncation_wrong_hashtype_and_nonminimal_integers() {
        assert!(canonical_signature(&MAX_SIGNATURE));
        let tiny = [0x30, 6, 2, 1, 1, 2, 1, 1, 0x41];
        assert!(canonical_signature(&tiny));
        for end in 0..MAX_SIGNATURE.len() { assert!(!canonical_signature(&MAX_SIGNATURE[..end])); }
        let mut wrong = tiny; wrong[8] = 1; assert!(!canonical_signature(&wrong));
        let mut negative = tiny; negative[4] = 0x80; assert!(!canonical_signature(&negative));
        assert!(!canonical_signature(&[0x30, 7, 2, 2, 0, 1, 2, 1, 1, 0x41]));
        for length in 0..80 { assert!(!canonical_signature(&vec![0xff; length])); }
    }
}
