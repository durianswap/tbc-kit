use serde_json::{Value, json};
#[path = "support/optional_confirmations.rs"]
mod optional_confirmations;
#[path = "support/fragmented_funding.rs"]
mod fragmented_funding;

#[path = "support/unified_business.rs"]
mod unified_business;
#[test]
fn unified_pool_business_preserves_historical_transactions() {
    for name in ["pool-swap-tbc-for-token.json", "pool-swap-token-for-tbc.json", "pool-liquidity-add.json", "pool-liquidity-remove.json"] {
        unified_business::exercise_pool(plan_input(name));
        unified_business::exercise_pool(locked_plan_input(name, 799_900));
    }
}
fn bind(mut input: Value) -> Value {
    input["snapshot"]["snapshotHash"] = json!(canonical_hash(&input["snapshot"]["payload"]));
    input
}

#[test]
fn pool_sufficient_preferred_funding_ignores_small_incidental_parent() {
    let mut input = plan_input("pool-liquidity-add.json");
    fragmented_funding::replace(&mut input, 1, 30_000);
    let baseline = call_ok(EngineMethod::Plan, &bind(input.clone()));
    assert_eq!(baseline["plan"]["payload"]["transactions"].as_array().unwrap().len(), 1);
    // A small change output's raw parent may already be present as contract
    // ancestry. It must not displace the sufficient preferred fee candidate.
    let mut small = input.clone();
    fragmented_funding::replace(&mut small, 1, 1_010);
    let candidate = small["snapshot"]["payload"]["utxos"].as_array().unwrap().iter()
        .find(|v| v["classification"] == "native").unwrap().clone();
    let parent = small["snapshot"]["payload"]["parents"].as_array().unwrap().iter()
        .find(|v| v["txid"] == candidate["txid"]).unwrap().clone();
    input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(candidate);
    input["snapshot"]["payload"]["parents"].as_array_mut().unwrap().push(parent);
    let input = bind(input);
    let result = call_ok(EngineMethod::Plan, &input);
    assert_eq!(result["plan"]["payload"]["transactions"], baseline["plan"]["payload"]["transactions"],
        "incidental small change must not introduce a funding prerequisite");
    assert_eq!(result["plan"]["payload"]["transactions"].as_array().unwrap().len(), 1);
    complete_pool_public(&input);
}

#[test]
fn fragmented_native_funding_pool_finalize_and_validate() {
    for name in ["pool-liquidity-add.json", "pool-liquidity-remove.json",
        "pool-liquidity-close.json", "pool-swap-tbc-for-token.json", "pool-swap-token-for-tbc.json"] {
        let original = plan_input(name);
        let (mut low, mut high) = (0u64, 10_000_000u64);
        while low + 1 < high {
            let mid = (low + high) / 2;
            let mut input = original.clone();
            fragmented_funding::replace(&mut input, 1, mid);
            if call(EngineMethod::Plan, &bind(input))["ok"] == true { high = mid; } else { low = mid; }
        }
        assert!(high > 1 && high < 10_000_000, "{name}: invalid minimum {high}");
        let mut fragmented = original.clone();
        fragmented_funding::replace(&mut fragmented, 3, high - 1);
        let input = bind(fragmented);
        let planned = call(EngineMethod::Plan, &input);
        assert_eq!(planned["ok"], true, "{name}: {planned}");
        assert_eq!(planned["result"]["plan"]["payload"]["transactions"][0]["id"], "native-funding-1", "{name}");
        let (result, _) = complete_pool_public(&input);
        let transactions = result["bundle"]["transactions"].as_array().unwrap();
        let funding = Transaction::from_hex(transactions[0]["rawTransaction"].as_str().unwrap()).unwrap();
        assert!(transactions[1..].iter().any(|tx| Transaction::from_hex(tx["rawTransaction"].as_str().unwrap())
            .unwrap().inputs.iter().any(|input| input.previous_output.txid == funding.txid())), "{name}: missing signed funding dependency");
    }
}

#[test]
fn optional_confirmations_pool_thresholds_and_hash_binding() {
    for name in ["pool-liquidity-add.json", "pool-liquidity-remove.json",
        "pool-liquidity-close.json", "pool-swap-tbc-for-token.json", "pool-swap-token-for-tbc.json"] {
        optional_confirmations::exercise(plan_input(name));
    }
    optional_confirmations::exercise(fragmented_plan_input(
        "pool-liquidity-remove.json", &[500_000, 500_000, 500_000, 1_000_000], &[5_000, 5_000],
    ));
}

use secp256k1::{Message, Secp256k1, SecretKey};
use sha2::{Digest, Sha256};
use tbc_engine_core::{EngineMethod, call_json};
use tbc_sdk::{
    Address, OutPoint, Transaction, TxIn, TxOut, Txid,
    contracts::{
        ft::{
            amount::{balance_from_tape, build_tape_amount},
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
            scripts::transfer_ftlp_code_script,
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
    material_with_pool_source(OWNER, 9_800, b"for poolnft mint")
}

fn material_with_pool_source(creator: &str, source_value: u64, marker: &[u8]) -> PoolMaterial {
    material_with_pool_fees(creator, source_value, marker, 1, 35)
}

fn material_with_pool_fees(creator: &str, source_value: u64, marker: &[u8], lp_plan: u8, service_fee_rate: u16) -> PoolMaterial {
    let owner = Address::from_string(OWNER).unwrap();
    let creator = Address::from_string(creator).unwrap();
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
        encode_hex(&creator.hash160()), encode_hex(marker)
    )).unwrap();
    let pool_source = transaction(
        vec![TxOut { satoshis: source_value, script_pubkey: pool_source_script }],
        0x32,
    );
    let source_outpoint = OutPoint { txid: pool_source.txid(), vout: 0 };
    let pool_code_script = pool_code(
        source_outpoint.clone(), POOL_PROVIDER.as_bytes(),
        &PoolCodeParams { lp_plan, ft_version: FtScriptVersion::V4, is_coin: false },
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
        service_fee_rate,
        service_provider: POOL_PROVIDER.to_owned(),
        lp_plan,
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
    let fee_state = PoolState::from_v2_tape(&m.pool_current.outputs[1].script_pubkey, POOL_PROVIDER.to_owned()).unwrap();
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
        "lpPlan":fee_state.lp_plan, "serviceProviderTag":POOL_PROVIDER, "serviceFeeRate":fee_state.service_fee_rate
    });
    input["policy"]["payload"]["expiresAt"] = expires_at;
    input["policy"]["payload"]["amountLimits"] = json!([]);
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    input["snapshot"]["snapshotHash"] = json!(canonical_hash(&input["snapshot"]["payload"]));
    input["policy"]["policyHash"] = json!(canonical_hash(&input["policy"]["payload"]));
    input
}

fn split_create_mint_input() -> Value {
    let mut input = plan_input("pool-create.json");
    input["request"]["intent"]["stage"] = json!("mint");
    input["request"]["intent"].as_object_mut().unwrap().remove("initialLiquidity");
    input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap()
        .retain(|item| item["classification"] != "pool-source");
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    input["snapshot"]["snapshotHash"] = json!(canonical_hash(&input["snapshot"]["payload"]));
    input
}

