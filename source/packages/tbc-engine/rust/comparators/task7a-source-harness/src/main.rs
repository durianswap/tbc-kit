use std::{env, fs};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tbc_sdk::{
    DEFAULT_SEQUENCE, DEFAULT_SIGHASH, OutPoint, PrivateKey, Transaction, TxIn, TxOut, Txid,
    UtxoInfo,
    contracts::{
        ft::unlock::{
            contract_tx_data, current_inputs_data, current_tx_data, pre_pre_tx_data_from_parents,
            pre_tx_data,
        },
        pool_nft_v2::{
            FtlpTapeLayout, FtlpTapeParams, PoolSpendContext, PoolState, PoolSwapOption,
            PoolUnlockContext, PoolUnlockOption, PoolUnlockSignature, ftlp_tape, pool_tape,
            pool_unlock,
        },
    },
    script::{Script, opcodes},
};

const SOURCE_COMMIT: &str = "923497e8b2473c0e179fa0b86dbb32a2f188d25a";
const OWNER_PUBLIC_KEY: &str =
    "031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";
const POOL_SOURCE: &str =
    "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/pool_nft_v2/unlock.rs";
const FT_SOURCE: &str =
    "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/ft/builder.rs";
const FTLP_SOURCE: &str =
    "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/pool_nft_v2/builder.rs";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hash(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn vector_hash(value: &Value) -> String {
    hash(&serde_json::to_vec(value).expect("vector JSON"))
}

fn parse_tx(raw: &str) -> Transaction {
    Transaction::from_hex(raw).expect("source fixture transaction")
}

fn source(path: &str, functions: &[&str]) -> Value {
    json!({
        "repository": "git@github.com:LoongYearMeta/turing-wallet.git",
        "commit": SOURCE_COMMIT,
        "path": path,
        "functions": functions,
    })
}

fn finish(mut input: Value, expected: Vec<u8>, source: Value) -> Value {
    let input_hash = vector_hash(&input);
    let expected_hash = hash(&expected);
    input["expectedUnlockHex"] = json!(hex(&expected));
    input["expectedByteHash"] = json!(expected_hash);
    input["inputVectorHash"] = json!(input_hash);
    input["source"] = source;
    input
}

fn pool_vector(root: &Value, key: &str, signing_key: &PrivateKey) -> Value {
    let value = &root["vectors"][key];
    let mut current = parse_tx(value["currentRaw"].as_str().expect("current raw"));
    let mut parent = parse_tx(value["poolPreRaw"].as_str().expect("Pool parent raw"));
    let pre_parent = parse_tx(value["poolPrePreRaw"].as_str().expect("Pool pre-parent raw"));
    let contract = parse_tx(value["contractRaw"].as_str().expect("contract raw"));
    let auxiliary_parents = value["inputParentRaws"]
        .as_array()
        .expect("input parents")
        .iter()
        .map(|raw| parse_tx(raw.as_str().expect("input parent raw")))
        .collect::<Vec<_>>();
    let locked = value["withLock"].as_bool().expect("lock flag");
    let mut state = PoolState::from_v2_tape(
        &parent.outputs[1].script_pubkey,
        "source-fixture".to_owned(),
    )
    .expect("Pool parent state");
    state.ft_a_contract_id = contract.txid();
    state.public_key_locked = locked;
    parent.outputs[1].script_pubkey = pool_tape(&state).expect("authenticated Pool parent Tape");
    current.inputs[0].previous_output.txid = parent.txid();
    let mut successor = PoolState::from_v2_tape(
        &current.outputs[1].script_pubkey,
        "source-fixture".to_owned(),
    )
    .expect("Pool successor state");
    successor.ft_a_contract_id = contract.txid();
    successor.public_key_locked = locked;
    current.outputs[1].script_pubkey = pool_tape(&successor).expect("authenticated Pool successor Tape");
    let public_key_lock = locked.then(|| vec![signing_key.public_key()]).unwrap_or_default();
    let signature_bytes = locked.then(|| {
        signature(
            &current,
            0,
            &parent.outputs[0].script_pubkey,
            parent.outputs[0].satoshis,
            signing_key,
        )
    });
    let unlock_signature = signature_bytes.as_ref().map(|bytes| PoolUnlockSignature {
        signature_with_hashtype: bytes.clone(),
        public_key: signing_key.public_key(),
    });
    let pool = PoolSpendContext {
        pool_utxo: UtxoInfo {
            outpoint: current.inputs[0].previous_output.clone(),
            satoshis: parent.outputs[0].satoshis,
            script_pubkey: parent.outputs[0].script_pubkey.clone(),
        },
        pool_pre_tx: parent.clone(),
        pool_pre_pre_tx: pre_parent.clone(),
        contract_tx: contract.clone(),
        state,
    };
    let expected = pool_unlock(&PoolUnlockContext {
        transaction: &current,
        input_index: 0,
        spent_vout: 0,
        pool: &pool,
        input_parents: &auxiliary_parents,
        option: PoolUnlockOption::Swap,
        swap_option: Some(PoolSwapOption::TbcToFt),
        with_lock: locked,
        signature: unlock_signature.as_ref(),
        public_key_lock: &public_key_lock,
    })
    .expect("authenticated source Pool unlock");
    let input = json!({
        "name": if key.ends_with("standard") { "standard-large-pool" } else { "locked-pool-swap" },
        "family": "poolCode",
        "currentRaw": current.to_hex(),
        "parentRaw": parent.to_hex(),
        "preParentRaw": pre_parent.to_hex(),
        "contractRaw": contract.to_hex(),
        "auxiliaryParentRaws": auxiliary_parents.iter().map(Transaction::to_hex).collect::<Vec<_>>(),
        "operation": value["option"],
        "swapOption": value["swapOption"],
        "withLock": value["withLock"],
        "publicKeyLock": value["poolPublicKeys"],
        "signatureWithSighash": signature_bytes.map(|bytes| hex(&bytes)).unwrap_or_default(),
        "publicKey": hex(&signing_key.public_key().to_bytes()),
        "semanticFields": [
            "current transaction data", "ordered auxiliary input parents", "output layout",
            "operation tag", "Pool pre-parent data", "Pool parent data"
        ],
    });
    finish(
        input,
        expected,
        source(POOL_SOURCE, &["pool_unlock"]),
    )
}

fn simple_parent(seed: u8, script: Script, satoshis: u64) -> Transaction {
    Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn {
            previous_output: OutPoint {
                txid: Txid::from_le_bytes([seed; 32]),
                vout: 0,
            },
            script_sig: Script::from_bytes(vec![1, seed]),
            sequence: DEFAULT_SEQUENCE,
        }],
        outputs: vec![TxOut { satoshis, script_pubkey: script }],
        lock_time: 0,
    }
}

