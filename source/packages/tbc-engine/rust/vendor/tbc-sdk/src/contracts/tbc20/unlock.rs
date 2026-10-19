use crate::{
    DEFAULT_SIGHASH, Error, PrivateKey, Result, Transaction, TxOut, Txid, hash,
    script::{Script, opcodes},
};

use super::{
    TBC20_AMOUNT_SLOTS, TBC20_CODE_SATOSHIS, TBC20_MAX_INPUTS, TBC20_MAX_OUTPUT_GROUPS,
    TBC20_MAX_OUTPUTS, TBC20_TAPE_SATOSHIS, encode_unsigned_script_num, parse_tbc20_tape,
    tbc20_controller,
};
use crate::contracts::ft::partial_sha256::calculate_partial_hash;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tbc20OutputGroup {
    pub code_vout: usize,
    pub tape_vout: Option<usize>,
}

pub trait Tbc20AncestorResolver {
    fn resolve_tbc20_ancestor(&self, txid: &Txid) -> Option<&Transaction>;
}

impl Tbc20AncestorResolver for Vec<Transaction> {
    fn resolve_tbc20_ancestor(&self, txid: &Txid) -> Option<&Transaction> {
        self.iter().find(|transaction| transaction.txid() == *txid)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Tbc20ContractControllerWitness<'a> {
    pub transaction: &'a Transaction,
    pub current_input_index: usize,
}

#[derive(Clone, Copy)]
pub struct Tbc20UnlockOptions<'a> {
    pub current_tx: &'a Transaction,
    pub input_index: usize,
    pub pre_tx: &'a Transaction,
    pub pre_tx_vout: usize,
    pub output_groups: &'a [Tbc20OutputGroup],
    pub ancestor_transactions: &'a dyn Tbc20AncestorResolver,
    pub contract_controller: Option<Tbc20ContractControllerWitness<'a>>,
    pub signature: &'a [u8],
    pub public_key: &'a [u8],
}

#[derive(Clone, Debug, Default)]
struct PartialScriptData {
    suffix: Vec<u8>,
    partial_hash: Vec<u8>,
    size: Vec<u8>,
}

#[derive(Clone, Debug, Default)]
struct OutputData {
    value: Vec<u8>,
    partial: PartialScriptData,
}

#[derive(Clone, Debug, Default)]
struct OutputGroupData {
    code: OutputData,
    tape_value: Vec<u8>,
    tape_script: Vec<u8>,
}

#[derive(Clone, Debug, Default)]
struct PreTxData {
    vlio: Vec<u8>,
    inputs: [Vec<u8>; TBC20_MAX_INPUTS],
    unlocking_script_hash: Vec<u8>,
    outputs_first: Vec<u8>,
    output: OutputGroupData,
    outputs_last: Vec<u8>,
}

#[derive(Clone, Debug, Default)]
struct PrePreTxData {
    vlio: Vec<u8>,
    inputs_hash_data: Vec<u8>,
    outputs_first: Vec<u8>,
    output: OutputData,
    outputs_last: Vec<u8>,
}

#[derive(Clone, Debug, Default)]
struct ContractTxData {
    vlio: Vec<u8>,
    inputs_hash_data: Vec<u8>,
    outputs_first: Vec<u8>,
    middle_value: Vec<u8>,
    middle_locking_script: Vec<u8>,
    outputs_last: Vec<u8>,
}

pub fn build_tbc20_unlock_script(
    options: Tbc20UnlockOptions<'_>,
    private_key: &PrivateKey,
) -> Result<Script> {
    validate_common(&options)?;
    let previous = &options.pre_tx.outputs[options.pre_tx_vout];
    let signature = options.current_tx.signature_with_hashtype(
        options.input_index,
        private_key,
        &previous.script_pubkey,
        previous.satoshis,
        DEFAULT_SIGHASH,
    )?;
    let public_key = private_key.public_key().to_bytes();
    build_tbc20_unlock_script_with_signature(Tbc20UnlockOptions {
        current_tx: options.current_tx,
        input_index: options.input_index,
        pre_tx: options.pre_tx,
        pre_tx_vout: options.pre_tx_vout,
        output_groups: options.output_groups,
        ancestor_transactions: options.ancestor_transactions,
        contract_controller: options.contract_controller,
        signature: &signature,
        public_key: &public_key,
    })
}

