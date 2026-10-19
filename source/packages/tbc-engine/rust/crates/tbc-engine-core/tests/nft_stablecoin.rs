use serde_json::{Value, json};
#[path = "support/optional_confirmations.rs"]
mod optional_confirmations;
#[path = "support/fragmented_funding.rs"]
mod fragmented_funding;
#[path = "support/unified_business.rs"]
mod unified_business;

#[test]
fn unified_historical_nft_signing_matches_concrete() {
    unified_business::exercise(bound_fixture("nft-transfer.json"), "tbc721.transfer");
    unified_business::exercise(bound_nft_v0(), "tbc721.transfer");
    unified_business::exercise(bound_nft_v1(), "tbc721.transfer");
}

#[test]
fn unified_historical_stablecoin_signing_matches_concrete() {
    unified_business::exercise(bound_fixture("stablecoin-transfer.json"), "tbc20Stablecoin.transfer");
    let mut merge = bound_fixture("stablecoin-merge.json");
    merge["request"]["intent"] = json!({"type":"tbc.stablecoin.merge","version":"1.0","contractId":merge["request"]["intent"]["contractId"]});
    merge["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().truncate(3);
    unified_business::exercise(bind(merge), "tbc20Stablecoin.merge");
}

#[test]
fn fragmented_native_funding_nft_and_stablecoin_finalize_and_validate() {
    for name in ["nft-transfer.json",
        "stablecoin-transfer.json", "stablecoin-merge.json"] {
        let original = bound_fixture(name);
        // Find the smallest single funding value accepted by this real fixture.
        let (mut low, mut high) = (0u64, 100_000u64);
        while low + 1 < high {
            let mid = (low + high) / 2;
            let mut input = original.clone();
            fragmented_funding::replace(&mut input, 1, mid);
            if call(EngineMethod::Plan, &bind(input))["ok"] == true { high = mid; } else { low = mid; }
        }
        assert!(high < 100_000, "{name}: invalid minimum {high}");
        if high == 1 {
            // Asset Code inputs can themselves pay the fee: do not consolidate.
            let mut input = original.clone();
            fragmented_funding::replace(&mut input, 3, 1);
            let (result, _) = complete_public(name, &bind(input));
            assert!(!result["bundle"]["transactions"].as_array().unwrap().iter()
                .any(|transaction| transaction["id"] == "native-funding-1"));
            continue;
        }
        let mut fragmented = original.clone();
        fragmented_funding::replace(&mut fragmented, 3, high - 1);
        let input = bind(fragmented);
        let planned = call(EngineMethod::Plan, &input);
        assert_eq!(planned["ok"], true, "{name}: {planned}");
        assert_eq!(planned["result"]["plan"]["payload"]["transactions"][0]["id"], "native-funding-1", "{name}");
        let (result, stages) = complete_public(name, &input);
        assert_eq!(stages, 2, "{name}");
        let transactions = result["bundle"]["transactions"].as_array().unwrap();
        assert_eq!(transactions.len(), 2, "{name}");
        let funding = Transaction::from_hex(transactions[0]["rawTransaction"].as_str().unwrap()).unwrap();
        let child = Transaction::from_hex(transactions[1]["rawTransaction"].as_str().unwrap()).unwrap();
        assert!(child.inputs.iter().any(|input| input.previous_output.txid == funding.txid()), "{name}: signed parent ID not rebound");
    }
}

#[test]
fn optional_confirmations_nft_stablecoin_thresholds_and_hash_binding() {
    for name in ["nft-transfer.json",
        "stablecoin-transfer.json", "stablecoin-merge.json"] {
        optional_confirmations::exercise(bound_fixture(name));
    }
}

use secp256k1::{Message, Secp256k1, SecretKey};
use sha2::{Digest, Sha256};
use tbc_engine_core::{EngineMethod, call_json};
use tbc_sdk::{
    Address, OutPoint, Transaction, TxIn, TxOut, Txid,
    contracts::{
        ft::{amount::build_tape_amount, scripts::{FtCodeReceiver, FtMintVersion, mint_code_script_with_version, mint_source_script, mint_tape_script, transfer_code_script}, unlock::pre_tx_data},
        nft::{CollectionData, NftData, scripts as nft_scripts},
        stable_coin::{CoinNftData, scripts::{coin_mint_code_script, coin_nft_code_script, coin_nft_hold_script_from_hash, coin_nft_tape_script, coin_tape_script}},
    },
};

const SENDER: &str = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const LEGACY_CODE_PREFIX: &str = "OP_1 OP_PICK OP_3 OP_SPLIT 0x01 0x14 OP_SPLIT OP_DROP OP_TOALTSTACK OP_DROP OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_1 OP_PICK OP_TOALTSTACK OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_CAT OP_1 OP_PICK 0x01 0x24 OP_SPLIT OP_DROP OP_TOALTSTACK OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_SHA256 OP_6 OP_PUSH_META 0x01 0x20 OP_SPLIT OP_DROP OP_EQUALVERIFY OP_1 OP_PICK OP_TOALTSTACK OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_CAT OP_CAT OP_CAT OP_SHA256 OP_SHA256 OP_FROMALTSTACK OP_FROMALTSTACK OP_DUP 0x01 0x20 OP_SPLIT OP_DROP OP_3 OP_ROLL OP_EQUALVERIFY OP_SWAP OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_EQUAL OP_IF OP_DROP OP_ELSE 0x24";
const LEGACY_CODE_SUFFIX: &str = "OP_EQUALVERIFY OP_ENDIF OP_1 OP_PICK OP_FROMALTSTACK OP_EQUALVERIFY OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_7 OP_PUSH_META OP_EQUALVERIFY OP_DUP OP_HASH160 OP_FROMALTSTACK OP_EQUALVERIFY OP_CHECKSIG OP_RETURN 0x05 0x33436f6465";

fn fixture(name: &str) -> Value {
    let text = match name {
        "collection-create.json" => include_str!("../../../fixtures/collection-create.json"),
        "nft-mint.json" => include_str!("../../../fixtures/nft-mint.json"),
        "nft-transfer.json" => include_str!("../../../fixtures/nft-transfer.json"),
        "stablecoin-transfer.json" => include_str!("../../../fixtures/stablecoin-transfer.json"),
        "stablecoin-merge.json" => include_str!("../../../fixtures/stablecoin-merge.json"),
        _ => panic!("unknown Task 6 fixture {name}"),
    };
    serde_json::from_str(text).expect("Task 6 fixture must be valid JSON")
}

fn base_plan_input() -> Value {
    serde_json::from_str::<Value>(include_str!("../../../fixtures/tbc-transfer.json"))
        .expect("TBC fixture must be valid JSON")["planInput"]
        .clone()
}

fn call(method: EngineMethod, input: &Value) -> Value {
    serde_json::from_str(&call_json(method, &input.to_string())).unwrap()
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

fn bind(mut params: Value) -> Value {
    let normalized = call(
        EngineMethod::NormalizeRequest,
        &json!({"version": "1.0", "request": params["request"].clone()}),
    );
    assert_eq!(normalized["ok"], true, "{normalized}");
    params["request"] = normalized["result"]["request"].clone();
    params["requestHash"] = normalized["result"]["requestHash"].clone();
    params["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&params["snapshot"]["payload"]));
    params["policy"]["policyHash"] = json!(canonical_hash(&params["policy"]["payload"]));
    params
}

fn native_material(params: &Value) -> (Value, Value) {
    (
        params["snapshot"]["payload"]["utxos"][0].clone(),
        params["snapshot"]["payload"]["parents"][0].clone(),
    )
}

fn collection_parent(supply: u32) -> Transaction {
    let data = CollectionData {
        collection_name: "Task Six Collection".to_owned(),
        description: "Deterministic collection fixture".to_owned(),
        supply,
        file: serde_json::to_string(&fixture("collection-create.json")["intent"]["media"]).unwrap(),
    };
    let mut outputs = vec![TxOut {
        satoshis: 0,
        script_pubkey: nft_scripts::tape_script(&data).unwrap(),
    }];
    outputs.extend((0..supply).map(|_| TxOut {
        satoshis: 100,
        script_pubkey: nft_scripts::mint_script(&Address::from_string(SENDER).unwrap()),
    }));
    Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint {
            txid: Txid::from_le_bytes([0x31; 32]),
            vout: 0,
        })],
        outputs,
        lock_time: 0,
    }
}