fn reparent(template: &Transaction, grandparent: &Transaction, tape: Option<Script>) -> Transaction {
    let mut outputs = template.outputs[..2].to_vec();
    if let Some(tape) = tape {
        outputs[1].script_pubkey = tape;
    }
    Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint {
            txid: grandparent.txid(),
            vout: 0,
        })],
        outputs,
        lock_time: 0,
    }
}

fn unsigned_child(parent: &Transaction, lock_time: u32, sequence: u32, seed: u8) -> Transaction {
    Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn {
            previous_output: OutPoint { txid: parent.txid(), vout: 0 },
            script_sig: Script::empty(),
            sequence,
        }],
        outputs: vec![TxOut {
            satoshis: 400,
            script_pubkey: simple_parent(seed, Script::empty(), 0).outputs[0].script_pubkey.clone(),
        }],
        lock_time,
    }
}

fn signature(
    tx: &Transaction,
    input_index: usize,
    script: &Script,
    satoshis: u64,
    key: &PrivateKey,
) -> Vec<u8> {
    let digest = tx
        .sighash_digest(input_index, script, satoshis, DEFAULT_SIGHASH)
        .expect("source sighash");
    let mut signature = key.sign_ecdsa_digest(&digest);
    signature.push((DEFAULT_SIGHASH & 0xff) as u8);
    signature
}

fn push_data(out: &mut Vec<u8>, data: &[u8]) {
    match data.len() {
        0..=75 => out.push(data.len() as u8),
        76..=0xff => {
            out.push(opcodes::OP_PUSHDATA1);
            out.push(data.len() as u8);
        }
        _ => panic!("signature push exceeds released width"),
    }
    out.extend_from_slice(data);
}

#[allow(clippy::too_many_arguments)]
fn source_ft_swap_unlock(
    tx: &Transaction,
    input_index: usize,
    parent: &Transaction,
    grandparents: &[Transaction],
    contract: &Transaction,
    signature: &[u8],
    public_key: &[u8],
    version: u8,
    coin: bool,
    logical_index: usize,
) -> Vec<u8> {
    let mut script = current_tx_data(tx, input_index).expect("current transaction data");
    script.extend_from_slice(
        &pre_pre_tx_data_from_parents(parent, 0, grandparents).expect("pre-pre data"),
    );
    push_data(&mut script, signature);
    push_data(&mut script, public_key);
    script.extend_from_slice(&current_inputs_data(tx).expect("current input data"));
    let contract_vout = if version > 1 {
        -1
    } else {
        tx.inputs[0].previous_output.vout as i32
    };
    script.extend_from_slice(&contract_tx_data(contract, contract_vout).expect("contract data"));
    if version > 2 {
        script.push(match logical_index {
            0 => 0,
            1..=5 => 0x50 + logical_index as u8,
            _ => panic!("released swap index"),
        });
    }
    if coin {
        script.push(opcodes::OP_1);
    }
    script.extend_from_slice(&pre_tx_data(parent, 0).expect("parent data"));
    script
}