fn split_create_initialize_input() -> Value {
    let mut m = material();
    m.pool_current = m.pool_creation.clone();
    m.pool_ft_vouts.clear();
    m.ftlp_vouts.clear();
    let mut input = plan_input_from_material("pool-liquidity-add.json", m);
    input["request"]["intent"] = json!({
        "type":"tbc.pool.create", "version":"1.0", "stage":"initialize",
        "poolContractId":input["snapshot"]["payload"]["contracts"][1]["contractId"].clone(),
        "initialLiquidity":{"receiver":OWNER, "tbcAmount":"10000", "ftAmount":"2500000"}
    });
    let mut seen = std::collections::BTreeSet::new();
    input["snapshot"]["payload"]["parents"].as_array_mut().unwrap()
        .retain(|item| seen.insert(item["txid"].as_str().unwrap().to_owned()));
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    input["snapshot"]["snapshotHash"] = json!(canonical_hash(&input["snapshot"]["payload"]));
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
    let mut m = material();
    // Existing locked-pool holdings are fixture material, not newly issued via
    // the now-disabled public creation path. Reuse the pinned SDK codecs just
    // like material() does for historical FT and the ordinary Pool2 fixture.
    let owner = Address::from_string(OWNER).unwrap();
    let keys = create["request"]["intent"]["lock"]["publicKeys"].as_array().unwrap().iter()
        .map(|key| tbc_sdk::PublicKey::from_slice(&decode_hex(key.as_str().unwrap())).unwrap())
        .collect::<Vec<_>>();
    let code = tbc_sdk::contracts::pool_nft_v2::locked_pool_code(
        OutPoint { txid: m.pool_source.txid(), vout: 0 }, POOL_PROVIDER.as_bytes(), &keys,
        &tbc_sdk::contracts::pool_nft_v2::LockedPoolCodeParams {
            pool: PoolCodeParams { lp_plan: 1, ft_version: FtScriptVersion::V4, is_coin: false },
            lp_cost_address: owner.clone(), lp_cost_sat: 100,
        },
    ).unwrap();
    assert_locked_pool_code(&code);
    let zero_tape = ftlp_tape(&FtlpTapeParams { amount_raw: 0, layout: FtlpTapeLayout::LockTime {
        lock_time: 800_100, source_ft_tape_size: m.ft_contract.outputs[1].script_pubkey.as_bytes().len(),
    }}).unwrap();
    let zero_params = FtlpCodeParams::for_tape(&zero_tape, FtScriptVersion::V4, false).unwrap();
    let zero_code = ftlp_lock_time_code(hash::sha256(code.as_bytes()), &owner, &zero_params).unwrap();
    let mut zero_state = PoolState::from_v2_tape(&m.pool_creation.outputs[1].script_pubkey, POOL_PROVIDER.to_owned()).unwrap();
    zero_state.public_key_locked = true;
    zero_state.ftlp_lock_time_enabled = true;
    zero_state.ft_lp_partial_hash = calculate_partial_hash(&zero_code.as_bytes()[..2048]).to_vec();
    m.pool_creation.outputs[0].script_pubkey = code;
    m.pool_creation.outputs[1].script_pubkey = pool_tape(&zero_state).unwrap();
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

fn assert_signing_task_batch(
    tasks: &Value,
    transaction_id: &str,
    transaction: &Transaction,
    expected_input_indexes: &[usize],
) {
    let tasks = tasks.as_array().unwrap();
    assert_eq!(tasks.len(), expected_input_indexes.len(), "{transaction_id} signing task count");
    assert!(!tasks.is_empty(), "{transaction_id} has no signing tasks");
    let mut input_indexes = Vec::with_capacity(tasks.len());
    for task in tasks {
        let actual_id = task
            .get("transactionTemplateId")
            .and_then(Value::as_str)
            .unwrap();
        assert_eq!(actual_id, transaction_id, "premature later-stage signing task");
        let input_index = usize::try_from(task["inputIndex"].as_u64().unwrap()).unwrap();
        assert!(input_index < transaction.inputs.len(), "signing input index is out of range");
        input_indexes.push(input_index);
        assert_eq!(task["taskId"], format!("sign-{transaction_id}-input-{input_index}"));
        assert_eq!(task["purpose"], "transaction");
        assert_eq!(task["algorithm"], "secp256k1-ecdsa-sha256d");
        assert_eq!(task["signatureEncoding"], "compact64");
        assert_eq!(decode_hex(task["digest"].as_str().unwrap()).len(), 32);
        assert_eq!(task["sighashType"], 65);
    }
    let unique = input_indexes.iter().copied().collect::<std::collections::BTreeSet<_>>();
    assert_eq!(unique.len(), input_indexes.len(), "duplicate signing input index");
    input_indexes.sort_unstable();
    assert_eq!(input_indexes, expected_input_indexes);
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

fn complete_pool_public(input: &Value) -> (Value, usize) {
    let planned = call_ok(EngineMethod::Plan, input);
    let checked = validation_for_plan(input.clone(), &planned);
    assert_eq!(checked["valid"], true, "{checked}");
    let mut finalize = pool_finalize_input(input, &planned);
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
            return (result, stages);
        }
        finalize["continuation"] = result["continuation"].clone();
        finalize["signatures"] = sign_tasks(&result["signingRequests"]);
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

fn assert_dependencies_follow_finalized_input_order(planned: &Value, finalized: &Value) {
    let declared = planned["plan"]["payload"]["transactions"].as_array().unwrap();
    let bundle = finalized["bundle"]["transactions"].as_array().unwrap();
    assert_eq!(declared.len(), bundle.len());
    let parsed = bundle
        .iter()
        .map(|item| Transaction::from_hex(item["rawTransaction"].as_str().unwrap()).unwrap())
        .collect::<Vec<_>>();
    for (child_index, child) in parsed.iter().enumerate() {
        let mut expected = Vec::<String>::new();
        for input in &child.inputs {
            let matches = parsed[..child_index]
                .iter()
                .enumerate()
                .filter(|(_, parent)| parent.txid() == input.previous_output.txid)
                .collect::<Vec<_>>();
            assert!(matches.len() <= 1, "internal parent txid must resolve uniquely");
            if let Some((parent_index, parent)) = matches.first().copied() {
                assert!(
                    usize::try_from(input.previous_output.vout).unwrap() < parent.outputs.len(),
                    "internal parent vout must resolve"
                );
                let id = declared[parent_index]["id"].as_str().unwrap().to_owned();
                if !expected.contains(&id) {
                    expected.push(id);
                }
            }
        }
        assert_eq!(
            declared[child_index]["dependsOn"],
            json!(expected),
            "dependsOn must follow first distinct internal parent occurrence in raw input order"
        );
    }
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

#[test]
fn historical_pool_create_is_disabled() {
    let result = call(EngineMethod::Plan, &plan_input("pool-create.json"));
    assert_eq!(result["error"]["code"], "UNSUPPORTED_INTENT");
    assert!(result.get("result").is_none());
}

#[test]
fn historical_pool_split_creation_cannot_bypass_issuance_policy() {
    for input in [split_create_mint_input(), split_create_initialize_input()] {
        let result = call(EngineMethod::Plan, &input);
        assert_eq!(result["error"]["code"], "UNSUPPORTED_INTENT");
        assert!(result.get("result").is_none());
    }
}

#[test]
fn pool_liquidity_math_and_exact_input_rounding_match_released_v2() {
    let add = call_ok(EngineMethod::Plan, &plan_input("pool-liquidity-add.json"));
    let add_tx = planned_transaction(&add, roles(&add).len() - 1);
    let add_state = PoolState::from_v2_tape(&add_tx.outputs[1].script_pubkey, POOL_PROVIDER.to_owned()).unwrap();
    assert_eq!(add_state.amounts, PoolAmounts { ft_lp_raw: 11_000, ft_a_raw: 2_750_000, tbc_sat: 11_000 });

    let remove = call_ok(EngineMethod::Plan, &plan_input("pool-liquidity-remove.json"));
    let remove_tx = planned_transaction(&remove, roles(&remove).len() - 1);
    assert_eq!(remove_tx.outputs[4].satoshis, 1_000);

    let tbc_swap = call_ok(EngineMethod::Plan, &plan_input("pool-swap-tbc-for-token.json"));
    let tbc_tx = planned_transaction(&tbc_swap, roles(&tbc_swap).len() - 1);
    let tbc_state = PoolState::from_v2_tape(&tbc_tx.outputs[1].script_pubkey, POOL_PROVIDER.to_owned()).unwrap();
    assert_eq!(tbc_state.amounts.ft_a_raw, 2_273_347);
    assert_eq!(tbc_state.amounts.tbc_sat, 10_997);

    let ft_swap = call_ok(EngineMethod::Plan, &plan_input("pool-swap-token-for-tbc.json"));
    let ft_tx = planned_transaction(&ft_swap, roles(&ft_swap).len() - 1);
    assert_eq!(ft_tx.outputs[2].satoshis, 907);
}

#[test]
fn pool2_lp6_330_uses_bound_current_economics_and_shared_signing() {
    use tbc_sdk::contracts::pool_nft_v2::math;
    for (lp_plan, rate, lp) in [(1, 35, 25), (6, 330, 200)] {
        assert_eq!(math::lp_fee_rate(rate, lp_plan).unwrap(), lp);
        for name in ["pool-swap-tbc-for-token.json", "pool-swap-token-for-tbc.json", "pool-liquidity-add.json", "pool-liquidity-remove.json"] {
            let mut material = material_with_pool_fees(OWNER, 9_800, b"for poolnft mint", lp_plan, rate);
            // This fixture is independently VM-checked, unlike the older
            // arithmetic-only scaffold. Its held FT comes from input 1
            // (owner_ft), not input 0 (Pool). Commit that actual provenance.
            if std::env::var("POOL173_INVALID_PROVENANCE").as_deref()!=Ok("1") {
                let (slots, _) = build_tape_amount(2_500_000, &[0, 2_500_000]).unwrap();
                material.pool_current.outputs[3].script_pubkey = transfer_tape_script(
                    &material.ft_contract.outputs[1].script_pubkey, &slots,
                ).unwrap();
            }
            let mut input = plan_input_from_material(name, material);
            // Existing plan-1 fixture slippage cannot be reused as an expected
            // LP6 quote. These offline fixtures set explicit positive minima.
            for field in ["minimumFtAmount", "minimumTbcAmount"] {
                if input["request"]["intent"].get(field).is_some() { input["request"]["intent"][field]=json!("1"); }
            }
            input["requestHash"]=json!(canonical_hash(&input["request"]));
            let plan = call_ok(EngineMethod::Plan, &input);
            let transaction = planned_transaction(&plan, roles(&plan).len()-1);
            let after = PoolState::from_v2_tape(&transaction.outputs[1].script_pubkey, POOL_PROVIDER.to_owned()).unwrap();
            assert_eq!(after.service_fee_rate, rate);
            assert_eq!(after.lp_plan, lp_plan);
            let (finalized, _) = complete_pool_public(&input);
            assert!(!finalized["bundle"]["transactions"].as_array().unwrap().is_empty());
            if std::env::var("POOL173_DUMP_WIRE").as_deref()==Ok("1") {
                println!("POOL173_WIRE:{}",json!({"name":name,"plan":lp_plan,"parents":input["snapshot"]["payload"]["parents"],"bundle":finalized["bundle"]}));
            }
            // No total-1.3% compatibility alias and no operation-level override.
            let mut wrong=input.clone();wrong["policy"]["payload"]["pool"]["serviceFeeRate"]=json!(130);
            wrong["policy"]["policyHash"]=json!(canonical_hash(&wrong["policy"]["payload"]));
            assert_eq!(call(EngineMethod::Plan,&wrong)["ok"],false);
        }
    }
    for rate in [0,80,129,130,131,329,331] { assert!(math::lp_fee_rate(rate,6).is_err()); }
}

#[test]
fn locked_remove_emits_unlock_maintenance_before_primary() {
    let mut input = locked_plan_input("pool-liquidity-remove.json", 800_100);
    let contracts = input["snapshot"]["payload"]["contracts"]
        .as_array()
        .expect("authenticated contracts");
    let current_txid = contracts
        .iter()
        .find(|item| item["family"] == "pool")
        .expect("authenticated Pool contract")["currentOutpoint"]["txid"]
        .as_str()
        .expect("authenticated current Pool txid")
        .to_owned();
    let current_parents = input["snapshot"]["payload"]["parents"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["txid"] == current_txid)
        .collect::<Vec<_>>();
    assert_eq!(current_parents.len(), 1, "current Pool parent must resolve uniquely");
    let mut current = Transaction::from_hex(
        current_parents[0]["rawTransaction"]
            .as_str()
            .expect("authenticated current Pool raw parent"),
    )
    .expect("parse authenticated current Pool raw parent");
    assert_eq!(current.txid().to_string(), current_txid);

    let mut state = PoolState::from_v2_tape(
        &current.outputs[1].script_pubkey,
        POOL_PROVIDER.to_owned(),
    )
    .expect("authenticated locked Pool state");
    state.amounts = PoolAmounts { ft_lp_raw: 9_900, ft_a_raw: 2_500_000, tbc_sat: 9_900 };
    current.outputs[0].satoshis = 10_900;
    current.outputs[1].script_pubkey = pool_tape(&state).expect("post-cost Pool Tape");

    let ft_creation_txid = contracts
        .iter()
        .find(|item| item["family"] == "ft")
        .expect("authenticated FT contract")["creationTxid"]
        .as_str()
        .expect("authenticated FT creation txid");
    let ft_parents = input["snapshot"]["payload"]["parents"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["txid"] == ft_creation_txid)
        .collect::<Vec<_>>();
    assert_eq!(ft_parents.len(), 1, "FT creation parent must resolve uniquely");
    let ft_creation = Transaction::from_hex(
        ft_parents[0]["rawTransaction"]
            .as_str()
            .expect("authenticated FT creation raw parent"),
    )
    .expect("parse authenticated FT creation raw parent");
    assert_eq!(ft_creation.txid().to_string(), ft_creation_txid);

    let locked_tape = ftlp_tape(&FtlpTapeParams {
        amount_raw: 9_900,
        layout: FtlpTapeLayout::LockTime {
            lock_time: 800_100,
            source_ft_tape_size: ft_creation.outputs[1].script_pubkey.as_bytes().len(),
        },
    })
    .expect("canonical released locked FTLP Tape");
    let locked_params = FtlpCodeParams::for_tape(&locked_tape, FtScriptVersion::V4, false)
        .expect("canonical released locked FTLP parameters");
    current.outputs[4].script_pubkey = ftlp_lock_time_code(
        hash::sha256(current.outputs[0].script_pubkey.as_bytes()),
        &Address::from_string(OWNER).expect("canonical fixture owner"),
        &locked_params,
    )
    .expect("canonical released locked FTLP Code");
    current.outputs[5].script_pubkey = locked_tape.clone();
    replace_current_parent(&mut input, current);
    input["snapshot"]["payload"]["block"]["height"] = json!("800101");
    input["snapshot"]["snapshotHash"] = json!(canonical_hash(&input["snapshot"]["payload"]));

    let pool_contract = input["snapshot"]["payload"]["contracts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["family"] == "pool")
        .expect("authenticated Pool contract");
    let resolved_txid = pool_contract["currentOutpoint"]["txid"].as_str().unwrap();
    let resolved = input["snapshot"]["payload"]["parents"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["txid"] == resolved_txid)
        .collect::<Vec<_>>();
    assert_eq!(resolved.len(), 1, "updated Pool parent must resolve uniquely");
    let resolved = Transaction::from_hex(resolved[0]["rawTransaction"].as_str().unwrap()).unwrap();
    assert_eq!(resolved.txid().to_string(), resolved_txid);
    let resolved_state = PoolState::from_v2_tape(
        &resolved.outputs[1].script_pubkey,
        POOL_PROVIDER.to_owned(),
    )
    .expect("updated authenticated locked Pool state");
    assert_eq!(resolved_state.amounts, state.amounts);
    assert!(resolved_state.public_key_locked && resolved_state.ftlp_lock_time_enabled);
    assert_eq!(resolved.outputs[0].satoshis, 10_900);
    assert_eq!(resolved.outputs[5].script_pubkey, locked_tape);
    assert_eq!(input["request"]["intent"]["lpAmount"], json!("1000"));

    let result = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&result), ["maintenance", "primary"]);
    assert_eq!(
        result["plan"]["payload"]["transactions"][1]["dependsOn"],
        json!([result["plan"]["payload"]["transactions"][0]["id"].clone()])
    );
}

#[test]
fn pool_slippage_limits_are_enforced_during_validation() {
    let input = plan_input("pool-swap-token-for-tbc.json");
    let result = call_ok(EngineMethod::Plan, &input);
    let mut changed = input.clone();
    changed["request"]["intent"]["minimumTbcAmount"] = json!("999999999999");
    changed["requestHash"] = json!(canonical_hash(&changed["request"]));
    changed["plan"] = result["plan"].clone();
    changed["phase"] = json!("plan");
    let validation = call_ok(EngineMethod::Validate, &changed);
    assert!(validation["violations"].as_array().unwrap().iter().any(|item| item["code"] == "INTENT_OUTPUT_MISMATCH"), "{validation}");
}

#[test]
fn pool_state_rejects_outpoint_creation_script_policy_and_height_mutations() {
    let baseline = plan_input("pool-liquidity-remove.json");
    for mutation in ["outpoint", "creation", "script", "fee", "height"] {
        let mut changed = baseline.clone();
        match mutation {
            "outpoint" => changed["snapshot"]["payload"]["contracts"][1]["currentOutpoint"]["vout"] = json!(1),
            "creation" => changed["snapshot"]["payload"]["contracts"][1]["creationTxid"] = json!("11".repeat(32)),
            "script" => changed["snapshot"]["payload"]["utxos"][1]["scriptPubKey"] = json!("51"),
            "fee" => changed["policy"]["payload"]["pool"]["serviceFeeRate"] = json!(36),
            "height" => changed["snapshot"]["payload"]["block"]["height"] = json!("500000000"),
            _ => unreachable!(),
        }
        changed["snapshot"]["snapshotHash"] = json!(canonical_hash(&changed["snapshot"]["payload"]));
        changed["policy"]["policyHash"] = json!(canonical_hash(&changed["policy"]["payload"]));
        assert_eq!(call(EngineMethod::Plan, &changed)["ok"], false, "mutation {mutation} was accepted");
    }
}

#[test]
fn pool_close_burns_the_complete_lp_position_and_returns_reserves_to_sender() {
    let result = call_ok(EngineMethod::Plan, &plan_input("pool-liquidity-close.json"));
    let tx = planned_transaction(&result, roles(&result).len() - 1);
    let state = PoolState::from_v2_tape(&tx.outputs[1].script_pubkey, POOL_PROVIDER.to_owned()).unwrap();
    assert_eq!(state.amounts, PoolAmounts { ft_lp_raw: 0, ft_a_raw: 0, tbc_sat: 0 });
    assert_eq!(tx.outputs[4].satoshis, 10_000);
}

#[test]
fn pool_signing_requests_follow_transaction_then_input_order() {
    let result = call_ok(EngineMethod::Plan, &plan_input("pool-liquidity-add.json"));
    let tasks = result["plan"]["payload"]["signingTasks"].as_array().unwrap();
    assert!(tasks.windows(2).all(|pair| {
        let left = (&pair[0]["transactionTemplateId"], pair[0]["inputIndex"].as_u64().unwrap());
        let right = (&pair[1]["transactionTemplateId"], pair[1]["inputIndex"].as_u64().unwrap());
        left.0 != right.0 || left.1 < right.1
    }));
}

#[test]
fn pool_planning_is_deterministic_and_maintenance_is_not_a_public_intent() {
    let input = plan_input("pool-swap-tbc-for-token.json");
    assert_eq!(call_ok(EngineMethod::Plan, &input), call_ok(EngineMethod::Plan, &input));
    let mut public_merge = input;
    public_merge["request"]["intent"]["type"] = json!("tbc.pool.merge");
    public_merge["requestHash"] = json!(canonical_hash(&public_merge["request"]));
    assert_eq!(call(EngineMethod::Plan, &public_merge)["error"]["code"], "UNSUPPORTED_INTENT");
}

#[test]
fn source_math_literals_are_independent_of_the_core_plan() {
    let state = PoolAmounts { ft_lp_raw: 10_000, ft_a_raw: 2_500_000, tbc_sat: 10_000 };
    let tbc = tbc_sdk::swap_tbc_to_ft(&state, 1_000, 35, 1).unwrap();
    let ft = tbc_sdk::swap_ft_to_tbc(&state, 250_000, 35, 1).unwrap();
    assert_eq!((tbc.ft_a_delta, tbc.tbc_sat_delta, tbc.pool_value_delta), (-226_653, 997, 1_000));
    assert_eq!((ft.ft_a_delta, ft.tbc_sat_delta, ft.pool_value_delta), (250_000, -910, -907));
}

#[test]
fn pool_schema_rejects_cross_operation_fields_and_unknown_maintenance_spellings() {
    let baseline = plan_input("pool-liquidity-add.json");
    for intent_type in [
        "tbc.pool.merge",
        "tbc.ftlp.merge",
    ] {
        let mut changed = baseline.clone();
        changed["request"]["intent"]["type"] = json!(intent_type);
        changed["requestHash"] = json!(canonical_hash(&changed["request"]));
        assert_eq!(call(EngineMethod::Plan, &changed)["error"]["code"], "UNSUPPORTED_INTENT");
    }

    for (field, value) in [
        ("ftAmount", json!("1")),
        ("lpAmount", json!("1")),
        ("minimumFtAmount", json!("1")),
        ("minimumTbcAmount", json!("1")),
        ("serviceProviderTag", json!("caller-controlled")),
    ] {
        let mut changed = baseline.clone();
        changed["request"]["intent"][field] = value;
        assert_eq!(call(EngineMethod::NormalizeRequest, &normalize_input(&changed))["ok"], false, "cross-operation field {field} was accepted");
    }
}

#[test]
fn public_pool_ft_and_ftlp_merge_are_single_primary_bounded_operations() {
    for (intent_type, pool_ft, ftlp, expected_id, expected_kind) in [
        ("tbc.pool.ft.merge", vec![1_000_000, 1_500_000], vec![10_000], "pool-ft-merge-1", "ft"),
        ("tbc.pool.ftlp.merge", vec![2_500_000], vec![4_000, 6_000], "ftlp-merge-1", "lp"),
    ] {
        let mut input = fragmented_plan_input("pool-liquidity-remove.json", &pool_ft, &ftlp);
        let ft_contract_id = input["snapshot"]["payload"]["contracts"][0]["contractId"].clone();
        let pool_contract_id = input["snapshot"]["payload"]["contracts"][1]["contractId"].clone();
        input["request"]["intent"] = json!({
            "type": intent_type,
            "version": "1.0",
            "poolContractId": pool_contract_id,
        });
        input["requestHash"] = json!(canonical_hash(&input["request"]));
        let result = call_ok(EngineMethod::Plan, &input);
        assert_eq!(roles(&result), ["primary"]);
        assert_eq!(result["plan"]["payload"]["transactions"][0]["id"], expected_id);
        assert_eq!(result["plan"]["payload"]["preview"]["assetFlows"][0]["kind"], expected_kind);
        assert_eq!(result["plan"]["payload"]["preview"]["assetFlows"][0]["direction"], "merge");
        if intent_type == "tbc.pool.ft.merge" {
            assert_eq!(
                result["plan"]["payload"]["preview"]["assetFlows"][0]["contractId"],
                ft_contract_id
            );
        }
    }
}

#[test]
fn unified_pool_loader_fragmented_fixture() {
    // Public scalar-one fixture only. The Node source gate captures this in
    // memory to exercise the real HTTP adapters, not a mocked material loader.
    let p=fragmented_plan_input("pool-liquidity-remove.json", &[1_000_000,1_500_000], &[4_000,6_000]);
    let payload=&p["snapshot"]["payload"];
    let pool=&payload["contracts"][1];
    let parent=payload["parents"].as_array().unwrap().iter()
        .find(|v|v["txid"]==pool["currentOutpoint"]["txid"]).unwrap();
    let tx=Transaction::from_hex(parent["rawTransaction"].as_str().unwrap()).unwrap();
    let state=PoolState::from_v2_tape(&tx.outputs[1].script_pubkey,POOL_PROVIDER.into()).unwrap();
    let native=payload["utxos"].as_array().unwrap().iter().find(|v|v["classification"]=="native").unwrap();
    assert_eq!(tx.outputs.len(),10);
    if std::env::var_os("UNIFIED_POOL_LOADER_FIXTURE").is_some() {
        println!("UNIFIED_POOL_LOADER_FIXTURE:{}",json!({
            "poolContractId":pool["contractId"],"address":OWNER,
            "publicKey":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            "rawTransactions":payload["parents"].as_array().unwrap().iter().map(|v|
                (v["txid"].as_str().unwrap().to_owned(),v["rawTransaction"].clone())).collect::<serde_json::Map<_,_>>(),
            "poolInfo":{"ft_a_partial_hash":encode_hex(&state.ft_a_partial_hash),
                "ft_lp_partial_hash":encode_hex(&state.ft_lp_partial_hash),"ft_contract_id":state.ft_a_contract_id.to_string(),
                "lp_balance":state.amounts.ft_lp_raw.to_string(),"token_balance":state.amounts.ft_a_raw.to_string(),
                "tbc_balance":state.amounts.tbc_sat.to_string(),"pool_code_script":encode_hex(tx.outputs[0].script_pubkey.as_bytes()),
                "service_fee_rate":state.service_fee_rate,"service_provider":POOL_PROVIDER,"txid":tx.txid().to_string(),
                "value":tx.outputs[0].satoshis.to_string(),"version":2,"vout":0},
            "native":{"txid":native["txid"],"index":native["vout"],"value":native["satoshis"].as_str().unwrap().parse::<u64>().unwrap(),"height":799999},
            "poolFt":[{"txid":tx.txid().to_string(),"index":2,"tbc_value":500,"ft_value":"1000000"},
                {"txid":tx.txid().to_string(),"index":4,"tbc_value":500,"ft_value":"1500000"}],
            "poolLp":[{"txid":tx.txid().to_string(),"index":6,"tbc_balance":500,"lp_balance":"4000","lock_time":0},
                {"txid":tx.txid().to_string(),"index":8,"tbc_balance":500,"lp_balance":"6000","lock_time":0}]
        }));
    }
}
#[test]
fn unified_pool_rejects_unsupported_historical_holder_operations() {
    unified_business::reject_unsupported_pool_operations(
        fragmented_plan_input("pool-liquidity-remove.json", &[1_000_000,1_500_000], &[4_000,6_000]), false);
}
#[test]
fn unified_pool_maintenance_preserves_historical_transactions() {
    for kind in ["tbc.pool.ft.merge","tbc.pool.ftlp.merge","tbc.pool.ftlp.burn"] {
        let mut p=fragmented_plan_input("pool-liquidity-remove.json", &[1_000_000,1_500_000], &[4_000,6_000]);
        let id=p["snapshot"]["payload"]["contracts"][1]["contractId"].clone();
        p["request"]["intent"]=json!({"type":kind,"version":"1.0","poolContractId":id});
        p["requestHash"]=json!(canonical_hash(&p["request"]));
        unified_business::exercise_pool(p);
    }
}

#[test]
fn public_ftlp_burn_sends_whole_selected_balance_to_eater_without_spending_pool() {
    let mut input = fragmented_plan_input(
        "pool-liquidity-remove.json",
        &[2_500_000],
        &[4_000, 6_000],
    );
    let pool_contract_id = input["snapshot"]["payload"]["contracts"][1]["contractId"].clone();
    let pool_txid = input["snapshot"]["payload"]["contracts"][1]["currentOutpoint"]["txid"]
        .as_str().unwrap().to_owned();
    input["request"]["intent"] = json!({
        "type": "tbc.pool.ftlp.burn",
        "version": "1.0",
        "poolContractId": pool_contract_id,
    });
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    let result = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&result), ["primary"]);
    assert_eq!(result["plan"]["payload"]["transactions"][0]["id"], "ftlp-burn-1");
    assert_eq!(result["plan"]["payload"]["preview"]["assetFlows"][0]["kind"], "lp");
    assert_eq!(result["plan"]["payload"]["preview"]["assetFlows"][0]["direction"], "burn");
    assert_eq!(result["plan"]["payload"]["preview"]["assetFlows"][0]["amount"], "10000");
    assert_eq!(result["plan"]["payload"]["preview"]["assetFlows"][0]["to"], "1BitcoinEaterAddressDontSendf59kuE");
    let tx = planned_transaction(&result, 0);
    assert!(tx.inputs.iter().all(|item| {
        item.previous_output.txid.to_string() != pool_txid || item.previous_output.vout != 0
    }));
    assert_eq!(balance_from_tape(&tx.outputs[1].script_pubkey).unwrap(), 10_000);
    let source_code = input["snapshot"]["payload"]["utxos"]
        .as_array().unwrap().iter().find(|item| item["classification"] == "ftlp").unwrap()["scriptPubKey"]
        .as_str().unwrap();
    let eater = Address::from_string("1BitcoinEaterAddressDontSendf59kuE").unwrap();
    assert_eq!(
        tx.outputs[0].script_pubkey,
        transfer_ftlp_code_script(&Script::from_bytes(decode_hex(source_code)), &eater).unwrap(),
    );
    let (completed, stages) = complete_pool_public(&input);
    assert_eq!(stages, 1);
    assert_eq!(completed["bundle"]["transactions"].as_array().unwrap().len(), 1);
}