fn nft_parent() -> (Transaction, Transaction) {
    let sender = Address::from_string(SENDER).unwrap();
    let pre_pre = collection_parent(2);
    let data = NftData {
        nft_name: "Task Six NFT".to_owned(),
        symbol: "TSNFT".to_owned(),
        description: "Deterministic NFT fixture".to_owned(),
        attributes: "[{\"traitType\":\"rarity\",\"value\":\"genesis\"}]".to_owned(),
        file: Some("{\"kind\":\"base64\",\"data\":\"AQIDBA==\",\"mediaType\":\"image/png\",\"sha256\":\"9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a\"}".to_owned()),
    };
    let parent = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint { txid: pre_pre.txid(), vout: 1 })],
        outputs: vec![
            TxOut { satoshis: 200, script_pubkey: nft_scripts::code_script(&pre_pre.txid().to_string(), 1).unwrap() },
            TxOut { satoshis: 100, script_pubkey: nft_scripts::hold_script(&sender) },
            TxOut { satoshis: 0, script_pubkey: nft_scripts::tape_script(&data).unwrap() },
        ],
        lock_time: 0,
    };
    (parent, pre_pre)
}

fn legacy_code_script(collection_id: &str, index: u32) -> tbc_sdk::script::Script {
    let txid = collection_id.parse::<Txid>().unwrap();
    let origin = format!("{}{}", encode_hex(txid.as_le_bytes()), encode_hex(&index.to_le_bytes()));
    tbc_sdk::script::Script::from_asm(&format!("{LEGACY_CODE_PREFIX} 0x{origin} {LEGACY_CODE_SUFFIX}")).unwrap()
}

fn bound_nft_v0() -> Value {
    let mut params = bound_fixture("nft-transfer.json");
    let native_utxo = params["snapshot"]["payload"]["utxos"][0].clone();
    let native_parent = params["snapshot"]["payload"]["parents"][0].clone();
    let (mut parent, pre_pre) = nft_parent();
    parent.outputs[0].script_pubkey = legacy_code_script(&pre_pre.txid().to_string(), 1);
    let id = parent.txid().to_string();
    params["request"]["intent"]["contractId"] = json!(id.clone());
    params["snapshot"]["payload"]["utxos"] = json!([native_utxo,
        {"txid": id, "vout": 0, "satoshis": "200", "scriptPubKey": encode_hex(parent.outputs[0].script_pubkey.as_bytes()), "confirmations": "100", "classification": "nft", "contractId": id},
        {"txid": id, "vout": 1, "satoshis": "100", "scriptPubKey": encode_hex(parent.outputs[1].script_pubkey.as_bytes()), "confirmations": "100", "classification": "nft", "contractId": id}
    ]);
    params["snapshot"]["payload"]["parents"] = json!([native_parent,
        {"txid": pre_pre.txid().to_string(), "rawTransaction": pre_pre.to_hex()},
        {"txid": id, "rawTransaction": parent.to_hex()}
    ]);
    params["snapshot"]["payload"]["contracts"] = json!([{
        "contractId": id, "family": "nft", "protocolVersion": "2.0",
        "creationTxid": id, "currentOutpoint": {"txid": id, "vout": 0}
    }]);
    bind(params)
}

fn bound_nft_v1() -> Value {
    let mut params = bound_nft_v0();
    let pre_pre = Transaction::from_hex(params["snapshot"]["payload"]["parents"][1]["rawTransaction"].as_str().unwrap()).unwrap();
    let mut parent = Transaction::from_hex(params["snapshot"]["payload"]["parents"][2]["rawTransaction"].as_str().unwrap()).unwrap();
    parent.outputs[0].script_pubkey = nft_scripts::code_script_v1(&pre_pre.txid().to_string(), 1).unwrap();
    let id = parent.txid().to_string();
    params["request"]["intent"]["contractId"] = json!(id.clone());
    for vout in [0usize, 1] {
        params["snapshot"]["payload"]["utxos"][vout + 1]["txid"] = json!(id.clone());
        params["snapshot"]["payload"]["utxos"][vout + 1]["contractId"] = json!(id.clone());
        params["snapshot"]["payload"]["utxos"][vout + 1]["scriptPubKey"] = json!(encode_hex(parent.outputs[vout].script_pubkey.as_bytes()));
    }
    params["snapshot"]["payload"]["parents"][2] = json!({"txid":id,"rawTransaction":parent.to_hex()});
    params["snapshot"]["payload"]["contracts"][0]["contractId"] = json!(id.clone());
    params["snapshot"]["payload"]["contracts"][0]["creationTxid"] = json!(id.clone());
    params["snapshot"]["payload"]["contracts"][0]["currentOutpoint"] = json!({"txid":id,"vout":0});
    bind(params)
}