fn source_ftlp_unlock(
    tx: &Transaction,
    parent: &Transaction,
    grandparents: &[Transaction],
    signature: &[u8],
    public_key: &[u8],
) -> Vec<u8> {
    let mut script = current_tx_data(tx, 0).expect("current transaction data");
    script.extend_from_slice(
        &pre_pre_tx_data_from_parents(parent, 0, grandparents).expect("pre-pre data"),
    );
    push_data(&mut script, signature);
    push_data(&mut script, public_key);
    script.extend_from_slice(&pre_tx_data(parent, 0).expect("parent data"));
    script
}

fn ft_vector(
    name: &str,
    template: &Transaction,
    contract: &Transaction,
    key: &PrivateKey,
    seed: u8,
    logical_index: usize,
) -> Value {
    let grandparent = simple_parent(seed, key.address().script_pubkey(), 1_000);
    let mut parent = reparent(template, &grandparent, None);
    let classified = tbc_sdk::contracts::ft::unlock::classify_ft_script(
        &parent.outputs[0].script_pubkey,
    )
    .expect("source FT family");
    parent.outputs[0].script_pubkey = tbc_sdk::contracts::pool_nft_v2::pool_held_ft_code(
        &parent.outputs[0].script_pubkey,
        tbc_sdk::hash::hash160(&contract.outputs[0].script_pubkey.sha256()),
    )
    .expect("source Pool-held FT receiver");
    let current = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![
            TxIn::new(OutPoint { txid: contract.txid(), vout: 0 }),
            TxIn::new(OutPoint { txid: parent.txid(), vout: 0 }),
        ],
        outputs: vec![TxOut {
            satoshis: 400,
            script_pubkey: simple_parent(seed.wrapping_add(1), Script::empty(), 0)
                .outputs[0]
                .script_pubkey
                .clone(),
        }],
        lock_time: 0,
    };
    let signed = signature(
        &current,
        1,
        &parent.outputs[0].script_pubkey,
        parent.outputs[0].satoshis,
        key,
    );
    let expected = source_ft_swap_unlock(
        &current,
        1,
        &parent,
        std::slice::from_ref(&grandparent),
        contract,
        &signed,
        &key.public_key().to_bytes(),
        classified.version,
        classified.is_coin,
        logical_index,
    );
    let input = json!({
        "name": name,
        "family": "poolHeldFt",
        "currentRaw": current.to_hex(),
        "inputIndex": 1,
        "parentRaw": parent.to_hex(),
        "proofRaws": [grandparent.to_hex()],
        "contractRaw": contract.to_hex(),
        "ftVersion": classified.version,
        "coinMode": classified.is_coin,
        "logicalSwapInputIndex": logical_index,
        "signatureWithSighash": hex(&signed),
        "publicKey": OWNER_PUBLIC_KEY,
        "semanticFields": [
            "current transaction data", "authenticated pre-pre data", "signature plus sighash",
            "public key", "current-input data", "contract transaction data", "V3/V4 input-index tag",
            "coin flag when applicable", "authenticated parent data"
        ],
    });
    finish(input, expected, source(FT_SOURCE, &["sign_ft_swap_input", "ft_swap_input_index_tag"]))
}

fn ftlp_vector(
    name: &str,
    template: &Transaction,
    key: &PrivateKey,
    seed: u8,
    locked: bool,
) -> Value {
    let grandparent = simple_parent(seed, key.address().script_pubkey(), 1_000);
    let tape = locked.then(|| {
        ftlp_tape(&FtlpTapeParams {
            amount_raw: 25,
            layout: FtlpTapeLayout::LockTime {
                lock_time: 90,
                source_ft_tape_size: template.outputs[1].script_pubkey.as_bytes().len(),
            },
        })
        .expect("locked FTLP tape")
    });
    let parent = reparent(template, &grandparent, tape);
    let (lock_time, sequence) = if locked { (100, 0xffff_fffe) } else { (0, DEFAULT_SEQUENCE) };
    let current = unsigned_child(&parent, lock_time, sequence, seed.wrapping_add(1));
    let signed = signature(
        &current,
        0,
        &parent.outputs[0].script_pubkey,
        parent.outputs[0].satoshis,
        key,
    );
    let expected = source_ftlp_unlock(
        &current,
        &parent,
        std::slice::from_ref(&grandparent),
        &signed,
        &key.public_key().to_bytes(),
    );
    let input = json!({
        "name": name,
        "family": "ftlp",
        "currentRaw": current.to_hex(),
        "parentRaw": parent.to_hex(),
        "proofRaws": [grandparent.to_hex()],
        "locked": locked,
        "lockHeight": if locked { 90 } else { 0 },
        "currentHeight": if locked { 100 } else { 0 },
        "orderedInputIndex": 0,
        "orderedInputCount": 1,
        "signatureWithSighash": hex(&signed),
        "publicKey": OWNER_PUBLIC_KEY,
        "semanticFields": [
            "current transaction data", "authenticated pre-pre data", "signature plus sighash",
            "public key", "authenticated parent data", "input sequence", "transaction lock time"
        ],
    });
    finish(input, expected, source(FTLP_SOURCE, &["sign_ftlp_input", "ftlp_lock_time_from_tape"]))
}

