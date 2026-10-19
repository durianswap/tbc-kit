use crate::{Error, Result, TX_VERSION, Transaction, TxOut, hash};

use super::partial_sha256::calculate_partial_hash;

const VERSION_LENGTH_MARKER: u8 = 0x10;
const AMOUNT_LENGTH_MARKER: u8 = 0x08;
const HASH_LENGTH_MARKER: u8 = 0x20;
const FT_V1_LENGTH: usize = 1_564;
const FT_V1_PARTIAL_OFFSET: usize = 1_536;
const FT_V2_LENGTH: usize = 1_884;
const FT_V2_PARTIAL_OFFSET: usize = 1_856;
const LEGACY_COIN_LENGTH: usize = 2_012;
const LEGACY_COIN_PARTIAL_OFFSET: usize = 1_984;
pub(crate) const FT_V4_LENGTH: usize = 2_076;
pub(crate) const FT_V4_PARTIAL_OFFSET: usize = 2_048;
const FT_CODE_MARKER: &[u8] = b"2Code";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FtScriptInfo {
    pub version: u8,
    pub is_coin: bool,
}

/// Classifies all published FT and StableCoin code families through
/// tbc-contract 1.6.6.
pub fn classify_ft_script(script: &crate::script::Script) -> Result<FtScriptInfo> {
    let instructions = script_instructions(script.as_bytes())?;
    if instructions.last().and_then(|instruction| instruction.data) != Some(FT_CODE_MARKER) {
        return Err(Error::InvalidScript(
            "FT code marker 2Code is missing".to_string(),
        ));
    }
    let fill = instructions
        .get(instructions.len().checked_sub(5).ok_or_else(|| {
            Error::InvalidScript("FT code has fewer than five instructions".to_string())
        })?)
        .ok_or_else(|| Error::InvalidScript("FT code is missing its fill chunk".to_string()))?;
    let fill_length = if fill.opcode == 0x5f {
        1
    } else if let Some(data) = fill.data {
        data.len()
    } else {
        usize::from(fill.opcode)
    };
    let all_ff = fill
        .data
        .is_some_and(|data| !data.is_empty() && data.iter().all(|byte| *byte == 0xff));

    match script.as_bytes().len() {
        FT_V1_LENGTH => Ok(FtScriptInfo {
            version: 1,
            is_coin: false,
        }),
        FT_V2_LENGTH => Ok(FtScriptInfo {
            version: if matches!(fill_length, 1 | 2) { 3 } else { 2 },
            is_coin: false,
        }),
        LEGACY_COIN_LENGTH => match (all_ff, fill_length) {
            (true, 2) => Ok(FtScriptInfo {
                version: 3,
                is_coin: true,
            }),
            (true, 11 | 54) => Ok(FtScriptInfo {
                version: 2,
                is_coin: true,
            }),
            (true, 28) => Ok(FtScriptInfo {
                version: 4,
                is_coin: false,
            }),
            _ => Err(Error::InvalidScript(format!(
                "unsupported 2012-byte FT fill length {fill_length}"
            ))),
        },
        FT_V4_LENGTH => Ok(FtScriptInfo {
            version: 4,
            is_coin: all_ff && fill_length == 10,
        }),
        length => Err(Error::InvalidScript(format!(
            "unsupported FT code length {length}"
        ))),
    }
}

#[derive(Clone, Copy)]
struct ScriptInstruction<'a> {
    opcode: u8,
    data: Option<&'a [u8]>,
}