pub fn build_tbc20_unlock_script_with_signature(options: Tbc20UnlockOptions<'_>) -> Result<Script> {
    validate_common(&options)?;
    if options.signature.is_empty()
        || options.signature.len() > 72
        || options.public_key.len() != 33
    {
        return Err(invalid("invalid signature or compressed public key"));
    }
    let pre = pre_tx_data(options.pre_tx, options.pre_tx_vout)?;
    let controller = tbc20_controller(&options.pre_tx.outputs[options.pre_tx_vout].script_pubkey)?;
    if controller[20] == 0 && hash::hash160(options.public_key) != controller[..20] {
        return Err(invalid("public key does not match controller"));
    }
    let (contract, controller_input_index) =
        resolve_controller(options.current_tx, controller, options.contract_controller)?;
    let outputs = current_output_data(options.current_tx, options.output_groups)?;
    let current_inputs = input_records(options.current_tx);
    let ancestors = pre_pre_array(
        options.pre_tx,
        options.pre_tx_vout,
        options.ancestor_transactions,
    )?;

    let mut unlock = Vec::new();
    for output in outputs {
        add_group(&mut unlock, &output);
    }
    push_data(&mut unlock, &current_inputs);
    push_number(&mut unlock, options.input_index);
    for ancestor in ancestors {
        add_pre_pre(&mut unlock, &ancestor);
    }
    push_data(&mut unlock, options.signature);
    push_data(&mut unlock, options.public_key);
    add_contract(&mut unlock, &contract);
    push_number(&mut unlock, controller_input_index);
    add_pre_tx(&mut unlock, &pre);
    if count_chunks(&unlock)? != 123 {
        return Err(invalid("internal ABI did not produce exactly 123 chunks"));
    }
    Ok(Script::from_bytes(unlock))
}

fn validate_common(options: &Tbc20UnlockOptions<'_>) -> Result<()> {
    assert_version10(options.current_tx, "current transaction")?;
    assert_version10(options.pre_tx, "previous transaction")?;
    if options.input_index >= TBC20_AMOUNT_SLOTS
        || options.input_index >= options.current_tx.inputs.len()
    {
        return Err(invalid("input index out of range"));
    }
    if options.pre_tx_vout >= options.pre_tx.outputs.len() {
        return Err(invalid("previous transaction vout out of range"));
    }
    let input = &options.current_tx.inputs[options.input_index];
    if input.previous_output.txid != options.pre_tx.txid()
        || input.previous_output.vout as usize != options.pre_tx_vout
    {
        return Err(invalid(
            "current input does not spend previous transaction output",
        ));
    }
    Ok(())
}

fn assert_version10(transaction: &Transaction, name: &str) -> Result<()> {
    if transaction.version != 10 || transaction.inputs.is_empty() || transaction.outputs.is_empty()
    {
        return Err(invalid(format!(
            "{name} must have version 10 with inputs and outputs"
        )));
    }
    Ok(())
}

fn vlio(transaction: &Transaction) -> Vec<u8> {
    let mut result = Vec::with_capacity(16);
    result.extend_from_slice(&transaction.version.to_le_bytes());
    result.extend_from_slice(&transaction.lock_time.to_le_bytes());
    result.extend_from_slice(&(transaction.inputs.len() as u32).to_le_bytes());
    result.extend_from_slice(&(transaction.outputs.len() as u32).to_le_bytes());
    result
}