#[test]
fn public_ftlp_burn_rejects_locked_family_inputs_that_are_not_already_unlocked() {
    let mut input = locked_plan_input("pool-liquidity-remove.json", 800_100);
    let pool_contract_id = input["snapshot"]["payload"]["contracts"][1]["contractId"].clone();
    input["request"]["intent"] = json!({
        "type": "tbc.pool.ftlp.burn",
        "version": "1.0",
        "poolContractId": pool_contract_id,
    });
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    assert_eq!(call(EngineMethod::Plan, &input)["error"]["code"], "INSUFFICIENT_FUNDS");
}

#[test]
fn public_pool_merge_rejects_a_single_asset_input() {
    for (intent_type, pool_ft, ftlp) in [
        ("tbc.pool.ft.merge", vec![2_500_000], vec![10_000]),
        ("tbc.pool.ftlp.merge", vec![2_500_000], vec![10_000]),
    ] {
        let mut input = fragmented_plan_input("pool-liquidity-remove.json", &pool_ft, &ftlp);
        let pool_contract_id = input["snapshot"]["payload"]["contracts"][1]["contractId"].clone();
        input["request"]["intent"] = json!({
            "type": intent_type,
            "version": "1.0",
            "poolContractId": pool_contract_id,
        });
        input["requestHash"] = json!(canonical_hash(&input["request"]));
        assert_eq!(call(EngineMethod::Plan, &input)["error"]["code"], "INSUFFICIENT_FUNDS");
    }
}

#[test]
fn pool_minimum_outputs_fail_closed_at_one_raw_unit_above_released_output() {
    for (fixture, field, minimum) in [
        ("pool-liquidity-add.json", "minimumLpAmount", "1001"),
        ("pool-liquidity-remove.json", "minimumTbcAmount", "1001"),
        ("pool-liquidity-remove.json", "minimumFtAmount", "250001"),
        ("pool-swap-tbc-for-token.json", "minimumFtAmount", "226654"),
        ("pool-swap-token-for-tbc.json", "minimumTbcAmount", "908"),
    ] {
        let input = plan_input(fixture);
        let planned = call_ok(EngineMethod::Plan, &input);
        let mut changed = input;
        changed["request"]["intent"][field] = json!(minimum);
        changed["requestHash"] = json!(canonical_hash(&changed["request"]));
        let validation = validation_for_plan(changed, &planned);
        assert!(has_violation(&validation, "INTENT_OUTPUT_MISMATCH"), "{fixture} {field} accepted an off-by-one minimum: {validation}");
    }
}

#[test]
fn existing_pool_allows_an_operator_other_than_the_historical_creator() {
    for fixture in ["pool-liquidity-add.json", "pool-liquidity-remove.json",
        "pool-swap-tbc-for-token.json", "pool-swap-token-for-tbc.json"] {
        let input = plan_input_from_material(fixture,
            material_with_pool_source("1BitcoinEaterAddressDontSendf59kuE", 9_800, b"for poolnft mint"));
        let (_, stages) = complete_pool_public(&input);
        assert_eq!(stages, 1, "{fixture}: unexpected extra transaction");
    }
}

#[test]
fn pool_creation_still_requires_the_current_account_to_own_its_source() {
    let input = plan_input_from_material("pool-create.json",
        material_with_pool_source("1BitcoinEaterAddressDontSendf59kuE", 9_800, b"for poolnft mint"));
    assert_eq!(call(EngineMethod::Plan, &input)["ok"], false);
}

