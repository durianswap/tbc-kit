//! Shared version-10 proof byte encoding. No contract rules, I/O or keys.
use tbc_sdk::{hash, Transaction, TxOut};

pub(crate) fn input_record(tx: &Transaction, index: usize) -> Vec<u8> {
    let input = &tx.inputs[index];
    let mut bytes = Vec::with_capacity(40);
    input.previous_output.serialize(&mut bytes);
    bytes.extend_from_slice(&input.sequence.to_le_bytes());
    bytes
}

pub(crate) fn input_records(tx: &Transaction) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(tx.inputs.len() * 40);
    for index in 0..tx.inputs.len() { bytes.extend_from_slice(&input_record(tx, index)); }
    bytes
}

pub(crate) fn unlocking_scripts_hash(tx: &Transaction) -> Vec<u8> {
    let mut hashes = Vec::with_capacity(tx.inputs.len() * 32);
    for input in &tx.inputs { hashes.extend_from_slice(&hash::sha256(input.script_sig.as_bytes())); }
    hash::sha256(&hashes).to_vec()
}

pub(crate) fn inputs_hash_data(tx: &Transaction) -> Vec<u8> {
    let mut bytes = hash::sha256(&input_records(tx)).to_vec();
    bytes.extend_from_slice(&unlocking_scripts_hash(tx));
    bytes
}

pub(crate) fn vlio(tx: &Transaction) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(16);
    bytes.extend_from_slice(&tx.version.to_le_bytes());
    bytes.extend_from_slice(&tx.lock_time.to_le_bytes());
    bytes.extend_from_slice(&(tx.inputs.len() as i32).to_le_bytes());
    bytes.extend_from_slice(&(tx.outputs.len() as i32).to_le_bytes());
    bytes
}

pub(crate) fn output_records(outputs: &[TxOut]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(outputs.len() * 40);
    for output in outputs {
        bytes.extend_from_slice(&output.satoshis.to_le_bytes());
        bytes.extend_from_slice(&hash::sha256(output.script_pubkey.as_bytes()));
    }
    bytes
}

pub(crate) fn push_data(bytes: &mut Vec<u8>, data: &[u8]) {
    match data {
        [] => bytes.push(0),
        [value @ 1..=16] => bytes.push(0x50 + value),
        [0x81] => bytes.push(0x4f),
        _ => {
            match data.len() {
                1..=75 => bytes.push(data.len() as u8),
                76..=255 => { bytes.push(0x4c); bytes.push(data.len() as u8); }
                256..=65535 => { bytes.push(0x4d); bytes.extend_from_slice(&(data.len() as u16).to_le_bytes()); }
                _ => { bytes.push(0x4e); bytes.extend_from_slice(&(data.len() as u32).to_le_bytes()); }
            }
            bytes.extend_from_slice(data);
        }
    }
}