fn input_record(input: &crate::TxIn) -> Vec<u8> {
    let mut result = Vec::with_capacity(40);
    input.previous_output.serialize(&mut result);
    result.extend_from_slice(&input.sequence.to_le_bytes());
    result
}

fn input_records(transaction: &Transaction) -> Vec<u8> {
    transaction.inputs.iter().flat_map(input_record).collect()
}

fn unlocking_scripts_hash(transaction: &Transaction) -> Vec<u8> {
    let hashes = transaction
        .inputs
        .iter()
        .flat_map(|input| hash::sha256(input.script_sig.as_bytes()))
        .collect::<Vec<_>>();
    hash::sha256(&hashes).to_vec()
}

fn inputs_hash_data(transaction: &Transaction) -> Vec<u8> {
    let mut result = hash::sha256(&input_records(transaction)).to_vec();
    result.extend_from_slice(&unlocking_scripts_hash(transaction));
    result
}

fn output_hash_records(transaction: &Transaction, start: usize, end: usize) -> Result<Vec<u8>> {
    if end < start || end > transaction.outputs.len() {
        return Err(invalid("output range is invalid"));
    }
    let mut result = Vec::with_capacity((end - start) * 40);
    for output in &transaction.outputs[start..end] {
        result.extend_from_slice(&output.satoshis.to_le_bytes());
        result.extend_from_slice(&hash::sha256(output.script_pubkey.as_bytes()));
    }
    Ok(result)
}

fn partial_script_data(script: &Script) -> Result<PartialScriptData> {
    if script.as_bytes().is_empty() {
        return Err(invalid("locking script must be non-empty"));
    }
    let bytes = script.as_bytes();
    let partial_offset = bytes.len() / 64 * 64;
    Ok(PartialScriptData {
        suffix: bytes[partial_offset..].to_vec(),
        partial_hash: if partial_offset == 0 {
            Vec::new()
        } else {
            calculate_partial_hash(&bytes[..partial_offset]).to_vec()
        },
        size: encode_unsigned_script_num(bytes.len() as u64),
    })
}

fn output_data(output: &TxOut) -> Result<OutputData> {
    Ok(OutputData {
        value: output.satoshis.to_le_bytes().to_vec(),
        partial: partial_script_data(&output.script_pubkey)?,
    })
}

fn output_group_data(
    transaction: &Transaction,
    code_vout: usize,
    tape_vout: Option<usize>,
) -> Result<OutputGroupData> {
    let code = transaction
        .outputs
        .get(code_vout)
        .ok_or_else(|| invalid("code output is out of range"))?;
    let mut result = OutputGroupData {
        code: output_data(code)?,
        ..OutputGroupData::default()
    };
    if let Some(tape_vout) = tape_vout {
        let tape = transaction
            .outputs
            .get(tape_vout)
            .ok_or_else(|| invalid("tape output is out of range"))?;
        result.tape_value = tape.satoshis.to_le_bytes().to_vec();
        result.tape_script = tape.script_pubkey.as_bytes().to_vec();
    }
    Ok(result)
}

fn current_output_data(
    transaction: &Transaction,
    groups: &[Tbc20OutputGroup],
) -> Result<[OutputGroupData; TBC20_MAX_OUTPUT_GROUPS]> {
    assert_version10(transaction, "current transaction")?;
    if transaction.outputs.len() > TBC20_MAX_OUTPUTS
        || groups.is_empty()
        || groups.len() > TBC20_MAX_OUTPUT_GROUPS
    {
        return Err(invalid("invalid current output group count"));
    }
    let mut result: [OutputGroupData; TBC20_MAX_OUTPUT_GROUPS] = Default::default();
    let mut next = 0usize;
    for (index, group) in groups.iter().enumerate() {
        if group.code_vout != next {
            return Err(invalid(format!(
                "output group {index} code vout must be {next}"
            )));
        }
        if let Some(tape_vout) = group.tape_vout {
            if tape_vout != group.code_vout + 1 {
                return Err(invalid("tape must immediately follow code"));
            }
            next += 2;
        } else {
            next += 1;
        }
        result[index] = output_group_data(transaction, group.code_vout, group.tape_vout)?;
    }
    if next != transaction.outputs.len() {
        return Err(invalid("output groups do not cover every physical output"));
    }
    Ok(result)
}