fn stable_material(balances: &[u64], lock_time: u32) -> (Vec<Value>, Vec<Value>, Value) {
    let sender = Address::from_string(SENDER).unwrap();
    let total = balances.iter().sum::<u64>();
    let (total_slots, _) = build_tape_amount(total as u128, &[total as u128]).unwrap();
    let creation_tape = coin_tape_script(&total_slots, 6, "Task Six Dollar", "TSD", lock_time);
    let funding = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint { txid: Txid::from_le_bytes([0x58; 32]), vout: 0 })],
        outputs: vec![TxOut { satoshis: 100_000, script_pubkey: sender.script_pubkey() }],
        lock_time: 0,
    };
    let admin_hash = [0x22; 20];
    let zero_nft = CoinNftData {
        nft_name: "Task Six Dollar NFT".to_owned(),
        nft_symbol: "TSD NFT".to_owned(),
        description: "The sole issuance certificate for the stablecoin, dynamically recording cumulative supply and issuance history. Non-transferable, real-time updated, ensuring full transparency and auditability.".to_owned(),
        coin_decimal: 6,
        coin_total_supply: "0".to_owned(),
    };
    let coin_nft = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint { txid: funding.txid(), vout: 0 })],
        outputs: vec![
            TxOut { satoshis: 200, script_pubkey: coin_nft_code_script(&funding.txid().to_string(), 0).unwrap() },
            TxOut { satoshis: 100, script_pubkey: coin_nft_hold_script_from_hash(&admin_hash, &zero_nft.nft_name) },
            TxOut { satoshis: 0, script_pubkey: coin_nft_tape_script(&zero_nft).unwrap() },
            TxOut { satoshis: 90_000, script_pubkey: sender.script_pubkey() },
        ],
        lock_time: 0,
    };
    let genesis_code = coin_mint_code_script(&admin_hash, &sender, &coin_nft.outputs[0].script_pubkey.sha256(), creation_tape.as_bytes().len()).unwrap();
    let current_code = transfer_code_script(&genesis_code, FtCodeReceiver::Address(sender)).unwrap();
    let issued_nft = CoinNftData { coin_total_supply: total.to_string(), ..zero_nft };
    let creation = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![
            TxIn::new(OutPoint { txid: coin_nft.txid(), vout: 0 }),
            TxIn::new(OutPoint { txid: coin_nft.txid(), vout: 1 }),
            TxIn::new(OutPoint { txid: coin_nft.txid(), vout: 3 }),
        ],
        outputs: vec![
            coin_nft.outputs[0].clone(),
            coin_nft.outputs[1].clone(),
            TxOut { satoshis: 0, script_pubkey: coin_nft_tape_script(&issued_nft).unwrap() },
            TxOut { satoshis: 500, script_pubkey: genesis_code },
            TxOut { satoshis: 0, script_pubkey: creation_tape },
        ],
        lock_time,
    };
    let creation_txid = creation.txid().to_string();
    let contract_id = coin_nft.txid().to_string();
    let split_outputs = balances.iter().flat_map(|balance| {
        let (slots, _) = build_tape_amount(*balance as u128, &[*balance as u128]).unwrap();
        [
            TxOut { satoshis: 500, script_pubkey: current_code.clone() },
            TxOut { satoshis: 0, script_pubkey: coin_tape_script(&slots, 6, "Task Six Dollar", "TSD", lock_time) },
        ]
    }).collect::<Vec<_>>();
    let split = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn { previous_output: OutPoint { txid: creation.txid(), vout: 3 }, script_sig: tbc_sdk::script::Script::empty(), sequence: 0xffff_fffe }],
        outputs: split_outputs,
        lock_time,
    };
    let mut utxos = Vec::new();
    let parents = vec![
        json!({"txid": funding.txid().to_string(), "rawTransaction": funding.to_hex()}),
        json!({"txid": coin_nft.txid().to_string(), "rawTransaction": coin_nft.to_hex()}),
        json!({"txid": creation_txid, "rawTransaction": creation.to_hex()}),
        json!({"txid": split.txid().to_string(), "rawTransaction": split.to_hex()}),
    ];
    for (index, _balance) in balances.iter().enumerate() {
        utxos.push(json!({
            "txid": split.txid().to_string(), "vout": index * 2, "satoshis": "500",
            "scriptPubKey": encode_hex(current_code.as_bytes()), "confirmations": "100",
            "classification": "stablecoin", "contractId": contract_id
        }));
    }
    let contract = json!({
        "contractId": contract_id, "family": "stablecoin", "protocolVersion": "4.0",
        "creationTxid": creation_txid, "currentOutpoint": {"txid": split.txid().to_string(), "vout": 0}
    });
    (utxos, parents, contract)
}

fn bound_ft_merge() -> Value {
    let sender = Address::from_string(SENDER).unwrap();
    let balances = [100u64; 6];
    let mut total_slot = [0u8; 48];
    total_slot[..8].copy_from_slice(&600u64.to_le_bytes());
    let creation_tape = mint_tape_script(&total_slot, 6, "Task Six FT", "TSF");
    let source = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint { txid: Txid::from_le_bytes([0x68; 32]), vout: 0 })],
        outputs: vec![
            TxOut { satoshis: 9_900, script_pubkey: mint_source_script(&sender) },
            TxOut { satoshis: 0, script_pubkey: creation_tape.clone() },
        ],
        lock_time: 0,
    };
    let genesis_code = mint_code_script_with_version(&source.txid().to_string(), 0, &sender, creation_tape.as_bytes().len(), FtMintVersion::V4).unwrap();
    let current_code = transfer_code_script(&genesis_code, FtCodeReceiver::Address(sender)).unwrap();
    let creation = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint { txid: source.txid(), vout: 0 })],
        outputs: vec![TxOut { satoshis: 500, script_pubkey: genesis_code }, TxOut { satoshis: 0, script_pubkey: creation_tape }],
        lock_time: 0,
    };
    let split = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint { txid: creation.txid(), vout: 0 })],
        outputs: balances.iter().flat_map(|balance| {
            let mut slot = [0u8; 48]; slot[..8].copy_from_slice(&balance.to_le_bytes());
            [TxOut { satoshis: 500, script_pubkey: current_code.clone() }, TxOut { satoshis: 0, script_pubkey: mint_tape_script(&slot, 6, "Task Six FT", "TSF") }]
        }).collect(),
        lock_time: 0,
    };
    let contract_id = creation.txid().to_string();
    let mut params = base_plan_input();
    let native_utxo = params["snapshot"]["payload"]["utxos"][0].clone();
    let native_parent = params["snapshot"]["payload"]["parents"][0].clone();
    params["request"]["clientRequestId"] = json!("task-6-cross-ft");
    params["request"]["intent"] = json!({"type":"tbc.ft.transfer","version":"1.0","contractId":contract_id,"to":"1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP","amount":"550","attachedTbcAmount":"24"});
    params["request"]["constraints"]["maxFee"] = json!("50000");
    params["policy"]["payload"]["amountLimits"] = json!([]);
    params["snapshot"]["payload"]["utxos"] = json!([native_utxo]);
    for index in 0..balances.len() {
        params["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(json!({"txid":split.txid().to_string(),"vout":index * 2,"satoshis":"500","scriptPubKey":encode_hex(current_code.as_bytes()),"confirmations":"100","classification":"ft","contractId":contract_id}));
    }
    params["snapshot"]["payload"]["parents"] = json!([native_parent,
        {"txid":source.txid().to_string(),"rawTransaction":source.to_hex()},
        {"txid":creation.txid().to_string(),"rawTransaction":creation.to_hex()},
        {"txid":split.txid().to_string(),"rawTransaction":split.to_hex()}
    ]);
    params["snapshot"]["payload"]["contracts"] = json!([{"contractId":contract_id,"family":"ft","protocolVersion":"4.0","creationTxid":contract_id,"currentOutpoint":{"txid":split.txid().to_string(),"vout":0}}]);
    bind(params)
}

fn bound_later_minted_stablecoin() -> Value {
    let mut params = bound_fixture("stablecoin-transfer.json");
    let native_utxo = params["snapshot"]["payload"]["utxos"][0].clone();
    let native_parent = params["snapshot"]["payload"]["parents"][0].clone();
    let (_, mut parents, _) = stable_material(&[600], 0);
    let creation = Transaction::from_hex(parents[2]["rawTransaction"].as_str().unwrap()).unwrap();
    let fee = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint { txid: Txid::from_le_bytes([0x69; 32]), vout: 0 })],
        outputs: vec![TxOut { satoshis: 100_000, script_pubkey: Address::from_string(SENDER).unwrap().script_pubkey() }],
        lock_time: 0,
    };
    let issued = CoinNftData {
        nft_name: "Task Six Dollar NFT".to_owned(), nft_symbol: "TSD NFT".to_owned(),
        description: "The sole issuance certificate for the stablecoin, dynamically recording cumulative supply and issuance history. Non-transferable, real-time updated, ensuring full transparency and auditability.".to_owned(),
        coin_decimal: 6, coin_total_supply: "1000".to_owned(),
    };
    let (slots, _) = build_tape_amount(400, &[400]).unwrap();
    let later = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![
            TxIn::new(OutPoint { txid: creation.txid(), vout: 0 }),
            TxIn::new(OutPoint { txid: creation.txid(), vout: 1 }),
            TxIn::new(OutPoint { txid: fee.txid(), vout: 0 }),
        ],
        outputs: vec![
            creation.outputs[0].clone(), creation.outputs[1].clone(),
            TxOut { satoshis: 0, script_pubkey: coin_nft_tape_script(&issued).unwrap() },
            creation.outputs[3].clone(),
            TxOut { satoshis: 0, script_pubkey: coin_tape_script(&slots, 6, "Task Six Dollar", "TSD", 0) },
        ],
        lock_time: 0,
    };
    let contract_id = creation.inputs[0].previous_output.txid.to_string();
    let creation_txid = creation.txid().to_string();
    parents.pop();
    parents.push(json!({"txid": fee.txid().to_string(), "rawTransaction": fee.to_hex()}));
    parents.push(json!({"txid": later.txid().to_string(), "rawTransaction": later.to_hex()}));
    params["request"]["intent"]["contractId"] = json!(contract_id.clone());
    params["snapshot"]["payload"]["utxos"] = json!([native_utxo, {
        "txid": later.txid().to_string(), "vout": 3, "satoshis": "500",
        "scriptPubKey": encode_hex(later.outputs[3].script_pubkey.as_bytes()), "confirmations": "100",
        "classification": "stablecoin", "contractId": contract_id
    }]);
    params["snapshot"]["payload"]["parents"] = json!([native_parent]);
    params["snapshot"]["payload"]["parents"].as_array_mut().unwrap().append(&mut parents);
    params["snapshot"]["payload"]["contracts"] = json!([{
        "contractId": contract_id, "family": "stablecoin", "protocolVersion": "4.0",
        "creationTxid": creation_txid, "currentOutpoint": {"txid": later.txid().to_string(), "vout": 3}
    }]);
    bind(params)
}