fn script_instructions(script: &[u8]) -> Result<Vec<ScriptInstruction<'_>>> {
    let mut instructions = Vec::new();
    let mut index = 0usize;
    while index < script.len() {
        let opcode = script[index];
        index += 1;
        let data_length = match opcode {
            0x01..=0x4b => opcode as usize,
            crate::script::opcodes::OP_PUSHDATA1 => {
                let length = *script.get(index).ok_or_else(|| {
                    Error::InvalidScript("truncated OP_PUSHDATA1 in FT code".to_string())
                })? as usize;
                index += 1;
                length
            }
            crate::script::opcodes::OP_PUSHDATA2 => {
                let bytes: [u8; 2] = script
                    .get(index..index + 2)
                    .ok_or_else(|| {
                        Error::InvalidScript("truncated OP_PUSHDATA2 in FT code".to_string())
                    })?
                    .try_into()
                    .expect("slice length checked");
                index += 2;
                u16::from_le_bytes(bytes) as usize
            }
            crate::script::opcodes::OP_PUSHDATA4 => {
                let bytes: [u8; 4] = script
                    .get(index..index + 4)
                    .ok_or_else(|| {
                        Error::InvalidScript("truncated OP_PUSHDATA4 in FT code".to_string())
                    })?
                    .try_into()
                    .expect("slice length checked");
                index += 4;
                usize::try_from(u32::from_le_bytes(bytes)).map_err(|_| {
                    Error::InvalidScript("FT push length does not fit usize".to_string())
                })?
            }
            _ => 0,
        };
        let end = index.checked_add(data_length).ok_or_else(|| {
            Error::InvalidScript("FT code instruction length overflow".to_string())
        })?;
        if end > script.len() {
            return Err(Error::InvalidScript(
                "FT code contains a truncated push instruction".to_string(),
            ));
        }
        let data = (data_length > 0).then_some(&script[index..end]);
        instructions.push(ScriptInstruction { opcode, data });
        index = end;
    }
    Ok(instructions)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputSplit {
    pub outputs1: Vec<u8>,
    pub outputs1_length: Vec<u8>,
    pub outputs2: Vec<u8>,
    pub outputs2_length: Vec<u8>,
}

pub fn contract_tx_data(tx: &Transaction, vout: i32) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    write_tx_header(&mut data, tx);
    let (input_base, input_unlock_hashes) = input_data(tx);
    data.push(HASH_LENGTH_MARKER);
    data.extend_from_slice(&hash::sha256(&input_base));
    data.push(HASH_LENGTH_MARKER);
    data.extend_from_slice(&hash::sha256(&input_unlock_hashes));

    if vout < 0 {
        for output in &tx.outputs {
            data.push(AMOUNT_LENGTH_MARKER);
            data.extend_from_slice(&output.satoshis.to_le_bytes());
            data.push(HASH_LENGTH_MARKER);
            data.extend_from_slice(&output.script_pubkey.sha256());
        }
        for _ in tx.outputs.len()..15 {
            data.push(0);
            data.push(0);
        }
    } else {
        let vout = vout as usize;
        let output = tx
            .outputs
            .get(vout)
            .ok_or_else(|| Error::InvalidUtxo("FT contract tx vout out of range".to_string()))?;
        let split = pre_pre_outputs_data(tx, vout)?;
        data.extend_from_slice(&split.outputs1_length);
        data.extend_from_slice(&split.outputs1);
        data.push(AMOUNT_LENGTH_MARKER);
        data.extend_from_slice(&output.satoshis.to_le_bytes());
        data.push(HASH_LENGTH_MARKER);
        data.extend_from_slice(&output.script_pubkey.sha256());
        data.extend_from_slice(&split.outputs2_length);
        data.extend_from_slice(&split.outputs2);
    }

    Ok(data)
}

pub fn current_inputs_data(tx: &Transaction) -> Result<Vec<u8>> {
    let (input_base, _) = input_data(tx);
    let mut data = length_hex(input_base.len())?;
    data.extend_from_slice(&input_base);
    Ok(data)
}

pub fn current_tx_data(tx: &Transaction, input_index: usize) -> Result<Vec<u8>> {
    let mut data = vec![0x51];
    let mut output_index = 0usize;
    while output_index < tx.outputs.len() {
        output_index += write_current_output(tx, output_index, &mut data)?;
        data.push(0x52);
    }
    data.push(input_index_tag(input_index)?);
    Ok(data)
}

