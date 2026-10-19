use std::{env, fs};

use serde_json::{Value, json};
use secp256k1::{Message, Secp256k1, SecretKey};
use sha2::{Digest, Sha256};
use tbc_engine_core::{EngineMethod, call_json};
use tbc_sdk::{
    Address, OutPoint, Transaction, TxIn, TxOut, Txid,
    contracts::{
        ft::{
            amount::build_tape_amount,
            partial_sha256::calculate_partial_hash,
            scripts::{
                FtCodeReceiver, FtMintVersion, mint_code_script_with_version,
                mint_source_script, mint_tape_script, transfer_code_script,
                transfer_tape_script,
            },
            unlock::classify_ft_script,
        },
        pool_nft_v2::{
            FtlpCodeParams, FtlpTapeLayout, FtlpTapeParams, FtScriptVersion, PoolAmounts,
            PoolCodeParams, PoolState, ftlp_code, ftlp_lock_time_code, ftlp_tape, pool_code,
            pool_held_ft_code, pool_tape,
        },
        stable_coin::scripts::{coin_mint_code_script, coin_tape_script},
    },
    hash, script::Script,
};

const OWNER: &str = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const POOL_PROVIDER: &str = "task-7";

fn vector(name: &str) -> Value {
    let source = match name {
        "pool-create.json" => include_str!("../../../fixtures/pool-create.json"),
        "pool-liquidity-add.json" => include_str!("../../../fixtures/pool-liquidity-add.json"),
        "pool-liquidity-remove.json" => include_str!("../../../fixtures/pool-liquidity-remove.json"),
        "pool-liquidity-close.json" => include_str!("../../../fixtures/pool-liquidity-close.json"),
        "pool-swap-tbc-for-token.json" => include_str!("../../../fixtures/pool-swap-tbc-for-token.json"),
        "pool-swap-token-for-tbc.json" => include_str!("../../../fixtures/pool-swap-token-for-tbc.json"),
        "pool-merge.json" => include_str!("../../../fixtures/pool-merge.json"),
        "ftlp-merge.json" => include_str!("../../../fixtures/ftlp-merge.json"),
        _ => panic!("unknown Pool fixture {name}"),
    };
    serde_json::from_str(source).expect("checked-in Pool fixture must be JSON")
}

fn call(method: EngineMethod, input: &Value) -> Value {
    serde_json::from_str(&call_json(method, &input.to_string())).unwrap()
}

fn call_ok(method: EngineMethod, input: &Value) -> Value {
    let envelope = call(method, input);
    assert_eq!(envelope["ok"], true, "{envelope}");
    envelope["result"].clone()
}

fn canonical_hash(value: &Value) -> String {
    Sha256::digest(serde_json::to_vec(value).unwrap())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn transaction(outputs: Vec<TxOut>, seed: u8) -> Transaction {
    Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn {
            previous_output: OutPoint { txid: Txid::from_le_bytes([seed; 32]), vout: 0 },
            script_sig: Script::from_bytes(vec![0x51, seed]),
            sequence: tbc_sdk::DEFAULT_SEQUENCE,
        }],
        outputs,
        lock_time: 0,
    }
}

fn amount_tape(base: &Script, amount: u64) -> Script {
    let (slots, _) = build_tape_amount(u128::from(amount), &[u128::from(amount)]).unwrap();
    transfer_tape_script(base, &slots).unwrap()
}

struct PoolMaterial {
    ft_source: Transaction,
    ft_contract: Transaction,
    owner_ft: Transaction,
    pool_source: Transaction,
    pool_creation: Transaction,
    pool_current: Transaction,
    fee_parent: Transaction,
    ft_contract_id: String,
    pool_contract_id: String,
    pool_ft_vouts: Vec<u32>,
    ftlp_vouts: Vec<u32>,
}

fn material() -> PoolMaterial {
    let owner = Address::from_string(OWNER).unwrap();
    let mut supply = [0u8; 48];
    supply[..8].copy_from_slice(&5_000_000u64.to_le_bytes());
    let ft_tape = mint_tape_script(&supply, 6, "Task Seven Token", "TST");
    let ft_source = transaction(
        vec![
            TxOut { satoshis: 9_900, script_pubkey: mint_source_script(&owner) },
            TxOut { satoshis: 0, script_pubkey: ft_tape.clone() },
        ],
        0x31,
    );
    let ft_code = mint_code_script_with_version(
        &ft_source.txid().to_string(), 0, &owner, ft_tape.as_bytes().len(), FtMintVersion::V4,
    ).unwrap();
    let ft_contract = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint { txid: ft_source.txid(), vout: 0 })],
        outputs: vec![
            TxOut { satoshis: 500, script_pubkey: ft_code.clone() },
            TxOut { satoshis: 0, script_pubkey: ft_tape.clone() },
        ],
        lock_time: 0,
    };
    let owned_ft_code = transfer_code_script(&ft_code, FtCodeReceiver::Address(owner.clone())).unwrap();
    let owner_ft = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint { txid: ft_contract.txid(), vout: 0 })],
        outputs: vec![
            TxOut { satoshis: 500, script_pubkey: owned_ft_code },
            TxOut { satoshis: 0, script_pubkey: amount_tape(&ft_tape, 2_500_000) },
        ],
        lock_time: 0,
    };
    let pool_source_script = Script::from_asm(&format!(
        "OP_DUP OP_HASH160 {} OP_EQUALVERIFY OP_CHECKSIG OP_RETURN {}",
        encode_hex(&owner.hash160()), encode_hex(b"for poolnft mint")
    )).unwrap();
    let pool_source = transaction(
        vec![TxOut { satoshis: 9_800, script_pubkey: pool_source_script }],
        0x32,
    );
    let source_outpoint = OutPoint { txid: pool_source.txid(), vout: 0 };
    let pool_code_script = pool_code(
        source_outpoint.clone(), POOL_PROVIDER.as_bytes(),
        &PoolCodeParams { lp_plan: 1, ft_version: FtScriptVersion::V4, is_coin: false },
    ).unwrap();
    let empty_ftlp_tape = ftlp_tape(&FtlpTapeParams {
        amount_raw: 0,
        layout: FtlpTapeLayout::Standard {
            decimal: 6, name: "Task Seven Token", symbol: "TST", is_coin: false,
        },
    }).unwrap();
    let ftlp_params = FtlpCodeParams::for_tape(&empty_ftlp_tape, FtScriptVersion::V4, false).unwrap();
    let ftlp_code_script = ftlp_code(hash::sha256(pool_code_script.as_bytes()), &owner, &ftlp_params).unwrap();
    let zero_state = PoolState {
        amounts: PoolAmounts { ft_lp_raw: 0, ft_a_raw: 0, tbc_sat: 0 },
        ft_lp_partial_hash: calculate_partial_hash(&ftlp_code_script.as_bytes()[..2048]).to_vec(),
        ft_a_partial_hash: calculate_partial_hash(&ft_code.as_bytes()[..2048]).to_vec(),
        ft_a_contract_id: ft_contract.txid(),
        service_fee_rate: 35,
        service_provider: POOL_PROVIDER.to_owned(),
        lp_plan: 1,
        public_key_locked: false,
        ftlp_lock_time_enabled: false,
    };
    let pool_creation = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(source_outpoint)],
        outputs: vec![
            TxOut { satoshis: 1_000, script_pubkey: pool_code_script.clone() },
            TxOut { satoshis: 0, script_pubkey: pool_tape(&zero_state).unwrap() },
        ],
        lock_time: 0,
    };
    let state = PoolState {
        amounts: PoolAmounts { ft_lp_raw: 10_000, ft_a_raw: 2_500_000, tbc_sat: 10_000 },
        ..zero_state
    };
    let live_ftlp_tape = ftlp_tape(&FtlpTapeParams {
        amount_raw: 10_000,
        layout: FtlpTapeLayout::Standard {
            decimal: 6, name: "Task Seven Token", symbol: "TST", is_coin: false,
        },
    }).unwrap();
    let live_ftlp_params = FtlpCodeParams::for_tape(&live_ftlp_tape, FtScriptVersion::V4, false).unwrap();
    let live_ftlp_code = ftlp_code(hash::sha256(pool_code_script.as_bytes()), &owner, &live_ftlp_params).unwrap();
    let pool_current = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![
            TxIn::new(OutPoint { txid: pool_creation.txid(), vout: 0 }),
            TxIn::new(OutPoint { txid: owner_ft.txid(), vout: 0 }),
        ],
        outputs: vec![
            TxOut { satoshis: 11_000, script_pubkey: pool_code_script.clone() },
            TxOut { satoshis: 0, script_pubkey: pool_tape(&state).unwrap() },
            TxOut {
                satoshis: 500,
                script_pubkey: pool_held_ft_code(
                    &ft_code, hash::hash160(&hash::sha256(pool_code_script.as_bytes())),
                ).unwrap(),
            },
            TxOut { satoshis: 0, script_pubkey: amount_tape(&ft_tape, 2_500_000) },
            TxOut { satoshis: 500, script_pubkey: live_ftlp_code },
            TxOut { satoshis: 0, script_pubkey: live_ftlp_tape },
        ],
        lock_time: 0,
    };
    let fee_parent = transaction(
        vec![TxOut { satoshis: 1_000_000, script_pubkey: owner.script_pubkey() }],
        0x33,
    );
    PoolMaterial {
        ft_contract_id: ft_contract.txid().to_string(),
        pool_contract_id: pool_creation.txid().to_string(),
        pool_ft_vouts: vec![2],
        ftlp_vouts: vec![4],
        ft_source, ft_contract, owner_ft, pool_source, pool_creation, pool_current, fee_parent,
    }
}