fn bound_fixture(name: &str) -> Value {
    let vector = fixture(name);
    let mut params = base_plan_input();
    let (native_utxo, native_parent) = native_material(&params);
    params["request"]["clientRequestId"] = json!(format!("task-6-{name}"));
    params["request"]["intent"] = vector["intent"].clone();
    params["request"]["constraints"]["maxFee"] = json!("50000");
    params["policy"]["payload"]["amountLimits"] = json!([]);
    match name {
        "collection-create.json" => {}
        "nft-mint.json" => {
            let parent = collection_parent(2);
            let id = parent.txid().to_string();
            params["request"]["intent"]["collectionId"] = json!(id.clone());
            params["snapshot"]["payload"]["utxos"] = json!([native_utxo, {
                "txid": id, "vout": 1, "satoshis": "100",
                "scriptPubKey": encode_hex(parent.outputs[1].script_pubkey.as_bytes()),
                "confirmations": "100", "classification": "collection-slot", "contractId": id
            }]);
            params["snapshot"]["payload"]["parents"] = json!([native_parent, {
                "txid": parent.txid().to_string(), "rawTransaction": parent.to_hex()
            }]);
            params["snapshot"]["payload"]["contracts"] = json!([{
                "contractId": parent.txid().to_string(), "family": "collection", "protocolVersion": "2.0",
                "creationTxid": parent.txid().to_string(), "currentOutpoint": {"txid": parent.txid().to_string(), "vout": 1}
            }]);
        }
        "nft-transfer.json" => {
            let (parent, pre_pre) = nft_parent();
            let id = json!(parent.txid().to_string());
            params["request"]["intent"]["contractId"] = id.clone();
            params["snapshot"]["payload"]["utxos"] = json!([native_utxo,
                {"txid": parent.txid().to_string(), "vout": 0, "satoshis": "200", "scriptPubKey": encode_hex(parent.outputs[0].script_pubkey.as_bytes()), "confirmations": "100", "classification": "nft", "contractId": id},
                {"txid": parent.txid().to_string(), "vout": 1, "satoshis": "100", "scriptPubKey": encode_hex(parent.outputs[1].script_pubkey.as_bytes()), "confirmations": "100", "classification": "nft", "contractId": id}
            ]);
            params["snapshot"]["payload"]["parents"] = json!([native_parent,
                {"txid": pre_pre.txid().to_string(), "rawTransaction": pre_pre.to_hex()},
                {"txid": parent.txid().to_string(), "rawTransaction": parent.to_hex()}
            ]);
            params["snapshot"]["payload"]["contracts"] = json!([{
                "contractId": id, "family": "nft", "protocolVersion": "2.0",
                "creationTxid": parent.txid().to_string(), "currentOutpoint": {"txid": parent.txid().to_string(), "vout": 0}
            }]);
        }
        "stablecoin-transfer.json" | "stablecoin-merge.json" => {
            let balances = vector["balances"].as_array().unwrap().iter()
                .map(|value| value.as_str().unwrap().parse().unwrap()).collect::<Vec<u64>>();
            let lock_time = vector["lockTime"].as_u64().unwrap() as u32;
            let (asset_utxos, mut asset_parents, contract) = stable_material(&balances, lock_time);
            params["request"]["intent"]["contractId"] = contract["contractId"].clone();
            params["snapshot"]["payload"]["utxos"] = json!([native_utxo]);
            params["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().extend(asset_utxos);
            params["snapshot"]["payload"]["parents"] = json!([native_parent]);
            params["snapshot"]["payload"]["parents"].as_array_mut().unwrap().append(&mut asset_parents);
            params["snapshot"]["payload"]["contracts"] = json!([contract]);
        }
        _ => unreachable!(),
    }
    bind(params)
}

fn plan_fixture(name: &str) -> Value {
    let envelope = call(EngineMethod::Plan, &bound_fixture(name));
    assert_eq!(envelope["ok"], true, "{name}: {envelope}");
    envelope["result"].clone()
}

fn assert_plan_error(mut params: Value, expected: &str) {
    params["snapshot"]["snapshotHash"] = json!(canonical_hash(&params["snapshot"]["payload"]));
    params["policy"]["policyHash"] = json!(canonical_hash(&params["policy"]["payload"]));
    let envelope = call(EngineMethod::Plan, &params);
    assert_eq!(envelope["ok"], false, "{envelope}");
    assert_eq!(envelope["error"]["code"], expected, "{envelope}");
}

fn decode_hex(value: &str) -> Vec<u8> {
    value.as_bytes().chunks_exact(2).map(|pair| {
        let digit = |byte: u8| match byte { b'0'..=b'9' => byte - b'0', b'a'..=b'f' => byte - b'a' + 10, _ => panic!("hex") };
        digit(pair[0]) * 16 + digit(pair[1])
    }).collect()
}

fn sign_tasks(tasks: &Value, scalar: u8) -> Value {
    sign_tasks_with_digest(tasks, scalar, None)
}

fn sign_tasks_with_digest(tasks: &Value, scalar: u8, override_digest: Option<[u8; 32]>) -> Value {
    let mut bytes = [0u8; 32];
    bytes[31] = scalar;
    let secret = SecretKey::from_byte_array(bytes).unwrap();
    let secp = Secp256k1::new();
    Value::Array(tasks.as_array().unwrap().iter().map(|task| {
        let digest: [u8; 32] = override_digest.unwrap_or_else(|| decode_hex(task["digest"].as_str().unwrap()).try_into().unwrap());
        let signature = secp.sign_ecdsa(Message::from_digest(digest), &secret).serialize_compact();
        json!({"taskId": task["taskId"], "signatureEncoding": "compact64", "signature": encode_hex(&signature)})
    }).collect())
}

fn make_high_s(signatures: &mut Value) {
    const ORDER: [u8; 32] = [
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
        0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
    ];
    let mut compact = decode_hex(signatures[0]["signature"].as_str().unwrap());
    let low = compact[32..].to_vec();
    let mut borrow = 0i16;
    for index in (0..32).rev() {
        let value = ORDER[index] as i16 - low[index] as i16 - borrow;
        compact[32 + index] = if value < 0 { (value + 256) as u8 } else { value as u8 };
        borrow = i16::from(value < 0);
    }
    signatures[0]["signature"] = json!(encode_hex(&compact));
}

fn assert_public_signature_failures(mut finalize: Value, tasks: &Value) {
    finalize["signatures"] = sign_tasks(tasks, 2);
    assert_eq!(call(EngineMethod::Finalize, &finalize)["error"]["code"], "INVALID_SIGNATURE");
    finalize["signatures"] = json!([]);
    assert_eq!(call(EngineMethod::Finalize, &finalize)["error"]["code"], "MISSING_SIGNATURE");
    let mut duplicate = sign_tasks(tasks, 1);
    let repeated = duplicate[0].clone();
    duplicate.as_array_mut().unwrap().push(repeated);
    finalize["signatures"] = duplicate;
    assert_eq!(call(EngineMethod::Finalize, &finalize)["error"]["code"], "INVALID_SIGNATURE");
    finalize["signatures"] = sign_tasks_with_digest(tasks, 1, Some([7; 32]));
    assert_eq!(call(EngineMethod::Finalize, &finalize)["error"]["code"], "INVALID_SIGNATURE");
    finalize["signatures"] = sign_tasks(tasks, 1);
    make_high_s(&mut finalize["signatures"]);
    assert_eq!(call(EngineMethod::Finalize, &finalize)["error"]["code"], "INVALID_SIGNATURE");
}

fn public_finalize_input(input: &Value, planned: &Value) -> Value {
    let legacy = fixture("nft-transfer.json");
    let base = serde_json::from_str::<Value>(include_str!("../../../fixtures/tbc-transfer.json")).unwrap();
    let mut binding = base["finalizeInput"]["binding"].clone();
    binding["payload"]["requestHash"] = input["requestHash"].clone();
    binding["payload"]["operationHash"] = planned["plan"]["planHash"].clone();
    binding["payload"]["accountId"] = json!(format!("{}:{}", input["request"]["chainId"].as_str().unwrap(), input["request"]["from"].as_str().unwrap()));
    binding["payload"]["expiresAt"] = planned["plan"]["payload"]["expiresAt"].clone();
    binding["bindingHash"] = json!(canonical_hash(&binding["payload"]));
    let mut approval = base["finalizeInput"]["approval"].clone();
    approval["bindingHash"] = binding["bindingHash"].clone();
    approval["expiresAt"] = planned["plan"]["payload"]["expiresAt"].clone();
    let _ = legacy;
    json!({
        "version": input["version"], "request": input["request"], "requestHash": input["requestHash"],
        "snapshot": input["snapshot"], "policy": input["policy"], "plan": planned["plan"],
        "binding": binding, "approval": approval,
        "signatures": sign_tasks(&planned["plan"]["payload"]["signingTasks"], 1)
    })
}

fn complete_public(name: &str, input: &Value) -> (Value, usize) {
    let planned = call(EngineMethod::Plan, input);
    assert_eq!(planned["ok"], true, "{planned}");
    let planned = &planned["result"];
    let mut finalize = public_finalize_input(input, planned);
    let mut stages = 1usize;
    loop {
        let result = call(EngineMethod::Finalize, &finalize);
        assert_eq!(result["ok"], true, "{name} stage {stages}: {result}");
        if result["result"].get("bundle").is_some() {
            let mut validation = finalize.clone();
            validation["phase"] = json!("finalized");
            validation["bundle"] = result["result"]["bundle"].clone();
            let checked = call(EngineMethod::Validate, &validation);
            assert_eq!(checked["ok"], true, "{name} validate: {checked}");
            assert_eq!(checked["result"]["valid"], true, "{name} validate: {checked}");
            return (result["result"].clone(), stages);
        }
        finalize["continuation"] = result["result"]["continuation"].clone();
        finalize["signatures"] = sign_tasks(&result["result"]["signingRequests"], 1);
        stages += 1;
    }
}

#[test]
fn historical_issuance_rejects_and_holder_operations_dispatch_to_rust() {
    for name in ["nft-mint.json"] {
        assert_plan_error(bound_fixture(name), "UNSUPPORTED_INTENT");
    }
    for name in [
        "collection-create.json",
        "nft-transfer.json",
        "stablecoin-transfer.json",
        "stablecoin-merge.json",
    ] {
        let result = plan_fixture(name);
        assert_eq!(result["plan"]["payload"]["requestHash"].as_str().unwrap().len(), 64, "{name}");
        assert!(!result["plan"]["payload"]["transactions"].as_array().unwrap().is_empty(), "{name}");
    }
}

#[test]
fn shared_collection_uses_full_public_plan_sign_finalize_validation() {
    let (result, stages) = complete_public("collection-create.json", &bound_fixture("collection-create.json"));
    assert_eq!(stages, 1);
    assert_eq!(result["bundle"]["transactions"].as_array().unwrap().len(), 1);
}

#[test]
fn stablecoin_merge_uses_maintenance_before_primary_and_preserves_coin_rules() {
    let result = plan_fixture("stablecoin-merge.json");
    let transactions = result["plan"]["payload"]["transactions"].as_array().unwrap();
    assert_eq!(transactions[0]["role"], "maintenance");
    assert_eq!(transactions.last().unwrap()["role"], "primary");
    assert_eq!(result["plan"]["payload"]["preview"]["assetFlows"][0]["kind"], "stablecoin");
    eprintln!(
        "TASK6_STABLECOIN_DAG plan_bytes={} transactions={} signing_stages=2",
        serde_json::to_vec(&result).unwrap().len(),
        transactions.len(),
    );
}

// Official API already validates issuance. Ordinary holder operations consume
// its bound Code/Tape/supply plus exactly the SDK's selected/direct parents.
fn indexed_stablecoin(input: &Value) -> Value {
    let mut next = input.clone();
    let payload = &input["snapshot"]["payload"];
    let record = &payload["contracts"][0];
    let creation = payload["parents"].as_array().unwrap().iter()
        .find(|p| p["txid"] == record["creationTxid"]).unwrap();
    let creation = Transaction::from_hex(creation["rawTransaction"].as_str().unwrap()).unwrap();
    let mut ids = std::collections::BTreeSet::new();
    for u in payload["utxos"].as_array().unwrap().iter().filter(|u| u["classification"] == "stablecoin") {
        let id = u["txid"].as_str().unwrap();
        ids.insert(id.to_owned());
        let row = payload["parents"].as_array().unwrap().iter().find(|p| p["txid"] == id).unwrap();
        let tx = Transaction::from_hex(row["rawTransaction"].as_str().unwrap()).unwrap();
        let tape = tx.outputs[u["vout"].as_u64().unwrap() as usize + 1].script_pubkey.as_bytes();
        for (i, slot) in tape[3..51].chunks_exact(8).enumerate() {
            if u64::from_le_bytes(slot.try_into().unwrap()) != 0 {
                ids.insert(tx.inputs[i].previous_output.txid.to_string());
            }
        }
    }
    let supply = tbc_sdk::contracts::ft::amount::balance_from_tape(&creation.outputs[4].script_pubkey).unwrap();
    let p = &mut next["snapshot"]["payload"];
    p["contracts"][0]["creationTxid"] = record["contractId"].clone();
    p["contracts"][0]["indexedFungible"] = json!({
        "codeScript": encode_hex(creation.outputs[3].script_pubkey.as_bytes()),
        "tapeScript": encode_hex(creation.outputs[4].script_pubkey.as_bytes()),
        "totalSupply": supply.to_string()
    });
    p["parents"].as_array_mut().unwrap().retain(|p| ids.contains(p["txid"].as_str().unwrap()));
    bind(next)
}

#[test]
fn trusted_index_stablecoin_matches_full_history_and_preserves_local_checks() {
    for name in ["stablecoin-transfer.json", "stablecoin-merge.json"] {
        let full = bound_fixture(name);
        let indexed = indexed_stablecoin(&full);
        let old = call(EngineMethod::Plan, &full);
        let new = call(EngineMethod::Plan, &indexed);
        assert_eq!(new["ok"], true, "{new}");
        for field in ["transactions", "signingTasks", "preview"] {
            assert_eq!(new["result"]["plan"]["payload"][field], old["result"]["plan"]["payload"][field], "{name}: {field}");
        }
        let (old_final, _) = complete_public(name, &full);
        let (new_final, _) = complete_public(name, &indexed);
        assert_eq!(new_final["bundle"]["transactions"], old_final["bundle"]["transactions"]);
        assert!(indexed["snapshot"]["payload"]["parents"].as_array().unwrap().len()
            < full["snapshot"]["payload"]["parents"].as_array().unwrap().len());
        for field in ["satoshis", "scriptPubKey"] {
            let mut bad = indexed.clone();
            bad["snapshot"]["payload"]["utxos"][1][field] = json!(if field == "satoshis" { "501" } else { "51" });
            assert_plan_error(bad, "INVALID_ANCESTRY");
        }
        let mut missing = indexed.clone();
        missing["snapshot"]["payload"]["parents"].as_array_mut().unwrap().pop();
        assert_plan_error(missing, "INVALID_ANCESTRY");
        let mut low_supply = indexed.clone();
        low_supply["snapshot"]["payload"]["contracts"][0]["indexedFungible"]["totalSupply"] = json!("1");
        assert_plan_error(low_supply, "INVALID_ANCESTRY");
    }
}

#[test]
fn independent_stablecoin_merge_is_one_bounded_primary_transaction() {
    let mut input = bound_fixture("stablecoin-merge.json");
    let contract_id = input["request"]["intent"]["contractId"].clone();
    input["request"]["intent"] = json!({
        "type": "tbc.stablecoin.merge",
        "version": "1.0",
        "contractId": contract_id,
    });
    input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().truncate(3);
    let input = bind(input);
    let envelope = call(EngineMethod::Plan, &input);
    assert_eq!(envelope["ok"], true, "{envelope}");
    let result = &envelope["result"];
    let transactions = result["plan"]["payload"]["transactions"].as_array().unwrap();
    assert_eq!(transactions.len(), 1);
    assert_eq!(transactions[0]["id"], "stablecoin-merge-1");
    assert_eq!(transactions[0]["role"], "primary");
    assert_eq!(result["plan"]["payload"]["preview"]["assetFlows"][0]["kind"], "stablecoin");
    assert_eq!(result["plan"]["payload"]["preview"]["assetFlows"][0]["direction"], "merge");
}

#[test]
fn excluded_stablecoin_operations_remain_unsupported() {
    for kind in ["tbc.stablecoin.create", "tbc.stablecoin.mint", "tbc.stablecoin.freeze", "tbc.stablecoin.unfreeze", "tbc.stablecoin.batchTransfer"] {
        let mut request = base_plan_input()["request"].clone();
        request["intent"] = json!({"type": kind, "version": "1.0"});
        let envelope = call(EngineMethod::NormalizeRequest, &json!({"version": "1.0", "request": request}));
        assert_eq!(envelope["error"]["code"], "UNSUPPORTED_INTENT", "{kind}");
    }
}

#[test]
fn nft_and_stablecoin_reject_forged_contract_and_parent_material() {
    let mut wrong_family = bound_fixture("stablecoin-transfer.json");
    wrong_family["snapshot"]["payload"]["contracts"][0]["family"] = json!("ft");
    assert_plan_error(wrong_family, "INVALID_ANCESTRY");

    let mut wrong_creation = bound_fixture("nft-transfer.json");
    wrong_creation["snapshot"]["payload"]["contracts"][0]["creationTxid"] = json!("11".repeat(32));
    assert_plan_error(wrong_creation, "INVALID_ANCESTRY");

    let mut tampered_raw = bound_fixture("stablecoin-transfer.json");
    let raw = tampered_raw["snapshot"]["payload"]["parents"][1]["rawTransaction"].as_str().unwrap().to_owned();
    tampered_raw["snapshot"]["payload"]["parents"][1]["rawTransaction"] = json!(format!("{}00", raw));
    assert_plan_error(tampered_raw, "INVALID_ANCESTRY");

    let mut missing_pre_pre = bound_fixture("nft-transfer.json");
    missing_pre_pre["snapshot"]["payload"]["parents"].as_array_mut().unwrap().remove(1);
    assert_plan_error(missing_pre_pre, "INVALID_ANCESTRY");
}

#[test]
fn selected_contract_inputs_enforce_owner_confirmations_and_uniqueness() {
    let mut wrong_owner = bound_fixture("nft-transfer.json");
    wrong_owner["snapshot"]["payload"]["utxos"][2]["scriptPubKey"] = json!("51");
    assert_plan_error(wrong_owner, "INVALID_ANCESTRY");

    let mut unconfirmed = bound_fixture("stablecoin-transfer.json");
    unconfirmed["snapshot"]["payload"]["utxos"][1]["confirmations"] = json!("0");
    assert_plan_error(unconfirmed, "INSUFFICIENT_FUNDS");

    let mut duplicate = bound_fixture("stablecoin-transfer.json");
    let repeated = duplicate["snapshot"]["payload"]["utxos"][1].clone();
    duplicate["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(repeated);
    assert_plan_error(duplicate, "INVALID_ANCESTRY");
}

#[test]
fn funding_and_media_limits_fail_closed() {
    let mut max_fee = bound_fixture("nft-transfer.json");
    max_fee["request"]["constraints"]["maxFee"] = json!("1");
    max_fee["requestHash"] = json!(canonical_hash(&max_fee["request"]));
    assert_plan_error(max_fee, "FEE_CAP_EXCEEDED");

    let mut request = base_plan_input()["request"].clone();
    request["intent"] = fixture("collection-create.json")["intent"].clone();
    request["intent"]["supply"] = json!("2001");
    let envelope = call(EngineMethod::NormalizeRequest, &json!({"version": "1.0", "request": request}));
    assert_eq!(envelope["error"]["code"], "INVALID_INPUT", "{envelope}");

    let mut request = base_plan_input()["request"].clone();
    request["intent"] = fixture("nft-mint.json")["intent"].clone();
    request["intent"]["collectionId"] = json!("11".repeat(32));
    request["intent"]["media"]["sha256"] = Value::Null;
    let envelope = call(EngineMethod::NormalizeRequest, &json!({"version": "1.0", "request": request}));
    assert_eq!(envelope["error"]["code"], "INVALID_INPUT", "{envelope}");
}

#[test]
fn source_semantics_are_argument_derived_and_ignore_unrelated_holdings() {
    let mut changed_collection = bound_fixture("collection-create.json");
    changed_collection["request"]["intent"]["name"] = json!("Mutated Collection");
    changed_collection["requestHash"] = json!(canonical_hash(&changed_collection["request"]));
    let changed_collection = call(EngineMethod::Plan, &changed_collection);
    assert_eq!(changed_collection["ok"], true, "{changed_collection}");
    let original_collection = plan_fixture("collection-create.json");
    assert_ne!(changed_collection["result"]["plan"]["planHash"], original_collection["plan"]["planHash"]);
    assert_ne!(changed_collection["result"]["plan"]["payload"]["transactions"], original_collection["plan"]["payload"]["transactions"]);

    let base_stable = plan_fixture("stablecoin-transfer.json");
    let mut unrelated = bound_fixture("stablecoin-transfer.json");
    unrelated["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(json!({
        "txid": "77".repeat(32), "vout": 0, "satoshis": "500", "scriptPubKey": "51",
        "confirmations": "100", "classification": "stablecoin", "contractId": "88".repeat(32)
    }));
    unrelated["snapshot"]["snapshotHash"] = json!(canonical_hash(&unrelated["snapshot"]["payload"]));
    let unrelated = call(EngineMethod::Plan, &unrelated);
    assert_eq!(unrelated["ok"], true, "{unrelated}");
    assert_eq!(
        base_stable["plan"]["payload"]["transactions"],
        unrelated["result"]["plan"]["payload"]["transactions"]
    );
    assert_eq!(
        base_stable["plan"]["payload"]["preview"]["assetFlows"],
        unrelated["result"]["plan"]["payload"]["preview"]["assetFlows"]
    );
}