#[test]
fn existing_pool_uses_trusted_current_state_not_historical_funding_audit() {
    for fixture in ["pool-liquidity-add.json", "pool-liquidity-remove.json",
        "pool-swap-tbc-for-token.json", "pool-swap-token-for-tbc.json"] {
        let original = plan_input(fixture);
        let expected = call_ok(EngineMethod::Plan, &original);
        let mut input = original.clone();
        let payload = &mut input["snapshot"]["payload"];
        let old_sources = payload["utxos"].as_array().unwrap().iter()
            .filter(|u| u["classification"] == "pool-source")
            .map(|u| u["txid"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        payload["utxos"].as_array_mut().unwrap().retain(|u| u["classification"] != "pool-source");
        payload["parents"].as_array_mut().unwrap().retain(|p|
            !old_sources.iter().any(|id| p["txid"] == id.as_str()));
        payload.as_object_mut().unwrap().remove("block");
        let actual = call_ok(EngineMethod::Plan, &bind(input.clone()));
        let raw = |result: &Value| result["plan"]["payload"]["transactions"].as_array().unwrap()
            .iter().map(|tx| tx["unsignedTransaction"].clone()).collect::<Vec<_>>();
        assert_eq!(raw(&actual), raw(&expected), "{fixture}");
        assert_eq!(actual["plan"]["payload"]["signingTasks"], expected["plan"]["payload"]["signingTasks"]);
        // Actual selected output tampering still fails; trusted indexing never
        // authorizes a different amount or owner than the spent transaction.
        let current = input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap()
            .iter_mut().find(|u| u["classification"] == "pool").unwrap();
        current["satoshis"] = json!("1");
        assert_eq!(call(EngineMethod::Plan, &bind(input))["ok"], false);
    }
}
#[test]
fn indexed_pool_authority_preserves_signed_bytes_and_rejects_material_tampering() {
    for fixture in ["pool-liquidity-add.json", "pool-liquidity-remove.json",
        "pool-swap-tbc-for-token.json", "pool-swap-token-for-tbc.json"] {
        let original = plan_input(fixture);
        let expected = complete_pool_public(&original).0;
        let mut input = original.clone();
        let payload = &mut input["snapshot"]["payload"];
        let ft_id = payload["contracts"].as_array().unwrap().iter()
            .find(|r| r["family"] == "ft").unwrap()["contractId"].as_str().unwrap().to_owned();
        let ft = payload["parents"].as_array().unwrap().iter().find(|p| p["txid"] == ft_id).unwrap();
        let tx = Transaction::from_hex(ft["rawTransaction"].as_str().unwrap()).unwrap();
        let code = encode_hex(tx.outputs[0].script_pubkey.as_bytes());
        let tape = encode_hex(tx.outputs[1].script_pubkey.as_bytes());
        for record in payload["contracts"].as_array_mut().unwrap() {
            if record["family"] == "ft" { record["indexedFungible"] = json!({"codeScript":code,"tapeScript":tape,"totalSupply":"1"}); }
            if record["family"] == "pool" { record["indexedPool"] = json!({"ftCodeScript":code,"ftTapeScript":tape}); }
        }
        payload["utxos"].as_array_mut().unwrap().retain(|u| u["classification"] != "pool-source");
        // Keep only spent transactions and their direct witness ancestors.
        let mut needed = std::collections::BTreeSet::new();
        for u in payload["utxos"].as_array().unwrap() {
            let id=u["txid"].as_str().unwrap(); needed.insert(id.to_owned());
            let p=payload["parents"].as_array().unwrap().iter().find(|p| p["txid"]==id).unwrap();
            let tx=Transaction::from_hex(p["rawTransaction"].as_str().unwrap()).unwrap();
            for i in tx.inputs { needed.insert(i.previous_output.txid.to_string()); }
        }
        payload["parents"].as_array_mut().unwrap().retain(|p|needed.contains(p["txid"].as_str().unwrap()));
        payload.as_object_mut().unwrap().remove("block");
        let input=bind(input);
        let actual=complete_pool_public(&input).0;
        assert_eq!(actual["bundle"]["transactions"],expected["bundle"]["transactions"],"{fixture}");
        for field in ["codeScript", "tapeScript"] {
            let mut bad=input.clone();
            bad["snapshot"]["payload"]["contracts"].as_array_mut().unwrap().iter_mut()
                .find(|r|r["family"]=="ft").unwrap()["indexedFungible"][field]=json!("51");
            assert_eq!(call(EngineMethod::Plan,&bind(bad))["ok"],false);
        }
    }
}

#[test]
fn pool_create_authenticates_exact_mint_source_value_marker_and_outpoint() {
    let baseline = plan_input("pool-create.json");
    for (field, value) in [
        ("satoshis", json!("9799")),
        ("scriptPubKey", json!("51")),
        ("vout", json!(1)),
    ] {
        let mut changed = baseline.clone();
        changed["snapshot"]["payload"]["utxos"][0][field] = value;
        changed["snapshot"]["snapshotHash"] = json!(canonical_hash(&changed["snapshot"]["payload"]));
        assert_eq!(call(EngineMethod::Plan, &changed)["ok"], false, "mutated Pool mint source {field} was accepted");
    }
}

#[test]
fn pool_policy_lock_domain_key_set_and_current_height_mutations_fail_closed() {
    let baseline = plan_input("pool-create.json");
    let public_key = baseline["snapshot"]["payload"]["account"]["publicKey"].clone();
    let mut locked = baseline.clone();
    locked["request"]["intent"]["lock"] = json!({
        "publicKeys":[public_key.clone()],
        "costRecipient":OWNER,
        "costAmount":"100",
        "untilHeight":"800100"
    });
    locked["requestHash"] = json!(canonical_hash(&locked["request"]));
    assert_eq!(call(EngineMethod::Plan, &locked)["error"]["code"], "UNSUPPORTED_INTENT");

    let mut duplicate_key = locked.clone();
    duplicate_key["request"]["intent"]["lock"]["publicKeys"] = json!([public_key.clone(), public_key]);
    duplicate_key["requestHash"] = json!(canonical_hash(&duplicate_key["request"]));
    assert_eq!(call(EngineMethod::Plan, &duplicate_key)["ok"], false);

    for (target, value) in [
        ("untilHeight", json!("500000000")),
        ("costAmount", json!("0")),
    ] {
        let mut changed = locked.clone();
        changed["request"]["intent"]["lock"][target] = value;
        changed["requestHash"] = json!(canonical_hash(&changed["request"]));
        assert_eq!(call(EngineMethod::Plan, &changed)["ok"], false, "invalid lock {target} was accepted");
    }

    for (target, value) in [
        ("lpPlan", json!(2)),
        ("serviceProviderTag", json!("wrong-provider")),
        ("serviceFeeRate", json!(9)),
    ] {
        let mut changed = baseline.clone();
        changed["policy"]["payload"]["pool"][target] = value;
        changed["policy"]["policyHash"] = json!(canonical_hash(&changed["policy"]["payload"]));
        assert_eq!(call(EngineMethod::Plan, &changed)["ok"], false, "mutated Pool policy {target} was accepted");
    }
}

#[test]
fn direct_pool_workflows_omit_unnecessary_internal_maintenance() {
    for fixture in [
        "pool-liquidity-add.json",
        "pool-liquidity-remove.json",
        "pool-liquidity-close.json",
        "pool-swap-tbc-for-token.json",
        "pool-swap-token-for-tbc.json",
    ] {
        let result = call_ok(EngineMethod::Plan, &plan_input(fixture));
        assert_eq!(roles(&result), ["primary"], "{fixture} emitted unnecessary maintenance");
    }
}

#[test]
fn fragmented_pool_ft_uses_internal_merge_before_liquidity_removal() {
    let mut input = fragmented_plan_input(
        "pool-liquidity-remove.json",
        &[416_666, 416_666, 416_666, 416_666, 416_668, 416_668],
        &[10_000],
    );
    input["request"]["intent"]["lpAmount"] = json!("6000");
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    let result = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&result), ["maintenance", "primary"]);
    assert_eq!(
        result["plan"]["payload"]["transactions"][1]["dependsOn"],
        json!(["pool-ft-merge-0"])
    );
    let maintenance_preview = planned_transaction(&result, 0);
    let original_fee = maintenance_preview.inputs.last().unwrap().previous_output.clone();
    assert_eq!(maintenance_preview.outputs.len(), 5);

    let (finalized, stages) = complete_pool_public(&input);
    assert_eq!(stages, 2);
    assert_dependencies_follow_finalized_input_order(&result, &finalized);
    let bundle = finalized["bundle"]["transactions"].as_array().unwrap();
    let maintenance = Transaction::from_hex(bundle[0]["rawTransaction"].as_str().unwrap()).unwrap();
    let primary = Transaction::from_hex(bundle[1]["rawTransaction"].as_str().unwrap()).unwrap();
    assert_eq!(
        primary.inputs.last().unwrap().previous_output,
        OutPoint { txid: maintenance.txid(), vout: 4 },
        "primary fee input must consume the authenticated maintenance fee-change successor"
    );
    assert!(
        primary.inputs.iter().all(|item| item.previous_output != original_fee),
        "primary must not reuse the original fee outpoint"
    );

    let mut wrong_fee = result.clone();
    mutate_unsigned(
        &mut wrong_fee["plan"]["payload"]["transactions"][1],
        |raw| raw.inputs.last_mut().unwrap().previous_output = original_fee,
    );
    let validation = validation_for_plan(input.clone(), &wrong_fee);
    assert_eq!(validation["valid"], false);
    assert!(has_violation(&validation, "PLAN_HASH_MISMATCH"), "wrong fee lineage: {validation}");
}

#[test]
fn pool_ft_merge_is_required_when_no_three_input_subset_covers_amount() {
    let mut input = fragmented_plan_input_with_totals(
        "pool-liquidity-remove.json",
        &[70_000, 70_000, 70_000, 70_000],
        &[10_000],
        280_000,
        10_000,
    );
    input["request"]["intent"]["lpAmount"] = json!("1000");
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));

    let result = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&result), ["maintenance", "primary"]);
    let merge = planned_transaction(&result, 0);
    assert_eq!(merge.inputs.len(), 6, "Pool plus all four necessary Pool-held FT candidates plus fee");
    let declared_candidates = input["snapshot"]["payload"]["utxos"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["classification"] == "pool-ft")
        .map(|item| OutPoint {
            txid: item["txid"].as_str().unwrap().parse().unwrap(),
            vout: u32::try_from(item["vout"].as_u64().unwrap()).unwrap(),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        merge.inputs[1..5].iter().map(|item| item.previous_output.clone()).collect::<Vec<_>>(),
        declared_candidates,
        "maintenance must preserve deterministic authenticated candidate order"
    );
    let primary = planned_transaction(&result, 1);
    assert!(primary.inputs.iter().all(|item| !declared_candidates.contains(&item.previous_output)));
    assert_eq!(primary.inputs[2].previous_output, OutPoint { txid: Txid::from_le_bytes([0; 32]), vout: 2 });
}

fn pool_ft_outpoints(input: &Value) -> Vec<OutPoint> {
    input["snapshot"]["payload"]["utxos"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["classification"] == "pool-ft")
        .map(|item| OutPoint {
            txid: item["txid"].as_str().unwrap().parse().unwrap(),
            vout: u32::try_from(item["vout"].as_u64().unwrap()).unwrap(),
        })
        .collect()
}

fn replace_native_funding(input: &mut Value, satoshis: u64) {
    let (old_txid, vout) = input["snapshot"]["payload"]["utxos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["classification"] == "native")
        .map(|native| {
            (
                native["txid"].as_str().unwrap().to_owned(),
                usize::try_from(native["vout"].as_u64().unwrap()).unwrap(),
            )
        })
        .unwrap();
    let txid = {
        let parent = input["snapshot"]["payload"]["parents"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|item| item["txid"] == old_txid)
            .unwrap();
        let mut transaction =
            Transaction::from_hex(parent["rawTransaction"].as_str().unwrap()).unwrap();
        transaction.outputs[vout].satoshis = satoshis;
        let txid = transaction.txid().to_string();
        parent["txid"] = json!(txid.clone());
        parent["rawTransaction"] = json!(transaction.to_hex());
        txid
    };
    let native = input["snapshot"]["payload"]["utxos"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|item| item["classification"] == "native")
        .unwrap();
    native["txid"] = json!(txid);
    native["satoshis"] = json!(satoshis.to_string());
    input["snapshot"]["snapshotHash"] = json!(canonical_hash(&input["snapshot"]["payload"]));
}

fn assert_pool_ft_frontier_lineage(
    planned: &Value,
    finalized: &Value,
    maintenance_count: usize,
) -> Vec<Transaction> {
    let declared = planned["plan"]["payload"]["transactions"].as_array().unwrap();
    assert_eq!(declared.len(), maintenance_count + 1);
    for round in 0..maintenance_count {
        assert_eq!(declared[round]["id"], format!("pool-ft-merge-{round}"));
        assert_eq!(
            declared[round]["dependsOn"],
            if round == 0 {
                json!([])
            } else {
                json!([format!("pool-ft-merge-{}", round - 1)])
            }
        );
    }
    assert_eq!(
        declared[maintenance_count]["dependsOn"],
        json!([format!("pool-ft-merge-{}", maintenance_count - 1)])
    );
    assert_dependencies_follow_finalized_input_order(planned, finalized);
    let raw = finalized["bundle"]["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| Transaction::from_hex(item["rawTransaction"].as_str().unwrap()).unwrap())
        .collect::<Vec<_>>();
    for round in 0..maintenance_count {
        let candidate_inputs = &raw[round].inputs[1..raw[round].inputs.len() - 1];
        assert!(candidate_inputs.len() <= 4, "Pool-FT maintenance input cap exceeded");
        if round > 0 {
            let predecessor = raw[round - 1].txid();
            assert_eq!(raw[round].inputs[0].previous_output, OutPoint { txid: predecessor.clone(), vout: 0 });
            assert_eq!(candidate_inputs[0].previous_output, OutPoint { txid: predecessor.clone(), vout: 2 });
            assert_eq!(raw[round].inputs.last().unwrap().previous_output, OutPoint { txid: predecessor, vout: 4 });
        }
    }
    let predecessor = raw[maintenance_count - 1].txid();
    let primary = &raw[maintenance_count];
    assert_eq!(primary.inputs[0].previous_output, OutPoint { txid: predecessor.clone(), vout: 0 });
    assert_eq!(primary.inputs.iter().filter(|input| input.previous_output == OutPoint { txid: predecessor.clone(), vout: 4 }).count(), 1);
    assert_eq!(primary.inputs.iter().filter(|input| input.previous_output == OutPoint { txid: predecessor, vout: 2 }).count(), 1);
    raw
}

#[test]
fn pool_ft_selection_stops_when_maintenance_successor_alone_is_sufficient() {
    let mut input = fragmented_plan_input(
        "pool-liquidity-remove.json",
        &[500_000, 480_000, 460_000, 440_000, 320_000, 300_000],
        &[10_000],
    );
    input["request"]["intent"]["lpAmount"] = json!("6000");
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));

    let planned = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&planned), ["maintenance", "primary"]);
    let candidates = pool_ft_outpoints(&input);
    let maintenance = planned_transaction(&planned, 0);
    assert_eq!(
        maintenance.inputs[1..maintenance.inputs.len() - 1]
            .iter()
            .map(|item| item.previous_output.clone())
            .collect::<Vec<_>>(),
        candidates[..4],
    );
    let primary = planned_transaction(&planned, 1);
    assert!(
        primary
            .inputs
            .iter()
            .all(|item| !candidates.contains(&item.previous_output)),
        "a sufficient merged successor must not drag external Pool-FT tails into primary"
    );

    let (finalized, stages) = complete_pool_public(&input);
    assert_eq!(stages, 2);
    assert_dependencies_follow_finalized_input_order(&planned, &finalized);
    let raw = finalized["bundle"]["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| Transaction::from_hex(item["rawTransaction"].as_str().unwrap()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(raw[1].inputs.iter().filter(|item| item.previous_output == OutPoint { txid: raw[0].txid(), vout: 2 }).count(), 1);
    assert!(raw.iter().flat_map(|transaction| &transaction.inputs).all(|item| !candidates[4..].contains(&item.previous_output)));
}

#[test]
fn pool_ft_selection_stops_after_exactly_one_sufficient_tail() {
    let mut input = fragmented_plan_input(
        "pool-liquidity-remove.json",
        &[350_000, 340_000, 330_000, 320_000, 300_000, 290_000, 285_000, 285_000],
        &[10_000],
    );
    input["request"]["intent"]["lpAmount"] = json!("6000");
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));

    let planned = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&planned), ["maintenance", "primary"]);
    let candidates = pool_ft_outpoints(&input);
    let maintenance = planned_transaction(&planned, 0);
    assert_eq!(
        maintenance.inputs[1..maintenance.inputs.len() - 1]
            .iter()
            .map(|item| item.previous_output.clone())
            .collect::<Vec<_>>(),
        candidates[..4],
    );
    let primary = planned_transaction(&planned, 1);
    let direct_tails = primary
        .inputs
        .iter()
        .map(|item| item.previous_output.clone())
        .filter(|outpoint| candidates.contains(outpoint))
        .collect::<Vec<_>>();
    assert_eq!(direct_tails, vec![candidates[4].clone()]);

    let (finalized, stages) = complete_pool_public(&input);
    assert_eq!(stages, 2);
    assert_dependencies_follow_finalized_input_order(&planned, &finalized);
    let raw = finalized["bundle"]["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| Transaction::from_hex(item["rawTransaction"].as_str().unwrap()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(raw[1].inputs.iter().filter(|item| item.previous_output == OutPoint { txid: raw[0].txid(), vout: 2 }).count(), 1);
    assert!(raw.iter().flat_map(|transaction| &transaction.inputs).all(|item| !candidates[5..].contains(&item.previous_output)));
}