fn planned_parent_vector(template: &Transaction, key: &PrivateKey) -> Value {
    let grandparent = simple_parent(0x71, key.address().script_pubkey(), 2_000);
    let mut parent = reparent(template, &grandparent, None);
    let parent_signature = signature(
        &parent,
        0,
        &grandparent.outputs[0].script_pubkey,
        grandparent.outputs[0].satoshis,
        key,
    );
    parent
        .apply_p2pkh_signature(
            0,
            &key.public_key(),
            &grandparent.outputs[0].script_pubkey,
            grandparent.outputs[0].satoshis,
            DEFAULT_SIGHASH,
            &parent_signature[..parent_signature.len() - 1],
        )
        .expect("source parent signature insertion");
    let current = unsigned_child(&parent, 0, DEFAULT_SEQUENCE, 0x72);
    let child_signature = signature(
        &current,
        0,
        &parent.outputs[0].script_pubkey,
        parent.outputs[0].satoshis,
        key,
    );
    let expected = source_ftlp_unlock(
        &current,
        &parent,
        std::slice::from_ref(&grandparent),
        &child_signature,
        &key.public_key().to_bytes(),
    );
    let mut unsigned_parent = parent.clone();
    unsigned_parent.inputs[0].script_sig = Script::empty();
    let input = json!({
        "name": "stage-two-planned-parent",
        "family": "ftlp",
        "parentUnsignedRaw": unsigned_parent.to_hex(),
        "parentSignedRaw": parent.to_hex(),
        "parentSignatureWithSighash": hex(&parent_signature),
        "currentRaw": current.to_hex(),
        "proofRaws": [grandparent.to_hex()],
        "signatureWithSighash": hex(&child_signature),
        "publicKey": OWNER_PUBLIC_KEY,
        "semanticFields": ["finalized planned-parent txid", "signed parent bytes", "stage-two FTLP unlock"],
    });
    finish(input, expected, source(FTLP_SOURCE, &["sign_ftlp_input"]))
}

fn main() {
    let output_path = env::args().nth(1).expect("output path argument");
    let pool_fixture: Value = serde_json::from_str(include_str!(
        "../../../vendor/tbc-sdk/tests/fixtures/pool-v2-unlock-js-165.json"
    ))
    .expect("released Pool fixture");
    let base = &pool_fixture["vectors"]["option1_standard"];
    let parents = base["inputParentRaws"].as_array().expect("input parents");
    let current_ft = parse_tx(parents[2].as_str().expect("current FT raw"));
    let coin = parse_tx(parents[3].as_str().expect("coin raw"));
    let standard_ftlp = parse_tx(parents[4].as_str().expect("standard FTLP raw"));
    let locked_ftlp = parse_tx(parents[5].as_str().expect("locked FTLP raw"));
    let contract = parse_tx(base["poolPreRaw"].as_str().expect("Pool parent raw"));
    let key = PrivateKey::from_slice(&[1; 32]).expect("fixture key");

    let result = json!({
        "schemaVersion": 1,
        "authority": {
            "repository": "git@github.com:LoongYearMeta/turing-wallet.git",
            "commit": SOURCE_COMMIT,
            "derivation": "Independent comparator; no tbc-engine-core dependency or recipe call",
        },
        "vectors": [
            pool_vector(&pool_fixture, "option3Swap1_standard", &key),
            pool_vector(&pool_fixture, "option3Swap1_locked", &key),
            ft_vector("tbc-to-ft-pool-held-ft-v3", &current_ft, &contract, &key, 0x41, 0),
            ft_vector("ft-to-tbc-pool-held-ft-v2-coin", &coin, &contract, &key, 0x51, 0),
            ftlp_vector("standard-ftlp", &standard_ftlp, &key, 0x61, false),
            ftlp_vector("locked-ftlp-height", &locked_ftlp, &key, 0x62, true),
            planned_parent_vector(&standard_ftlp, &key),
        ],
    });
    fs::write(
        output_path,
        format!("{}\n", serde_json::to_string_pretty(&result).expect("fixture JSON")),
    )
    .expect("write fixture");
}