#[test]
fn stablecoin_transactions_preserve_source_locktime_and_sequence() {
    for name in ["stablecoin-transfer.json", "stablecoin-merge.json"] {
        let result = plan_fixture(name);
        for template in result["plan"]["payload"]["transactions"].as_array().unwrap() {
            let tx = Transaction::from_hex(template["unsignedTransaction"].as_str().unwrap()).unwrap();
            assert_eq!(tx.lock_time, 500_000_001, "{name}");
            assert!(tx.inputs.iter().take(tx.inputs.len().saturating_sub(1)).all(|input| input.sequence == 0xffff_fffe), "{name}");
        }
    }
}

#[test]
fn nft_transfer_plan_stays_compact_with_deduplicated_ancestry() {
    let result = plan_fixture("nft-transfer.json");
    let template = &result["plan"]["payload"]["transactions"][0];
    let raw_bytes = template["unsignedTransaction"].as_str().unwrap().len() / 2;
    let plan_bytes = serde_json::to_vec(&result).unwrap().len();
    assert!(plan_bytes < 100_000);
    eprintln!("TASK6_NFT_SIZE plan_bytes={plan_bytes} unsigned_tx_bytes={raw_bytes} signing_stages=1");
}

#[test]
fn every_task6_operation_completes_through_the_public_external_signer_facade() {
    for name in ["nft-transfer.json", "stablecoin-transfer.json"] {
        let input = bound_fixture(name);
        let (complete, stages) = complete_public(name, &input);
        assert!(complete["bundle"]["transactions"].as_array().is_some_and(|items| !items.is_empty()), "{name}: {complete}");
        assert_eq!(stages, 1, "{name}");
    }
    let (v0, stages) = complete_public("nft-v0-transfer", &bound_nft_v0());
    assert!(v0["bundle"]["transactions"].as_array().is_some_and(|items| items.len() == 1));
    assert_eq!(stages, 1);
    let (v1, stages) = complete_public("nft-v1-transfer", &bound_nft_v1());
    assert!(v1["bundle"]["transactions"].as_array().is_some_and(|items| items.len() == 1));
    assert_eq!(stages, 1);
    let (merged, stages) = complete_public("stablecoin-merge.json", &bound_fixture("stablecoin-merge.json"));
    assert!(merged["bundle"]["transactions"].as_array().is_some_and(|items| items.len() > 1));
    assert!(stages > 1);
}