fn pre_tx_data(transaction: &Transaction, code_vout: usize) -> Result<PreTxData> {
    assert_version10(transaction, "previous transaction")?;
    if transaction.inputs.len() > TBC20_MAX_INPUTS || code_vout + 1 >= transaction.outputs.len() {
        return Err(invalid("invalid previous TBC20 output"));
    }
    let code = &transaction.outputs[code_vout];
    let tape = &transaction.outputs[code_vout + 1];
    if code.satoshis != TBC20_CODE_SATOSHIS || tape.satoshis != TBC20_TAPE_SATOSHIS {
        return Err(invalid("previous code/tape values must be 500/0"));
    }
    parse_tbc20_tape(&tape.script_pubkey)?;
    let mut result = PreTxData {
        vlio: vlio(transaction),
        unlocking_script_hash: unlocking_scripts_hash(transaction),
        outputs_first: output_hash_records(transaction, 0, code_vout)?,
        output: output_group_data(transaction, code_vout, Some(code_vout + 1))?,
        outputs_last: output_hash_records(transaction, code_vout + 2, transaction.outputs.len())?,
        ..PreTxData::default()
    };
    for (index, input) in transaction.inputs.iter().enumerate() {
        result.inputs[index] = input_record(input);
    }
    Ok(result)
}

fn pre_pre_data(transaction: &Transaction, vout: usize) -> Result<PrePreTxData> {
    assert_version10(transaction, "ancestor transaction")?;
    let output = transaction
        .outputs
        .get(vout)
        .ok_or_else(|| invalid("ancestor vout is out of range"))?;
    Ok(PrePreTxData {
        vlio: vlio(transaction),
        inputs_hash_data: inputs_hash_data(transaction),
        outputs_first: output_hash_records(transaction, 0, vout)?,
        output: output_data(output)?,
        outputs_last: output_hash_records(transaction, vout + 1, transaction.outputs.len())?,
    })
}

fn pre_pre_array(
    pre_tx: &Transaction,
    code_vout: usize,
    resolver: &dyn Tbc20AncestorResolver,
) -> Result<[PrePreTxData; TBC20_MAX_INPUTS]> {
    let mut result: [PrePreTxData; TBC20_MAX_INPUTS] = Default::default();
    let tape = pre_tx
        .outputs
        .get(code_vout + 1)
        .ok_or_else(|| invalid("previous tape output is missing"))?;
    let amounts = parse_tbc20_tape(&tape.script_pubkey)?.amounts;
    for parent_index in 0..TBC20_MAX_INPUTS {
        if amounts[parent_index] == 0 {
            continue;
        }
        let input = pre_tx
            .inputs
            .get(parent_index)
            .ok_or_else(|| invalid(format!("tape slot {parent_index} has no matching input")))?;
        let ancestor = resolver
            .resolve_tbc20_ancestor(&input.previous_output.txid)
            .ok_or_else(|| invalid(format!("missing ancestor {}", input.previous_output.txid)))?;
        if ancestor.txid() != input.previous_output.txid {
            return Err(invalid("ancestor transaction hash mismatch"));
        }
        result[TBC20_MAX_INPUTS - 1 - parent_index] =
            pre_pre_data(ancestor, input.previous_output.vout as usize)?;
    }
    Ok(result)
}

