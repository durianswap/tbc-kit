#![forbid(unsafe_code)]

use std::{collections::HashMap, str::FromStr};

use aes::Aes128;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use cbc::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
use hmac::{Hmac, Mac};
use secp256k1::{Message, PublicKey as SecpPublicKey, Scalar, Secp256k1, SecretKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use tbc_sdk::{
    DEFAULT_SIGHASH, OutPoint, PrivateKey, Transaction, TxIn, TxOut, Txid,
    contracts::ft::unlock::{
        contract_tx_data, current_inputs_data, current_tx_data, pre_tx_data,
    },
    script::Script,
};
use zeroize::Zeroizing;

const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_TRANSACTIONS: usize = 33;
const MAX_INPUTS: usize = 1_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignP2pkhRequest {
    txraws: Vec<String>,
    #[serde(alias = "utxos_satoshis")]
    utxos_satoshis: Vec<Vec<u64>>,
    #[serde(alias = "script_pubkeys")]
    script_pubkeys: Vec<Vec<String>>,
}

#[derive(Serialize)]
struct SignP2pkhResponse {
    sigs: Vec<Vec<String>>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AssociatedScriptType {
    P2pkh,
    Tbc20,
    Tbc20Contract,
    Tbc20Coin,
    Tbc20CoinContract,
    Other,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssociatedInput {
    tx_id: Option<String>,
    script: Option<String>,
    satoshis: Option<u64>,
    output_index: u32,
    script_sig_type: AssociatedScriptType,
    pre_tx: Option<String>,
    pre_pre_tx_data: Option<String>,
    contract_tx: Option<String>,
    ft_version: Option<u8>,
    unfinished_script_sig: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct AssociatedOutput {
    script: String,
    satoshis: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignAssociatedRequest {
    source_txraw: String,
    source_utxos: Vec<AssociatedInput>,
    #[serde(default)]
    inputs: Vec<Vec<AssociatedInput>>,
    #[serde(default)]
    outputs: Vec<Vec<AssociatedOutput>>,
}

#[derive(Serialize)]
struct SignAssociatedResponse {
    txraws: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncryptRequest {
    message_hex: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecryptRequest {
    encrypted_message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EncryptResponse {
    encrypted_message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DecryptResponse {
    message_hex: String,
}

fn private_key(scalar: &[u8]) -> Result<PrivateKey, String> {
    if scalar.len() != 32 {
        return Err("wallet-private scalar must be exactly 32 bytes".to_owned());
    }
    let copy = Zeroizing::new(<[u8; 32]>::try_from(scalar)
        .map_err(|_| "wallet-private scalar must be exactly 32 bytes".to_owned())?);
    PrivateKey::from_slice(copy.as_slice())
        .map_err(|_| "invalid wallet-private scalar".to_owned())
}

fn parse_request<T: for<'de> Deserialize<'de>>(input: &str, label: &str) -> Result<T, String> {
    if input.len() > MAX_REQUEST_BYTES {
        return Err(format!("{label} request exceeds the private native limit"));
    }
    serde_json::from_str(input).map_err(|error| format!("invalid {label} request: {error}"))
}

pub fn call(method: &str, input: &str, scalar: &[u8]) -> Result<String, String> {
    let key = private_key(scalar)?;
    match method {
        "signP2pkh" => sign_p2pkh(input, &key),
        "signAssociated" => sign_associated(input, &key),
        "encryptMessage" => encrypt(input, &key),
        "decryptMessage" => decrypt(input, &key),
        _ => Err("unsupported wallet-private native method".to_owned()),
    }
}

fn sign_p2pkh(input: &str, key: &PrivateKey) -> Result<String, String> {
    let request: SignP2pkhRequest = parse_request(input, "P2PKH signing")?;
    if request.txraws.is_empty()
        || request.txraws.len() > MAX_TRANSACTIONS
        || request.txraws.len() != request.utxos_satoshis.len()
        || request.txraws.len() != request.script_pubkeys.len()
    {
        return Err("P2PKH transaction matrix lengths are invalid".to_owned());
    }
    let mut sigs = Vec::with_capacity(request.txraws.len());
    for (transaction_index, raw) in request.txraws.iter().enumerate() {
        let transaction = Transaction::from_hex(raw)
            .map_err(|error| format!("txraws[{transaction_index}]: {error}"))?;
        let input_count = transaction.inputs.len();
        if input_count == 0
            || input_count > MAX_INPUTS
            || request.utxos_satoshis[transaction_index].len() != input_count
            || request.script_pubkeys[transaction_index].len() != input_count
        {
            return Err(format!("transaction {transaction_index} input matrix is invalid"));
        }
        let mut transaction_sigs = Vec::with_capacity(input_count);
        for input_index in 0..input_count {
            let script = parse_script(
                &request.script_pubkeys[transaction_index][input_index],
                &format!("scriptPubkeys[{transaction_index}][{input_index}]"),
            )?;
            let digest = transaction
                .sighash_digest(
                    input_index,
                    &script,
                    request.utxos_satoshis[transaction_index][input_index],
                    DEFAULT_SIGHASH,
                )
                .map_err(|error| error.to_string())?;
            transaction_sigs.push(hex::encode(signature(key, digest)?));
        }
        sigs.push(transaction_sigs);
    }
    serde_json::to_string(&SignP2pkhResponse { sigs }).map_err(|error| error.to_string())
}

fn sign_associated(input: &str, key: &PrivateKey) -> Result<String, String> {
    let request: SignAssociatedRequest = parse_request(input, "associated signing")?;
    if request.inputs.len() != request.outputs.len()
        || request.inputs.len() + 1 > MAX_TRANSACTIONS
        || request.source_utxos.len() > MAX_INPUTS
        || request.inputs.iter().any(|row| row.is_empty() || row.len() > MAX_INPUTS)
    {
        return Err("associated transaction matrix is invalid".to_owned());
    }
    reject_stablecoin(&request.source_utxos)?;
    for row in &request.inputs {
        reject_stablecoin(row)?;
    }
    let mut source = Transaction::from_hex(&request.source_txraw)
        .map_err(|error| format!("sourceTxraw: {error}"))?;
    if source.inputs.len() != request.source_utxos.len() {
        return Err("sourceUtxos length must match source transaction input count".to_owned());
    }
    let mut ancestry = HashMap::new();
    cache_pre_txs(&request.source_utxos, &mut ancestry)?;
    for row in &request.inputs {
        cache_pre_txs(row, &mut ancestry)?;
    }
    for (index, item) in request.source_utxos.iter().enumerate() {
        sign_associated_input(&mut source, index, item, key)?;
    }
    ancestry.insert(source.txid().to_string(), source.clone());
    let mut transactions = vec![source];
    for (transaction_index, (inputs, outputs)) in request.inputs.iter().zip(&request.outputs).enumerate() {
        let previous = transactions.last()
            .ok_or_else(|| "associated chain has no previous transaction".to_owned())?;
        let mut transaction = Transaction::new();
        for (input_index, item) in inputs.iter().enumerate() {
            let outpoint = if let Some(txid) = &item.tx_id {
                item.script.as_ref().ok_or_else(|| format!("inputs[{transaction_index}][{input_index}].script is required"))?;
                item.satoshis.ok_or_else(|| format!("inputs[{transaction_index}][{input_index}].satoshis is required"))?;
                OutPoint {
                    txid: Txid::from_str(txid).map_err(|error| format!("inputs[{transaction_index}][{input_index}].txId: {error}"))?,
                    vout: item.output_index,
                }
            } else {
                previous.outputs.get(item.output_index as usize)
                    .ok_or_else(|| format!("inputs[{transaction_index}][{input_index}].outputIndex is out of range"))?;
                OutPoint { txid: previous.txid(), vout: item.output_index }
            };
            transaction.inputs.push(TxIn::new(outpoint));
        }
        for (output_index, item) in outputs.iter().enumerate() {
            transaction.outputs.push(TxOut {
                satoshis: item.satoshis,
                script_pubkey: parse_script(&item.script, &format!("outputs[{transaction_index}][{output_index}].script"))?,
            });
        }
        let mut resolved = Vec::with_capacity(inputs.len());
        for item in inputs {
            if item.tx_id.is_some() {
                resolved.push(item.clone());
                continue;
            }
            let output = previous.outputs[item.output_index as usize].clone();
            let mut next = AssociatedInput {
                tx_id: Some(previous.txid().to_string()),
                script: Some(hex::encode(output.script_pubkey.as_bytes())),
                satoshis: Some(output.satoshis),
                ..item.clone()
            };
            if matches!(item.script_sig_type, AssociatedScriptType::Tbc20 | AssociatedScriptType::Tbc20Contract) {
                next.pre_tx = Some(previous.to_hex());
                next.pre_pre_tx_data = Some(hex::encode(local_pre_pre_tx_data(
                    previous,
                    item.output_index as usize,
                    &ancestry,
                )?));
            }
            resolved.push(next);
        }
        for (input_index, item) in resolved.iter().enumerate() {
            sign_associated_input(&mut transaction, input_index, item, key)?;
        }
        ancestry.insert(transaction.txid().to_string(), transaction.clone());
        transactions.push(transaction);
    }
    serde_json::to_string(&SignAssociatedResponse {
        txraws: transactions.into_iter().map(|transaction| transaction.to_hex()).collect(),
    }).map_err(|error| error.to_string())
}

fn reject_stablecoin(inputs: &[AssociatedInput]) -> Result<(), String> {
    if inputs.iter().any(|item| matches!(item.script_sig_type, AssociatedScriptType::Tbc20Coin | AssociatedScriptType::Tbc20CoinContract)) {
        return Err("StableCoin associated signing is outside this private native capability".to_owned());
    }
    Ok(())
}

fn sign_associated_input(
    transaction: &mut Transaction,
    input_index: usize,
    input: &AssociatedInput,
    key: &PrivateKey,
) -> Result<(), String> {
    let script_text = input.script.as_ref().ok_or_else(|| format!("input {input_index} script is required"))?;
    let satoshis = input.satoshis.ok_or_else(|| format!("input {input_index} satoshis is required"))?;
    let script = parse_script(script_text, &format!("input {input_index} script"))?;
    match input.script_sig_type {
        AssociatedScriptType::P2pkh => sign_p2pkh_input(transaction, input_index, key, &script, satoshis),
        AssociatedScriptType::Tbc20 | AssociatedScriptType::Tbc20Contract => {
            let is_contract = matches!(input.script_sig_type, AssociatedScriptType::Tbc20Contract);
            let pre_tx = Transaction::from_hex(input.pre_tx.as_ref().ok_or_else(|| format!("input {input_index} preTx is required"))?)
                .map_err(|error| format!("input {input_index} preTx: {error}"))?;
            let pre_pre = hex::decode(input.pre_pre_tx_data.as_ref().ok_or_else(|| format!("input {input_index} prePreTxData is required"))?)
                .map_err(|error| format!("input {input_index} prePreTxData: {error}"))?;
            let digest = transaction.sighash_digest(input_index, &script, satoshis, DEFAULT_SIGHASH)
                .map_err(|error| error.to_string())?;
            let mut unlocking = current_tx_data(transaction, input_index).map_err(|error| error.to_string())?;
            unlocking.extend_from_slice(&pre_pre);
            push_data(&mut unlocking, &signature(key, digest)?)?;
            push_data(&mut unlocking, &public_key(key)?)?;
            if is_contract {
                let version = input.ft_version.filter(|version| (1..=3).contains(version))
                    .ok_or_else(|| format!("input {input_index} ftVersion must be 1, 2, or 3"))?;
                let contract = Transaction::from_hex(input.contract_tx.as_ref().ok_or_else(|| format!("input {input_index} contractTx is required"))?)
                    .map_err(|error| format!("input {input_index} contractTx: {error}"))?;
                unlocking.extend_from_slice(&current_inputs_data(transaction).map_err(|error| error.to_string())?);
                let vout = if version > 1 { -1 } else {
                    transaction.inputs.first().map(|item| item.previous_output.vout as i32).unwrap_or_default()
                };
                unlocking.extend_from_slice(&contract_tx_data(&contract, vout).map_err(|error| error.to_string())?);
                if version > 2 { unlocking.push(0); }
            }
            unlocking.extend_from_slice(&pre_tx_data(&pre_tx, input.output_index as usize).map_err(|error| error.to_string())?);
            transaction.inputs[input_index].script_sig = Script::from_bytes(unlocking);
            Ok(())
        }
        AssociatedScriptType::Other => {
            const PLACEHOLDER: &[u8] = b"\x09signature";
            let mut template = hex::decode(input.unfinished_script_sig.as_ref().ok_or_else(|| format!("input {input_index} unfinishedScriptSig is required"))?)
                .map_err(|error| format!("input {input_index} unfinishedScriptSig: {error}"))?;
            let positions: Vec<_> = template.windows(PLACEHOLDER.len()).enumerate()
                .filter_map(|(index, value)| (value == PLACEHOLDER).then_some(index)).collect();
            if positions.len() != 1 {
                return Err(format!("input {input_index} unfinishedScriptSig must contain exactly one signature placeholder"));
            }
            let digest = transaction.sighash_digest(input_index, &script, satoshis, DEFAULT_SIGHASH)
                .map_err(|error| error.to_string())?;
            let mut pushed = Vec::new();
            push_data(&mut pushed, &signature(key, digest)?)?;
            template.splice(positions[0]..positions[0] + PLACEHOLDER.len(), pushed);
            transaction.inputs[input_index].script_sig = Script::from_bytes(template);
            Ok(())
        }
        AssociatedScriptType::Tbc20Coin | AssociatedScriptType::Tbc20CoinContract =>
            Err("StableCoin associated signing is outside this private native capability".to_owned()),
    }
}

fn cache_pre_txs(inputs: &[AssociatedInput], ancestry: &mut HashMap<String, Transaction>) -> Result<(), String> {
    for input in inputs {
        if let Some(raw) = &input.pre_tx {
            let transaction = Transaction::from_hex(raw).map_err(|error| format!("preTx: {error}"))?;
            ancestry.insert(transaction.txid().to_string(), transaction);
        }
    }
    Ok(())
}

fn local_pre_pre_tx_data(
    pre_tx: &Transaction,
    output_index: usize,
    ancestry: &HashMap<String, Transaction>,
) -> Result<Vec<u8>, String> {
    let tape = pre_tx.outputs.get(output_index + 1)
        .ok_or_else(|| format!("preTx output {output_index} is missing its tape output"))?
        .script_pubkey.as_bytes();
    if tape.len() < 51 { return Err("preTx tape output is shorter than 51 bytes".to_owned()); }
    let mut data = vec![0x57];
    for byte_offset in (0..=40).rev().step_by(8) {
        if tape[3 + byte_offset..3 + byte_offset + 8].iter().all(|byte| *byte == 0) { continue; }
        let input = pre_tx.inputs.get(byte_offset / 8)
            .ok_or_else(|| format!("preTx input {} required by tape is missing", byte_offset / 8))?;
        let ancestor = ancestry.get(&input.previous_output.txid.to_string())
            .ok_or_else(|| format!("missing pre-pre transaction {}", input.previous_output.txid))?;
        data.extend_from_slice(&tbc_sdk::contracts::ft::unlock::pre_pre_tx_data(
            ancestor,
            input.previous_output.vout as usize,
        ).map_err(|error| error.to_string())?);
    }
    Ok(data)
}

fn encrypt(input: &str, key: &PrivateKey) -> Result<String, String> {
    let request: EncryptRequest = parse_request(input, "encryption")?;
    let message = hex::decode(&request.message_hex).map_err(|error| format!("messageHex: {error}"))?;
    let secret = SecretKey::from_byte_array(key.to_bytes()).map_err(|error| error.to_string())?;
    let public = SecpPublicKey::from_secret_key(&Secp256k1::new(), &secret);
    let material = bie1_material(&secret, &public)?;
    let ciphertext = cbc::Encryptor::<Aes128>::new_from_slices(&material[16..32], &material[..16])
        .map_err(|error| error.to_string())?.encrypt_padded_vec_mut::<Pkcs7>(&message);
    let mut encrypted = Vec::with_capacity(4 + 33 + ciphertext.len() + 32);
    encrypted.extend_from_slice(b"BIE1");
    encrypted.extend_from_slice(&public.serialize());
    encrypted.extend_from_slice(&ciphertext);
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&material[32..]).map_err(|error| error.to_string())?;
    mac.update(&encrypted);
    encrypted.extend_from_slice(&mac.finalize().into_bytes());
    serde_json::to_string(&EncryptResponse { encrypted_message: BASE64.encode(encrypted) })
        .map_err(|error| error.to_string())
}

fn decrypt(input: &str, key: &PrivateKey) -> Result<String, String> {
    let request: DecryptRequest = parse_request(input, "decryption")?;
    let encrypted = BASE64.decode(&request.encrypted_message).map_err(|error| format!("encryptedMessage: {error}"))?;
    if encrypted.len() < 4 + 33 + 16 + 32 || &encrypted[..4] != b"BIE1" {
        return Err("Invalid BIE1 ciphertext".to_owned());
    }
    let payload_end = encrypted.len() - 32;
    let ciphertext = &encrypted[37..payload_end];
    if ciphertext.is_empty() || !ciphertext.len().is_multiple_of(16) {
        return Err("Invalid BIE1 ciphertext length".to_owned());
    }
    let public = SecpPublicKey::from_slice(&encrypted[4..37]).map_err(|error| error.to_string())?;
    let secret = SecretKey::from_byte_array(key.to_bytes()).map_err(|error| error.to_string())?;
    let material = bie1_material(&secret, &public)?;
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&material[32..]).map_err(|error| error.to_string())?;
    mac.update(&encrypted[..payload_end]);
    mac.verify_slice(&encrypted[payload_end..]).map_err(|_| "Invalid checksum".to_owned())?;
    let message = cbc::Decryptor::<Aes128>::new_from_slices(&material[16..32], &material[..16])
        .map_err(|error| error.to_string())?.decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
        .map_err(|error| error.to_string())?;
    serde_json::to_string(&DecryptResponse { message_hex: hex::encode(message) })
        .map_err(|error| error.to_string())
}

fn bie1_material(secret: &SecretKey, public: &SecpPublicKey) -> Result<[u8; 64], String> {
    let scalar = Scalar::from_be_bytes(secret.secret_bytes()).map_err(|_| "invalid ECIES secret scalar".to_owned())?;
    let shared = public.mul_tweak(&Secp256k1::new(), &scalar).map_err(|error| error.to_string())?;
    Ok(Sha512::digest(shared.serialize()).into())
}

fn signature(key: &PrivateKey, digest: [u8; 32]) -> Result<Vec<u8>, String> {
    let secret = SecretKey::from_byte_array(key.to_bytes()).map_err(|error| error.to_string())?;
    let mut signature = Secp256k1::new().sign_ecdsa(Message::from_digest(digest), &secret);
    signature.normalize_s();
    let mut encoded = signature.serialize_der().to_vec();
    encoded.push((DEFAULT_SIGHASH & 0xff) as u8);
    Ok(encoded)
}

fn public_key(key: &PrivateKey) -> Result<Vec<u8>, String> {
    let secret = SecretKey::from_byte_array(key.to_bytes()).map_err(|error| error.to_string())?;
    Ok(SecpPublicKey::from_secret_key(&Secp256k1::new(), &secret).serialize().to_vec())
}

fn sign_p2pkh_input(
    transaction: &mut Transaction,
    input_index: usize,
    key: &PrivateKey,
    script: &Script,
    satoshis: u64,
) -> Result<(), String> {
    let digest = transaction.sighash_digest(input_index, script, satoshis, DEFAULT_SIGHASH)
        .map_err(|error| error.to_string())?;
    let mut script_sig = Vec::new();
    push_data(&mut script_sig, &signature(key, digest)?)?;
    push_data(&mut script_sig, &public_key(key)?)?;
    transaction.inputs[input_index].script_sig = Script::from_bytes(script_sig);
    Ok(())
}

fn push_data(output: &mut Vec<u8>, data: &[u8]) -> Result<(), String> {
    match data.len() {
        0..=75 => output.push(data.len() as u8),
        76..=0xff => { output.push(0x4c); output.push(data.len() as u8); }
        _ => return Err("unlock push data exceeds 255 bytes".to_owned()),
    }
    output.extend_from_slice(data);
    Ok(())
}

fn parse_script(value: &str, field: &str) -> Result<Script, String> {
    hex::decode(value).map(Script::from_bytes)
        .or_else(|_| Script::from_asm(value).map_err(|error| format!("{field}: {error}")))
}