#[test]
fn stablecoin_unlocks_keep_the_coin_marker_and_fee_headroom_in_every_stage() {
    for name in ["stablecoin-transfer.json", "stablecoin-merge.json"] {
        let input = bound_fixture(name);
        let planned = call(EngineMethod::Plan, &input);
        assert_eq!(planned["ok"], true, "{planned}");
        let (complete, _) = complete_public(name, &input);
        let templates = planned["result"]["plan"]["payload"]["transactions"]
            .as_array()
            .unwrap();
        let finalized = complete["bundle"]["transactions"].as_array().unwrap();
        assert_eq!(templates.len(), finalized.len());

        let mut parents = std::collections::BTreeMap::<String, Transaction>::new();
        for parent in input["snapshot"]["payload"]["parents"].as_array().unwrap() {
            let transaction = Transaction::from_hex(parent["rawTransaction"].as_str().unwrap()).unwrap();
            parents.insert(transaction.txid().to_string(), transaction);
        }
        let fee_rate = input["policy"]["payload"]["feeRateSatPerKb"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();

        for (template, record) in templates.iter().zip(finalized) {
            let transaction = Transaction::from_hex(record["rawTransaction"].as_str().unwrap()).unwrap();
            for asset_input in transaction.inputs.iter().take(transaction.inputs.len() - 1) {
                let parent = parents.get(&asset_input.previous_output.txid.to_string()).unwrap();
                let pre_tx = pre_tx_data(parent, asset_input.previous_output.vout as usize).unwrap();
                let script = asset_input.script_sig.as_bytes();
                assert!(script.ends_with(&pre_tx), "{name}: FT parent suffix must be exact");
                let marker = script.len() - pre_tx.len() - 1;
                assert_eq!(script[marker], 0, "{name}: stablecoin marker must precede preTxData");
                assert_eq!(script[marker - 34], 33, "{name}: marker must follow the 33-byte public key push");
            }
            let paid = template["fee"].as_str().unwrap().parse::<u64>().unwrap();
            let minimum = (u64::try_from(transaction.serialize().len()).unwrap() * fee_rate).div_ceil(1000);
            assert!(paid >= minimum, "{name}: paid={paid} minimum={minimum}");
            parents.insert(transaction.txid().to_string(), transaction);
        }
    }
}

#[test]
fn task6_family_signatures_reject_wrong_key_missing_and_duplicate_entries() {
    for name in ["nft-transfer.json", "stablecoin-transfer.json"] {
        let input = bound_fixture(name);
        let planned = call(EngineMethod::Plan, &input);
        assert_eq!(planned["ok"], true, "{planned}");
        let mut finalize = public_finalize_input(&input, &planned["result"]);
        finalize["signatures"] = sign_tasks(&planned["result"]["plan"]["payload"]["signingTasks"], 2);
        assert_eq!(call(EngineMethod::Finalize, &finalize)["error"]["code"], "INVALID_SIGNATURE");
        finalize["signatures"] = json!([]);
        assert_eq!(call(EngineMethod::Finalize, &finalize)["error"]["code"], "MISSING_SIGNATURE");
        finalize["signatures"] = public_finalize_input(&input, &planned["result"])["signatures"].clone();
        finalize["signatures"][1]["taskId"] = finalize["signatures"][0]["taskId"].clone();
        assert_eq!(call(EngineMethod::Finalize, &finalize)["error"]["code"], "INVALID_SIGNATURE");
        finalize["signatures"] = sign_tasks_with_digest(&planned["result"]["plan"]["payload"]["signingTasks"], 1, Some([7; 32]));
        assert_eq!(call(EngineMethod::Finalize, &finalize)["error"]["code"], "INVALID_SIGNATURE");
        finalize["signatures"] = sign_tasks(&planned["result"]["plan"]["payload"]["signingTasks"], 1);
        make_high_s(&mut finalize["signatures"]);
        assert_eq!(call(EngineMethod::Finalize, &finalize)["error"]["code"], "INVALID_SIGNATURE");
    }
}

#[test]
fn stablecoin_merge_rejects_stale_and_tampered_continuations() {
    let input = bound_fixture("stablecoin-merge.json");
    let planned = call(EngineMethod::Plan, &input);
    assert_eq!(planned["ok"], true, "{planned}");
    let initial = public_finalize_input(&input, &planned["result"]);
    let pending = call(EngineMethod::Finalize, &initial);
    assert_eq!(pending["ok"], true, "{pending}");
    assert_eq!(pending["result"]["status"], "pending");

    let mut stale = initial.clone();
    stale["continuation"] = pending["result"]["continuation"].clone();
    stale["continuation"]["stage"] = json!(0);
    stale["signatures"] = sign_tasks(&pending["result"]["signingRequests"], 1);
    assert_eq!(call(EngineMethod::Finalize, &stale)["error"]["code"], "INVALID_PLAN");

    let mut tampered = initial;
    tampered["continuation"] = pending["result"]["continuation"].clone();
    tampered["continuation"]["signingStage"]["continuation"]["planCommitment"] = json!("00".repeat(32));
    tampered["signatures"] = sign_tasks(&pending["result"]["signingRequests"], 1);
    assert_eq!(call(EngineMethod::Finalize, &tampered)["error"]["code"], "INVALID_PLAN");
}

#[test]
fn later_minted_stablecoin_tranche_plans_and_completes_from_authenticated_supply() {
    let input = bound_later_minted_stablecoin();
    let planned = call(EngineMethod::Plan, &input);
    assert_eq!(planned["ok"], true, "{planned}");
    assert_eq!(planned["result"]["plan"]["payload"]["preview"]["assetFlows"][0]["kind"], "stablecoin");
    let (complete, stages) = complete_public("stablecoin-later-mint", &input);
    assert_eq!(stages, 1);
    assert_eq!(complete["validation"]["valid"], true);
}

#[test]
fn public_family_specific_signature_negatives_cover_v0_v1_and_second_stage() {
    for input in [bound_nft_v0(), bound_nft_v1()] {
        let planned = call(EngineMethod::Plan, &input);
        assert_eq!(planned["ok"], true, "{planned}");
        assert_public_signature_failures(public_finalize_input(&input, &planned["result"]), &planned["result"]["plan"]["payload"]["signingTasks"]);
    }

    let input = bound_fixture("stablecoin-merge.json");
    let planned = call(EngineMethod::Plan, &input);
    assert_eq!(planned["ok"], true, "{planned}");
    let initial = public_finalize_input(&input, &planned["result"]);
    let pending = call(EngineMethod::Finalize, &initial);
    assert_eq!(pending["result"]["status"], "pending", "{pending}");
    let mut second = initial;
    second["continuation"] = pending["result"]["continuation"].clone();
    assert_public_signature_failures(second, &pending["result"]["signingRequests"]);
}

#[test]
fn public_rejects_cross_operation_and_cross_family_continuations() {
    let first = bound_fixture("stablecoin-merge.json");
    let first_plan = call(EngineMethod::Plan, &first);
    let first_initial = public_finalize_input(&first, &first_plan["result"]);
    let first_pending = call(EngineMethod::Finalize, &first_initial);
    assert_eq!(first_pending["result"]["status"], "pending");

    let mut second = bound_fixture("stablecoin-merge.json");
    second["request"]["intent"]["amount"] = json!("540");
    let second = bind(second);
    let second_plan = call(EngineMethod::Plan, &second);
    let second_initial = public_finalize_input(&second, &second_plan["result"]);
    let second_pending = call(EngineMethod::Finalize, &second_initial);
    assert_eq!(second_pending["result"]["status"], "pending");

    let mut swapped = first_initial.clone();
    swapped["continuation"] = second_pending["result"]["continuation"].clone();
    swapped["signatures"] = sign_tasks(&second_pending["result"]["signingRequests"], 1);
    assert_eq!(call(EngineMethod::Finalize, &swapped)["error"]["code"], "INVALID_PLAN");

    let nft = bound_nft_v1();
    let nft_plan = call(EngineMethod::Plan, &nft);
    let mut cross_family = public_finalize_input(&nft, &nft_plan["result"]);
    cross_family["continuation"] = first_pending["result"]["continuation"].clone();
    cross_family["signatures"] = sign_tasks(&first_pending["result"]["signingRequests"], 1);
    assert_eq!(call(EngineMethod::Finalize, &cross_family)["error"]["code"], "INVALID_PLAN");

    let ft = bound_ft_merge();
    let ft_plan = call(EngineMethod::Plan, &ft);
    assert_eq!(ft_plan["ok"], true, "{ft_plan}");
    let ft_initial = public_finalize_input(&ft, &ft_plan["result"]);
    let ft_pending = call(EngineMethod::Finalize, &ft_initial);
    assert_eq!(ft_pending["result"]["status"], "pending", "{ft_pending}");
    let mut stable_to_ft = ft_initial;
    stable_to_ft["continuation"] = first_pending["result"]["continuation"].clone();
    stable_to_ft["signatures"] = sign_tasks(&first_pending["result"]["signingRequests"], 1);
    assert_eq!(call(EngineMethod::Finalize, &stable_to_ft)["error"]["code"], "INVALID_PLAN");

    let mut ft_to_stable = first_initial;
    ft_to_stable["continuation"] = ft_pending["result"]["continuation"].clone();
    ft_to_stable["signatures"] = sign_tasks(&ft_pending["result"]["signingRequests"], 1);
    assert_eq!(call(EngineMethod::Finalize, &ft_to_stable)["error"]["code"], "INVALID_PLAN");
}

#[test]
fn public_second_stage_distinguishes_artifact_from_approval_mismatch() {
    let input = bound_fixture("stablecoin-merge.json");
    let planned = call(EngineMethod::Plan, &input);
    let initial = public_finalize_input(&input, &planned["result"]);
    let pending = call(EngineMethod::Finalize, &initial);
    let signatures = sign_tasks(&pending["result"]["signingRequests"], 1);
    let mut advance = initial.clone();
    advance["continuation"] = pending["result"]["continuation"].clone();
    advance["signatures"] = signatures.clone();
    let complete = call(EngineMethod::Finalize, &advance);
    assert!(complete["result"].get("bundle").is_some(), "{complete}");
    let validation = json!({
        "version": input["version"], "phase": "finalized", "request": input["request"],
        "requestHash": input["requestHash"], "snapshot": input["snapshot"], "policy": input["policy"],
        "plan": planned["result"]["plan"], "binding": advance["binding"], "approval": advance["approval"],
        "signatures": signatures, "continuation": pending["result"]["continuation"], "bundle": complete["result"]["bundle"]
    });

    for mutation in 0..5 {
        let mut artifact = validation.clone();
        if mutation == 4 {
            artifact["continuation"]["stageCommitment"] = json!("00".repeat(32));
        } else {
            let record = &mut artifact["continuation"]["signingStage"]["continuation"]["finalizedTransactions"][0];
            match mutation {
                0 => record["rawTransaction"] = json!("00"),
                1 => record["txid"] = json!("00".repeat(32)),
                2 => {
                    let mut tx = Transaction::from_hex(record["rawTransaction"].as_str().unwrap()).unwrap();
                    tx.inputs[0].sequence ^= 1;
                    record["rawTransaction"] = json!(tx.to_hex());
                }
                _ => {
                    let mut tx = Transaction::from_hex(record["rawTransaction"].as_str().unwrap()).unwrap();
                    let mut tape = tx.outputs[1].script_pubkey.as_bytes().to_vec();
                    let index = tape.len() - 7;
                    tape[index] ^= 1;
                    tx.outputs[1].script_pubkey = tbc_sdk::script::Script::from_bytes(tape);
                    record["rawTransaction"] = json!(tx.to_hex());
                }
            }
        }
        let result = call(EngineMethod::Validate, &artifact);
        let codes = result["result"]["violations"].as_array().unwrap().iter().map(|item| item["code"].as_str().unwrap()).collect::<Vec<_>>();
        assert!(codes.contains(&"ARTIFACT_MISMATCH"), "{result}");
        assert!(!codes.contains(&"APPROVAL_BINDING_MISMATCH"), "{result}");
    }

    let mut approval = validation;
    approval["approval"]["bindingHash"] = json!("00".repeat(32));
    let result = call(EngineMethod::Validate, &approval);
    let codes = result["result"]["violations"].as_array().unwrap().iter().map(|item| item["code"].as_str().unwrap()).collect::<Vec<_>>();
    assert!(codes.contains(&"APPROVAL_BINDING_MISMATCH"), "{result}");
}