fn utxo(tx: &Transaction, vout: u32, classification: &str, contract_id: Option<&str>) -> Value {
    let output = &tx.outputs[vout as usize];
    let mut value = json!({
        "txid": tx.txid().to_string(), "vout": vout,
        "satoshis": output.satoshis.to_string(), "scriptPubKey": encode_hex(output.script_pubkey.as_bytes()),
        "confirmations": "100", "classification": classification
    });
    if let Some(contract_id) = contract_id {
        value["contractId"] = json!(contract_id);
    }
    value
}

fn parent(tx: &Transaction) -> Value {
    json!({"txid": tx.txid().to_string(), "rawTransaction": tx.to_hex()})
}

fn plan_input(name: &str) -> Value {
    plan_input_from_material(name, material())
}

fn plan_input_from_material(name: &str, m: PoolMaterial) -> Value {
    let fixture = vector(name);
    let mut input = serde_json::from_str::<Value>(include_str!("../../../fixtures/tbc-transfer.json")).unwrap()["planInput"].clone();
    let mut intent = fixture["intent"].clone();
    if intent["ftContractId"] == "fixture" { intent["ftContractId"] = json!(m.ft_contract_id); }
    if intent["poolContractId"] == "fixture" { intent["poolContractId"] = json!(m.pool_contract_id); }
    input["request"]["clientRequestId"] = json!(name.trim_end_matches(".json"));
    input["request"]["intent"] = intent;
    input["request"]["constraints"] = json!({"expiresAt":"2026-09-09T00:00:00Z", "maxFee":"100000"});
    input["snapshot"]["payload"]["block"]["height"] = json!("800000");
    input["snapshot"]["payload"]["utxos"] = if name == "pool-create.json" {
        json!([
            utxo(&m.pool_source, 0, "pool-source", None),
            utxo(&m.owner_ft, 0, "ft", Some(&m.ft_contract_id)),
            utxo(&m.fee_parent, 0, "native", None)
        ])
    } else {
        let mut utxos = vec![
            utxo(&m.pool_source, 0, "pool-source", None),
            utxo(&m.pool_current, 0, "pool", Some(&m.pool_contract_id)),
        ];
        utxos.extend(m.pool_ft_vouts.iter().map(|vout| {
            utxo(&m.pool_current, *vout, "pool-ft", Some(&m.pool_contract_id))
        }));
        utxos.extend(m.ftlp_vouts.iter().map(|vout| {
            utxo(&m.pool_current, *vout, "ftlp", Some(&m.pool_contract_id))
        }));
        utxos.extend([
            utxo(&m.owner_ft, 0, "ft", Some(&m.ft_contract_id)),
            utxo(&m.fee_parent, 0, "native", None),
        ]);
        Value::Array(utxos)
    };
    input["snapshot"]["payload"]["parents"] = json!([
        parent(&m.ft_source), parent(&m.ft_contract), parent(&m.owner_ft), parent(&m.pool_source),
        parent(&m.pool_creation), parent(&m.pool_current), parent(&m.fee_parent)
    ]);
    input["snapshot"]["payload"]["contracts"] = if name == "pool-create.json" {
        json!([{
            "contractId": m.ft_contract_id, "family":"ft", "protocolVersion":"4.0",
            "creationTxid":m.ft_contract.txid().to_string(),
            "currentOutpoint":{"txid":m.owner_ft.txid().to_string(),"vout":0}
        }])
    } else {
        json!([
            {
                "contractId":m.ft_contract_id, "family":"ft", "protocolVersion":"4.0",
                "creationTxid":m.ft_contract.txid().to_string(),
                "currentOutpoint":{"txid":m.owner_ft.txid().to_string(),"vout":0}
            },
            {
                "contractId":m.pool_contract_id, "family":"pool", "protocolVersion":"2.0",
                "creationTxid":m.pool_creation.txid().to_string(),
                "currentOutpoint":{"txid":m.pool_current.txid().to_string(),"vout":0}
            }
        ])
    };
    let expires_at = input["policy"]["payload"].as_object_mut().unwrap().remove("expiresAt").unwrap();
    input["policy"]["payload"]["pool"] = json!({
        "lpPlan":1, "serviceProviderTag":POOL_PROVIDER, "serviceFeeRate":35
    });
    input["policy"]["payload"]["expiresAt"] = expires_at;
    input["policy"]["payload"]["amountLimits"] = json!([]);
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    input["snapshot"]["snapshotHash"] = json!(canonical_hash(&input["snapshot"]["payload"]));
    input["policy"]["policyHash"] = json!(canonical_hash(&input["policy"]["payload"]));
    input
}

fn fragmented_plan_input(
    name: &str,
    pool_ft_amounts: &[u64],
    ftlp_amounts: &[u64],
) -> Value {
    fragmented_plan_input_with_ftlp_total(name, pool_ft_amounts, ftlp_amounts, 10_000)
}

fn fragmented_plan_input_with_ftlp_total(
    name: &str,
    pool_ft_amounts: &[u64],
    ftlp_amounts: &[u64],
    expected_ftlp_total: u64,
) -> Value {
    fragmented_plan_input_with_totals(
        name,
        pool_ft_amounts,
        ftlp_amounts,
        2_500_000,
        expected_ftlp_total,
    )
}

fn fragmented_plan_input_with_totals(
    name: &str,
    pool_ft_amounts: &[u64],
    ftlp_amounts: &[u64],
    expected_pool_ft_total: u64,
    expected_ftlp_total: u64,
) -> Value {
    assert_eq!(pool_ft_amounts.iter().sum::<u64>(), expected_pool_ft_total);
    assert_eq!(ftlp_amounts.iter().sum::<u64>(), expected_ftlp_total);
    let mut m = material();
    let pool = m.pool_current.outputs[0].clone();
    let tape = m.pool_current.outputs[1].clone();
    let pool_ft_code = m.pool_current.outputs[2].clone();
    let ftlp_code = m.pool_current.outputs[4].clone();
    let ft_tape = m.ft_contract.outputs[1].script_pubkey.clone();
    let mut outputs = vec![pool, tape];
    m.pool_ft_vouts.clear();
    for amount in pool_ft_amounts {
        m.pool_ft_vouts.push(u32::try_from(outputs.len()).unwrap());
        outputs.push(pool_ft_code.clone());
        outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: amount_tape(&ft_tape, *amount),
        });
    }
    m.ftlp_vouts.clear();
    for amount in ftlp_amounts {
        m.ftlp_vouts.push(u32::try_from(outputs.len()).unwrap());
        outputs.push(ftlp_code.clone());
        outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: ftlp_tape(&FtlpTapeParams {
                amount_raw: *amount,
                layout: FtlpTapeLayout::Standard {
                    decimal: 6,
                    name: "Task Seven Token",
                    symbol: "TST",
                    is_coin: false,
                },
            })
            .unwrap(),
        });
    }
    m.pool_current.outputs = outputs;
    plan_input_from_material(name, m)
}