#[test]
fn pool_ft_selection_shortens_the_final_maintenance_round() {
    let mut input = fragmented_plan_input(
        "pool-liquidity-remove.json",
        &[250_000, 240_000, 235_000, 230_000, 225_000, 220_000, 210_000, 200_000, 195_000, 190_000, 160_000, 145_000],
        &[10_000],
    );
    input["request"]["intent"]["lpAmount"] = json!("6000");
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));

    let planned = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&planned), ["maintenance", "maintenance", "primary"]);
    let candidates = pool_ft_outpoints(&input);
    let first = planned_transaction(&planned, 0);
    let second = planned_transaction(&planned, 1);
    assert_eq!(first.inputs[1..first.inputs.len() - 1].iter().map(|item| item.previous_output.clone()).collect::<Vec<_>>(), candidates[..4]);
    let second_pool_ft_inputs = second.inputs[1..second.inputs.len() - 1]
        .iter()
        .map(|item| item.previous_output.clone())
        .collect::<Vec<_>>();
    assert_eq!(second_pool_ft_inputs.len(), 4);
    assert_eq!(second_pool_ft_inputs[0].vout, 2);
    assert_eq!(second_pool_ft_inputs[1..], candidates[4..7]);
    let primary = planned_transaction(&planned, 2);
    assert!(primary.inputs.iter().all(|item| !candidates.contains(&item.previous_output)));
    assert_eq!(planned["plan"]["payload"]["transactions"][1]["dependsOn"], json!(["pool-ft-merge-0"]));
    assert_eq!(planned["plan"]["payload"]["transactions"][2]["dependsOn"], json!(["pool-ft-merge-1"]));

    let (finalized, stages) = complete_pool_public(&input);
    assert_eq!(stages, 3);
    assert_dependencies_follow_finalized_input_order(&planned, &finalized);
    let raw = finalized["bundle"]["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| Transaction::from_hex(item["rawTransaction"].as_str().unwrap()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(raw[1].inputs[0].previous_output, OutPoint { txid: raw[0].txid(), vout: 0 });
    assert_eq!(raw[1].inputs.last().unwrap().previous_output, OutPoint { txid: raw[0].txid(), vout: 4 });
    assert!(raw.iter().flat_map(|transaction| &transaction.inputs).all(|item| !candidates[7..].contains(&item.previous_output)));
}

#[test]
fn pool_ft_frontier_handles_thirteen_candidate_remove_and_preserves_unused() {
    let amounts = [
        192_316, 192_307, 192_307, 192_307, 192_307, 192_307, 192_307,
        192_307, 192_307, 192_307, 192_307, 192_307, 192_307,
    ];
    let mut input = fragmented_plan_input("pool-liquidity-remove.json", &amounts, &[10_000]);
    input["request"]["intent"]["lpAmount"] = json!("9000");
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));

    let planned = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&planned), ["maintenance", "maintenance", "maintenance", "primary"]);
    let candidates = pool_ft_outpoints(&input);
    let (finalized, stages) = complete_pool_public(&input);
    assert_eq!(stages, 4);
    let raw = assert_pool_ft_frontier_lineage(&planned, &finalized, 3);
    let consumed = raw
        .iter()
        .flat_map(|transaction| &transaction.inputs)
        .map(|input| input.previous_output.clone())
        .filter(|outpoint| candidates.contains(outpoint))
        .collect::<Vec<_>>();
    assert_eq!(consumed, candidates[..12]);
    assert!(raw.iter().flat_map(|transaction| &transaction.inputs).all(|input| input.previous_output != candidates[12]));
}

#[test]
fn pool_ft_frontier_handles_thirteen_candidate_close() {
    let amounts = [
        192_316, 192_307, 192_307, 192_307, 192_307, 192_307, 192_307,
        192_307, 192_307, 192_307, 192_307, 192_307, 192_307,
    ];
    let input = fragmented_plan_input("pool-liquidity-close.json", &amounts, &[10_000]);
    let planned = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&planned), ["maintenance", "maintenance", "maintenance", "maintenance", "primary"]);
    let candidates = pool_ft_outpoints(&input);
    let (finalized, stages) = complete_pool_public(&input);
    assert_eq!(stages, 5);
    let raw = assert_pool_ft_frontier_lineage(&planned, &finalized, 4);
    let consumed = raw
        .iter()
        .flat_map(|transaction| &transaction.inputs)
        .map(|input| input.previous_output.clone())
        .filter(|outpoint| candidates.contains(outpoint))
        .collect::<Vec<_>>();
    assert_eq!(consumed, candidates);
}

#[test]
fn pool_ft_frontier_handles_seventeen_candidate_tbc_to_ft_swap() {
    let amounts = [
        147_072, 147_058, 147_058, 147_058, 147_058, 147_058, 147_058, 147_058,
        147_058, 147_058, 147_058, 147_058, 147_058, 147_058, 147_058, 147_058,
        147_058,
    ];
    let mut input = fragmented_plan_input("pool-swap-tbc-for-token.json", &amounts, &[10_000]);
    input["request"]["intent"]["tbcAmount"] = json!("100000000");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    replace_native_funding(&mut input, 200_000_000);

    let planned = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&planned), ["maintenance", "maintenance", "maintenance", "maintenance", "maintenance", "primary"]);
    let candidates = pool_ft_outpoints(&input);
    let (finalized, stages) = complete_pool_public(&input);
    assert_eq!(stages, 6);
    let raw = assert_pool_ft_frontier_lineage(&planned, &finalized, 5);
    let consumed = raw
        .iter()
        .flat_map(|transaction| &transaction.inputs)
        .map(|input| input.previous_output.clone())
        .filter(|outpoint| candidates.contains(outpoint))
        .collect::<Vec<_>>();
    assert_eq!(consumed, candidates);
}

#[test]
fn fragmented_pool_ft_uses_internal_merge_before_tbc_swap() {
    let mut input = fragmented_plan_input(
        "pool-swap-tbc-for-token.json",
        &[250_000, 250_000, 250_000, 250_000, 250_000, 250_000, 250_000, 250_000, 250_000, 250_000],
        &[10_000],
    );
    input["request"]["intent"]["tbcAmount"] = json!("10000");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    let result = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&result), ["maintenance", "primary"]);
    assert_eq!(
        result["plan"]["payload"]["transactions"][1]["dependsOn"],
        json!(["pool-ft-merge-0"])
    );
}

#[test]
fn fragmented_ftlp_uses_internal_merge_before_liquidity_removal() {
    let mut input = fragmented_plan_input(
        "pool-liquidity-remove.json",
        &[2_500_000],
        &[5_000, 5_000],
    );
    input["request"]["intent"]["lpAmount"] = json!("6000");
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    let result = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&result), ["maintenance", "primary"]);
    assert_eq!(
        result["plan"]["payload"]["transactions"][1]["dependsOn"],
        json!(["ftlp-merge-0"])
    );
}

#[test]
fn seven_ftlp_candidates_stop_after_shortest_sufficient_maintenance_prefix() {
    let mut input = fragmented_plan_input_with_ftlp_total(
        "pool-liquidity-remove.json",
        &[2_500_000],
        &[2_000, 2_100, 2_200, 2_300, 2_400, 2_500, 2_600],
        16_100,
    );
    input["request"]["intent"]["lpAmount"] = json!("9000");
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));

    let planned = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&planned), ["maintenance", "primary"]);
    let transactions = planned["plan"]["payload"]["transactions"].as_array().unwrap();
    assert_eq!(transactions[0]["id"], "ftlp-merge-0");
    assert_eq!(transactions[0]["dependsOn"], json!([]));
    assert_eq!(transactions[1]["dependsOn"], json!(["ftlp-merge-0"]));
    let merge = planned_transaction(&planned, 0);
    let primary = planned_transaction(&planned, 1);
    assert_eq!(merge.inputs.len(), 5, "four sufficient FTLP candidates plus fee");
    assert_signing_task_batch(
        &planned["plan"]["payload"]["signingTasks"],
        "ftlp-merge-0",
        &merge,
        &[0, 1, 2, 3, 4],
    );
    let original_ftlp = input["snapshot"]["payload"]["utxos"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["classification"] == "ftlp")
        .map(|item| OutPoint {
            txid: item["txid"].as_str().unwrap().parse().unwrap(),
            vout: u32::try_from(item["vout"].as_u64().unwrap()).unwrap(),
        })
        .collect::<Vec<_>>();
    assert_eq!(original_ftlp.len(), 7);
    assert_eq!(
        merge.inputs[..merge.inputs.len() - 1]
            .iter()
            .filter(|item| original_ftlp.contains(&item.previous_output))
            .count(),
        4,
    );
    assert!(primary.inputs.iter().all(|item| !original_ftlp.contains(&item.previous_output)));

    let (finalized, stages) = complete_pool_public(&input);
    assert_eq!(stages, 2);
    let raw = finalized["bundle"]["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| Transaction::from_hex(item["rawTransaction"].as_str().unwrap()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(raw.len(), 2);
    assert_eq!(raw[1].inputs[1].previous_output, OutPoint { txid: raw[0].txid(), vout: 0 });
    assert_eq!(raw[1].inputs.last().unwrap().previous_output, OutPoint { txid: raw[0].txid(), vout: 2 });
    assert_dependencies_follow_finalized_input_order(&planned, &finalized);
}

#[test]
fn seven_ftlp_candidates_chain_two_rounds_when_first_merge_is_insufficient() {
    let mut input = fragmented_plan_input(
        "pool-liquidity-remove.json",
        &[2_500_000],
        &[1_000, 1_100, 1_200, 1_300, 1_400, 1_500, 2_500],
    );
    input["request"]["intent"]["lpAmount"] = json!("9000");
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));

    let result = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&result), ["maintenance", "maintenance", "primary"]);
    let transactions = result["plan"]["payload"]["transactions"].as_array().unwrap();
    assert_eq!(transactions[0]["id"], "ftlp-merge-0");
    assert_eq!(transactions[0]["dependsOn"], json!([]));
    assert_eq!(transactions[1]["id"], "ftlp-merge-1");
    assert_eq!(transactions[1]["dependsOn"], json!(["ftlp-merge-0"]));
    assert_eq!(transactions[2]["id"], "pool-liquidity-remove");
    assert_eq!(transactions[2]["dependsOn"], json!(["ftlp-merge-1"]));
    let first = planned_transaction(&result, 0);
    let second = planned_transaction(&result, 1);
    let primary = planned_transaction(&result, 2);
    let omitted_pool_input = &primary.inputs[0];
    let pool_parent_txid = omitted_pool_input.previous_output.txid.to_string();
    let pool_parents = input["snapshot"]["payload"]["parents"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|parent| parent["txid"] == pool_parent_txid)
        .collect::<Vec<_>>();
    assert_eq!(pool_parents.len(), 1, "Pool covenant parent must resolve uniquely");
    let pool_parent = Transaction::from_hex(pool_parents[0]["rawTransaction"].as_str().unwrap()).unwrap();
    let pool_vout = usize::try_from(omitted_pool_input.previous_output.vout).unwrap();
    assert_eq!(pool_vout, 0);
    assert!(
        tbc_sdk::contracts::pool_nft_v2::scripts::pool_code_source_outpoint(
            &pool_parent.outputs[pool_vout].script_pubkey,
        )
        .is_ok(),
        "unsigned primary input 0 must spend the authenticated Pool covenant",
    );
    PoolState::from_v2_tape(
        &pool_parent.outputs[pool_vout + 1].script_pubkey,
        POOL_PROVIDER.to_owned(),
    )
    .expect("Pool covenant input must retain its adjacent authenticated Pool Tape");
    assert_signing_task_batch(
        &result["plan"]["payload"]["signingTasks"],
        "ftlp-merge-0",
        &first,
        &[0, 1, 2, 3, 4, 5],
    );

    assert_eq!(first.inputs.len(), 6, "five FTLP inputs plus fee");
    assert_eq!(second.inputs.len(), 3, "prior FTLP successor, shortest sufficient tail, fee change");
    assert_eq!(
        second.inputs[0].previous_output,
        OutPoint { txid: Txid::from_le_bytes([0; 32]), vout: 0 },
    );
    assert_eq!(
        second.inputs.last().unwrap().previous_output,
        OutPoint { txid: Txid::from_le_bytes([0; 32]), vout: 2 },
    );
    assert_eq!(
        primary.inputs[1].previous_output,
        OutPoint { txid: Txid::from_le_bytes([0; 32]), vout: 0 },
    );
    assert_eq!(
        primary.inputs.last().unwrap().previous_output,
        OutPoint { txid: Txid::from_le_bytes([0; 32]), vout: 2 },
    );
    assert_no_reused_plan_outpoints(&result);
    let mut finalize = pool_finalize_input(&input, &result);
    let first_signatures = finalize["signatures"].clone();
    let first_stage = call_ok(EngineMethod::Finalize, &finalize);
    assert!(first_stage.get("bundle").is_none());
    assert_signing_task_batch(
        &first_stage["signingRequests"],
        "ftlp-merge-1",
        &second,
        &[0, 1, 2],
    );
    let mut reused_first_batch = finalize.clone();
    reused_first_batch["continuation"] = first_stage["continuation"].clone();
    reused_first_batch["signatures"] = first_signatures;
    assert_eq!(call(EngineMethod::Finalize, &reused_first_batch)["ok"], false);
    finalize["continuation"] = first_stage["continuation"].clone();
    finalize["signatures"] = sign_tasks(&first_stage["signingRequests"]);

    let second_signatures = finalize["signatures"].clone();
    let second_stage = call_ok(EngineMethod::Finalize, &finalize);
    assert!(second_stage.get("bundle").is_none());
    assert_signing_task_batch(
        &second_stage["signingRequests"],
        "pool-liquidity-remove",
        &primary,
        &[1, 2, 3],
    );
    let mut reused_second_batch = finalize.clone();
    reused_second_batch["continuation"] = second_stage["continuation"].clone();
    reused_second_batch["signatures"] = second_signatures;
    assert_eq!(call(EngineMethod::Finalize, &reused_second_batch)["ok"], false);
    finalize["continuation"] = second_stage["continuation"].clone();
    finalize["signatures"] = sign_tasks(&second_stage["signingRequests"]);

    let finalized = call_ok(EngineMethod::Finalize, &finalize);
    let bundle = finalized["bundle"]["transactions"].as_array().unwrap();
    assert_eq!(bundle.len(), 3);
    let first_finalized = Transaction::from_hex(bundle[0]["rawTransaction"].as_str().unwrap()).unwrap();
    let second_finalized = Transaction::from_hex(bundle[1]["rawTransaction"].as_str().unwrap()).unwrap();
    let primary_finalized = Transaction::from_hex(bundle[2]["rawTransaction"].as_str().unwrap()).unwrap();
    assert_eq!(second_finalized.inputs[0].previous_output, OutPoint { txid: first_finalized.txid(), vout: 0 });
    assert_eq!(second_finalized.inputs.last().unwrap().previous_output, OutPoint { txid: first_finalized.txid(), vout: 2 });
    assert_eq!(primary_finalized.inputs[1].previous_output, OutPoint { txid: second_finalized.txid(), vout: 0 });
    assert_eq!(primary_finalized.inputs.last().unwrap().previous_output, OutPoint { txid: second_finalized.txid(), vout: 2 });
    assert!(primary_finalized.inputs.iter().all(|input| input.previous_output.txid != first_finalized.txid()));
}