pub fn pre_tx_data(tx: &Transaction, vout: usize) -> Result<Vec<u8>> {
    let output = tx
        .outputs
        .get(vout)
        .ok_or_else(|| Error::InvalidUtxo("FT pre tx vout out of range".to_string()))?;
    let tape_output = tx.outputs.get(vout + 1).ok_or_else(|| {
        Error::InvalidUtxo("FT pre tx missing tape output after code output".to_string())
    })?;
    let mut data = Vec::new();
    write_tx_header(&mut data, tx);
    let (input_base, input_unlock_hashes) = input_data(tx);
    data.extend_from_slice(&length_hex(input_base.len())?);
    data.extend_from_slice(&input_base);
    data.push(HASH_LENGTH_MARKER);
    data.extend_from_slice(&hash::sha256(&input_unlock_hashes));

    let split = pre_outputs_data(tx, vout)?;
    data.extend_from_slice(&split.outputs1_length);
    data.extend_from_slice(&split.outputs1);
    write_pre_code_output(output, &mut data)?;
    write_full_output(tape_output, &mut data)?;
    data.extend_from_slice(&split.outputs2_length);
    data.extend_from_slice(&split.outputs2);
    Ok(data)
}

pub fn pre_pre_tx_data(tx: &Transaction, vout: usize) -> Result<Vec<u8>> {
    let output = tx
        .outputs
        .get(vout)
        .ok_or_else(|| Error::InvalidUtxo("FT pre-pre tx vout out of range".to_string()))?;
    let mut data = Vec::new();
    write_tx_header(&mut data, tx);
    let (input_base, input_unlock_hashes) = input_data(tx);
    data.push(HASH_LENGTH_MARKER);
    data.extend_from_slice(&hash::sha256(&input_base));
    data.push(HASH_LENGTH_MARKER);
    data.extend_from_slice(&hash::sha256(&input_unlock_hashes));

    let split = pre_pre_outputs_data(tx, vout)?;
    data.extend_from_slice(&split.outputs1_length);
    data.extend_from_slice(&split.outputs1);
    write_output_summary(output, &mut data)?;
    data.extend_from_slice(&split.outputs2_length);
    data.extend_from_slice(&split.outputs2);
    data.push(0x52);
    Ok(data)
}

pub fn pre_pre_tx_data_from_parents(
    pre_tx: &Transaction,
    pre_tx_vout: usize,
    parents: &[Transaction],
) -> Result<Vec<u8>> {
    let source_indexes = ft_pre_pre_source_indexes(pre_tx, pre_tx_vout)?;
    if parents.len() != source_indexes.len() {
        return Err(Error::InvalidUtxo(format!(
            "FT grandparent count {} does not match referenced source count {}",
            parents.len(),
            source_indexes.len()
        )));
    }
    let mut data = vec![0x57];
    for (parent, input_index) in parents.iter().zip(source_indexes) {
        let input = &pre_tx.inputs[input_index];
        if parent.txid() != input.previous_output.txid {
            return Err(Error::InvalidUtxo(format!(
                "FT grandparent transaction id does not match pre-tx input {input_index}"
            )));
        }
        let vout = input.previous_output.vout as usize;
        if parent.outputs.get(vout).is_none() {
            return Err(Error::InvalidUtxo(format!(
                "FT grandparent vout is out of range for pre-tx input {input_index}"
            )));
        }
        data.extend_from_slice(&pre_pre_tx_data(parent, vout)?);
    }
    Ok(data)
}

pub(crate) fn ft_pre_pre_source_indexes(
    pre_tx: &Transaction,
    pre_tx_vout: usize,
) -> Result<Vec<usize>> {
    let tape_output = pre_tx.outputs.get(pre_tx_vout + 1).ok_or_else(|| {
        Error::InvalidUtxo("FT pre tx missing tape output after code output".to_string())
    })?;
    if tape_output.satoshis != 0 {
        return Err(Error::InvalidUtxo(
            "FT tape output must contain zero satoshis".to_string(),
        ));
    }
    let tape_script = tape_output.script_pubkey.as_bytes();
    if tape_script.len() < 56
        || !tape_script.starts_with(&[
            crate::script::opcodes::OP_FALSE,
            crate::script::opcodes::OP_RETURN,
            0x30,
        ])
        || !tape_script.ends_with(b"FTape")
    {
        return Err(Error::InvalidScript(
            "FT tape must be OP_FALSE OP_RETURN with a 48-byte amount push and FTape marker"
                .to_string(),
        ));
    }
    let tape_amounts = &tape_script[3..51];
    let mut indexes = Vec::new();
    for input_index in (0..6).rev() {
        let start = input_index * 8;
        if tape_amounts[start..start + 8] != [0u8; 8] {
            if pre_tx.inputs.get(input_index).is_none() {
                return Err(Error::InvalidUtxo(format!(
                    "FT tape references missing input index {input_index}"
                )));
            }
            indexes.push(input_index);
        }
    }
    if indexes.is_empty() {
        return Err(Error::InvalidUtxo(
            "FT tape does not reference any source input".to_string(),
        ));
    }
    Ok(indexes)
}