fn contract_data(transaction: &Transaction, vout: usize) -> Result<ContractTxData> {
    assert_version10(transaction, "controller transaction")?;
    let output = transaction
        .outputs
        .get(vout)
        .ok_or_else(|| invalid("controller vout is out of range"))?;
    Ok(ContractTxData {
        vlio: vlio(transaction),
        inputs_hash_data: inputs_hash_data(transaction),
        outputs_first: output_hash_records(transaction, 0, vout)?,
        middle_value: output.satoshis.to_le_bytes().to_vec(),
        middle_locking_script: hash::sha256(output.script_pubkey.as_bytes()).to_vec(),
        outputs_last: output_hash_records(transaction, vout + 1, transaction.outputs.len())?,
    })
}

fn resolve_controller(
    current_tx: &Transaction,
    controller: [u8; 21],
    witness: Option<Tbc20ContractControllerWitness<'_>>,
) -> Result<(ContractTxData, usize)> {
    if controller[20] == 0 {
        if witness.is_some() {
            return Err(invalid(
                "contract controller must be omitted for address controller",
            ));
        }
        return Ok((ContractTxData::default(), 0));
    }
    if controller[20] == 0x80 {
        return Err(invalid("negative-zero controller"));
    }
    let witness = witness.ok_or_else(|| invalid("contract controller witness is required"))?;
    let input = current_tx
        .inputs
        .get(witness.current_input_index)
        .ok_or_else(|| invalid("controller input index is out of range"))?;
    if input.previous_output.txid != witness.transaction.txid() {
        return Err(invalid("controller input transaction mismatch"));
    }
    let output = witness
        .transaction
        .outputs
        .get(input.previous_output.vout as usize)
        .ok_or_else(|| invalid("controller vout is out of range"))?;
    let expected = hash::hash160(&hash::sha256(output.script_pubkey.as_bytes()));
    if expected != controller[..20] {
        return Err(invalid("controller hash mismatch"));
    }
    Ok((
        contract_data(witness.transaction, input.previous_output.vout as usize)?,
        witness.current_input_index,
    ))
}

fn add_output(unlock: &mut Vec<u8>, output: &OutputData) {
    push_data(unlock, &output.value);
    push_data(unlock, &output.partial.suffix);
    push_data(unlock, &output.partial.partial_hash);
    push_data(unlock, &output.partial.size);
}

fn add_group(unlock: &mut Vec<u8>, group: &OutputGroupData) {
    add_output(unlock, &group.code);
    push_data(unlock, &group.tape_value);
    push_data(unlock, &group.tape_script);
}

fn add_pre_pre(unlock: &mut Vec<u8>, data: &PrePreTxData) {
    push_data(unlock, &data.vlio);
    push_data(unlock, &data.inputs_hash_data);
    push_data(unlock, &data.outputs_first);
    add_output(unlock, &data.output);
    push_data(unlock, &data.outputs_last);
}

fn add_contract(unlock: &mut Vec<u8>, data: &ContractTxData) {
    push_data(unlock, &data.vlio);
    push_data(unlock, &data.inputs_hash_data);
    push_data(unlock, &data.outputs_first);
    push_data(unlock, &data.middle_value);
    push_data(unlock, &data.middle_locking_script);
    push_data(unlock, &data.outputs_last);
}

fn add_pre_tx(unlock: &mut Vec<u8>, data: &PreTxData) {
    push_data(unlock, &data.vlio);
    for input in &data.inputs {
        push_data(unlock, input);
    }
    push_data(unlock, &data.unlocking_script_hash);
    push_data(unlock, &data.outputs_first);
    add_group(unlock, &data.output);
    push_data(unlock, &data.outputs_last);
}

fn push_number(unlock: &mut Vec<u8>, value: usize) {
    match value {
        0 => unlock.push(opcodes::OP_0),
        1..=16 => unlock.push(opcodes::OP_1 + value as u8 - 1),
        _ => push_data(unlock, &encode_unsigned_script_num(value as u64)),
    }
}

