use crate::{Error, Result, Transaction, hash};

const VERSION_LENGTH_MARKER: u8 = 0x10;
const AMOUNT_LENGTH_MARKER: u8 = 0x08;
const HASH_LENGTH_MARKER: u8 = 0x20;

pub fn current_tx_data(tx: &Transaction) -> Result<Vec<u8>> {
    let output = tx
        .outputs
        .first()
        .ok_or_else(|| Error::InvalidUtxo("NFT current tx missing code output".to_string()))?;
    let mut data = Vec::new();
    data.push(AMOUNT_LENGTH_MARKER);
    data.extend_from_slice(&output.satoshis.to_le_bytes());
    data.push(HASH_LENGTH_MARKER);
    data.extend_from_slice(&output.script_pubkey.sha256());
    data.extend_from_slice(&outputs_data(tx, 1)?);
    Ok(data)
}

pub fn pre_tx_data(tx: &Transaction) -> Result<Vec<u8>> {
    let code_output = tx
        .outputs
        .first()
        .ok_or_else(|| Error::InvalidUtxo("NFT pre tx missing code output".to_string()))?;
    let hold_output = tx
        .outputs
        .get(1)
        .ok_or_else(|| Error::InvalidUtxo("NFT pre tx missing hold output".to_string()))?;
    let (input_base, input_unlock_hashes) = input_data(tx);

    let mut data = Vec::new();
    write_tx_header(tx, &mut data);
    data.extend_from_slice(&length_hex(input_base.len())?);
    data.extend_from_slice(&input_base);
    data.push(HASH_LENGTH_MARKER);
    data.extend_from_slice(&hash::sha256(&input_unlock_hashes));
    data.push(AMOUNT_LENGTH_MARKER);
    data.extend_from_slice(&code_output.satoshis.to_le_bytes());
    data.push(HASH_LENGTH_MARKER);
    data.extend_from_slice(&code_output.script_pubkey.sha256());
    data.push(AMOUNT_LENGTH_MARKER);
    data.extend_from_slice(&hold_output.satoshis.to_le_bytes());
    data.extend_from_slice(&length_hex(hold_output.script_pubkey.as_bytes().len())?);
    data.extend_from_slice(hold_output.script_pubkey.as_bytes());
    data.extend_from_slice(&outputs_data(tx, 2)?);
    Ok(data)
}

pub fn pre_pre_tx_data(tx: &Transaction) -> Result<Vec<u8>> {
    let code_output = tx
        .outputs
        .first()
        .ok_or_else(|| Error::InvalidUtxo("NFT pre-pre tx missing first output".to_string()))?;
    let (input_base, input_unlock_hashes) = input_data(tx);

    let mut data = Vec::new();
    write_tx_header(tx, &mut data);
    data.push(HASH_LENGTH_MARKER);
    data.extend_from_slice(&hash::sha256(&input_base));
    data.push(HASH_LENGTH_MARKER);
    data.extend_from_slice(&hash::sha256(&input_unlock_hashes));
    data.push(AMOUNT_LENGTH_MARKER);
    data.extend_from_slice(&code_output.satoshis.to_le_bytes());
    data.push(HASH_LENGTH_MARKER);
    data.extend_from_slice(&code_output.script_pubkey.sha256());
    data.extend_from_slice(&outputs_data(tx, 1)?);
    Ok(data)
}

pub fn outputs_data(tx: &Transaction, index: usize) -> Result<Vec<u8>> {
    let mut output_bytes = Vec::new();
    for output in tx.outputs.iter().skip(index) {
        output_bytes.extend_from_slice(&output.satoshis.to_le_bytes());
        output_bytes.extend_from_slice(&output.script_pubkey.sha256());
    }
    if output_bytes.is_empty() {
        return Ok(vec![0]);
    }

    let mut data = length_hex(output_bytes.len())?;
    data.extend_from_slice(&output_bytes);
    Ok(data)
}

pub fn length_hex(length: usize) -> Result<Vec<u8>> {
    match length {
        0..=75 => Ok(vec![length as u8]),
        76..=0xff => Ok(vec![crate::script::opcodes::OP_PUSHDATA1, length as u8]),
        0x100..=0xffff => {
            let mut data = vec![crate::script::opcodes::OP_PUSHDATA2];
            data.extend_from_slice(&(length as u16).to_le_bytes());
            Ok(data)
        }
        0x1_0000..=0xffff_ffff => {
            let mut data = vec![crate::script::opcodes::OP_PUSHDATA4];
            data.extend_from_slice(&(length as u32).to_le_bytes());
            Ok(data)
        }
        _ => Err(Error::InvalidScript(
            "length exceeds maximum supported script push size".to_string(),
        )),
    }
}

fn write_tx_header(tx: &Transaction, out: &mut Vec<u8>) {
    out.push(VERSION_LENGTH_MARKER);
    out.extend_from_slice(&(tx.version as u32).to_le_bytes());
    out.extend_from_slice(&tx.lock_time.to_le_bytes());
    out.extend_from_slice(&(tx.inputs.len() as i32).to_le_bytes());
    out.extend_from_slice(&(tx.outputs.len() as i32).to_le_bytes());
}

fn input_data(tx: &Transaction) -> (Vec<u8>, Vec<u8>) {
    let mut input_base = Vec::new();
    let mut input_unlock_hashes = Vec::new();
    for input in &tx.inputs {
        input.previous_output.serialize(&mut input_base);
        input_base.extend_from_slice(&input.sequence.to_le_bytes());
        input_unlock_hashes.extend_from_slice(&input.script_sig.sha256());
    }
    (input_base, input_unlock_hashes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nft_unlock_length_hex_matches_js_push_lengths() {
        assert_eq!(hex::encode(length_hex(75).unwrap()), "4b");
        assert_eq!(hex::encode(length_hex(76).unwrap()), "4c4c");
        assert_eq!(hex::encode(length_hex(256).unwrap()), "4d0001");
    }

    #[test]
    fn nft_unlock_current_tx_data_uses_output_zero_and_hashes_following_outputs() {
        let mut tx = crate::Transaction::new();
        tx.outputs.push(crate::TxOut {
            satoshis: 200,
            script_pubkey: crate::script::Script::from_bytes(vec![0x51]),
        });
        tx.outputs.push(crate::TxOut {
            satoshis: 100,
            script_pubkey: crate::script::Script::from_bytes(vec![0x52]),
        });
        let data = current_tx_data(&tx).unwrap();
        assert_eq!(&hex::encode(&data)[0..2], "08");
        assert!(data.len() > 41);
    }
}