pub fn pre_pre_outputs_data(tx: &Transaction, vout: usize) -> Result<OutputSplit> {
    outputs_split(tx, vout, 1)
}

pub fn pre_outputs_data(tx: &Transaction, vout: usize) -> Result<OutputSplit> {
    outputs_split(tx, vout, 2)
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
        _ => Err(Error::InvalidScript(
            "length exceeds maximum supported FT push size".to_string(),
        )),
    }
}

pub fn size_le(length: usize) -> Result<Vec<u8>> {
    match length {
        0..=0xff => Ok(vec![length as u8]),
        0x100..=0xffff => Ok((length as u16).to_le_bytes().to_vec()),
        _ => Err(Error::InvalidScript(
            "script size exceeds maximum supported FT size".to_string(),
        )),
    }
}

fn write_tx_header(out: &mut Vec<u8>, tx: &Transaction) {
    out.push(VERSION_LENGTH_MARKER);
    out.extend_from_slice(&(TX_VERSION as u32).to_le_bytes());
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

fn outputs_split(tx: &Transaction, vout: usize, after_skip: usize) -> Result<OutputSplit> {
    if vout >= tx.outputs.len() {
        return Err(Error::InvalidUtxo(
            "FT output split vout out of range".to_string(),
        ));
    }

    let mut outputs1 = Vec::new();
    for output in tx.outputs.iter().take(vout) {
        write_output_hash_pair(output, &mut outputs1);
    }
    let outputs1_length = if outputs1.is_empty() {
        outputs1.push(0);
        Vec::new()
    } else {
        length_hex(outputs1.len())?
    };

    let mut outputs2 = Vec::new();
    for output in tx.outputs.iter().skip(vout + after_skip) {
        write_output_hash_pair(output, &mut outputs2);
    }
    let outputs2_length = if outputs2.is_empty() {
        outputs2.push(0);
        Vec::new()
    } else {
        length_hex(outputs2.len())?
    };

    Ok(OutputSplit {
        outputs1,
        outputs1_length,
        outputs2,
        outputs2_length,
    })
}

fn write_output_hash_pair(output: &TxOut, out: &mut Vec<u8>) {
    out.extend_from_slice(&output.satoshis.to_le_bytes());
    out.extend_from_slice(&output.script_pubkey.sha256());
}

fn write_current_output(tx: &Transaction, index: usize, out: &mut Vec<u8>) -> Result<usize> {
    let output = &tx.outputs[index];
    let script = output.script_pubkey.as_bytes();
    if let Some(offset) = fixed_partial_offset(script.len()) {
        write_partial_output(output, offset, out)?;
        if let Some(tape_output) = tx.outputs.get(index + 1) {
            write_full_output(tape_output, out)?;
            return Ok(2);
        }
        return Err(Error::InvalidUtxo(
            "FT code output missing following tape output".to_string(),
        ));
    }

    write_output_summary(output, out)?;
    Ok(1)
}

fn write_pre_code_output(output: &TxOut, out: &mut Vec<u8>) -> Result<()> {
    let offset =
        fixed_partial_offset(output.script_pubkey.as_bytes().len()).unwrap_or(FT_V1_PARTIAL_OFFSET);
    write_partial_output(output, offset, out)
}

fn write_output_summary(output: &TxOut, out: &mut Vec<u8>) -> Result<()> {
    let script = output.script_pubkey.as_bytes();
    if let Some(offset) = fixed_partial_offset(script.len()) {
        write_partial_output(output, offset, out)
    } else if script.len() < 64 {
        out.push(AMOUNT_LENGTH_MARKER);
        out.extend_from_slice(&output.satoshis.to_le_bytes());
        out.extend_from_slice(&length_hex(script.len())?);
        out.extend_from_slice(script);
        out.push(0);
        let size = size_le(script.len())?;
        out.extend_from_slice(&length_hex(size.len())?);
        out.extend_from_slice(&size);
        Ok(())
    } else {
        let partial_len = (script.len() / 64) * 64;
        let partial_hash = calculate_partial_hash(&script[..partial_len]);
        let suffix = &script[partial_len..];
        out.push(AMOUNT_LENGTH_MARKER);
        out.extend_from_slice(&output.satoshis.to_le_bytes());
        out.extend_from_slice(&length_hex(suffix.len())?);
        out.extend_from_slice(suffix);
        out.push(HASH_LENGTH_MARKER);
        out.extend_from_slice(&partial_hash);
        let size = size_le(script.len())?;
        out.extend_from_slice(&length_hex(size.len())?);
        out.extend_from_slice(&size);
        Ok(())
    }
}

fn write_partial_output(output: &TxOut, offset: usize, out: &mut Vec<u8>) -> Result<()> {
    let script = output.script_pubkey.as_bytes();
    let prefix_len = offset.min(script.len());
    let partial_hash = calculate_partial_hash(&script[..prefix_len]);
    let suffix = if offset <= script.len() {
        &script[offset..]
    } else {
        &[]
    };
    out.push(AMOUNT_LENGTH_MARKER);
    out.extend_from_slice(&output.satoshis.to_le_bytes());
    out.extend_from_slice(&length_hex(suffix.len())?);
    out.extend_from_slice(suffix);
    out.push(HASH_LENGTH_MARKER);
    out.extend_from_slice(&partial_hash);
    let size = size_le(script.len())?;
    out.extend_from_slice(&length_hex(size.len())?);
    out.extend_from_slice(&size);
    Ok(())
}

fn write_full_output(output: &TxOut, out: &mut Vec<u8>) -> Result<()> {
    let script = output.script_pubkey.as_bytes();
    out.push(AMOUNT_LENGTH_MARKER);
    out.extend_from_slice(&output.satoshis.to_le_bytes());
    out.extend_from_slice(&length_hex(script.len())?);
    out.extend_from_slice(script);
    Ok(())
}

pub(crate) fn fixed_partial_offset(script_len: usize) -> Option<usize> {
    match script_len {
        FT_V1_LENGTH => Some(FT_V1_PARTIAL_OFFSET),
        FT_V2_LENGTH => Some(FT_V2_PARTIAL_OFFSET),
        LEGACY_COIN_LENGTH => Some(LEGACY_COIN_PARTIAL_OFFSET),
        FT_V4_LENGTH => Some(FT_V4_PARTIAL_OFFSET),
        _ => None,
    }
}

fn input_index_tag(input_index: usize) -> Result<u8> {
    match input_index {
        0 => Ok(0x00),
        1..=5 => Ok(0x50 + input_index as u8),
        _ => Err(Error::InvalidUtxo(
            "FT input index must be in the range 0..=5".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::Script;

    #[test]
    fn ft_unlock_length_and_size_match_js() {
        assert_eq!(hex::encode(length_hex(75).unwrap()), "4b");
        assert_eq!(hex::encode(length_hex(76).unwrap()), "4c4c");
        assert_eq!(hex::encode(length_hex(256).unwrap()), "4d0001");
        assert_eq!(hex::encode(size_le(255).unwrap()), "ff");
        assert_eq!(hex::encode(size_le(256).unwrap()), "0001");
    }

    #[test]
    fn ft_v2_contract_data_pads_to_fifteen_outputs_without_an_extra_zero() {
        let mut tx = Transaction::new();
        tx.outputs.push(TxOut {
            satoshis: 500,
            script_pubkey: crate::script::Script::from_bytes(vec![crate::script::opcodes::OP_1]),
        });

        let data = contract_tx_data(&tx, -1).unwrap();

        // Header and input hashes use 83 bytes. A real output uses 42 bytes,
        // followed by fourteen missing-output pairs (28 bytes).
        assert_eq!(data.len(), 83 + 42 + 28);
    }

    #[test]
    fn ft_pre_pre_outputs_split_around_vout() {
        let mut tx = crate::Transaction::new();
        tx.outputs.push(crate::TxOut {
            satoshis: 1,
            script_pubkey: crate::script::Script::from_bytes(vec![0x51]),
        });
        tx.outputs.push(crate::TxOut {
            satoshis: 2,
            script_pubkey: crate::script::Script::from_bytes(vec![0x52]),
        });
        tx.outputs.push(crate::TxOut {
            satoshis: 3,
            script_pubkey: crate::script::Script::from_bytes(vec![0x53]),
        });

        let split = pre_pre_outputs_data(&tx, 1).unwrap();
        assert!(!split.outputs1.is_empty());
        assert!(!split.outputs2.is_empty());
        assert_eq!(split.outputs1_length, vec![40]);
        assert_eq!(split.outputs2_length, vec![40]);
    }

    #[test]
    fn ft_current_inputs_data_serializes_outpoints_and_sequences() {
        let mut prev = crate::Transaction::new();
        prev.outputs.push(crate::TxOut {
            satoshis: 1,
            script_pubkey: crate::script::Script::from_bytes(vec![0x51]),
        });

        let mut tx = crate::Transaction::new();
        tx.add_input_from_prev_tx(&prev, 0).unwrap();
        let data = current_inputs_data(&tx).unwrap();
        assert_eq!(data[0], 40);
        assert_eq!(data.len(), 41);
    }

    #[test]
    fn ft_current_tx_data_appends_input_index_tag() {
        let mut tx = crate::Transaction::new();
        tx.outputs.push(crate::TxOut {
            satoshis: 500,
            script_pubkey: crate::script::Script::from_bytes(vec![0x51; 70]),
        });
        let data = current_tx_data(&tx, 2).unwrap();
        assert_eq!(data[0], 0x51);
        assert_eq!(data[data.len() - 1], 0x52);
    }

    fn synthetic_ft_script(length: usize, fill_opcode: u8) -> Script {
        let mut suffix = vec![fill_opcode];
        if fill_opcode == 0x02 {
            suffix.extend_from_slice(&[0xaa, 0xbb]);
        }
        suffix.extend_from_slice(&[0x61, 0x61]);
        suffix.push(0x15);
        suffix.extend_from_slice(&[0x22; 21]);
        suffix.push(0x05);
        suffix.extend_from_slice(b"2Code");
        let mut bytes = vec![0x61; length - suffix.len()];
        bytes.extend_from_slice(&suffix);
        Script::from_bytes(bytes)
    }

    fn synthetic_ft_script_with_fill(length: usize, fill: &[u8]) -> Script {
        let mut suffix = vec![fill.len() as u8];
        suffix.extend_from_slice(fill);
        suffix.extend_from_slice(&[0x61, 0x61]);
        suffix.push(0x15);
        suffix.extend_from_slice(&[0x22; 21]);
        suffix.push(0x05);
        suffix.extend_from_slice(b"2Code");
        let mut bytes = vec![0x61; length - suffix.len()];
        bytes.extend_from_slice(&suffix);
        Script::from_bytes(bytes)
    }

    #[test]
    fn ft_classifier_distinguishes_v1_v2_and_v3() {
        let v1 = synthetic_ft_script(1_564, 0x60);
        let v2 = synthetic_ft_script(1_884, 0x60);
        let v3 = synthetic_ft_script(1_884, 0x5f);

        assert_eq!(classify_ft_script(&v1).unwrap().version, 1);
        assert_eq!(classify_ft_script(&v2).unwrap().version, 2);
        assert_eq!(classify_ft_script(&v3).unwrap().version, 3);
        assert!(!classify_ft_script(&v3).unwrap().is_coin);
    }

    #[test]
    fn ft_classifier_handles_coin_family_and_rejects_unsupported_scripts() {
        let coin_v2 = synthetic_ft_script_with_fill(2_012, &[0xff; 11]);
        let coin_v3 = synthetic_ft_script_with_fill(2_012, &[0xff; 2]);
        let ft_v4_legacy = synthetic_ft_script_with_fill(2_012, &[0xff; 28]);
        let ft_v4 = synthetic_ft_script_with_fill(2_076, &[0x42; 39]);
        let coin_v4 = synthetic_ft_script_with_fill(2_076, &[0xff; 10]);

        assert_eq!(classify_ft_script(&coin_v2).unwrap().version, 2);
        assert!(classify_ft_script(&coin_v2).unwrap().is_coin);
        assert_eq!(classify_ft_script(&coin_v3).unwrap().version, 3);
        assert!(classify_ft_script(&coin_v3).unwrap().is_coin);
        assert_eq!(classify_ft_script(&ft_v4_legacy).unwrap().version, 4);
        assert!(!classify_ft_script(&ft_v4_legacy).unwrap().is_coin);
        assert_eq!(classify_ft_script(&ft_v4).unwrap().version, 4);
        assert!(!classify_ft_script(&ft_v4).unwrap().is_coin);
        assert_eq!(classify_ft_script(&coin_v4).unwrap().version, 4);
        assert!(classify_ft_script(&coin_v4).unwrap().is_coin);
        assert!(classify_ft_script(&Script::from_bytes(vec![0x51; 100])).is_err());
    }

    #[test]
    fn ft_pre_pre_data_derives_verified_grandparents_in_reverse_slot_order() {
        let parent = |seed: u8| {
            let mut tx = Transaction::new();
            tx.lock_time = seed as u32;
            tx.outputs.push(TxOut {
                satoshis: seed as u64,
                script_pubkey: Script::from_bytes(vec![0x51]),
            });
            tx
        };
        let parent0 = parent(1);
        let parent1 = parent(2);
        let mut pre_tx = Transaction::new();
        pre_tx.inputs.push(crate::TxIn::new(crate::OutPoint {
            txid: parent0.txid(),
            vout: 0,
        }));
        pre_tx.inputs.push(crate::TxIn::new(crate::OutPoint {
            txid: parent1.txid(),
            vout: 0,
        }));
        pre_tx.outputs.push(TxOut {
            satoshis: 500,
            script_pubkey: synthetic_ft_script(1_884, 0x5f),
        });
        let mut amounts = [0u8; 48];
        amounts[..8].copy_from_slice(&3u64.to_le_bytes());
        amounts[8..16].copy_from_slice(&4u64.to_le_bytes());
        pre_tx.outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: crate::contracts::ft::scripts::mint_tape_script(&amounts, 0, "T", "T"),
        });

        let data =
            pre_pre_tx_data_from_parents(&pre_tx, 0, &[parent1.clone(), parent0.clone()]).unwrap();
        let mut expected = vec![0x57];
        expected.extend_from_slice(&pre_pre_tx_data(&parent1, 0).unwrap());
        expected.extend_from_slice(&pre_pre_tx_data(&parent0, 0).unwrap());
        assert_eq!(data, expected);

        assert!(
            pre_pre_tx_data_from_parents(&pre_tx, 0, &[parent0.clone(), parent1.clone()]).is_err()
        );
        assert!(pre_pre_tx_data_from_parents(&pre_tx, 0, std::slice::from_ref(&parent1)).is_err());
        assert!(
            pre_pre_tx_data_from_parents(&pre_tx, 0, &[parent1, parent0.clone(), parent0]).is_err()
        );
    }

    #[test]
    fn ft_pre_pre_data_rejects_malformed_or_nonzero_tape_outputs() {
        let mut pre_tx = Transaction::new();
        pre_tx.inputs.push(crate::TxIn::new(crate::OutPoint {
            txid: crate::Txid::from_le_bytes([1; 32]),
            vout: 0,
        }));
        pre_tx.outputs.push(TxOut {
            satoshis: 500,
            script_pubkey: synthetic_ft_script(1_884, 0x5f),
        });
        for (satoshis, script) in [
            (0, Script::from_bytes(vec![0; 56])),
            (
                1,
                crate::contracts::ft::scripts::mint_tape_script(&[1; 48], 0, "T", "T"),
            ),
        ] {
            let mut malformed = pre_tx.clone();
            malformed.outputs.push(TxOut {
                satoshis,
                script_pubkey: script,
            });
            assert!(pre_pre_tx_data_from_parents(&malformed, 0, &[]).is_err());
        }
    }
}