fn coin_material() -> PoolMaterial {
    let mut m = material();
    let owner = Address::from_string(OWNER).unwrap();
    let mut supply = [0u8; 48];
    supply[..8].copy_from_slice(&5_000_000u64.to_le_bytes());
    let ft_tape = coin_tape_script(&supply, 6, "Task Seven Coin", "TSC", 0);
    let ft_code = coin_mint_code_script(&[0x22; 20], &owner, &[0x44; 32], ft_tape.as_bytes().len())
        .unwrap();
    let classified = classify_ft_script(&ft_code).unwrap();
    let authority_partial_offset = match (classified.version, classified.is_coin) {
        (_, true) => 1_984,
        (1, false) => 1_536,
        (2 | 3, false) => 1_856,
        (4, false) => 2_048,
        _ => panic!("unsupported classified FT authority"),
    };
    m.ft_contract = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint { txid: m.ft_source.txid(), vout: 0 })],
        outputs: vec![
            TxOut { satoshis: 200, script_pubkey: Script::empty() },
            TxOut { satoshis: 100, script_pubkey: Script::empty() },
            TxOut { satoshis: 0, script_pubkey: Script::empty() },
            TxOut { satoshis: 500, script_pubkey: ft_code.clone() },
            TxOut { satoshis: 0, script_pubkey: ft_tape.clone() },
        ],
        lock_time: 0,
    };
    m.ft_contract_id = m.ft_contract.txid().to_string();
    m.owner_ft = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint { txid: m.ft_contract.txid(), vout: 3 })],
        outputs: vec![
            TxOut {
                satoshis: 500,
                script_pubkey: transfer_code_script(
                    &ft_code,
                    FtCodeReceiver::Address(owner.clone()),
                )
                .unwrap(),
            },
            TxOut { satoshis: 0, script_pubkey: amount_tape(&ft_tape, 2_500_000) },
        ],
        lock_time: 0,
    };
    let pool_code_script = pool_code(
        OutPoint { txid: m.pool_source.txid(), vout: 0 },
        POOL_PROVIDER.as_bytes(),
        &PoolCodeParams { lp_plan: 1, ft_version: FtScriptVersion::V4, is_coin: true },
    )
    .unwrap();
    let empty_ftlp_tape = ftlp_tape(&FtlpTapeParams {
        amount_raw: 0,
        layout: FtlpTapeLayout::Standard {
            decimal: 6,
            name: "Task Seven Coin",
            symbol: "TSC",
            is_coin: true,
        },
    })
    .unwrap();
    let ftlp_params = FtlpCodeParams::for_tape(&empty_ftlp_tape, FtScriptVersion::V4, true).unwrap();
    let ftlp_code_script =
        ftlp_code(hash::sha256(pool_code_script.as_bytes()), &owner, &ftlp_params).unwrap();
    let zero_state = PoolState {
        amounts: PoolAmounts { ft_lp_raw: 0, ft_a_raw: 0, tbc_sat: 0 },
        ft_lp_partial_hash: calculate_partial_hash(&ftlp_code_script.as_bytes()[..2048]).to_vec(),
        ft_a_partial_hash: calculate_partial_hash(
            &ft_code.as_bytes()[..authority_partial_offset],
        )
        .to_vec(),
        ft_a_contract_id: m.ft_contract.txid(),
        service_fee_rate: 35,
        service_provider: POOL_PROVIDER.to_owned(),
        lp_plan: 1,
        public_key_locked: false,
        ftlp_lock_time_enabled: false,
    };
    m.pool_creation = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint { txid: m.pool_source.txid(), vout: 0 })],
        outputs: vec![
            TxOut { satoshis: 1_000, script_pubkey: pool_code_script.clone() },
            TxOut { satoshis: 0, script_pubkey: pool_tape(&zero_state).unwrap() },
        ],
        lock_time: 0,
    };
    m.pool_contract_id = m.pool_creation.txid().to_string();
    let state = PoolState {
        amounts: PoolAmounts { ft_lp_raw: 10_000, ft_a_raw: 2_500_000, tbc_sat: 10_000 },
        ..zero_state
    };
    let live_ftlp_tape = ftlp_tape(&FtlpTapeParams {
        amount_raw: 10_000,
        layout: FtlpTapeLayout::Standard {
            decimal: 6,
            name: "Task Seven Coin",
            symbol: "TSC",
            is_coin: true,
        },
    })
    .unwrap();
    let live_ftlp_params = FtlpCodeParams::for_tape(&live_ftlp_tape, FtScriptVersion::V4, true).unwrap();
    m.pool_current = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![
            TxIn::new(OutPoint { txid: m.pool_creation.txid(), vout: 0 }),
            TxIn::new(OutPoint { txid: m.owner_ft.txid(), vout: 0 }),
        ],
        outputs: vec![
            TxOut { satoshis: 11_000, script_pubkey: pool_code_script.clone() },
            TxOut { satoshis: 0, script_pubkey: pool_tape(&state).unwrap() },
            TxOut {
                satoshis: 500,
                script_pubkey: pool_held_ft_code(
                    &ft_code,
                    hash::hash160(&hash::sha256(pool_code_script.as_bytes())),
                )
                .unwrap(),
            },
            TxOut { satoshis: 0, script_pubkey: amount_tape(&ft_tape, 2_500_000) },
            TxOut {
                satoshis: 500,
                script_pubkey: ftlp_code(
                    hash::sha256(pool_code_script.as_bytes()),
                    &owner,
                    &live_ftlp_params,
                )
                .unwrap(),
            },
            TxOut { satoshis: 0, script_pubkey: live_ftlp_tape },
        ],
        lock_time: 0,
    };
    m
}

fn fragmented_coin_plan_input(pool_ft_amounts: &[u64]) -> Value {
    assert_eq!(pool_ft_amounts.iter().sum::<u64>(), 2_500_000);
    let mut m = coin_material();
    let mut outputs = m.pool_current.outputs[..2].to_vec();
    let pool_ft_code = m.pool_current.outputs[2].clone();
    let ft_tape = m.ft_contract.outputs[4].script_pubkey.clone();
    m.pool_ft_vouts.clear();
    for amount in pool_ft_amounts {
        m.pool_ft_vouts.push(u32::try_from(outputs.len()).unwrap());
        outputs.push(pool_ft_code.clone());
        outputs.push(TxOut { satoshis: 0, script_pubkey: amount_tape(&ft_tape, *amount) });
    }
    m.ftlp_vouts = vec![u32::try_from(outputs.len()).unwrap()];
    outputs.extend_from_slice(&m.pool_current.outputs[4..6]);
    m.pool_current.outputs = outputs;
    plan_input_from_material("pool-liquidity-remove.json", m)
}

