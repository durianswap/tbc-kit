//! Keyless TBC721 20-field proof, pinned to tbc-contract 1.7.0.
//! Reference: lib/util/tbc721/tbc721unlock.ts at
//! af77616121db340e15bb8b73c197bc2f8d1ee986 (OpenTBC; release gate applies).
//! This layer validates immediate ancestry and ECDSA or x-only BIP340 owner.
//! Trusted genesis, NFT metadata, unspent status, fees and approval remain
//! planner/Host responsibilities. No history walking, I/O or private key access.

use std::collections::BTreeSet;
use tbc_sdk::{DEFAULT_SIGHASH, Transaction, hash, script::Script, sighash::forkid_sighash};
use super::covenant_signature::CovenantPublicKey;
use crate::{EngineError, ErrorCode};
use super::{tbc721::parse_code, tbc20_material::MAX_MATERIAL_TRANSACTION_BYTES,
    transaction_proof::{input_records, inputs_hash_data, unlocking_scripts_hash,
        vlio, output_records, push_data}};

pub const UNLOCK_LEAF_COUNT: usize = 20;
const MAX_SAFE_SATOSHIS: u64 = 9_007_199_254_740_991;

pub struct UnlockOptions<'a> {
    pub current_tx: &'a Transaction,
    pub parent_tx: &'a Transaction,
    pub grandparent_tx: &'a Transaction,
    pub public_key: &'a [u8],
}

/// Proof and digest frozen once; subsequent external-signature finalization
/// does not re-read, re-parse or re-hash ancestor transactions.
#[derive(Clone, Debug)]
pub struct PreparedUnlock {
    fields: Vec<Vec<u8>>,
    digest: [u8; 32],
    public_key: CovenantPublicKey,
}

fn invalid(message: &str) -> EngineError {
    EngineError {code: ErrorCode::InvalidAncestry, message: message.to_owned(), path: None}
}

impl PreparedUnlock {
    pub fn signing_digest(&self) -> &[u8; 32] { &self.digest }
    pub fn public_key(&self) -> &[u8] { self.public_key.bytes() }
    /// Slot 0 is empty until the external signature is verified.
    pub fn proof_fields(&self) -> &[Vec<u8>] { &self.fields }
    pub fn max_unlocking_script_bytes(&self) -> usize {
        // 72 bytes bounds low-S DER plus 0x41; these bytes are size-only and
        // are never exposed as a signed transaction or valid signature.
        self.encode(&vec![0; self.public_key.maximum_transaction_signature_bytes()]).as_bytes().len()
    }
    pub fn finalize(&self, signature: &[u8]) -> Result<Script, EngineError> {
        self.public_key.verify_transaction_signature(&self.digest,signature)?;
        Ok(self.encode(signature))
    }
    fn encode(&self, signature: &[u8]) -> Script {
        let mut bytes = Vec::new();
        for (index, field) in self.fields.iter().enumerate() {
            push_data(&mut bytes, if index == 0 {signature} else {field});
        }
        Script::from_bytes(bytes)
    }
}

fn check_transaction(tx: &Transaction) -> Result<(), EngineError> {
    if tx.version != 10 || tx.inputs.is_empty() || tx.outputs.is_empty()
        || tx.inputs.len() > i32::MAX as usize || tx.outputs.len() > i32::MAX as usize
        || tx.serialize().len() > MAX_MATERIAL_TRANSACTION_BYTES
        || tx.outputs.iter().any(|o| o.satoshis > MAX_SAFE_SATOSHIS)
    { return Err(invalid("TBC721 proof requires bounded nonempty version-10 transactions")); }
    Ok(())
}

pub fn prepare_unlock(options: UnlockOptions<'_>) -> Result<PreparedUnlock, EngineError> {
    let current = options.current_tx;
    let parent = options.parent_tx;
    let grandparent = options.grandparent_tx;
    for tx in [current, parent, grandparent] { check_transaction(tx)?; }
    if parent.outputs.len() < 2 { return Err(invalid("TBC721 parent Code/Hold is missing")); }
    let previous = &current.inputs[0].previous_output;
    if previous.vout != 0 || previous.txid != parent.txid() {
        return Err(invalid("TBC721 Code must be spent at input zero from parent output zero"));
    }
    let mut unique = BTreeSet::new();
    if current.inputs.iter().any(|input| !unique.insert((input.previous_output.txid.to_string(), input.previous_output.vout))) {
        return Err(invalid("TBC721 current transaction repeats an input outpoint"));
    }
    let source = &parent.inputs[0].previous_output;
    let ancestor = grandparent.outputs.get(source.vout as usize)
        .ok_or_else(|| invalid("TBC721 grandparent output is missing"))?;
    if source.txid != grandparent.txid() {
        return Err(invalid("TBC721 parent input zero does not spend the supplied grandparent"));
    }
    let code = &parent.outputs[0];
    let descriptor = parse_code(code.script_pubkey.as_bytes())
        .map_err(|_| invalid("TBC721 Code does not match the pinned template"))?;
    if current.outputs[0].script_pubkey != code.script_pubkey {
        return Err(invalid("TBC721 output zero must preserve the Code"));
    }
    if ancestor.script_pubkey == code.script_pubkey {
        if source.vout != 0 { return Err(invalid("Continued TBC721 Code ancestry must use output zero")); }
    } else if &descriptor.original_outpoint != source {
        return Err(invalid("TBC721 genesis ancestor differs from the original outpoint"));
    }
    let public_key=CovenantPublicKey::parse(options.public_key)?;
    let hold = parent.outputs[1].script_pubkey.as_bytes();
    if hold.len() < 25 || hold[..3] != [0x76, 0xa9, 0x14] || hold[23..25] != [0x88, 0xac]
        || hold[3..23] != hash::hash160(public_key.bytes())
    { return Err(invalid("TBC721 public key does not match the parent Hold owner")); }
    let index = source.vout as usize;
    let fields = vec![
        Vec::new(), public_key.bytes().to_vec(),
        current.outputs[0].satoshis.to_le_bytes().to_vec(),
        hash::sha256(current.outputs[0].script_pubkey.as_bytes()).to_vec(),
        output_records(&current.outputs[1..]), input_records(current),
        vlio(grandparent), inputs_hash_data(grandparent),
        output_records(&grandparent.outputs[..index]), ancestor.satoshis.to_le_bytes().to_vec(),
        hash::sha256(ancestor.script_pubkey.as_bytes()).to_vec(),
        output_records(&grandparent.outputs[index + 1..]),
        vlio(parent), input_records(parent), unlocking_scripts_hash(parent),
        code.satoshis.to_le_bytes().to_vec(), hash::sha256(code.script_pubkey.as_bytes()).to_vec(),
        parent.outputs[1].satoshis.to_le_bytes().to_vec(), hold.to_vec(),
        output_records(&parent.outputs[2..]),
    ];
    debug_assert_eq!(fields.len(), UNLOCK_LEAF_COUNT);
    let digest = forkid_sighash(current, 0, &code.script_pubkey, code.satoshis, DEFAULT_SIGHASH)
        .map_err(|_| invalid("TBC721 signing digest could not be formed"))?;
    Ok(PreparedUnlock {fields, digest, public_key})
}