#[test]
fn two_ftlp_rounds_then_pool_ft_maintenance_use_distinct_stages() {
    let mut input = fragmented_plan_input(
        "pool-liquidity-remove.json",
        &[416_666, 416_666, 416_666, 416_666, 416_668, 416_668],
        &[1_000, 1_100, 1_200, 1_300, 1_400, 1_500, 2_500],
    );
    input["request"]["intent"]["lpAmount"] = json!("9000");
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));

    let planned = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&planned), ["maintenance", "maintenance", "maintenance", "primary"]);
    let transactions = planned["plan"]["payload"]["transactions"].as_array().unwrap();
    assert_eq!(transactions[0]["id"], "ftlp-merge-0");
    assert_eq!(transactions[1]["id"], "ftlp-merge-1");
    assert_eq!(transactions[1]["dependsOn"], json!(["ftlp-merge-0"]));
    assert_eq!(transactions[2]["id"], "pool-ft-merge-0");
    assert_eq!(transactions[2]["dependsOn"], json!(["ftlp-merge-1"]));
    assert_eq!(transactions[3]["id"], "pool-liquidity-remove");

    let (finalized, stages) = complete_pool_public(&input);
    assert_eq!(stages, 4);
    let raw = finalized["bundle"]["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| Transaction::from_hex(item["rawTransaction"].as_str().unwrap()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(raw.len(), 4);
    assert_eq!(raw[1].inputs[0].previous_output, OutPoint { txid: raw[0].txid(), vout: 0 });
    assert_eq!(raw[1].inputs.last().unwrap().previous_output, OutPoint { txid: raw[0].txid(), vout: 2 });
    assert_eq!(raw[2].inputs.last().unwrap().previous_output, OutPoint { txid: raw[1].txid(), vout: 2 });
    assert!(raw[3].inputs.iter().any(|item| item.previous_output.txid == raw[1].txid()));
    assert!(raw[3].inputs.iter().any(|item| item.previous_output.txid == raw[2].txid()));
    assert_dependencies_follow_finalized_input_order(&planned, &finalized);
}

fn assert_no_reused_plan_outpoints(result: &Value) {
    let transactions = result["plan"]["payload"]["transactions"].as_array().unwrap();
    let mut external = std::collections::BTreeSet::new();
    for transaction in transactions {
        let raw = Transaction::from_hex(transaction["unsignedTransaction"].as_str().unwrap()).unwrap();
        for input in raw.inputs {
            if input.previous_output.txid != Txid::from_le_bytes([0; 32]) {
                assert!(
                    external.insert((
                        input.previous_output.txid.to_string(),
                        input.previous_output.vout,
                    )),
                    "external outpoint reused: {:?}",
                    input.previous_output
                );
            }
        }
    }
}

fn mutate_unsigned(transaction: &mut Value, mutation: impl FnOnce(&mut Transaction)) {
    let mut raw = Transaction::from_hex(transaction["unsignedTransaction"].as_str().unwrap()).unwrap();
    mutation(&mut raw);
    transaction["unsignedTransaction"] = json!(raw.to_hex());
}

#[test]
fn simultaneous_pool_ft_and_ftlp_maintenance_is_one_three_stage_lineage() {
    let mut input = fragmented_plan_input(
        "pool-liquidity-remove.json",
        &[416_666, 416_666, 416_666, 416_666, 416_668, 416_668],
        &[5_000, 5_000],
    );
    input["request"]["intent"]["lpAmount"] = json!("6000");
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    let result = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&result), ["maintenance", "maintenance", "primary"]);
    let transactions = result["plan"]["payload"]["transactions"].as_array().unwrap();
    assert_eq!(transactions[0]["id"], "ftlp-merge-0");
    assert_eq!(transactions[0]["dependsOn"], json!([]));
    assert_eq!(transactions[1]["id"], "pool-ft-merge-0");
    assert_eq!(transactions[1]["dependsOn"], json!(["ftlp-merge-0"]));
    assert_eq!(
        transactions[2]["dependsOn"],
        json!(["pool-ft-merge-0", "ftlp-merge-0"])
    );
    assert_no_reused_plan_outpoints(&result);
    let ftlp_merge = planned_transaction(&result, 0);
    let pool_ft_merge = planned_transaction(&result, 1);
    let primary = planned_transaction(&result, 2);
    let placeholder = Txid::from_le_bytes([0; 32]);
    assert_eq!(
        pool_ft_merge.inputs.last().unwrap().previous_output,
        OutPoint {
            txid: placeholder.clone(),
            vout: u32::try_from(ftlp_merge.outputs.len() - 1).unwrap(),
        }
    );
    assert_eq!(primary.inputs[0].previous_output, OutPoint { txid: placeholder.clone(), vout: 0 });
    assert_eq!(primary.inputs[1].previous_output, OutPoint { txid: placeholder.clone(), vout: 0 });
    assert_eq!(primary.inputs[2].previous_output, OutPoint { txid: placeholder.clone(), vout: 2 });
    assert_eq!(
        primary.inputs.last().unwrap().previous_output,
        OutPoint {
            txid: placeholder,
            vout: u32::try_from(pool_ft_merge.outputs.len() - 1).unwrap(),
        }
    );
    let planned_outpoints = [
        ("ftlp-merge-0", ftlp_merge.outputs.len() - 1),
        ("pool-ft-merge-0", 0),
        ("ftlp-merge-0", 0),
        ("pool-ft-merge-0", 2),
        ("pool-ft-merge-0", pool_ft_merge.outputs.len() - 1),
    ];
    assert_eq!(
        planned_outpoints.iter().collect::<std::collections::BTreeSet<_>>().len(),
        planned_outpoints.len(),
        "planned maintenance lineage reuses an outpoint"
    );

    for mutation in ["missing-dependency", "reordered-dependency", "wrong-vout", "wrong-parent", "funding-reuse", "extra-maintenance"] {
        let mut changed = result.clone();
        let txs = changed["plan"]["payload"]["transactions"].as_array_mut().unwrap();
        match mutation {
            "missing-dependency" => txs[2]["dependsOn"] = json!(["pool-ft-merge-0"]),
            "reordered-dependency" => {
                txs[2]["dependsOn"] = json!(["ftlp-merge-0", "pool-ft-merge-0"])
            }
            "wrong-vout" => {
                mutate_unsigned(&mut txs[2], |raw| raw.inputs[2].previous_output.vout = 1);
            }
            "wrong-parent" => {
                mutate_unsigned(&mut txs[2], |raw| {
                    raw.inputs[0].previous_output.txid = Txid::from_le_bytes([0x44; 32]);
                });
            }
            "funding-reuse" => {
                let first = Transaction::from_hex(txs[0]["unsignedTransaction"].as_str().unwrap()).unwrap();
                let funding = first.inputs.last().unwrap().previous_output.clone();
                mutate_unsigned(&mut txs[1], |raw| {
                    raw.inputs.last_mut().unwrap().previous_output = funding;
                });
            }
            "extra-maintenance" => {
                let mut extra = txs[0].clone();
                extra["id"] = json!("ftlp-merge-extra");
                txs.insert(1, extra);
            }
            _ => unreachable!(),
        }
        if mutation == "reordered-dependency" {
            changed["plan"]["planHash"] = json!(canonical_hash(&changed["plan"]["payload"]));
            let rejected = call(
                EngineMethod::Finalize,
                &pool_finalize_input(&input, &changed),
            );
            assert_eq!(rejected["ok"], false, "reordered dependency was accepted");
            assert_eq!(rejected["error"]["code"], "INVALID_PLAN", "{rejected}");
            assert_eq!(
                rejected["error"]["message"],
                "execution plan differs from deterministic planning output",
                "{rejected}",
            );
            assert_eq!(rejected["error"]["path"], "plan", "{rejected}");
            continue;
        }
        let validation = validation_for_plan(input.clone(), &changed);
        assert!(!validation["violations"].as_array().unwrap().is_empty(), "{mutation} was accepted");
    }

    let (finalized, stages) = complete_pool_public(&input);
    assert_eq!(stages, 3);
    assert_dependencies_follow_finalized_input_order(&result, &finalized);
    let transactions = finalized["bundle"]["transactions"]
        .as_array()
        .expect("finalized transactions");
    assert_eq!(transactions.len(), 3);
    assert_eq!(transactions.last().unwrap()["role"], "primary");
}

#[test]
fn pool_ft_candidate_count_alone_does_not_trigger_maintenance() {
    let mut direct = fragmented_plan_input_with_totals(
        "pool-liquidity-remove.json",
        &[500_000, 500_000, 500_000, 500_000, 500_000],
        &[10_000],
        2_500_000,
        10_000,
    );
    direct["request"]["intent"]["lpAmount"] = json!("6000");
    direct["request"]["intent"]["minimumTbcAmount"] = json!("1");
    direct["request"]["intent"]["minimumFtAmount"] = json!("1");
    direct["requestHash"] = json!(canonical_hash(&direct["request"]));
    assert_eq!(roles(&call_ok(EngineMethod::Plan, &direct)), ["primary"]);
}

#[test]
fn maintenance_templates_match_pinned_offsets_sequences_locks_and_required_change() {
    let mut fragmented = fragmented_plan_input(
        "pool-liquidity-remove.json",
        &[416_666, 416_666, 416_666, 416_666, 416_668, 416_668],
        &[10_000],
    );
    fragmented["request"]["intent"]["lpAmount"] = json!("6000");
    fragmented["request"]["intent"]["minimumTbcAmount"] = json!("1");
    fragmented["request"]["intent"]["minimumFtAmount"] = json!("1");
    fragmented["requestHash"] = json!(canonical_hash(&fragmented["request"]));
    let planned = call_ok(EngineMethod::Plan, &fragmented);
    let merge = planned_transaction(&planned, 0);
    let tape = merge.outputs[3].script_pubkey.as_bytes();
    assert_eq!(&tape[3..11], &[0; 8], "Pool input must retain Tape source slot zero");
    assert!(tape[11..43].iter().any(|byte| *byte != 0));
    assert_eq!(merge.outputs.len(), 5, "Pool-FT maintenance change must be fixed at vout 4");
    assert!(merge.outputs[4].satoshis >= tbc_sdk::SDK_DUST_SAT);

    let mut coin =
        fragmented_coin_plan_input(&[416_666, 416_666, 416_666, 416_666, 416_668, 416_668]);
    coin["request"]["intent"]["lpAmount"] = json!("6000");
    coin["request"]["intent"]["minimumTbcAmount"] = json!("1");
    coin["request"]["intent"]["minimumFtAmount"] = json!("1");
    coin["requestHash"] = json!(canonical_hash(&coin["request"]));
    let coin_plan = call_ok(EngineMethod::Plan, &coin);
    let coin_merge = planned_transaction(&coin_plan, 0);
    assert!(coin_merge.inputs[1..coin_merge.inputs.len() - 1]
        .iter()
        .all(|input| input.sequence == 0xffff_fffe));

    let locked = locked_fragmented_plan_input(&[5_000, 5_000], &[799_900, 799_900]);
    let locked_plan = call_ok(EngineMethod::Plan, &locked);
    let locked_merge = planned_transaction(&locked_plan, 0);
    assert_eq!(locked_merge.lock_time, 800_000);
    assert!(locked_merge.inputs[..2]
        .iter()
        .all(|input| input.sequence == 0xffff_fffe));
    assert_eq!(locked_merge.outputs.len(), 3, "FTLP maintenance change must be fixed at vout 2");

    let normal_change = merge.outputs[4].satoshis;
    assert!(normal_change >= tbc_sdk::SDK_DUST_SAT);
    let mut missing_change = planned.clone();
    mutate_unsigned(
        &mut missing_change["plan"]["payload"]["transactions"][0],
        |raw| {
            assert_eq!(raw.outputs.len(), 5, "Pool-FT maintenance requires fixed vout 4");
            let removed = raw.outputs.pop().expect("maintenance fee-change output");
            assert_eq!(removed.satoshis, normal_change);
        },
    );
    missing_change["plan"]["planHash"] =
        json!(canonical_hash(&missing_change["plan"]["payload"]));
    let rejected = validation_for_plan(fragmented, &missing_change);
    assert_eq!(rejected["valid"], false, "missing fixed fee change was accepted");
    assert!(!rejected["violations"].as_array().unwrap().is_empty());
}

#[test]
fn locked_ftlp_maintenance_uses_zero_height_successor_tape_and_rejects_mutation() {
    let input = locked_fragmented_plan_input(&[5_000, 5_000], &[799_900, 799_900]);
    let planned = call_ok(EngineMethod::Plan, &input);
    let merge = planned_transaction(&planned, 0);
    let (merged_slots, _) = build_tape_amount(10_000, &[5_000, 5_000]).unwrap();
    let expected_base = ftlp_tape(&FtlpTapeParams {
        amount_raw: 0,
        layout: FtlpTapeLayout::LockTime {
            lock_time: 0,
            source_ft_tape_size: material().ft_contract.outputs[1]
                .script_pubkey
                .as_bytes()
                .len(),
        },
    })
    .unwrap();
    let expected = transfer_tape_script(&expected_base, &merged_slots).unwrap();
    assert_eq!(merge.outputs[1].script_pubkey, expected);

    let wrong_base = ftlp_tape(&FtlpTapeParams {
        amount_raw: 0,
        layout: FtlpTapeLayout::LockTime {
            lock_time: 799_900,
            source_ft_tape_size: material().ft_contract.outputs[1]
                .script_pubkey
                .as_bytes()
                .len(),
        },
    })
    .unwrap();
    let wrong = transfer_tape_script(&wrong_base, &merged_slots).unwrap();
    let mut mutated = planned.clone();
    mutate_unsigned(&mut mutated["plan"]["payload"]["transactions"][0], |raw| {
        raw.outputs[1].script_pubkey = wrong;
    });
    mutated["plan"]["planHash"] = json!(canonical_hash(&mutated["plan"]["payload"]));
    let rejected = validation_for_plan(input, &mutated);
    assert_eq!(rejected["valid"], false, "non-pinned locked successor Tape was accepted");
}