fn replace_current_parent(input: &mut Value, transaction: Transaction) {
    let old_txid = input["snapshot"]["payload"]["contracts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["family"] == "pool")
        .unwrap()["currentOutpoint"]["txid"]
        .as_str()
        .unwrap()
        .to_owned();
    let new_txid = transaction.txid().to_string();
    for item in input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap() {
        if item["txid"] == old_txid {
            let vout = item["vout"].as_u64().unwrap() as usize;
            item["txid"] = json!(new_txid.clone());
            item["satoshis"] = json!(transaction.outputs[vout].satoshis.to_string());
            item["scriptPubKey"] = json!(encode_hex(transaction.outputs[vout].script_pubkey.as_bytes()));
        }
    }
    let parent = input["snapshot"]["payload"]["parents"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|item| item["txid"] == old_txid)
        .unwrap();
    *parent = json!({"txid":new_txid.clone(), "rawTransaction":transaction.to_hex()});
    let contract = input["snapshot"]["payload"]["contracts"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|item| item["family"] == "pool")
        .unwrap();
    contract["currentOutpoint"]["txid"] = json!(new_txid);
    input["snapshot"]["snapshotHash"] = json!(canonical_hash(&input["snapshot"]["payload"]));
}

fn locked_fragmented_plan_input(amounts: &[u64], lock_heights: &[u32]) -> Value {
    assert_eq!(amounts.len(), lock_heights.len());
    assert_eq!(amounts.iter().sum::<u64>(), 10_000);
    let mut input = locked_plan_input("pool-liquidity-remove.json", 799_900);
    let current_txid = input["snapshot"]["payload"]["contracts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["family"] == "pool")
        .unwrap()["currentOutpoint"]["txid"]
        .as_str()
        .unwrap()
        .to_owned();
    let pool_contract_id = input["request"]["intent"]["poolContractId"].clone();
    let mut current = input["snapshot"]["payload"]["parents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["txid"] == current_txid)
        .map(|item| Transaction::from_hex(item["rawTransaction"].as_str().unwrap()).unwrap())
        .unwrap();
    let code = current.outputs[4].clone();
    let source_ft_tape_size = material().ft_contract.outputs[1].script_pubkey.as_bytes().len();
    current.outputs.truncate(4);
    for (amount, height) in amounts.iter().zip(lock_heights) {
        let vout = u32::try_from(current.outputs.len()).unwrap();
        current.outputs.push(code.clone());
        current.outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: ftlp_tape(&FtlpTapeParams {
                amount_raw: *amount,
                layout: FtlpTapeLayout::LockTime {
                    lock_time: *height,
                    source_ft_tape_size,
                },
            })
            .unwrap(),
        });
        if vout != 4 {
            input["snapshot"]["payload"]["utxos"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "txid":current_txid.clone(),
                    "vout":vout,
                    "satoshis":"500",
                    "scriptPubKey":encode_hex(code.script_pubkey.as_bytes()),
                    "confirmations":"100",
                    "classification":"ftlp",
                    "contractId":pool_contract_id,
                }));
        }
    }
    replace_current_parent(&mut input, current);
    input["request"]["intent"]["lpAmount"] = json!("6000");
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    input
}

fn locked_create_input() -> Value {
    let mut input = plan_input("pool-create.json");
    input["request"]["intent"]["lock"] = json!({
        "publicKeys":[
            "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
            input["snapshot"]["payload"]["account"]["publicKey"].clone()
        ],
        "costRecipient":OWNER,
        "costAmount":"100",
        "untilHeight":"800100"
    });
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    input
}

fn locked_plan_input(name: &str, ftlp_lock_height: u32) -> Value {
    let create = locked_create_input();
    let created = call_ok(EngineMethod::Plan, &create);
    let mut m = material();
    m.pool_creation = planned_transaction(&created, 0);
    m.pool_contract_id = m.pool_creation.txid().to_string();
    let mut state = PoolState::from_v2_tape(
        &m.pool_creation.outputs[1].script_pubkey,
        POOL_PROVIDER.to_owned(),
    )
    .unwrap();
    state.amounts = PoolAmounts {
        ft_lp_raw: 10_000,
        ft_a_raw: 2_500_000,
        tbc_sat: 10_000,
    };
    let owner = Address::from_string(OWNER).unwrap();
    let pool_code_script = m.pool_creation.outputs[0].script_pubkey.clone();
    let ft_code = m.ft_contract.outputs[0].script_pubkey.clone();
    let ft_tape = m.ft_contract.outputs[1].script_pubkey.clone();
    let live_ftlp_tape = ftlp_tape(&FtlpTapeParams {
        amount_raw: 10_000,
        layout: FtlpTapeLayout::LockTime {
            lock_time: ftlp_lock_height,
            source_ft_tape_size: ft_tape.as_bytes().len(),
        },
    })
    .unwrap();
    let params = FtlpCodeParams::for_tape(&live_ftlp_tape, FtScriptVersion::V4, false).unwrap();
    let live_ftlp_code = ftlp_lock_time_code(
        hash::sha256(pool_code_script.as_bytes()),
        &owner,
        &params,
    )
    .unwrap();
    m.pool_current = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![
            TxIn::new(OutPoint { txid: m.pool_creation.txid(), vout: 0 }),
            TxIn::new(OutPoint { txid: m.owner_ft.txid(), vout: 0 }),
        ],
        outputs: vec![
            TxOut { satoshis: 11_000, script_pubkey: pool_code_script.clone() },
            TxOut { satoshis: 0, script_pubkey: pool_tape(&state).unwrap() },
            TxOut {
                satoshis: 500,
                script_pubkey: pool_held_ft_code(
                    &ft_code,
                    hash::hash160(&hash::sha256(pool_code_script.as_bytes())),
                )
                .unwrap(),
            },
            TxOut { satoshis: 0, script_pubkey: amount_tape(&ft_tape, 2_500_000) },
            TxOut { satoshis: 500, script_pubkey: live_ftlp_code },
            TxOut { satoshis: 0, script_pubkey: live_ftlp_tape },
        ],
        lock_time: 0,
    };
    let mut input = plan_input_from_material(name, m);
    if name == "pool-liquidity-add.json" {
        input["request"]["intent"]["lockUntilHeight"] = json!("800100");
        input["request"]["intent"]["minimumLpAmount"] = json!("1");
        input["requestHash"] = json!(canonical_hash(&input["request"]));
    }
    input
}

fn unique_snapshot_parent(input: &Value, txid: &str, label: &str) -> Transaction {
    let matches = input["snapshot"]["payload"]["parents"]
        .as_array()
        .expect("authenticated snapshot parents")
        .iter()
        .filter(|item| item["txid"] == txid)
        .collect::<Vec<_>>();
    assert_eq!(matches.len(), 1, "{label} must resolve to one authenticated raw parent");
    let transaction = Transaction::from_hex(
        matches[0]["rawTransaction"]
            .as_str()
            .expect("authenticated raw parent bytes"),
    )
    .expect("parse authenticated raw parent bytes");
    assert_eq!(transaction.txid().to_string(), txid, "{label} authenticated txid");
    transaction
}