fn push_data(unlock: &mut Vec<u8>, data: &[u8]) {
    match data.len() {
        0..=75 => unlock.push(data.len() as u8),
        76..=0xff => {
            unlock.push(opcodes::OP_PUSHDATA1);
            unlock.push(data.len() as u8);
        }
        0x100..=0xffff => {
            unlock.push(opcodes::OP_PUSHDATA2);
            unlock.extend_from_slice(&(data.len() as u16).to_le_bytes());
        }
        _ => {
            unlock.push(opcodes::OP_PUSHDATA4);
            unlock.extend_from_slice(&(data.len() as u32).to_le_bytes());
        }
    }
    unlock.extend_from_slice(data);
}

fn count_chunks(script: &[u8]) -> Result<usize> {
    let mut offset = 0usize;
    let mut count = 0usize;
    while offset < script.len() {
        let opcode = script[offset];
        offset += 1;
        count += 1;
        let length = match opcode {
            opcodes::OP_0 | opcodes::OP_1..=opcodes::OP_16 => continue,
            1..=75 => usize::from(opcode),
            opcodes::OP_PUSHDATA1 => {
                let length = *script
                    .get(offset)
                    .ok_or_else(|| invalid("truncated PUSHDATA1"))?;
                offset += 1;
                usize::from(length)
            }
            opcodes::OP_PUSHDATA2 => {
                let raw = script
                    .get(offset..offset + 2)
                    .ok_or_else(|| invalid("truncated PUSHDATA2"))?;
                offset += 2;
                usize::from(u16::from_le_bytes(raw.try_into().unwrap()))
            }
            opcodes::OP_PUSHDATA4 => {
                let raw = script
                    .get(offset..offset + 4)
                    .ok_or_else(|| invalid("truncated PUSHDATA4"))?;
                offset += 4;
                usize::try_from(u32::from_le_bytes(raw.try_into().unwrap()))
                    .map_err(|_| invalid("PUSHDATA4 length overflows usize"))?
            }
            _ => return Err(invalid("unlock contains a non-push opcode")),
        };
        offset = offset
            .checked_add(length)
            .filter(|end| *end <= script.len())
            .ok_or_else(|| invalid("unlock push is truncated"))?;
    }
    Ok(count)
}

fn invalid(message: impl Into<String>) -> Error {
    Error::InvalidScript(format!("TBC20 unlock: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    #[test]
    fn transfer_unlock_matches_javascript_166_exactly() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/js-166/tbc20.json"))
                .unwrap();
        let transaction = &fixture["transactionFixture"];
        let current = Transaction::from_hex(transaction["transferRaw"].as_str().unwrap()).unwrap();
        let pre = Transaction::from_hex(transaction["mintRaw"].as_str().unwrap()).unwrap();
        let source = Transaction::from_hex(transaction["sourceRaw"].as_str().unwrap()).unwrap();
        let signature = hex::decode(transaction["transferSignatureHex"].as_str().unwrap()).unwrap();
        let public_key = hex::decode(transaction["publicKeyHex"].as_str().unwrap()).unwrap();
        let groups = [
            Tbc20OutputGroup {
                code_vout: 0,
                tape_vout: Some(1),
            },
            Tbc20OutputGroup {
                code_vout: 2,
                tape_vout: Some(3),
            },
            Tbc20OutputGroup {
                code_vout: 4,
                tape_vout: None,
            },
        ];
        let ancestors = vec![source];
        let unlock = build_tbc20_unlock_script_with_signature(Tbc20UnlockOptions {
            current_tx: &current,
            input_index: 0,
            pre_tx: &pre,
            pre_tx_vout: 0,
            output_groups: &groups,
            ancestor_transactions: &ancestors,
            contract_controller: None,
            signature: &signature,
            public_key: &public_key,
        })
        .unwrap();
        assert_eq!(
            hex::encode(unlock.as_bytes()),
            transaction["transferUnlockHex"].as_str().unwrap()
        );
        assert_eq!(
            count_chunks(unlock.as_bytes()).unwrap() as u64,
            transaction["transferUnlockChunks"].as_u64().unwrap()
        );
    }
}