#[test]
fn locked_seven_ftlp_candidates_finalize_two_zero_height_successor_rounds() {
    let mut input = locked_fragmented_plan_input(
        &[1_000, 1_100, 1_200, 1_300, 1_400, 1_500, 2_500],
        &[799_900, 799_900, 799_900, 799_900, 799_900, 799_900, 799_900],
    );
    input["request"]["intent"]["lpAmount"] = json!("8000");
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    let planned = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&planned), ["maintenance", "maintenance", "primary"]);
    let transactions = planned["plan"]["payload"]["transactions"].as_array().unwrap();
    assert_eq!(transactions[0]["id"], "ftlp-merge-0");
    assert_eq!(transactions[0]["dependsOn"], json!([]));
    assert_eq!(transactions[1]["id"], "ftlp-merge-1");
    assert_eq!(transactions[1]["dependsOn"], json!(["ftlp-merge-0"]));
    assert_eq!(transactions[2]["dependsOn"], json!(["ftlp-merge-1"]));
    let first = planned_transaction(&planned, 0);
    let second = planned_transaction(&planned, 1);
    assert_eq!(first.lock_time, 800_000);
    assert_eq!(second.lock_time, 800_000);
    assert_eq!(first.inputs.len(), 6, "five FTLP candidates plus fee");
    assert_eq!(second.inputs.len(), 3, "successor, shortest sufficient tail, fee change");

    let (finalized, stages) = complete_pool_public(&input);
    assert_eq!(stages, 3);
    let raw = finalized["bundle"]["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| Transaction::from_hex(item["rawTransaction"].as_str().unwrap()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(raw.len(), 3);
    assert_eq!(raw[1].inputs[0].previous_output, OutPoint { txid: raw[0].txid(), vout: 0 });
    assert_eq!(raw[1].inputs.last().unwrap().previous_output, OutPoint { txid: raw[0].txid(), vout: 2 });
    assert_eq!(raw[2].inputs[1].previous_output, OutPoint { txid: raw[1].txid(), vout: 0 });
    assert_eq!(raw[2].inputs.last().unwrap().previous_output, OutPoint { txid: raw[1].txid(), vout: 2 });
    assert_dependencies_follow_finalized_input_order(&planned, &finalized);
}

#[test]
fn pool_amount_limits_ignore_unrelated_contracts() {
    let mut input = plan_input("pool-swap-token-for-tbc.json");
    input["policy"]["payload"]["amountLimits"] = json!([{
        "scope": "ft-total",
        "contractId": "11".repeat(32),
        "maximum": "1"
    }]);
    input["policy"]["policyHash"] = json!(canonical_hash(&input["policy"]["payload"]));
    assert_eq!(call(EngineMethod::Plan, &input)["ok"], true);
}

#[test]
fn pool_amount_limits_do_not_apply_new_tbc20_profile_to_legacy_ft() {
    let mut input = plan_input("pool-swap-token-for-tbc.json");
    let baseline = call_ok(EngineMethod::Plan, &input);
    input["policy"]["payload"]["amountLimits"] = json!([
        { "scope": "ft-total", "protocolVersion": "tbc20", "maximum": "1" },
        { "scope": "ft-slot", "protocolVersion": "tbc20", "maximum": "1" }
    ]);
    input["policy"]["policyHash"] = json!(canonical_hash(&input["policy"]["payload"]));
    let result = call_ok(EngineMethod::Plan, &input);
    assert_eq!(result["plan"]["payload"]["transactions"], baseline["plan"]["payload"]["transactions"]);
    assert_eq!(result["plan"]["payload"]["signingTasks"], baseline["plan"]["payload"]["signingTasks"]);
}

fn assert_pool_amount_limit_rejected(input: &Value, path: &str) {
    let result = call(EngineMethod::Plan, input);
    assert_eq!(result["ok"], false, "Pool amount limit was accepted: {result}");
    assert_eq!(result["error"]["code"], "INVALID_INPUT", "{result}");
    assert_eq!(
        result["error"]["message"],
        "Pool amount exceeds authenticated policy limit",
        "{result}"
    );
    assert_eq!(result["error"]["path"], path, "{result}");
}

#[test]
fn pool_amount_limits_cover_create_initialized_pool_state_value() {
    let mut input = plan_input("pool-create.json");
    input["policy"]["payload"]["amountLimits"] = json!([{
        "scope": "pool-state",
        "maximum": "10999"
    }]);
    input["policy"]["policyHash"] = json!(canonical_hash(&input["policy"]["payload"]));
    assert_eq!(call(EngineMethod::Plan, &input)["error"]["code"], "UNSUPPORTED_INTENT");
}

#[test]
fn pool_amount_limits_cover_derived_liquidity_add_ft() {
    let mut input = plan_input("pool-liquidity-add.json");
    let contract_id = input["snapshot"]["payload"]["contracts"][0]["contractId"].clone();
    input["policy"]["payload"]["amountLimits"] = json!([{
        "scope": "ft-total",
        "contractId": contract_id,
        "maximum": "249999"
    }]);
    input["policy"]["policyHash"] = json!(canonical_hash(&input["policy"]["payload"]));
    assert_pool_amount_limit_rejected(&input, "request.intent.tbcAmount");
}

#[test]
fn pool_amount_limits_cover_implicit_close_lp() {
    let mut input = plan_input("pool-liquidity-close.json");
    let contract_id = input["request"]["intent"]["poolContractId"].clone();
    input["policy"]["payload"]["amountLimits"] = json!([{
        "scope": "lp-slot",
        "contractId": contract_id,
        "maximum": "9999"
    }]);
    input["policy"]["policyHash"] = json!(canonical_hash(&input["policy"]["payload"]));
    assert_pool_amount_limit_rejected(&input, "request.intent.lpAmount");
}

#[test]
fn pool_amount_limits_cover_successor_pool_state_value() {
    let mut input = plan_input("pool-liquidity-add.json");
    let contract_id = input["request"]["intent"]["poolContractId"].clone();
    input["policy"]["payload"]["amountLimits"] = json!([{
        "scope": "pool-state",
        "contractId": contract_id,
        "maximum": "11000"
    }]);
    input["policy"]["policyHash"] = json!(canonical_hash(&input["policy"]["payload"]));
    assert_pool_amount_limit_rejected(&input, "request.intent.poolContractId");
}

#[test]
fn standard_ftlp_merge_caps_each_round_at_five_inputs() {
    let mut input = fragmented_plan_input(
        "pool-liquidity-remove.json",
        &[2_500_000],
        &[1_500, 1_500, 1_500, 1_500, 1_500, 2_500],
    );
    input["request"]["intent"]["lpAmount"] = json!("9000");
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    let result = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&result), ["maintenance", "maintenance", "primary"]);
    let transactions = result["plan"]["payload"]["transactions"].as_array().unwrap();
    assert_eq!(transactions[0]["id"], "ftlp-merge-0");
    assert_eq!(transactions[0]["dependsOn"], json!([]));
    assert_eq!(transactions[1]["id"], "ftlp-merge-1");
    assert_eq!(transactions[1]["dependsOn"], json!(["ftlp-merge-0"]));
    assert_eq!(transactions[2]["dependsOn"], json!(["ftlp-merge-1"]));

    let first = planned_transaction(&result, 0);
    let second = planned_transaction(&result, 1);
    let primary = planned_transaction(&result, 2);
    let first_candidate_inputs = &first.inputs[..first.inputs.len() - 1];
    let second_candidate_inputs = &second.inputs[..second.inputs.len() - 1];
    assert_eq!(first_candidate_inputs.len(), 5);
    assert!(first_candidate_inputs.len() <= 5);
    assert_eq!(second_candidate_inputs.len(), 2);
    assert!(second_candidate_inputs.len() <= 5);

    let expected_candidates = input["snapshot"]["payload"]["utxos"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|utxo| utxo["classification"] == "ftlp")
        .map(|utxo| {
            (
                utxo["txid"].as_str().unwrap().to_owned(),
                u32::try_from(utxo["vout"].as_u64().unwrap()).unwrap(),
            )
        })
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(expected_candidates.len(), 6);
    let mut consumed_candidates = first_candidate_inputs
        .iter()
        .map(|candidate| {
            (
                candidate.previous_output.txid.to_string(),
                candidate.previous_output.vout,
            )
        })
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(second_candidate_inputs[0].previous_output, OutPoint { txid: Txid::from_le_bytes([0; 32]), vout: 0 });
    consumed_candidates.insert((
        second_candidate_inputs[1].previous_output.txid.to_string(),
        second_candidate_inputs[1].previous_output.vout,
    ));
    assert_eq!(consumed_candidates, expected_candidates);
    assert_eq!(second.inputs.last().unwrap().previous_output, OutPoint { txid: Txid::from_le_bytes([0; 32]), vout: 2 });
    assert_eq!(primary.inputs[1].previous_output, OutPoint { txid: Txid::from_le_bytes([0; 32]), vout: 0 });
    assert_eq!(primary.inputs.last().unwrap().previous_output, OutPoint { txid: Txid::from_le_bytes([0; 32]), vout: 2 });
    assert_no_reused_plan_outpoints(&result);

    let (finalized, stages) = complete_pool_public(&input);
    assert_eq!(stages, 3);
    let bundle = finalized["bundle"]["transactions"].as_array().unwrap();
    let first_finalized = Transaction::from_hex(bundle[0]["rawTransaction"].as_str().unwrap()).unwrap();
    let second_finalized = Transaction::from_hex(bundle[1]["rawTransaction"].as_str().unwrap()).unwrap();
    let primary_finalized = Transaction::from_hex(bundle[2]["rawTransaction"].as_str().unwrap()).unwrap();
    assert_eq!(second_finalized.inputs[0].previous_output, OutPoint { txid: first_finalized.txid(), vout: 0 });
    assert_eq!(second_finalized.inputs.last().unwrap().previous_output, OutPoint { txid: first_finalized.txid(), vout: 2 });
    assert_eq!(primary_finalized.inputs[1].previous_output, OutPoint { txid: second_finalized.txid(), vout: 0 });
    assert_eq!(primary_finalized.inputs.last().unwrap().previous_output, OutPoint { txid: second_finalized.txid(), vout: 2 });
    assert!(primary_finalized.inputs.iter().all(|item| item.previous_output.txid != first_finalized.txid()));
}

#[test]
fn pool_selection_authenticates_all_candidates_and_uses_sufficient_descending_prefix() {
    let direct = fragmented_plan_input(
        "pool-liquidity-remove.json",
        &[70_000, 70_000, 70_000, 70_000, 2_220_000],
        &[10_000],
    );
    let direct_result = call_ok(EngineMethod::Plan, &direct);
    assert_eq!(roles(&direct_result), ["primary"]);
    let candidate_outpoints = direct["snapshot"]["payload"]["utxos"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["classification"] == "pool-ft")
        .map(|item| {
            OutPoint {
                txid: item["txid"].as_str().unwrap().parse().unwrap(),
                vout: item["vout"].as_u64().unwrap() as u32,
            }
        })
        .collect::<Vec<_>>();
    let selected_pool_ft = planned_transaction(&direct_result, 0)
        .inputs
        .into_iter()
        .filter(|input| candidate_outpoints.contains(&input.previous_output))
        .map(|input| input.previous_output)
        .collect::<Vec<_>>();
    assert_eq!(
        selected_pool_ft.len(),
        1,
        "the Engine deliberately permits one authenticated candidate when sufficient, reducing one input relative to tbc-contract@1.6.6 fetchFtUTXOsforPool without changing protocol semantics"
    );
    assert_eq!(selected_pool_ft[0], candidate_outpoints[4]);

    let single = fragmented_plan_input(
        "pool-liquidity-remove.json",
        &[2_500_000],
        &[10_000],
    );
    let single_result = call_ok(EngineMethod::Plan, &single);
    assert_eq!(roles(&single_result), ["primary"]);
    assert_eq!(
        planned_transaction(&single_result, 0).inputs.len(),
        4,
        "one available sufficient Pool-held FT candidate remains a valid direct selection"
    );

    for mutation in ["pool-ft-code", "pool-ft-tape"] {
        let mut changed = direct.clone();
        let current_txid = changed["snapshot"]["payload"]["contracts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["family"] == "pool")
            .unwrap()["currentOutpoint"]["txid"]
            .as_str()
            .unwrap();
        let mut current = changed["snapshot"]["payload"]["parents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["txid"] == current_txid)
            .map(|item| Transaction::from_hex(item["rawTransaction"].as_str().unwrap()).unwrap())
            .unwrap();
        if mutation == "pool-ft-code" {
            current.outputs[2].script_pubkey = Script::from_bytes(vec![0x51]);
        } else {
            current.outputs[3].script_pubkey = ftlp_tape(&FtlpTapeParams {
                amount_raw: 70_000,
                layout: FtlpTapeLayout::Standard {
                    decimal: 6,
                    name: "Wrong Family",
                    symbol: "BAD",
                    is_coin: false,
                },
            })
            .unwrap();
        }
        replace_current_parent(&mut changed, current);
        assert_eq!(call(EngineMethod::Plan, &changed)["ok"], false, "{mutation} was accepted");
    }

    let invalid_locked = locked_fragmented_plan_input(&[1_000, 9_000], &[500_000_001, 799_900]);
    assert_eq!(call(EngineMethod::Plan, &invalid_locked)["ok"], false);
}

#[test]
fn operations_without_pool_held_ft_policy_do_not_emit_pool_ft_maintenance() {
    for name in ["pool-liquidity-add.json", "pool-swap-token-for-tbc.json"] {
        let input = fragmented_plan_input(
            name,
            &[70_000, 70_000, 70_000, 70_000, 2_220_000],
            &[10_000],
        );
        assert_eq!(roles(&call_ok(EngineMethod::Plan, &input)), ["primary"], "{name}");
    }
}

#[test]
fn repeated_pool_ft_rounds_chain_pool_and_fee_successors_without_reuse() {
    let mut input = fragmented_plan_input(
        "pool-liquidity-remove.json",
        &[312_500, 312_500, 312_500, 312_500, 312_500, 312_500, 312_500, 312_500],
        &[10_000],
    );
    input["request"]["intent"]["lpAmount"] = json!("9000");
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    let result = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&result), ["maintenance", "maintenance", "primary"]);
    let txs = result["plan"]["payload"]["transactions"].as_array().unwrap();
    assert_eq!(txs[0]["id"], "pool-ft-merge-0");
    assert_eq!(txs[1]["id"], "pool-ft-merge-1");
    assert_eq!(txs[1]["dependsOn"], json!(["pool-ft-merge-0"]));
    assert_eq!(txs[2]["dependsOn"], json!(["pool-ft-merge-1"]));
    let first = planned_transaction(&result, 0);
    let second = planned_transaction(&result, 1);
    let primary = planned_transaction(&result, 2);
    let planned = Txid::from_le_bytes([0; 32]);
    assert_eq!(first.outputs.len(), 5);
    assert_eq!(second.outputs.len(), 5);
    assert_eq!(second.inputs[0].previous_output, OutPoint { txid: planned.clone(), vout: 0 });
    assert_eq!(second.inputs[1].previous_output, OutPoint { txid: planned.clone(), vout: 2 });
    assert_eq!(second.inputs.last().unwrap().previous_output, OutPoint { txid: planned.clone(), vout: 4 });
    assert_eq!(primary.inputs[0].previous_output, OutPoint { txid: planned.clone(), vout: 0 });
    assert_eq!(primary.inputs.last().unwrap().previous_output, OutPoint { txid: planned, vout: 4 });
    assert_no_reused_plan_outpoints(&result);
    let (finalized, stages) = complete_pool_public(&input);
    assert_eq!(stages, 3);
    assert_dependencies_follow_finalized_input_order(&result, &finalized);
    assert_eq!(finalized["bundle"]["transactions"].as_array().unwrap().last().unwrap()["role"], "primary");
}