fn assert_locked_remove_preflight(input: &Value) {
    assert_eq!(input["request"]["intent"]["type"], json!("tbc.pool.liquidity.remove"));
    assert_eq!(input["snapshot"]["payload"]["block"]["height"], json!("800101"));

    let contracts = input["snapshot"]["payload"]["contracts"]
        .as_array()
        .expect("authenticated contracts");
    let pool_contract = contracts
        .iter()
        .find(|item| item["family"] == "pool")
        .expect("authenticated Pool contract");
    let current_txid = pool_contract["currentOutpoint"]["txid"]
        .as_str()
        .expect("authenticated current Pool txid");
    let current_vout = pool_contract["currentOutpoint"]["vout"]
        .as_u64()
        .expect("authenticated current Pool vout") as usize;
    let current = unique_snapshot_parent(input, current_txid, "current Pool outpoint");
    let state = PoolState::from_v2_tape(
        &current.outputs[current_vout + 1].script_pubkey,
        POOL_PROVIDER.to_owned(),
    )
    .expect("authenticated locked Pool state");
    assert_eq!(
        state.amounts,
        PoolAmounts { ft_lp_raw: 9_900, ft_a_raw: 2_500_000, tbc_sat: 9_900 },
        "locked remove must use the released post-cost live state",
    );
    assert!(state.public_key_locked, "locked remove Pool public-key lock");
    assert!(state.ftlp_lock_time_enabled, "locked remove Pool FTLP lock-time mode");
    assert_eq!(current.outputs[current_vout].satoshis, 10_900);

    let ft_contract = contracts
        .iter()
        .find(|item| item["family"] == "ft")
        .expect("authenticated FT contract");
    let ft_creation_txid = ft_contract["creationTxid"]
        .as_str()
        .expect("authenticated FT creation txid");
    let ft_creation = unique_snapshot_parent(input, ft_creation_txid, "FT creation");
    let source_ft_tape_size = ft_creation.outputs[1].script_pubkey.as_bytes().len();

    let candidates = input["snapshot"]["payload"]["utxos"]
        .as_array()
        .expect("authenticated UTXOs")
        .iter()
        .filter(|item| item["classification"] == "ftlp")
        .collect::<Vec<_>>();
    assert_eq!(candidates.len(), 1, "locked remove must authenticate one FTLP candidate");
    assert_eq!(candidates[0]["txid"], json!(current_txid));
    assert_eq!(candidates[0]["vout"], json!(4));

    let expected_tape = ftlp_tape(&FtlpTapeParams {
        amount_raw: 9_900,
        layout: FtlpTapeLayout::LockTime {
            lock_time: 800_100,
            source_ft_tape_size,
        },
    })
    .expect("canonical released locked FTLP Tape");
    assert_eq!(current.outputs[5].script_pubkey, expected_tape);
    let expected_params = FtlpCodeParams::for_tape(&expected_tape, FtScriptVersion::V4, false)
        .expect("canonical released locked FTLP parameters");
    let expected_code = ftlp_lock_time_code(
        hash::sha256(current.outputs[current_vout].script_pubkey.as_bytes()),
        &Address::from_string(OWNER).expect("canonical fixture owner"),
        &expected_params,
    )
    .expect("canonical released locked FTLP Code");
    assert_eq!(current.outputs[4].script_pubkey, expected_code);

    let requested_lp = input["request"]["intent"]["lpAmount"]
        .as_str()
        .expect("locked remove LP amount")
        .parse::<u64>()
        .expect("locked remove LP amount integer");
    assert_eq!(requested_lp, 1_000);
    assert!(requested_lp < state.amounts.ft_lp_raw);
    assert!(800_100u32 <= 800_101u32);
    assert!(
        state.ftlp_lock_time_enabled && current.outputs[5].script_pubkey == expected_tape,
        "released locked FTLP input requires an unlock maintenance precursor",
    );
}

fn canonical_locked_remove_input() -> Value {
    let mut input = locked_plan_input("pool-liquidity-remove.json", 800_100);
    let current_txid = input["snapshot"]["payload"]["contracts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["family"] == "pool")
        .unwrap()["currentOutpoint"]["txid"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut current = unique_snapshot_parent(&input, &current_txid, "current Pool outpoint");
    let mut state = PoolState::from_v2_tape(
        &current.outputs[1].script_pubkey,
        POOL_PROVIDER.to_owned(),
    )
    .expect("locked Pool state");
    state.amounts = PoolAmounts { ft_lp_raw: 9_900, ft_a_raw: 2_500_000, tbc_sat: 9_900 };
    current.outputs[0].satoshis = 10_900;
    current.outputs[1].script_pubkey = pool_tape(&state).expect("released post-cost Pool Tape");

    let ft_contract = input["snapshot"]["payload"]["contracts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["family"] == "ft")
        .expect("authenticated FT contract");
    let ft_creation = unique_snapshot_parent(
        &input,
        ft_contract["creationTxid"].as_str().expect("FT creation txid"),
        "FT creation",
    );
    let locked_tape = ftlp_tape(&FtlpTapeParams {
        amount_raw: 9_900,
        layout: FtlpTapeLayout::LockTime {
            lock_time: 800_100,
            source_ft_tape_size: ft_creation.outputs[1].script_pubkey.as_bytes().len(),
        },
    })
    .expect("released post-cost locked FTLP Tape");
    let locked_params = FtlpCodeParams::for_tape(&locked_tape, FtScriptVersion::V4, false)
        .expect("released post-cost locked FTLP parameters");
    current.outputs[4].script_pubkey = ftlp_lock_time_code(
        hash::sha256(current.outputs[0].script_pubkey.as_bytes()),
        &Address::from_string(OWNER).expect("canonical fixture owner"),
        &locked_params,
    )
    .expect("released post-cost locked FTLP Code");
    current.outputs[5].script_pubkey = locked_tape;
    replace_current_parent(&mut input, current);
    input["snapshot"]["payload"]["block"]["height"] = json!("800101");
    input["snapshot"]["snapshotHash"] = json!(canonical_hash(&input["snapshot"]["payload"]));
    assert_locked_remove_preflight(&input);
    input
}

fn sign_tasks(tasks: &Value) -> Value {
    let mut bytes = [0u8; 32];
    bytes[31] = 1;
    let secret = SecretKey::from_byte_array(bytes).unwrap();
    let secp = Secp256k1::new();
    Value::Array(
        tasks
            .as_array()
            .unwrap()
            .iter()
            .map(|task| {
                let digest: [u8; 32] = decode_hex(task["digest"].as_str().unwrap())
                    .try_into()
                    .unwrap();
                let signature = secp
                    .sign_ecdsa(Message::from_digest(digest), &secret)
                    .serialize_compact();
                json!({
                    "taskId":task["taskId"],
                    "signatureEncoding":"compact64",
                    "signature":encode_hex(&signature)
                })
            })
            .collect(),
    )
}

fn pool_finalize_input(input: &Value, planned: &Value) -> Value {
    let base = serde_json::from_str::<Value>(include_str!("../../../fixtures/tbc-transfer.json"))
        .unwrap();
    let mut binding = base["finalizeInput"]["binding"].clone();
    binding["payload"]["requestHash"] = input["requestHash"].clone();
    binding["payload"]["operationHash"] = planned["plan"]["planHash"].clone();
    binding["payload"]["accountId"] = json!(format!(
        "{}:{}",
        input["request"]["chainId"].as_str().unwrap(),
        input["request"]["from"].as_str().unwrap()
    ));
    binding["payload"]["expiresAt"] = planned["plan"]["payload"]["expiresAt"].clone();
    binding["bindingHash"] = json!(canonical_hash(&binding["payload"]));
    let mut approval = base["finalizeInput"]["approval"].clone();
    approval["bindingHash"] = binding["bindingHash"].clone();
    approval["expiresAt"] = planned["plan"]["payload"]["expiresAt"].clone();
    json!({
        "version":input["version"], "request":input["request"],
        "requestHash":input["requestHash"], "snapshot":input["snapshot"],
        "policy":input["policy"], "plan":planned["plan"], "binding":binding,
        "approval":approval,
        "signatures":sign_tasks(&planned["plan"]["payload"]["signingTasks"])
    })
}

fn complete_pool_public(input: &Value) -> (Value, Vec<Value>) {
    let planned = call_ok(EngineMethod::Plan, input);
    let checked = validation_for_plan(input.clone(), &planned);
    assert_eq!(checked["valid"], true, "{checked}");
    let mut finalize = pool_finalize_input(input, &planned);
    let mut signing_batches = vec![planned["plan"]["payload"]["signingTasks"].clone()];
    let mut stages = 1usize;
    loop {
        let envelope = call(EngineMethod::Finalize, &finalize);
        assert_eq!(envelope["ok"], true, "finalize stage {stages}: {envelope}");
        let result = envelope["result"].clone();
        if result.get("bundle").is_some() {
            let mut validation = finalize;
            validation["phase"] = json!("finalized");
            validation["bundle"] = result["bundle"].clone();
            let envelope = call(EngineMethod::Validate, &validation);
            assert_eq!(envelope["ok"], true, "finalized validation: {envelope}");
            let checked = envelope["result"].clone();
            assert_eq!(checked["valid"], true, "{checked}");
            return (result, signing_batches);
        }
        finalize["continuation"] = result["continuation"].clone();
        let signing_requests = result["signingRequests"].clone();
        finalize["signatures"] = sign_tasks(&signing_requests);
        signing_batches.push(signing_requests);
        stages += 1;
    }
}

fn roles(result: &Value) -> Vec<&str> {
    result["plan"]["payload"]["transactions"].as_array().unwrap().iter()
        .map(|transaction| transaction["role"].as_str().unwrap()).collect()
}

fn planned_transaction(result: &Value, index: usize) -> Transaction {
    Transaction::from_hex(result["plan"]["payload"]["transactions"][index]["unsignedTransaction"].as_str().unwrap()).unwrap()
}

fn normalize_input(plan_input: &Value) -> Value {
    json!({"version":"1.0", "request":plan_input["request"].clone()})
}

fn validation_for_plan(mut input: Value, plan: &Value) -> Value {
    input["plan"] = plan["plan"].clone();
    input["phase"] = json!("plan");
    call_ok(EngineMethod::Validate, &input)
}

fn has_violation(result: &Value, code: &str) -> bool {
    result["violations"].as_array().unwrap().iter().any(|item| item["code"] == code)
}

#[derive(Clone, Copy)]
struct ReleasedPlanDefinition {
    lp_plan: u8,
    service_fee_rate: u16,
    service_fee_address: &'static str,
}

fn released_plan_definition(lp_plan: u8) -> ReleasedPlanDefinition {
    let (service_fee_rate, service_fee_address) = match lp_plan {
        1 => (35, "13oCEJaqyyiC8iRrfup6PDL2GKZ3xQrsZL"),
        2 => (35, "1Fa6Uy64Ub4qNdB896zX2pNMx4a8zMhtCy"),
        3 => (135, "125fTLNsraQxTYqT4EeQNF2ggzcqicveKL"),
        4 => (335, "19DetoaaohQkjFVJ6oGXd83xhZYQSbpE1g"),
        5 => (535, "15EKrhuD8Yf3SfhjAgbizYqfnBbKh9ZMZ7"),
        6 => (130, "1N7rf2AuAHB2aCrVgnbQhSWhaUVk3rGhjm"),
        _ => panic!("released LP plan must be in 1..=6: {lp_plan}"),
    };
    ReleasedPlanDefinition { lp_plan, service_fee_rate, service_fee_address }
}

fn assert_create_plan_preflight(input: &Value, definition: ReleasedPlanDefinition) {
    assert_eq!(
        input["request"]["intent"]["lpPlan"],
        json!(definition.lp_plan),
        "Process B preflight request LP plan"
    );
    assert_eq!(
        input["policy"]["payload"]["pool"]["lpPlan"],
        json!(definition.lp_plan),
        "Process B preflight authenticated policy LP plan"
    );
    assert_eq!(
        input["policy"]["payload"]["pool"]["serviceFeeRate"],
        json!(definition.service_fee_rate),
        "Process B preflight authenticated policy service fee rate"
    );
    assert_eq!(
        input["requestHash"],
        json!(canonical_hash(&input["request"])),
        "Process B preflight request hash"
    );
    assert_eq!(
        input["policy"]["policyHash"],
        json!(canonical_hash(&input["policy"]["payload"])),
        "Process B preflight authenticated policy hash"
    );
}

fn create_scenario_input(lp_plan: u8) -> (Value, ReleasedPlanDefinition) {
    let definition = released_plan_definition(lp_plan);
    let mut input = plan_input("pool-create.json");
    input["request"]["intent"]["lpPlan"] = json!(definition.lp_plan);
    input["policy"]["payload"]["pool"]["lpPlan"] = json!(definition.lp_plan);
    input["policy"]["payload"]["pool"]["serviceFeeRate"] =
        json!(definition.service_fee_rate);
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    input["policy"]["policyHash"] = json!(canonical_hash(&input["policy"]["payload"]));
    assert_create_plan_preflight(&input, definition);
    (input, definition)
}

fn authenticated_pool_definition(input: &Value) -> ReleasedPlanDefinition {
    assert_eq!(
        input["snapshot"]["snapshotHash"],
        json!(canonical_hash(&input["snapshot"]["payload"])),
        "Process B authenticated Pool snapshot hash"
    );
    assert_eq!(
        input["policy"]["policyHash"],
        json!(canonical_hash(&input["policy"]["payload"])),
        "Process B authenticated Pool policy hash"
    );
    let contract = input["snapshot"]["payload"]["contracts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["family"] == "pool")
        .expect("non-create scenario authenticated Pool contract");
    let current = &contract["currentOutpoint"];
    let txid = current["txid"].as_str().expect("authenticated Pool txid");
    let code_vout = current["vout"].as_u64().expect("authenticated Pool vout") as usize;
    let parent = input["snapshot"]["payload"]["parents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["txid"] == txid)
        .expect("authenticated current Pool parent");
    let transaction = Transaction::from_hex(
        parent["rawTransaction"].as_str().expect("authenticated Pool raw transaction")
    ).expect("parse authenticated current Pool transaction");
    assert_eq!(transaction.txid().to_string(), txid, "authenticated Pool parent txid");
    let state = PoolState::from_v2_tape(
        &transaction.outputs[code_vout + 1].script_pubkey,
        POOL_PROVIDER.to_owned(),
    ).expect("parse authenticated current Pool state");
    let definition = released_plan_definition(state.lp_plan);
    assert_eq!(state.service_fee_rate, definition.service_fee_rate, "authenticated Pool state fee rate");
    assert_eq!(input["policy"]["payload"]["pool"]["lpPlan"], json!(state.lp_plan));
    assert_eq!(
        input["policy"]["payload"]["pool"]["serviceFeeRate"],
        json!(state.service_fee_rate)
    );
    definition
}

fn assert_planned_pool_definition(plan: &Value, definition: ReleasedPlanDefinition) {
    let primary_index = roles(plan)
        .iter()
        .position(|role| *role == "primary")
        .expect("planned primary transaction");
    let transaction = planned_transaction(plan, primary_index);
    let state = PoolState::from_v2_tape(
        &transaction.outputs[1].script_pubkey,
        POOL_PROVIDER.to_owned(),
    ).expect("parse planned successor Pool state");
    assert_eq!(state.lp_plan, definition.lp_plan, "planned successor Pool LP plan");
    assert_eq!(
        state.service_fee_rate,
        definition.service_fee_rate,
        "planned successor Pool service fee rate"
    );
    let fee_hash = Address::from_string(definition.service_fee_address)
        .expect("released service fee address")
        .hash160();
    assert!(
        transaction.outputs[0]
            .script_pubkey
            .as_bytes()
            .windows(fee_hash.len())
            .any(|window| window == fee_hash.as_slice()),
        "planned successor Pool code must embed released service fee address"
    );
}

fn configure_removal(mut input: Value, lp_amount: &str) -> Value {
    input["request"]["intent"]["lpAmount"] = json!(lp_amount);
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    input
}


fn direct_scenario_input(name: &str) -> (Value, ReleasedPlanDefinition) {
    if let Some(plan) = name.strip_prefix("create-standard-plan-") {
        let plan = plan.parse::<u8>().expect("numeric LP plan");
        let (input, definition) = create_scenario_input(plan);
        return (input, definition);
    }
    let input = match name {
        "create-locked-plan-1" => locked_create_input(),
        "add-standard" => plan_input("pool-liquidity-add.json"),
        "add-locked" => locked_plan_input("pool-liquidity-add.json", 799_900),
        "remove-standard" => plan_input("pool-liquidity-remove.json"),
        "remove-locked" => canonical_locked_remove_input(),
        "close-standard" => plan_input("pool-liquidity-close.json"),
        "close-locked" => locked_plan_input("pool-liquidity-close.json", 799_900),
        "swap-tbc-for-token-standard" => plan_input("pool-swap-tbc-for-token.json"),
        "swap-tbc-for-token-locked" => locked_plan_input("pool-swap-tbc-for-token.json", 799_900),
        "swap-token-for-tbc-standard" => plan_input("pool-swap-token-for-tbc.json"),
        "swap-token-for-tbc-locked" => locked_plan_input("pool-swap-token-for-tbc.json", 799_900),
        "pool-ft-no-merge-threshold" => configure_removal(
            fragmented_plan_input_with_totals(
                "pool-liquidity-remove.json",
                &[70_000, 70_000, 70_000, 70_000, 2_220_000],
                &[10_000],
                2_500_000,
                10_000,
            ),
            "1000",
        ),
        "ftlp-no-merge-threshold" => configure_removal(
            fragmented_plan_input(
                "pool-liquidity-remove.json",
                &[2_500_000],
                &[6_000, 4_000],
            ),
            "6000",
        ),
        "pool-ft-merge" => configure_removal(
            fragmented_plan_input_with_totals(
                "pool-liquidity-remove.json",
                &[625_000, 625_000, 625_000, 625_000],
                &[10_000],
                2_500_000,
                10_000,
            ),
            "9000",
        ),
        "ftlp-merge-standard" => configure_removal(
            fragmented_plan_input(
                "pool-liquidity-remove.json",
                &[2_500_000],
                &[5_000, 5_000],
            ),
            "6000",
        ),
        "ftlp-merge-locked" => locked_fragmented_plan_input(
            &[5_000, 5_000],
            &[799_900, 799_900],
        ),
        "pool-ft-multi-round" => configure_removal(
            fragmented_plan_input(
                "pool-liquidity-remove.json",
                &[312_500, 312_500, 312_500, 312_500, 312_500, 312_500, 312_500, 312_500],
                &[10_000],
            ),
            "9000",
        ),
        "ftlp-multi-round" => configure_removal(
            fragmented_plan_input_with_ftlp_total(
                "pool-liquidity-remove.json",
                &[2_500_000],
                &[4_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000],
                10_000,
            ),
            "9000",
        ),
        "simultaneous-pool-ft-and-ftlp-maintenance" => configure_removal(
            fragmented_plan_input_with_totals(
                "pool-liquidity-remove.json",
                &[416_666, 416_666, 416_666, 416_666, 416_668, 416_668],
                &[5_000, 5_000],
                2_500_000,
                10_000,
            ),
            "6000",
        ),
        _ => panic!("Process B direct scenario is not implemented: {name}"),
    };
    let definition = if name == "create-locked-plan-1" {
        let definition = released_plan_definition(1);
        assert_create_plan_preflight(&input, definition);
        definition
    } else {
        authenticated_pool_definition(&input)
    };
    (input, definition)
}

fn external_parent_manifest(input: &Value, finalized: &Value) -> Value {
    let transactions = finalized["bundle"]["transactions"]
        .as_array().expect("finalized Process B transactions")
        .iter().map(|transaction| Transaction::from_hex(
            transaction["rawTransaction"].as_str().expect("finalized Process B raw transaction")
        ).expect("parse finalized Process B raw transaction")).collect::<Vec<_>>();
    let internal_txids = transactions.iter().map(Transaction::txid).collect::<Vec<_>>();
    let candidates = input["snapshot"]["payload"]["parents"]
        .as_array().expect("authenticated Process B snapshot parents");
    let mut parsed_candidates = Vec::<(String, Transaction)>::new();
    for candidate in candidates {
        let declared_txid = candidate["txid"].as_str().expect("snapshot parent declared txid");
        let raw = candidate["rawTransaction"].as_str().expect("snapshot parent raw transaction");
        let transaction = Transaction::from_hex(raw).expect("parse snapshot parent raw transaction");
        assert_eq!(transaction.txid().to_string(), declared_txid,
            "Process B snapshot parent declared txid must match raw bytes");
        if let Some((_, existing)) = parsed_candidates.iter()
            .find(|(_, existing)| existing.txid() == transaction.txid())
        {
            assert_eq!(existing.to_hex(), transaction.to_hex(),
                "duplicate Process B external txid must have byte-identical raw transaction");
        } else {
            parsed_candidates.push((declared_txid.to_owned(), transaction));
        }
    }
    let mut used = Vec::<usize>::new();
    for transaction in &transactions {
        for input in &transaction.inputs {
            if internal_txids.contains(&input.previous_output.txid) {
                continue;
            }
            let matches = parsed_candidates.iter().enumerate()
                .filter(|(_, (_, candidate))| candidate.txid() == input.previous_output.txid)
                .collect::<Vec<_>>();
            assert_eq!(matches.len(), 1,
                "every external input must resolve to exactly one Process B raw parent");
            let (index, (_, parent)) = matches[0];
            assert!((input.previous_output.vout as usize) < parent.outputs.len(),
                "Process B external input vout must resolve in authenticated raw parent");
            if !used.contains(&index) {
                used.push(index);
            }
        }
    }
    json!({"externalParents": used.into_iter().map(|index| {
        let (txid, transaction) = &parsed_candidates[index];
        json!({"txid":txid,"rawTransaction":transaction.to_hex()})
    }).collect::<Vec<_>>()})
}

fn main() {
    let input_path = env::args().nth(1).expect("input path argument");
    let output_path = env::args().nth(2).expect("output path argument");
    let input_bytes = fs::read(&input_path).expect("read immutable Process B input");
    let control: Value = serde_json::from_slice(&input_bytes).expect("Process B input JSON");
    assert_eq!(control["schemaVersion"], 1, "Process B input schema");
    let scenarios = if let Some(items) = control["scenarios"].as_array() {
        items.iter().collect::<Vec<_>>()
    } else {
        vec![&control]
    };
    let artifacts = scenarios.into_iter().map(|spec| {
        let scenario = spec.as_str().or_else(|| spec["name"].as_str())
            .expect("scenario name");
        let (input, definition) = direct_scenario_input(scenario);
        let plan = call_ok(EngineMethod::Plan, &input);
        assert_planned_pool_definition(&plan, definition);
        let (finalized, signing_batches) = complete_pool_public(&input);
        let input_manifest = external_parent_manifest(&input, &finalized);
        if let Some(declared) = spec.get("externalParents") {
            assert_eq!(declared, &input_manifest["externalParents"],
                "Process B immutable external parent manifest must match core fixture bytes");
        }
        json!({
            "name": scenario,
            "stages": signing_batches.len(),
            "signingBatches": signing_batches,
            "releasedPlan": {
                "lpPlan": definition.lp_plan,
                "serviceFeeRate": definition.service_fee_rate,
                "serviceFeeAddress": definition.service_fee_address,
            },
            "inputManifest": input_manifest,
            "plan": plan,
            "finalized": finalized,
        })
    }).collect::<Vec<_>>();
    let artifact = json!({
        "schemaVersion": 1,
        "pin": "923497e8b2473c0e179fa0b86dbb32a2f188d25a",
        "producer": "production-core",
        "productionCoreInvoked": true,
        "externalTestSigning": true,
        "inputSha256": hex::encode(Sha256::digest(&input_bytes)),
        "scenarios": artifacts,
    });
    fs::write(
        output_path,
        format!("{}\n", serde_json::to_string_pretty(&artifact).expect("artifact JSON")),
    )
    .expect("write immutable Process B output");
}

#[cfg(test)]
mod task7_process_b_tests {
    use super::*;

    #[test]
    fn create_scenarios_keep_request_and_authenticated_policy_on_the_same_released_plan() {
        for (plan, service_fee_rate) in
            [(1, 35), (2, 35), (3, 135), (4, 335), (5, 535), (6, 130)]
        {
            let (input, definition) = direct_scenario_input(&format!("create-standard-plan-{plan}"));
            assert_eq!(input["request"]["intent"]["lpPlan"], json!(plan));
            assert_eq!(input["policy"]["payload"]["pool"]["lpPlan"], json!(plan));
            assert_eq!(
                input["policy"]["payload"]["pool"]["serviceFeeRate"],
                json!(service_fee_rate)
            );
            assert_eq!(definition.service_fee_rate, service_fee_rate);
            assert_create_plan_preflight(&input, definition);
        }
        let addresses = [
            "13oCEJaqyyiC8iRrfup6PDL2GKZ3xQrsZL",
            "1Fa6Uy64Ub4qNdB896zX2pNMx4a8zMhtCy",
            "125fTLNsraQxTYqT4EeQNF2ggzcqicveKL",
            "19DetoaaohQkjFVJ6oGXd83xhZYQSbpE1g",
            "15EKrhuD8Yf3SfhjAgbizYqfnBbKh9ZMZ7",
            "1N7rf2AuAHB2aCrVgnbQhSWhaUVk3rGhjm",
        ];
        for (offset, address) in addresses.iter().enumerate() {
            assert_eq!(released_plan_definition((offset + 1) as u8).service_fee_address, *address);
        }
    }

    #[test]
    fn non_create_metadata_comes_from_authenticated_pool_fixture_without_an_intent_plan() {
        let fixture = plan_input("pool-liquidity-add.json");
        assert!(fixture["request"]["intent"].get("lpPlan").is_none());
        let (input, definition) = direct_scenario_input("add-standard");
        assert_eq!(input["policy"]["policyHash"], json!(canonical_hash(&input["policy"]["payload"])));
        assert_eq!(definition.lp_plan, 1);
        assert_eq!(definition.service_fee_rate, 35);
        assert_eq!(definition.service_fee_address, "13oCEJaqyyiC8iRrfup6PDL2GKZ3xQrsZL");
    }

    #[test]
    fn remove_locked_authenticates_post_cost_state_and_requires_unlock_maintenance() {
        let (input, _) = direct_scenario_input("remove-locked");
        assert_locked_remove_preflight(&input);

        let plan = call_ok(EngineMethod::Plan, &input);
        assert_eq!(roles(&plan), ["maintenance", "primary"]);
        assert_eq!(
            plan["plan"]["payload"]["transactions"][1]["dependsOn"],
            json!([plan["plan"]["payload"]["transactions"][0]["id"].clone()])
        );
    }

    #[test]
    fn maintenance_matrix_uses_real_authenticated_fragments_and_required_lineages() {
        let cases = [
            ("pool-ft-no-merge-threshold", 5, 1, vec!["primary"]),
            ("ftlp-no-merge-threshold", 1, 2, vec!["primary"]),
            ("pool-ft-merge", 4, 1, vec!["maintenance", "primary"]),
            ("ftlp-merge-standard", 1, 2, vec!["maintenance", "primary"]),
            ("ftlp-merge-locked", 1, 2, vec!["maintenance", "primary"]),
            ("pool-ft-multi-round", 8, 1, vec!["maintenance", "maintenance", "primary"]),
            (
                "ftlp-multi-round",
                1,
                7,
                vec!["maintenance", "maintenance", "primary"],
            ),
            (
                "simultaneous-pool-ft-and-ftlp-maintenance",
                6,
                2,
                vec!["maintenance", "maintenance", "primary"],
            ),
        ];
        for (name, pool_ft_count, ftlp_count, expected_roles) in cases {
            let (input, _) = direct_scenario_input(name);
            let utxos = input["snapshot"]["payload"]["utxos"].as_array().unwrap();
            assert_eq!(utxos.iter().filter(|item| item["classification"] == "pool-ft").count(), pool_ft_count, "{name}");
            assert_eq!(utxos.iter().filter(|item| item["classification"] == "ftlp").count(), ftlp_count, "{name}");
            let envelope = call(EngineMethod::Plan, &input);
            assert_eq!(envelope["ok"], true, "{name}: {envelope}");
            assert_eq!(roles(&envelope["result"]), expected_roles, "{name}");
        }
    }

    #[test]
    fn pool_ft_merge_uses_the_exact_pin_single_round_candidate_vector() {
        let (input, _) = direct_scenario_input("pool-ft-merge");
        assert_eq!(input["request"]["intent"]["lpAmount"], json!("9000"));
        let parents = input["snapshot"]["payload"]["parents"].as_array().unwrap();
        let candidates = input["snapshot"]["payload"]["utxos"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["classification"] == "pool-ft")
            .collect::<Vec<_>>();
        assert_eq!(candidates.len(), 4, "exact-pin single-round threshold is four candidates");
        let mut amounts = Vec::new();
        let mut code_scripts = Vec::new();
        let mut candidate_outpoints = Vec::new();
        for candidate in candidates {
            let txid = candidate["txid"].as_str().unwrap();
            let vout = usize::try_from(candidate["vout"].as_u64().unwrap()).unwrap();
            let parent_json = parents.iter().filter(|item| item["txid"] == txid).collect::<Vec<_>>();
            assert_eq!(parent_json.len(), 1, "candidate parent must resolve uniquely");
            let parent = Transaction::from_hex(parent_json[0]["rawTransaction"].as_str().unwrap()).unwrap();
            assert_eq!(parent.txid().to_string(), txid);
            let info = classify_ft_script(&parent.outputs[vout].script_pubkey).unwrap();
            assert_eq!(info.version, 4);
            assert!(!info.is_coin);
            let tape = parent.outputs[vout + 1].script_pubkey.as_bytes();
            assert_eq!(&tape[..3], &[0x00, 0x6a, 0x30], "candidate must have adjacent released FT Tape");
            let mut first_slot = [0u8; 8];
            first_slot.copy_from_slice(&tape[3..11]);
            assert!(tape[11..51].iter().all(|byte| *byte == 0), "candidate must occupy one authenticated amount slot");
            amounts.push(u64::from_le_bytes(first_slot));
            code_scripts.push(parent.outputs[vout].script_pubkey.clone());
            candidate_outpoints.push(OutPoint { txid: parent.txid(), vout: u32::try_from(vout).unwrap() });
        }
        assert_eq!(amounts, [625_000, 625_000, 625_000, 625_000]);
        assert!(code_scripts.windows(2).all(|pair| pair[0] == pair[1]), "all candidates must share contract/version/recipient binding");

        let planned = call_ok(EngineMethod::Plan, &input);
        assert_eq!(roles(&planned), ["maintenance", "primary"]);
        let merge = planned_transaction(&planned, 0);
        assert_eq!(merge.inputs.len(), 6, "Pool plus all four necessary candidates plus fee");
        assert_eq!(
            merge.inputs[1..5].iter().map(|item| item.previous_output.clone()).collect::<Vec<_>>(),
            candidate_outpoints,
            "single maintenance round must consume every necessary candidate in declared order"
        );
        let primary = planned_transaction(&planned, 1);
        assert!(primary.inputs.iter().all(|item| !candidate_outpoints.contains(&item.previous_output)),
            "primary must not retain an external candidate consumed by maintenance");
        let placeholder = Txid::from_le_bytes([0; 32]);
        let internal_vouts = primary.inputs.iter()
            .filter(|item| item.previous_output.txid == placeholder)
            .map(|item| item.previous_output.vout)
            .collect::<Vec<_>>();
        assert_eq!(internal_vouts, [0, 2, 4], "primary must consume Pool, merged FT and fee successors");
    }

    #[test]
    fn staged_completion_retains_serialized_signing_batches() {
        let (input, _) = direct_scenario_input("ftlp-multi-round");
        let (finalized, signing_batches) = complete_pool_public(&input);
        let transactions = finalized["bundle"]["transactions"].as_array().unwrap();

        assert_eq!(transactions.len(), 3);
        assert_eq!(signing_batches.len(), 3);
        for (batch, transaction) in signing_batches.iter().zip(transactions) {
            let tasks = batch.as_array().unwrap();
            assert!(!tasks.is_empty(), "every materialized stage must expose signing tasks");
            assert!(tasks.iter().all(|task| {
                task["transactionTemplateId"] == transaction["id"]
            }), "a signing batch must be associated only with its materialized transaction");
        }
    }
}