#[test]
fn pool_policy_rates_amount_limits_field_isolation_and_key_cap_fail_closed() {
    for (plan, rate) in [(1, 35), (2, 35), (3, 135), (4, 335), (5, 535), (6, 330)] {
        let mut accepted = plan_input("pool-create.json");
        accepted["request"]["intent"]["lpPlan"] = json!(plan);
        accepted["policy"]["payload"]["pool"]["lpPlan"] = json!(plan);
        accepted["policy"]["payload"]["pool"]["serviceFeeRate"] = json!(rate);
        accepted["requestHash"] = json!(canonical_hash(&accepted["request"]));
        accepted["policy"]["policyHash"] = json!(canonical_hash(&accepted["policy"]["payload"]));
        assert_eq!(call(EngineMethod::Plan, &accepted)["error"]["code"], "UNSUPPORTED_INTENT", "historical plan {plan} rate {rate} must not reenable issuance");
        accepted["policy"]["payload"]["pool"]["serviceFeeRate"] = json!(rate + 1);
        accepted["policy"]["policyHash"] = json!(canonical_hash(&accepted["policy"]["payload"]));
        assert_eq!(call(EngineMethod::Plan, &accepted)["ok"], false, "plan {plan} accepted wrong rate");
    }

    for (fixture, scope, maximum) in [
        ("pool-liquidity-add.json", "native", "999"),
        ("pool-swap-token-for-tbc.json", "ft-total", "249999"),
        ("pool-liquidity-remove.json", "lp-slot", "999"),
    ] {
        let mut limited = plan_input(fixture);
        let contract_id = if scope == "ft-total" {
            limited["snapshot"]["payload"]["contracts"][0]["contractId"].clone()
        } else if scope == "lp-slot" {
            limited["request"]["intent"]["poolContractId"].clone()
        } else {
            Value::Null
        };
        let mut limit = json!({"scope":scope, "maximum":maximum});
        if !contract_id.is_null() {
            limit["contractId"] = contract_id;
        }
        limited["policy"]["payload"]["amountLimits"] = json!([limit]);
        limited["policy"]["policyHash"] = json!(canonical_hash(&limited["policy"]["payload"]));
        assert_eq!(call(EngineMethod::Plan, &limited)["ok"], false, "{fixture} ignored {scope}");
    }

    let pool = plan_input("pool-liquidity-add.json");
    for (field, value) in [
        ("to", json!(OWNER)),
        ("amount", json!("1")),
        ("contractId", json!("11".repeat(32))),
    ] {
        let mut changed = pool.clone();
        changed["request"]["intent"][field] = value;
        assert_eq!(call(EngineMethod::NormalizeRequest, &normalize_input(&changed))["ok"], false);
    }

    let transfer = serde_json::from_str::<Value>(include_str!("../../../fixtures/tbc-transfer.json"))
        .unwrap()["planInput"]
        .clone();
    for (field, value) in [
        ("poolContractId", json!("11".repeat(32))),
        ("lpPlan", json!(1)),
        ("serviceProviderTag", json!(POOL_PROVIDER)),
        ("tbcAmount", json!("1")),
        ("lockUntilHeight", json!("800100")),
    ] {
        let mut changed = transfer.clone();
        changed["request"]["intent"][field] = value;
        assert_eq!(call(EngineMethod::NormalizeRequest, &normalize_input(&changed))["ok"], false);
    }

    let secp = Secp256k1::new();
    let keys = (1u8..=11)
        .map(|value| {
            let mut bytes = [0u8; 32];
            bytes[31] = value;
            encode_hex(&secp256k1::PublicKey::from_secret_key(
                &secp,
                &SecretKey::from_byte_array(bytes).unwrap(),
            )
            .serialize())
        })
        .collect::<Vec<_>>();
    let mut too_many = locked_create_input();
    too_many["request"]["intent"]["lock"]["publicKeys"] = json!(keys);
    assert_eq!(call(EngineMethod::NormalizeRequest, &normalize_input(&too_many))["ok"], false);
}

#[test]
fn pool_plan_role_dependency_output_and_signing_association_mutations_fail_validation() {
    let mut input = fragmented_plan_input("pool-liquidity-remove.json", &[2_500_000], &[5_000, 5_000]);
    input["request"]["intent"]["lpAmount"] = json!("6000");
    input["request"]["intent"]["minimumTbcAmount"] = json!("1");
    input["request"]["intent"]["minimumFtAmount"] = json!("1");
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    let planned = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&planned), ["maintenance", "primary"]);
    for mutation in ["role", "dependency", "output", "signing"] {
        let mut changed_plan = planned.clone();
        match mutation {
            "role" => changed_plan["plan"]["payload"]["transactions"][0]["role"] = json!("primary"),
            "dependency" => changed_plan["plan"]["payload"]["transactions"][1]["dependsOn"] = json!([]),
            "output" => {
                let mut tx = planned_transaction(&changed_plan, 0);
                tx.outputs[0].satoshis += 1;
                changed_plan["plan"]["payload"]["transactions"][0]["unsignedTransaction"] = json!(tx.to_hex());
            }
            "signing" => changed_plan["plan"]["payload"]["signingTasks"][0]["inputIndex"] = json!(99),
            _ => unreachable!(),
        }
        assert_ne!(changed_plan, planned, "{mutation} must change the fixture");
        let validation = validation_for_plan(input.clone(), &changed_plan);
        assert!(!validation["valid"].as_bool().unwrap(), "Pool plan {mutation} mutation was accepted");
        assert!(
            ["PLAN_HASH_MISMATCH", "BUSINESS_OUTPUT_MISMATCH", "SIGNING_TASK_MISMATCH"]
                .iter().any(|code| has_violation(&validation, code)),
            "Pool plan {mutation} mutation missed the closed validation codes: {validation}"
        );
    }

}

fn assert_pool_plan_rejected(input: &Value) {
    let mut input = input.clone();
    input["requestHash"] = json!(canonical_hash(&input["request"]));
    let result = call(EngineMethod::Plan, &input);
    let error = &result["error"];
    if input["request"]["intent"]["type"] == "tbc.pool.create" && error["code"] == "UNSUPPORTED_INTENT" {
        assert_eq!(error["message"], "historical asset issuance is disabled");
        return;
    }
    assert!(
        matches!(
            error["code"].as_str(),
            Some("INVALID_ANCESTRY")
                | Some("INVALID_INPUT")
                | Some("INVALID_REQUEST")
                | Some("INSUFFICIENT_FUNDS")
        ),
        "unexpected Pool rejection: {error}"
    );
}

fn normalize_pool_input(input: &Value) -> Value {
    json!({
        "version": "1.0",
        "request": input["request"].clone(),
    })
}

fn inspect_unsigned(plan: &Value, transaction_index: usize) -> Transaction {
    planned_transaction(plan, transaction_index)
}

fn assert_locked_pool_code(script: &Script) {
    let keys = tbc_sdk::contracts::pool_nft_v2::unlock::pool_code_lock(script)
        .expect("locked Pool code");
    assert_eq!(keys.len(), 2);
    let encoded = keys
        .iter()
        .map(|key| encode_hex(&key.to_bytes()))
        .collect::<Vec<_>>();
    let mut sorted = encoded.clone();
    sorted.sort();
    assert_eq!(encoded, sorted, "locked Pool keys must be canonical");
    assert_eq!(
        encoded,
        [
            "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
        ]
    );
}

#[test]
fn locked_pool_lifecycle_completes_with_external_signatures() {
    let create = locked_create_input();
    call_ok(EngineMethod::NormalizeRequest, &normalize_pool_input(&create));
    assert_eq!(call(EngineMethod::Plan, &create)["error"]["code"], "UNSUPPORTED_INTENT");
    let owner_script = Address::from_string(OWNER).expect("owner").script_pubkey();

    for name in [
        "pool-liquidity-add.json",
        "pool-liquidity-remove.json",
        "pool-liquidity-close.json",
        "pool-swap-tbc-for-token.json",
        "pool-swap-token-for-tbc.json",
    ] {
        let input = locked_plan_input(name, 799_900);
        call_ok(EngineMethod::NormalizeRequest, &normalize_pool_input(&input));
        let plan = call_ok(EngineMethod::Plan, &input);
        assert!(validation_for_plan(input.clone(), &plan)["valid"] == true, "{name}");

        let final_transaction = inspect_unsigned(
            &plan,
            plan["plan"]["payload"]["transactions"]
                .as_array()
                .expect("transactions")
                .len()
                - 1,
        );
        if name == "pool-liquidity-add.json" {
            assert!(final_transaction.outputs.iter().any(|output| {
                output.satoshis == 100 && output.script_pubkey == owner_script
            }), "locked add output values: {:?}", final_transaction.outputs.iter().map(|output| output.satoshis).collect::<Vec<_>>());
            let (tape_index, locked_ftlp) = final_transaction
                .outputs
                .iter()
                .enumerate()
                .find(|output| {
                    output
                        .1
                        .script_pubkey
                        .as_bytes()
                        .windows(4)
                        .any(|bytes| bytes == 800_100u32.to_le_bytes())
                })
                .expect("locked FTLP output");
            assert_eq!(locked_ftlp.satoshis, 0);
            assert_eq!(final_transaction.outputs[tape_index - 1].satoshis, 500);
            let params = FtlpCodeParams::for_tape(
                &locked_ftlp.script_pubkey,
                FtScriptVersion::V4,
                false,
            )
            .expect("locked FTLP params");
            let expected_code = ftlp_lock_time_code(
                hash::sha256(final_transaction.outputs[0].script_pubkey.as_bytes()),
                &Address::from_string(OWNER).expect("owner"),
                &params,
            )
            .expect("locked FTLP code");
            assert_eq!(final_transaction.outputs[tape_index - 1].script_pubkey, expected_code);
        }
        if matches!(name, "pool-liquidity-remove.json" | "pool-liquidity-close.json") {
            assert_eq!(roles(&plan), ["maintenance", "primary"]);
            assert_eq!(inspect_unsigned(&plan, 0).lock_time, 800_000);
            assert_eq!(final_transaction.lock_time, 0);
            assert_eq!(final_transaction.inputs[1].sequence, 0xffff_fffe);
        }

        let (_, stages) = complete_pool_public(&input);
        let expected_stages = if matches!(
            name,
            "pool-liquidity-remove.json" | "pool-liquidity-close.json"
        ) {
            2
        } else {
            1
        };
        assert_eq!(stages, expected_stages, "{name}");
    }
}

#[test]
fn locked_pool_fields_and_height_eligibility_fail_closed() {
    let mut duplicate_keys = locked_create_input();
    duplicate_keys["request"]["intent"]["lock"]["publicKeys"][1] =
        duplicate_keys["request"]["intent"]["lock"]["publicKeys"][0].clone();
    assert_pool_plan_rejected(&duplicate_keys);

    let mut zero_cost = locked_create_input();
    zero_cost["request"]["intent"]["lock"]["costAmount"] = json!("0");
    assert_pool_plan_rejected(&zero_cost);

    let mut invalid_recipient = locked_create_input();
    invalid_recipient["request"]["intent"]["lock"]["costRecipient"] = json!("not-an-address");
    assert_pool_plan_rejected(&invalid_recipient);

    let mut expired_create = locked_create_input();
    expired_create["request"]["intent"]["lock"]["untilHeight"] = json!("800000");
    assert_pool_plan_rejected(&expired_create);

    let mut unix_domain_create = locked_create_input();
    unix_domain_create["request"]["intent"]["lock"]["untilHeight"] = json!("1700000000");
    assert_pool_plan_rejected(&unix_domain_create);

    let mut expired_add = locked_plan_input("pool-liquidity-add.json", 799_900);
    expired_add["request"]["intent"]["lockUntilHeight"] = json!("800000");
    assert_pool_plan_rejected(&expired_add);

    let mut unix_domain_add = locked_plan_input("pool-liquidity-add.json", 799_900);
    unix_domain_add["request"]["intent"]["lockUntilHeight"] = json!("1700000000");
    assert_pool_plan_rejected(&unix_domain_add);

    for name in ["pool-liquidity-remove.json", "pool-liquidity-close.json"] {
        let premature = locked_plan_input(name, 800_100);
        assert_pool_plan_rejected(&premature);
    }

    let mut unix_current_height = locked_plan_input("pool-liquidity-remove.json", 799_900);
    unix_current_height["snapshot"]["payload"]["block"]["height"] = json!(500_000_000u64);
    unix_current_height["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&unix_current_height["snapshot"]["payload"]));
    assert_pool_plan_rejected(&unix_current_height);

    for name in [
        "pool-liquidity-add.json",
        "pool-liquidity-remove.json",
        "pool-liquidity-close.json",
        "pool-swap-tbc-for-token.json",
        "pool-swap-token-for-tbc.json",
    ] {
        let mut illegal_lock = locked_plan_input(name, 799_900);
        illegal_lock["request"]["intent"]["lock"] = json!({
            "publicKeys": ["02deadbeef"],
            "untilHeight": "800100",
        });
        let normalized = call(EngineMethod::NormalizeRequest, &normalize_pool_input(&illegal_lock));
        assert!(!normalized["ok"].as_bool().unwrap_or(false), "{name}");

        if name != "pool-liquidity-add.json" {
            let mut illegal_height = locked_plan_input(name, 799_900);
            illegal_height["request"]["intent"]["lockUntilHeight"] = json!("800100");
            let normalized = call(
                EngineMethod::NormalizeRequest,
                &normalize_pool_input(&illegal_height),
            );
            assert!(!normalized["ok"].as_bool().unwrap_or(false), "{name}");
        }
    }
}
