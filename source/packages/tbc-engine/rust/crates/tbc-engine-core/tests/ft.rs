use serde_json::{Value, json};
#[path = "support/optional_confirmations.rs"]
mod optional_confirmations;
#[path = "support/fragmented_funding.rs"]
mod fragmented_funding;
#[path = "support/unified_business.rs"]
mod unified_business;

#[test]
fn unified_historical_ft_signing_rounds_match_concrete() {
    unified_business::exercise(transfer_plan_input("mergeRequired"), "tbc20.transfer");
    let mut merge = transfer_plan_input("mergeRequired");
    merge["request"]["intent"] = json!({"type":"tbc.ft.merge","version":"1.0","contractId":merge["request"]["intent"]["contractId"]});
    let mut count = 0;
    merge["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().retain(|u| {
        if u["classification"] != "ft" { return true; } count += 1; count <= 5
    });
    unified_business::exercise(bind_request(merge), "tbc20.merge");
}

#[test]
fn staged_ft_output_review_binds_each_transaction_balance_and_destination() {
    let p=transfer_plan_input("mergeRequired");
    let plan=call_ok(EngineMethod::Plan,&p)["plan"].clone();
    let txs=plan["payload"]["transactions"].as_array().unwrap();assert!(txs.len()>1);
    for t in txs {
        let raw=Transaction::from_hex(t["unsignedTransaction"].as_str().unwrap()).unwrap();
        let rows=t["outputReview"].as_array().unwrap();
        assert_eq!(rows.iter().flat_map(|r|r["outputIndices"].as_array().unwrap()).map(|i|i.as_u64().unwrap()).collect::<Vec<_>>(),(0..raw.outputs.len() as u64).collect::<Vec<_>>());
        assert!(rows.iter().all(|r|r["kind"]!="unrecognized"),"{}",t["id"]);
        let tokens=rows.iter().filter(|r|r["kind"].as_str().unwrap().starts_with("historical-ft"));
        if t["role"]=="maintenance" {for row in tokens {assert_eq!(row["recipient"],p["request"]["from"]);}}
        else {assert!(tokens.into_iter().any(|r|r["recipient"]==p["request"]["intent"]["to"] && r["amountAtomic"]==p["request"]["intent"]["amount"]));}
    }
    for field in ["amountAtomic","recipient","assetIdentity"] {
        let mut altered=plan.clone();altered["payload"]["transactions"][0]["outputReview"][0][field]=json!(if field=="amountAtomic" {"999999"} else {"forged"});
        altered["planHash"]=json!(canonical_hash(&altered["payload"]));
        let mut check=p.clone();check["phase"]=json!("plan");check["plan"]=altered;
        assert_eq!(call_ok(EngineMethod::Validate,&check)["valid"],false,"rehashing a false {field} must not authorize it");
    }
}

#[test]
fn optional_confirmations_ft_thresholds_and_hash_binding() {
    for input in [transfer_plan_input("direct"), transfer_plan_input("mergeRequired")] {
        optional_confirmations::exercise(input);
    }
}

use secp256k1::{Message, Secp256k1, SecretKey};
use sha2::{Digest, Sha256};
use tbc_engine_core::{EngineMethod, call_json};
use tbc_engine_core::signing::{
    ExternalSignature, PlannedInput, PlannedOutput, PlannedTransaction, PublicSigningContext,
    StageOutcome, UnsignedPlan, begin_signing, finalize_signing_stage,
};
use tbc_sdk::{
    Address, OutPoint, Transaction, TxIn, TxOut, Txid,
    contracts::ft::{
        scripts::{
            FtCodeReceiver, FtMintVersion, mint_code_script_with_version, mint_source_script,
            mint_tape_script, transfer_code_script,
        },
        unlock::pre_tx_data,
    },
    script::Script,
};

fn vector(name: &str) -> Value {
    let source = match name {
        "ft-create-v4.json" => include_str!("../../../fixtures/ft-create-v4.json"),
        "ft-transfer.json" => include_str!("../../../fixtures/ft-transfer.json"),
        "ft-merge.json" => include_str!("../../../fixtures/ft-merge.json"),
        _ => panic!("unknown FT fixture {name}"),
    };
    serde_json::from_str(source).expect("the checked-in FT fixture must be valid JSON")
}

fn base_plan_input() -> Value {
    serde_json::from_str::<Value>(include_str!("../../../fixtures/tbc-transfer.json"))
        .expect("the checked-in TBC fixture must be valid JSON")["planInput"]
        .clone()
}

fn call(method: EngineMethod, input: &Value) -> Value {
    serde_json::from_str(&call_json(method, &input.to_string()))
        .expect("the Engine must always return JSON")
}

fn call_ok(method: EngineMethod, input: &Value) -> Value {
    let envelope = call(method, input);
    assert_eq!(envelope["ok"], true, "{envelope}");
    envelope["result"].clone()
}

fn call_error(method: EngineMethod, input: &Value) -> Value {
    let envelope = call(method, input);
    assert_eq!(envelope["ok"], false, "{envelope}");
    envelope["error"].clone()
}

fn canonical_hash(value: &Value) -> String {
    let digest = Sha256::digest(serde_json::to_vec(value).unwrap());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let nibble = |byte| match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                _ => panic!("fixture hex is lowercase"),
            };
            (nibble(pair[0]) << 4) | nibble(pair[1])
        })
        .collect()
}

fn bind_request(mut params: Value) -> Value {
    let normalized = call_ok(
        EngineMethod::NormalizeRequest,
        &json!({"version": "1.0", "request": params["request"].clone()}),
    );
    params["request"] = normalized["request"].clone();
    params["requestHash"] = normalized["requestHash"].clone();
    params["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&params["snapshot"]["payload"]));
    params["policy"]["policyHash"] = json!(canonical_hash(&params["policy"]["payload"]));
    params
}

fn create_plan_input() -> Value {
    let fixture = vector("ft-create-v4.json");
    let mut params = base_plan_input();
    params["request"]["clientRequestId"] = json!("ft-create-v4");
    params["request"]["intent"] = fixture["intent"].clone();
    params["request"]["constraints"]["maxFee"] = json!("5000");
    bind_request(params)
}

fn transfer_plan_input(variant: &str) -> Value {
    let fixture = vector("ft-transfer.json");
    let case = &fixture[variant];
    let balances = case["balances"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().parse::<u64>().unwrap())
        .collect::<Vec<_>>();
    let (asset_utxos, asset_parents, contract) = asset_material(&balances);
    let mut params = base_plan_input();
    let native_utxo = params["snapshot"]["payload"]["utxos"][0].clone();
    let native_parent = params["snapshot"]["payload"]["parents"][0].clone();
    params["request"]["clientRequestId"] = json!(format!("ft-transfer-{variant}"));
    params["request"]["intent"] = json!({
        "type": "tbc.ft.transfer",
        "version": "1.0",
        "contractId": contract["contractId"].clone(),
        "to": case["to"].clone(),
        "amount": case["amount"].clone(),
        "attachedTbcAmount": case["attachedTbcAmount"].clone()
    });
    params["request"]["constraints"]["maxFee"] = json!("5000");
    params["snapshot"]["payload"]["utxos"] = json!([native_utxo]);
    params["snapshot"]["payload"]["utxos"]
        .as_array_mut()
        .unwrap()
        .extend(asset_utxos);
    params["snapshot"]["payload"]["parents"] = json!([native_parent]);
    params["snapshot"]["payload"]["parents"]
        .as_array_mut()
        .unwrap()
        .extend(asset_parents);
    params["snapshot"]["payload"]["contracts"] = json!([contract]);
    params["policy"]["payload"]["amountLimits"] = json!([]);
    bind_request(params)
}

fn asset_material(balances: &[u64]) -> (Vec<Value>, Vec<Value>, Value) {
    asset_material_seed(balances, 0x91)
}

fn asset_material_seed(balances: &[u64], seed: u8) -> (Vec<Value>, Vec<Value>, Value) {
    asset_material_seed_with_metadata(balances, seed, "Task Five Token", "TFT")
}

fn asset_material_seed_with_metadata(balances: &[u64], seed: u8, name: &str, symbol: &str) -> (Vec<Value>, Vec<Value>, Value) {
    let sender = Address::from_string("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH").unwrap();
    let total_supply = balances.iter().copied().sum::<u64>();
    let mut full_amount = [0u8; 48];
    full_amount[..8].copy_from_slice(&total_supply.to_le_bytes());
    let base_tape = mint_tape_script(&full_amount, 6, name, symbol);
    let source = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn {
            previous_output: OutPoint {
                txid: Txid::from_le_bytes([seed; 32]),
                vout: 0,
            },
            script_sig: Script::from_bytes(vec![0x51]),
            sequence: tbc_sdk::DEFAULT_SEQUENCE,
        }],
        outputs: vec![
            TxOut {
                satoshis: 9_900,
                script_pubkey: mint_source_script(&sender),
            },
            TxOut {
                satoshis: 0,
                script_pubkey: base_tape.clone(),
            },
        ],
        lock_time: 0,
    };
    let code = mint_code_script_with_version(
        &source.txid().to_string(),
        0,
        &sender,
        base_tape.as_bytes().len(),
        FtMintVersion::V4,
    )
    .unwrap();
    let mut utxos = Vec::new();
    let creation = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint {
            txid: source.txid(),
            vout: 0,
        })],
        outputs: vec![
            TxOut {
                satoshis: 500,
                script_pubkey: code.clone(),
            },
            TxOut {
                satoshis: 0,
                script_pubkey: base_tape,
            },
        ],
        lock_time: 0,
    };
    let contract_id = creation.txid().to_string();
    let mut parents = vec![
        json!({"txid": source.txid().to_string(), "rawTransaction": source.to_hex()}),
        json!({"txid": contract_id, "rawTransaction": creation.to_hex()}),
    ];
    let mut parent_txids = Vec::new();

    for (index, balance) in balances.iter().copied().enumerate() {
        let marker = u32::try_from(index + 1).unwrap();
        let marker_byte = u8::try_from(marker).ok();
        let mut marker_txid = marker_byte.map_or([seed; 32], |byte| [byte; 32]);
        if marker_byte.is_none() {
            marker_txid[..4].copy_from_slice(&marker.to_le_bytes());
        }
        if seed != 0x91 {
            marker_txid[31] = seed;
        }
        let marker_script = marker_byte.map_or_else(
            || marker.to_le_bytes().to_vec(),
            |byte| vec![byte],
        );
        let grandparent = Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_le_bytes(marker_txid),
                    vout: marker,
                },
                script_sig: Script::from_bytes([vec![0x51], marker_script.clone()].concat()),
                sequence: tbc_sdk::DEFAULT_SEQUENCE,
            }],
            outputs: vec![TxOut {
                satoshis: 500,
                script_pubkey: Script::from_bytes(vec![0x51]),
            }],
            lock_time: marker,
        };
        let mut amount = [0u8; 48];
        amount[..8].copy_from_slice(&balance.to_le_bytes());
        let parent = Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![TxIn {
                previous_output: OutPoint {
                    txid: grandparent.txid(),
                    vout: 0,
                },
                script_sig: Script::from_bytes([vec![0x52], marker_script].concat()),
                sequence: tbc_sdk::DEFAULT_SEQUENCE,
            }],
            outputs: vec![
                TxOut {
                    satoshis: 500,
                    script_pubkey: code.clone(),
                },
                TxOut {
                    satoshis: 0,
                    script_pubkey: mint_tape_script(&amount, 6, name, symbol),
                },
            ],
            lock_time: marker,
        };
        parent_txids.push(parent.txid().to_string());
        parents.push(json!({
            "txid": parent.txid().to_string(),
            "rawTransaction": parent.to_hex()
        }));
        parents.push(json!({
            "txid": grandparent.txid().to_string(),
            "rawTransaction": grandparent.to_hex()
        }));
        utxos.push(json!({
            "txid": parent.txid().to_string(),
            "vout": 0,
            "satoshis": "500",
            "scriptPubKey": encode_hex(code.as_bytes()),
            "confirmations": "100",
            "classification": "ft",
            "contractId": "pending"
        }));
    }

    for utxo in &mut utxos {
        utxo["contractId"] = json!(contract_id.clone());
    }
    let contract = json!({
        "contractId": contract_id.clone(),
        "family": "ft",
        "protocolVersion": "4.0",
        "creationTxid": contract_id,
        "currentOutpoint": {"txid": parent_txids.last().unwrap(), "vout": 0}
    });
    (utxos, parents, contract)
}

fn roles(result: &Value) -> Vec<&str> {
    result["plan"]["payload"]["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|transaction| transaction["role"].as_str().unwrap())
        .collect()
}

#[test]
fn ft_create_v4_is_disabled_without_rewriting_the_historical_fixture() {
    assert_eq!(call_error(EngineMethod::Plan, &create_plan_input())["code"], "UNSUPPORTED_INTENT");
}

#[test]
fn unified_ft_request_preserves_binding_and_legacy_transaction_bytes() {
    let concrete = transfer_plan_input("mergeRequired");
    let before = call_ok(EngineMethod::Plan, &concrete);
    let mut unified = concrete.clone();
    unified["request"]["intent"]["type"] = json!("tbc20.transfer");
    let attached = unified["request"]["intent"].as_object_mut().unwrap().remove("attachedTbcAmount").unwrap();
    unified["request"]["intent"]["payment"] = json!({"to":unified["request"]["intent"]["to"],"amount":attached});
    let unified = bind_request(unified);
    let after = call_ok(EngineMethod::Plan, &unified);
    assert_eq!(after["plan"]["payload"]["requestHash"], unified["requestHash"]);
    assert_ne!(unified["requestHash"], concrete["requestHash"]);
    assert_eq!(after["plan"]["payload"]["transactions"], before["plan"]["payload"]["transactions"]);
    assert_eq!(after["plan"]["payload"]["signingTasks"], before["plan"]["payload"]["signingTasks"]);
    let mut validation = unified.clone();
    validation["phase"] = json!("plan");
    validation["plan"] = after["plan"].clone();
    assert_eq!(call_ok(EngineMethod::Validate, &validation)["valid"], true);
    validation["plan"] = before["plan"].clone();
    assert_eq!(call_ok(EngineMethod::Validate, &validation)["valid"], false);
}

#[test]
fn ft_transfer_inserts_merge_only_when_selected_inputs_require_it() {
    let direct = call_ok(EngineMethod::Plan, &transfer_plan_input("direct"));
    let merged = call_ok(EngineMethod::Plan, &transfer_plan_input("mergeRequired"));
    assert_eq!(roles(&direct), ["primary"]);
    assert_eq!(roles(&merged), ["maintenance", "primary"]);
    assert_eq!(
        merged["plan"]["payload"]["transactions"][1]["dependsOn"],
        json!([merged["plan"]["payload"]["transactions"][0]["id"].clone()])
    );
    // Keep the old vector immutable. The new local display projection is the
    // only added field; transaction bytes/fees/digests must still be identical.
    let mut direct_historical=direct["plan"]["payload"].clone();
    for t in direct_historical["transactions"].as_array_mut().unwrap(){t.as_object_mut().unwrap().remove("outputReview");}
    assert_eq!(canonical_hash(&direct_historical), vector("ft-transfer.json")["direct"]["expected"]["planHash"]);
    assert_eq!(
        merged["plan"]["payload"]["transactions"]
            .as_array().unwrap().iter()
            .map(|transaction| transaction["templateHash"].clone()).collect::<Vec<_>>(),
        vector("ft-transfer.json")["mergeRequired"]["expected"]["templateHashes"]
            .as_array().unwrap().clone()
    );
    assert_eq!(
        merged["plan"]["payload"]["signingTasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|task| task["digest"].clone())
            .collect::<Vec<_>>(),
        vector("ft-transfer.json")["mergeRequired"]["expected"]["stageZeroDigests"]
            .as_array()
            .unwrap()
            .clone()
    );
    // Current approvals bind all nine signatures and both outputs of the
    // maintenance transaction, not just the first stage's six signatures.
    // Preserve the historical vector and prove these are the only differences;
    // unsigned bytes, fees, initial digests and every other payload field remain.
    assert_eq!(merged["plan"]["payload"]["preview"]["signingTaskCount"], 9);
    assert_eq!(merged["plan"]["payload"]["transactions"][1]["deferredInputs"], json!([
        {"inputIndex":0,"sourceTransactionId":"ft-merge-1","sourceOutputIndex":0},
        {"inputIndex":2,"sourceTransactionId":"ft-merge-1","sourceOutputIndex":2},
    ]));
    let mut historical_payload = merged["plan"]["payload"].clone();
    historical_payload["preview"].as_object_mut().unwrap().remove("signingTaskCount");
    for transaction in historical_payload["transactions"].as_array_mut().unwrap() {
        transaction.as_object_mut().unwrap().remove("deferredInputs");
        transaction.as_object_mut().unwrap().remove("outputReview");
    }
    assert_eq!(canonical_hash(&historical_payload), vector("ft-transfer.json")["mergeRequired"]["expected"]["planHash"], "only signing count, deferred-input edges and bound output disclosure may change the historical hash");
    assert_eq!(merged["plan"]["planHash"], canonical_hash(&merged["plan"]["payload"]));
}

#[test]
fn ft_public_merge_is_one_primary_transaction_and_requires_multiple_inputs() {
    let mut input = transfer_plan_input("mergeRequired");
    let contract_id = input["request"]["intent"]["contractId"].clone();
    input["request"]["clientRequestId"] = json!("ft-public-merge");
    input["request"]["intent"] = json!({
        "type": "tbc.ft.merge",
        "version": "1.0",
        "contractId": contract_id,
    });
    let mut seen = 0usize;
    input["snapshot"]["payload"]["utxos"]
        .as_array_mut()
        .unwrap()
        .retain(|utxo| {
            if utxo["classification"] != "ft" {
                return true;
            }
            seen += 1;
            seen <= 5
        });
    input = bind_request(input);
    let result = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&result), ["primary"]);
    assert_eq!(result["plan"]["payload"]["transactions"][0]["id"], "ft-merge-1");
    assert_eq!(result["plan"]["payload"]["preview"]["assetFlows"][0]["direction"], "merge");

    let mut single = input;
    let mut retained = false;
    single["snapshot"]["payload"]["utxos"]
        .as_array_mut()
        .unwrap()
        .retain(|utxo| {
            if utxo["classification"] != "ft" {
                return true;
            }
            if retained {
                false
            } else {
                retained = true;
                true
            }
        });
    single = bind_request(single);
    assert_eq!(call_error(EngineMethod::Plan, &single)["code"], "INSUFFICIENT_FUNDS");
}

#[test]
fn ft_rejects_tampered_ancestry_and_insufficient_token_balance() {
    let mut ancestry = transfer_plan_input("direct");
    ancestry["snapshot"]["payload"]["parents"][1]["txid"] = json!("00".repeat(32));
    ancestry["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&ancestry["snapshot"]["payload"]));
    assert_eq!(
        call_error(EngineMethod::Plan, &ancestry)["code"],
        "INVALID_ANCESTRY"
    );

    let mut insufficient = transfer_plan_input("direct");
    insufficient["request"]["intent"]["amount"] = json!("1001");
    insufficient = bind_request(insufficient);
    assert_eq!(
        call_error(EngineMethod::Plan, &insufficient)["code"],
        "INSUFFICIENT_FUNDS"
    );
}

#[test]
fn ft_enforces_attached_tbc_dust_and_deterministic_planning() {
    let direct = transfer_plan_input("direct");
    assert_eq!(
        call_ok(EngineMethod::Plan, &direct),
        call_ok(EngineMethod::Plan, &direct)
    );

    let mut dust = direct;
    dust["request"]["intent"]["attachedTbcAmount"] = json!("23");
    dust = bind_request(dust);
    assert_eq!(call_error(EngineMethod::Plan, &dust)["code"], "INVALID_INPUT");
}

#[test]
fn ft_rejects_wrong_contract_fee_cap_and_malformed_parent() {
    let mut wrong_contract = transfer_plan_input("direct");
    wrong_contract["request"]["intent"]["contractId"] = json!("11".repeat(32));
    wrong_contract = bind_request(wrong_contract);
    assert_eq!(
        call_error(EngineMethod::Plan, &wrong_contract)["code"],
        "INVALID_ANCESTRY"
    );

    let mut capped = transfer_plan_input("direct");
    capped["request"]["constraints"]["maxFee"] = json!("439");
    capped = bind_request(capped);
    assert_eq!(call_error(EngineMethod::Plan, &capped)["code"], "FEE_CAP_EXCEEDED");

    let mut malformed = transfer_plan_input("direct");
    malformed["snapshot"]["payload"]["parents"][1]["rawTransaction"] = json!("00");
    malformed["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&malformed["snapshot"]["payload"]));
    assert_eq!(
        call_error(EngineMethod::Plan, &malformed)["code"],
        "INVALID_ANCESTRY"
    );
}

#[test]
fn ft_create_and_token_change_boundaries_are_closed() {
    for (field, value) in [
        ("symbol", json!("")),
        ("decimals", json!(19)),
        ("initialSupply", json!("1000000000000000001")),
    ] {
        let fixture = vector("ft-create-v4.json");
        let mut input = json!({
            "version": "1.0",
            "request": base_plan_input()["request"].clone()
        });
        input["request"]["intent"] = fixture["intent"].clone();
        input["request"]["intent"][field] = value;
        assert_eq!(
            call_error(EngineMethod::NormalizeRequest, &input)["code"],
            "INVALID_INPUT"
        );
    }

    let mut exact = transfer_plan_input("direct");
    exact["request"]["intent"]["amount"] = json!("1000");
    exact = bind_request(exact);
    let exact_plan = call_ok(EngineMethod::Plan, &exact);
    let exact_tx = Transaction::from_hex(
        exact_plan["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(exact_tx.outputs.len(), 4, "exact spend has no FT change pair");

    let mut one_unit_change = transfer_plan_input("direct");
    one_unit_change["request"]["intent"]["amount"] = json!("999");
    one_unit_change = bind_request(one_unit_change);
    let change_plan = call_ok(EngineMethod::Plan, &one_unit_change);
    let change_tx = Transaction::from_hex(
        change_plan["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(change_tx.outputs.len(), 6, "one raw token unit is conserved as FT change");
}

#[test]
fn ft_covenant_input_finalizes_from_an_external_signature_only() {
    let (utxos, parents, _) = asset_material(&[1_000]);
    let utxo = &utxos[0];
    let parent = Transaction::from_hex(
        parents
            .iter()
            .find(|candidate| candidate["txid"] == utxo["txid"])
            .unwrap()["rawTransaction"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let grandparent_txid = parent.inputs[0].previous_output.txid.to_string();
    let grandparent_raw = parents
        .iter()
        .find(|candidate| candidate["txid"] == grandparent_txid)
        .unwrap()["rawTransaction"]
        .as_str()
        .unwrap();
    let recipe = json!({
        "parent": {"kind": "raw", "value": parent.to_hex()},
        "proofReferences": [{
            "source": {"kind": "raw", "value": grandparent_raw},
            "outputIndex": 0
        }],
        "coinMode": false
    });
    let signer = PublicSigningContext {
        address: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH".to_owned(),
        public_key: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
            .to_owned(),
        public_key_hash: "751e76e8199196d454941c45d1b3a323f1433bd6".to_owned(),
    };
    let plan = UnsignedPlan {
        evidence_table: Vec::new(),
        transactions: vec![PlannedTransaction {
            transaction_id: "ft-signature-vector".to_owned(),
            role: "primary".to_owned(),
            stage: 0,
            depends_on: vec![],
            version: tbc_sdk::TX_VERSION,
            inputs: vec![PlannedInput {
                previous_transaction_id: utxo["txid"].as_str().unwrap().to_owned(),
                previous_output_index: 0,
                previous_output_script: utxo["scriptPubKey"].as_str().unwrap().to_owned(),
                previous_output_satoshis: 500,
                sequence: tbc_sdk::DEFAULT_SEQUENCE,
                unlocking_script: format!(
                    "ft1:{}",
                    encode_hex(&serde_json::to_vec(&recipe).unwrap())
                ),
                signer: signer.clone(),
            }],
            outputs: vec![
                PlannedOutput {
                    satoshis: 500,
                    locking_script: utxo["scriptPubKey"].as_str().unwrap().to_owned(),
                },
                PlannedOutput {
                    satoshis: 0,
                    locking_script: encode_hex(parent.outputs[1].script_pubkey.as_bytes()),
                },
            ],
            lock_time: 0,
        }],
    };
    let stage = begin_signing(&plan).unwrap();
    assert_eq!(stage.signing_requests[0].script_class, "ft-covenant");
    let digest: [u8; 32] = decode_hex(&stage.signing_requests[0].digest)
        .try_into()
        .unwrap();
    let mut secret_bytes = [0u8; 32];
    secret_bytes[31] = 1;
    let secret = SecretKey::from_byte_array(secret_bytes).unwrap();
    let der = Secp256k1::new()
        .sign_ecdsa(Message::from_digest(digest), &secret)
        .serialize_der();
    let request = &stage.signing_requests[0];
    let external = ExternalSignature {
        session_id: request.session_id.clone(),
        stage: request.stage,
        stage_commitment: request.stage_commitment.clone(),
        transaction_id: request.transaction_id.clone(),
        input_index: request.input_index,
        digest: request.digest.clone(),
        public_key: request.public_key.clone(),
        signature: encode_hex(&der),
    };
    let outcome = finalize_signing_stage(&plan, stage, &[external]).unwrap();
    let StageOutcome::Complete(bundle) = outcome else {
        panic!("single-stage FT signature vector must complete");
    };
    let signed = Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap();
    assert!(!signed.inputs[0].script_sig.as_bytes().is_empty());

    let mut mismatched = plan;
    let mut mismatched_recipe = recipe;
    mismatched_recipe["coinMode"] = json!(true);
    mismatched.transactions[0].inputs[0].unlocking_script = format!(
        "ft1:{}",
        encode_hex(&serde_json::to_vec(&mismatched_recipe).unwrap())
    );
    let mismatched_stage = begin_signing(&mismatched).unwrap();
    let request = &mismatched_stage.signing_requests[0];
    let digest: [u8; 32] = decode_hex(&request.digest).try_into().unwrap();
    let der = Secp256k1::new()
        .sign_ecdsa(Message::from_digest(digest), &secret)
        .serialize_der();
    let mismatched_signature = ExternalSignature {
        session_id: request.session_id.clone(),
        stage: request.stage,
        stage_commitment: request.stage_commitment.clone(),
        transaction_id: request.transaction_id.clone(),
        input_index: request.input_index,
        digest: request.digest.clone(),
        public_key: request.public_key.clone(),
        signature: encode_hex(&der),
    };
    assert_eq!(
        finalize_signing_stage(&mismatched, mismatched_stage, &[mismatched_signature])
            .unwrap_err()
            .message,
        "FT unlocking coin mode does not match the authenticated covenant"
    );
}

fn replace_native_funding(
    params: &mut Value,
    address: &str,
    public_key: &str,
    public_key_hash: &str,
    satoshis: u64,
) {
    let script = format!("76a914{public_key_hash}88ac");
    let transaction = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn {
            previous_output: OutPoint {
                txid: Txid::from_le_bytes([0x77; 32]),
                vout: 0,
            },
            script_sig: Script::from_bytes(vec![0x51, 0x77]),
            sequence: tbc_sdk::DEFAULT_SEQUENCE,
        }],
        outputs: vec![TxOut {
            satoshis,
            script_pubkey: Script::from_bytes(decode_hex(&script)),
        }],
        lock_time: 0,
    };
    let txid = transaction.txid().to_string();
    params["request"]["from"] = json!(address);
    params["snapshot"]["payload"]["account"]["address"] = json!(address);
    params["snapshot"]["payload"]["account"]["accountId"] = json!(format!(
        "{}:{address}",
        params["request"]["chainId"].as_str().unwrap()
    ));
    params["snapshot"]["payload"]["account"]["publicKey"] = json!(public_key);
    params["snapshot"]["payload"]["utxos"][0] = json!({
        "txid": txid,
        "vout": 0,
        "satoshis": satoshis.to_string(),
        "scriptPubKey": script,
        "confirmations": "100",
        "classification": "native"
    });
    params["snapshot"]["payload"]["parents"][0] = json!({
        "txid": txid,
        "rawTransaction": transaction.to_hex()
    });
}

fn append_native_funding(input: &mut Value, count: usize, satoshis: u64) {
    let script = input["snapshot"]["payload"]["utxos"][0]["scriptPubKey"]
        .as_str()
        .unwrap()
        .to_owned();
    for marker in 1..=count {
        let marker = u32::try_from(marker).unwrap();
        let transaction = Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_le_bytes(Sha256::digest(marker.to_le_bytes()).into()),
                    vout: marker,
                },
                script_sig: Script::from_bytes(vec![0x51, (marker & 0xff) as u8]),
                sequence: u32::MAX,
            }],
            outputs: vec![TxOut {
                satoshis,
                script_pubkey: Script::from_bytes(decode_hex(&script)),
            }],
            lock_time: marker,
        };
        let txid = transaction.txid().to_string();
        input["snapshot"]["payload"]["utxos"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "txid": txid,
                "vout": 0,
                "satoshis": satoshis.to_string(),
                "scriptPubKey": script,
                "confirmations": "100",
                "classification": "native"
            }));
        input["snapshot"]["payload"]["parents"]
            .as_array_mut()
            .unwrap()
            .push(json!({"txid": txid, "rawTransaction": transaction.to_hex()}));
    }
}

fn append_native_funding_values(input: &mut Value, values: &[u64]) -> Vec<String> {
    let script = input["snapshot"]["payload"]["utxos"][0]["scriptPubKey"]
        .as_str()
        .unwrap()
        .to_owned();
    values
        .iter()
        .enumerate()
        .map(|(index, satoshis)| {
            let marker = u32::try_from(20_000 + index).unwrap();
            let transaction = Transaction {
                version: tbc_sdk::TX_VERSION,
                inputs: vec![TxIn {
                    previous_output: OutPoint {
                        txid: Txid::from_le_bytes(Sha256::digest(marker.to_le_bytes()).into()),
                        vout: marker,
                    },
                    script_sig: Script::from_bytes(vec![0x51, (marker & 0xff) as u8]),
                    sequence: u32::MAX,
                }],
                outputs: vec![TxOut {
                    satoshis: *satoshis,
                    script_pubkey: Script::from_bytes(decode_hex(&script)),
                }],
                lock_time: marker,
            };
            let txid = transaction.txid().to_string();
            input["snapshot"]["payload"]["utxos"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "txid": txid,
                    "vout": 0,
                    "satoshis": satoshis.to_string(),
                    "scriptPubKey": script,
                    "confirmations": "100",
                    "classification": "native"
                }));
            input["snapshot"]["payload"]["parents"]
                .as_array_mut()
                .unwrap()
                .push(json!({"txid": txid, "rawTransaction": transaction.to_hex()}));
            txid
        })
        .collect()
}

#[test]
fn ft_rejects_duplicate_native_snapshot_outpoints_before_assignment() {
    let mut input = transfer_plan_input("direct");
    let duplicate = input["snapshot"]["payload"]["utxos"][0].clone();
    input["snapshot"]["payload"]["utxos"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    input = bind_request(input);

    let error = call_error(EngineMethod::Plan, &input);
    assert_eq!(error["code"], "INVALID_ANCESTRY");
    assert_eq!(error["path"], "snapshot.payload.utxos");
    assert_eq!(
        error["message"],
        "native funding snapshot contains a duplicate outpoint"
    );
}

#[test]
fn ft_funding_skips_insufficient_candidates_and_breaks_equal_value_ties_by_outpoint() {
    let mut direct = transfer_plan_input("direct");
    replace_native_funding(
        &mut direct,
        "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        "751e76e8199196d454941c45d1b3a323f1433bd6",
        1,
    );
    let sufficient = append_native_funding_values(&mut direct, &[100_000_000]);
    direct = bind_request(direct);
    let planned = call_ok(EngineMethod::Plan, &direct);
    let raw = planned["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
        .as_str()
        .unwrap();
    let transaction = Transaction::from_hex(raw).unwrap();
    assert_eq!(
        transaction.inputs.last().unwrap().previous_output.txid.to_string(),
        sufficient[0]
    );

    let mut maintenance = transfer_plan_input("mergeRequired");
    maintenance["request"]["intent"]["attachedTbcAmount"] = json!("10000");
    replace_native_funding(
        &mut maintenance,
        "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        "751e76e8199196d454941c45d1b3a323f1433bd6",
        1,
    );
    let maintenance_funding = append_native_funding_values(&mut maintenance, &[100_000_000]);
    maintenance = bind_request(maintenance);
    let planned = call_ok(EngineMethod::Plan, &maintenance);
    let raw = planned["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
        .as_str()
        .unwrap();
    let transaction = Transaction::from_hex(raw).unwrap();
    assert_eq!(
        transaction.inputs.last().unwrap().previous_output.txid.to_string(),
        maintenance_funding[0]
    );

    let mut tied = transfer_plan_input("direct");
    replace_native_funding(
        &mut tied,
        "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        "751e76e8199196d454941c45d1b3a323f1433bd6",
        1,
    );
    let tied_txids = append_native_funding_values(&mut tied, &[100_000_000, 100_000_000]);
    tied = bind_request(tied);
    let planned = call_ok(EngineMethod::Plan, &tied);
    let transaction = Transaction::from_hex(
        planned["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        transaction.inputs.last().unwrap().previous_output.txid.to_string(),
        *tied_txids.iter().min().unwrap()
    );

    let mut insufficient = transfer_plan_input("direct");
    replace_native_funding(
        &mut insufficient,
        "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        "751e76e8199196d454941c45d1b3a323f1433bd6",
        1,
    );
    append_native_funding_values(&mut insufficient, &[2]);
    insufficient = bind_request(insufficient);
    assert_eq!(
        call_error(EngineMethod::Plan, &insufficient)["code"],
        "INSUFFICIENT_FUNDS"
    );
}

fn plan_with_native_value(template: &Value, satoshis: u64) -> Value {
    let mut input = template.clone();
    replace_native_funding(
        &mut input,
        "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        "751e76e8199196d454941c45d1b3a323f1433bd6",
        satoshis,
    );
    call(EngineMethod::Plan, &bind_request(input))
}

fn minimum_successful_native_value(template: &Value) -> u64 {
    let mut low = 0u64;
    let mut high = 100_000_000u64;
    while low < high {
        let middle = low + (high - low) / 2;
        if plan_with_native_value(template, middle)["ok"] == true {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    low
}

#[test]
fn ft_exact_p2pkh_change_threshold_and_missing_25_byte_regression() {
    const HIGH_FUNDING: u64 = 100_000_000;
    const FEE_RATE: u64 = 2_000;
    let mut direct = transfer_plan_input("direct");
    direct["policy"]["payload"]["feeRateSatPerKb"] = json!(FEE_RATE.to_string());
    direct["request"]["constraints"]["maxFee"] = json!("10000000");
    let high = plan_with_native_value(&direct, HIGH_FUNDING);
    assert_eq!(high["ok"], true, "{high}");
    let high_transaction = &high["result"]["plan"]["payload"]["transactions"][0];
    let high_preview = Transaction::from_hex(
        high_transaction["unsignedTransaction"].as_str().unwrap(),
    ).unwrap();
    let high_change = high_preview.outputs.last().unwrap();
    assert_eq!(high_change.script_pubkey.as_bytes().len(), 25);
    let exact_threshold = HIGH_FUNDING - high_change.satoshis + tbc_sdk::SDK_DUST_SAT;

    let below = plan_with_native_value(&direct, exact_threshold - 1);
    assert_eq!(below["ok"], true, "{below}");
    let below_tx = Transaction::from_hex(
        below["result"]["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
            .as_str().unwrap(),
    ).unwrap();
    assert_eq!(below_tx.outputs.len() + 1, high_preview.outputs.len());

    for (candidate, expected_change) in [
        (exact_threshold, tbc_sdk::SDK_DUST_SAT),
        (exact_threshold + 1, tbc_sdk::SDK_DUST_SAT + 1),
    ] {
        let planned = plan_with_native_value(&direct, candidate);
        assert_eq!(planned["ok"], true, "{planned}");
        let transaction = Transaction::from_hex(
            planned["result"]["plan"]["payload"]["transactions"][0]
                ["unsignedTransaction"].as_str().unwrap(),
        ).unwrap();
        assert_eq!(transaction.outputs.last().unwrap().satoshis, expected_change);
        assert_eq!(
            planned["result"]["plan"]["payload"]["transactions"][0]["fee"],
            high_transaction["fee"]
        );
    }

    let minimum_direct = minimum_successful_native_value(&direct);
    let mut direct_fallback = direct.clone();
    replace_native_funding(
        &mut direct_fallback,
        "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        "751e76e8199196d454941c45d1b3a323f1433bd6",
        minimum_direct - 1,
    );
    let direct_valid = append_native_funding_values(&mut direct_fallback, &[minimum_direct]);
    let direct_planned = call_ok(EngineMethod::Plan, &bind_request(direct_fallback));
    let direct_transaction = Transaction::from_hex(
        direct_planned["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
            .as_str().unwrap(),
    ).unwrap();
    assert_eq!(
        direct_transaction.inputs.last().unwrap().previous_output.txid.to_string(),
        direct_valid[0]
    );
    assert_eq!(direct_transaction.outputs.len() + 1, high_preview.outputs.len());

    let mut maintenance = transfer_plan_input("mergeRequired");
    maintenance["policy"]["payload"]["feeRateSatPerKb"] = json!(FEE_RATE.to_string());
    maintenance["request"]["constraints"]["maxFee"] = json!("10000000");
    let exact_maintenance = minimum_successful_native_value(&maintenance);
    let missing_script_fee = 25 * FEE_RATE / 1_000;
    assert!(exact_maintenance > missing_script_fee);
    replace_native_funding(
        &mut maintenance,
        "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        "751e76e8199196d454941c45d1b3a323f1433bd6",
        exact_maintenance - missing_script_fee,
    );
    let valid = append_native_funding_values(&mut maintenance, &[exact_maintenance]);
    let planned = call_ok(EngineMethod::Plan, &bind_request(maintenance));
    let transactions = planned["plan"]["payload"]["transactions"].as_array().unwrap();
    assert_eq!(transactions.len(), 2);
    let first = Transaction::from_hex(
        planned["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
            .as_str().unwrap(),
    ).unwrap();
    assert_eq!(first.inputs.last().unwrap().previous_output.txid.to_string(), valid[0]);
    let primary = Transaction::from_hex(
        transactions[1]["unsignedTransaction"].as_str().unwrap(),
    ).unwrap();
    assert_eq!(transactions[0]["role"], "maintenance");
    assert_eq!(transactions[1]["role"], "primary");
    assert_eq!(primary.inputs.last().unwrap().previous_output.txid, first.txid());
    assert_eq!(primary.inputs.last().unwrap().previous_output.vout, 2);
    let maintenance_change = first.outputs[2].satoshis;
    let maintenance_fee = transactions[0]["fee"].as_str().unwrap();
    let primary_fee = transactions[1]["fee"].as_str().unwrap();
    eprintln!(
        "FT_EXACT_FUNDING fee_rate={FEE_RATE} direct_minimum={minimum_direct} direct_change_threshold={exact_threshold} maintenance_threshold={exact_maintenance} maintenance_fee={maintenance_fee} maintenance_change={maintenance_change} primary_fee={primary_fee} missing_25_byte_fee={missing_script_fee}"
    );
}

fn public_finalize_input(plan_input: &Value, planned: &Value) -> Value {
    let legacy = serde_json::from_str::<Value>(include_str!("../../../fixtures/tbc-transfer.json"))
        .unwrap();
    let mut binding = legacy["finalizeInput"]["binding"].clone();
    binding["payload"]["requestHash"] = plan_input["requestHash"].clone();
    binding["payload"]["operationHash"] = planned["plan"]["planHash"].clone();
    binding["payload"]["accountId"] = json!(format!(
        "{}:{}",
        plan_input["request"]["chainId"].as_str().unwrap(),
        plan_input["request"]["from"].as_str().unwrap()
    ));
    binding["payload"]["expiresAt"] = planned["plan"]["payload"]["expiresAt"].clone();
    binding["bindingHash"] = json!(canonical_hash(&binding["payload"]));
    let mut approval = legacy["finalizeInput"]["approval"].clone();
    approval["bindingHash"] = binding["bindingHash"].clone();
    approval["expiresAt"] = planned["plan"]["payload"]["expiresAt"].clone();
    json!({
        "version": plan_input["version"],
        "request": plan_input["request"],
        "requestHash": plan_input["requestHash"],
        "snapshot": plan_input["snapshot"],
        "policy": plan_input["policy"],
        "plan": planned["plan"],
        "binding": binding,
        "approval": approval,
        "signatures": sign_public_tasks(&planned["plan"]["payload"]["signingTasks"])
    })
}

#[test]
fn sdk_gap_ft_five_recipients_are_one_bound_transaction() {
    let mut input = transfer_plan_input("direct");
    // Existing selection fixtures deliberately use synthetic non-contract
    // grandparents. VM acceptance instead needs a genuine SDK mint ancestry.
    let mut scalar=[0u8;32];scalar[31]=1;
    let key=tbc_sdk::PrivateKey::from_slice(&scalar).unwrap();
    let native_parent=Transaction::from_hex(input["snapshot"]["payload"]["parents"][0]["rawTransaction"].as_str().unwrap()).unwrap();
    let funding=tbc_sdk::Utxo { outpoint:OutPoint{txid:native_parent.txid(),vout:0},
        satoshis:native_parent.outputs[0].satoshis, script_pubkey:native_parent.outputs[0].script_pubkey.clone(), private_key:key.clone() };
    let mut ft=tbc_sdk::contracts::ft::Ft::new("Gap Token".to_owned(),"GAP".to_owned(),1000,0).unwrap();
    let minted=ft.mint_ft(key.clone(),key.address(),funding).unwrap();
    let id=minted.mint.txid().to_string();
    input["request"]["intent"]["contractId"]=json!(id);
    input["snapshot"]["payload"]["utxos"]=json!([input["snapshot"]["payload"]["utxos"][0],{
        "txid":id,"vout":0,"satoshis":"500","scriptPubKey":encode_hex(minted.mint.outputs[0].script_pubkey.as_bytes()),
        "confirmations":"100","classification":"ft","contractId":id
    }]);
    input["snapshot"]["payload"]["parents"]=json!([
        {"txid":native_parent.txid().to_string(),"rawTransaction":native_parent.to_hex()},
        {"txid":minted.source.txid().to_string(),"rawTransaction":minted.source.to_hex()},
        {"txid":id,"rawTransaction":minted.mint.to_hex()}
    ]);
    input["snapshot"]["payload"]["contracts"]=json!([{
        "contractId":id,"family":"ft","protocolVersion":"4.0","creationTxid":id,
        "currentOutpoint":{"txid":id,"vout":0}
    }]);
    let sender = input["request"]["from"].clone();
    let other = input["request"]["intent"]["to"].clone();
    for field in ["to", "amount", "attachedTbcAmount"] { input["request"]["intent"].as_object_mut().unwrap().remove(field); }
    let recipients = (0..5).map(|i| json!({"to":if i%2==0 {&sender}else{&other},"amount":(i+1).to_string()})).collect::<Vec<_>>();
    input["request"]["intent"]["receivers"] = json!(recipients);
    input["policy"]["payload"]["amountLimits"] = json!([{"scope":"native","maximum":"2100000000000000"}]);
    // Enough fee funding for all five Code/Tape pairs; no extra network reads.
    replace_native_funding(&mut input,
        "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        "751e76e8199196d454941c45d1b3a323f1433bd6", 100000);
    let input = bind_request(input);
    let planned = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&planned), ["primary"]);
    let flows = planned["plan"]["payload"]["preview"]["assetFlows"].as_array().unwrap().iter()
        .filter(|flow| flow["kind"] == "ft" && flow["direction"] == "send").collect::<Vec<_>>();
    assert_eq!(flows.len(), 5);
    for (flow, receiver) in flows.iter().zip(&recipients) {
        assert_eq!(flow["to"], receiver["to"]); assert_eq!(flow["amount"], receiver["amount"]);
    }
    let finalized_input = public_finalize_input(&input, &planned);
    let finalized = call_ok(EngineMethod::Finalize, &finalized_input);
    let tx = Transaction::from_hex(finalized["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
    assert_eq!(tx.outputs.len(), 13); // Five recipients, token change, native change.
    let native=&input["snapshot"]["payload"]["utxos"][0];
    let sdk_batches=ft.batch_transfer(key.clone(),recipients.iter().map(|r|tbc_sdk::contracts::ft::FtReceiver{
        address:Address::from_string(r["to"].as_str().unwrap()).unwrap(),amount_raw:r["amount"].as_str().unwrap().parse().unwrap()
    }).collect(),vec![tbc_sdk::contracts::ft::FtUtxo{base:tbc_sdk::Utxo{
        outpoint:OutPoint{txid:minted.mint.txid(),vout:0},satoshis:500,
        script_pubkey:minted.mint.outputs[0].script_pubkey.clone(),private_key:key.clone()},ft_balance_raw:1000}],
        tbc_sdk::Utxo{outpoint:OutPoint{txid:native["txid"].as_str().unwrap().parse().unwrap(),vout:0},
            satoshis:100000,script_pubkey:key.address().script_pubkey(),private_key:key.clone()},
        vec![minted.mint.clone()],vec![tbc_sdk::contracts::ft::unlock::pre_pre_tx_data_from_parents(&minted.mint,0,&[minted.source.clone()]).unwrap()]).unwrap();
    assert_eq!(sdk_batches.len(),1,"SDK five-recipient batch remains one chain transaction");
    let sdk_tx=Transaction::from_hex(&sdk_batches[0].txraw).unwrap();
    assert_eq!(tx.outputs[..12],sdk_tx.outputs[..12],"all five recipients and token change match SDK Code/Tape bytes");
    for (i, receiver) in recipients.iter().enumerate() {
        assert_eq!(tbc_sdk::contracts::ft::amount::balance_from_tape(&tx.outputs[2*i+1].script_pubkey).unwrap(), (i+1) as u128);
        assert_eq!(flows[i]["to"], receiver["to"]);
    }
    let mut changed = finalized_input.clone(); changed["request"]["intent"]["receivers"][4]["amount"] = json!("9");
    changed["requestHash"] = json!(canonical_hash(&changed["request"]));
    assert_eq!(call(EngineMethod::Finalize, &changed)["ok"], false);
    let mut too_many = input.clone(); too_many["request"]["intent"]["receivers"].as_array_mut().unwrap().push(recipients[0].clone());
    assert_eq!(call(EngineMethod::NormalizeRequest, &json!({"version":"1.0","request":too_many["request"]}))["ok"], false);
    unified_business::exercise(input.clone(), "tbc20.transfer");
    if std::env::var("TBC_SDK_GAP_DUMP").as_deref() == Ok("1") {
        println!("SDK_GAP_VECTOR:{}", json!({"case":"ft-five-receivers","input":input,"planned":planned,"finalizeInput":finalized_input,"finalized":finalized}));
    }
}

fn sign_public_tasks(tasks: &Value) -> Value {
    let mut secret_bytes = [0u8; 32];
    secret_bytes[31] = 1;
    let secret = SecretKey::from_byte_array(secret_bytes).unwrap();
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
                let compact = secp
                    .sign_ecdsa(Message::from_digest(digest), &secret)
                    .serialize_compact();
                json!({
                    "taskId": task["taskId"],
                    "signatureEncoding": "compact64",
                    "signature": encode_hex(&compact)
                })
            })
            .collect(),
    )
}

fn rewritten_descendant_plan_input() -> Value {
    const B_ADDRESS: &str = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
    const B_PUBLIC_KEY: &str =
        "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    const B_PUBLIC_KEY_HASH: &str = "06afd46bcdfd22ef94ac122aa11f241244a37ecc";
    let mut params = transfer_plan_input("direct");
    let contract_id = params["request"]["intent"]["contractId"]
        .as_str()
        .unwrap()
        .to_owned();
    let creation_raw = params["snapshot"]["payload"]["parents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|parent| parent["txid"] == contract_id)
        .unwrap()["rawTransaction"]
        .as_str()
        .unwrap();
    let creation = Transaction::from_hex(creation_raw).unwrap();
    let receiver = Address::from_string(B_ADDRESS).unwrap();
    let rewritten = transfer_code_script(
        &creation.outputs[0].script_pubkey,
        FtCodeReceiver::Address(receiver),
    )
    .unwrap();
    let descendant = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint {
            txid: creation.txid(),
            vout: 0,
        })],
        outputs: vec![
            TxOut {
                satoshis: 500,
                script_pubkey: rewritten.clone(),
            },
            TxOut {
                satoshis: 0,
                script_pubkey: creation.outputs[1].script_pubkey.clone(),
            },
        ],
        lock_time: 0,
    };
    let descendant_txid = descendant.txid().to_string();
    params["snapshot"]["payload"]["utxos"][1] = json!({
        "txid": descendant_txid,
        "vout": 0,
        "satoshis": "500",
        "scriptPubKey": encode_hex(rewritten.as_bytes()),
        "confirmations": "100",
        "classification": "ft",
        "contractId": contract_id
    });
    params["snapshot"]["payload"]["parents"]
        .as_array_mut()
        .unwrap()
        .push(json!({"txid": descendant_txid, "rawTransaction": descendant.to_hex()}));
    params["snapshot"]["payload"]["contracts"][0]["currentOutpoint"] =
        json!({"txid": descendant_txid, "vout": 0});
    params["request"]["intent"]["to"] =
        json!("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH");
    replace_native_funding(
        &mut params,
        B_ADDRESS,
        B_PUBLIC_KEY,
        B_PUBLIC_KEY_HASH,
        1_000_000,
    );
    bind_request(params)
}

#[test]
fn ft_accepts_a_to_b_then_b_to_c_with_rewritten_sdk_receiver_script() {
    let input = rewritten_descendant_plan_input();
    let planned = call_ok(EngineMethod::Plan, &input);
    assert_eq!(roles(&planned), ["primary"]);
}

#[test]
fn ft_rejects_transfer_state_relabelled_as_a_new_genesis() {
    let mut input = transfer_plan_input("direct");
    let selected_txid = input["snapshot"]["payload"]["utxos"][1]["txid"].clone();
    input["request"]["intent"]["contractId"] = selected_txid.clone();
    input["snapshot"]["payload"]["utxos"][1]["contractId"] = selected_txid.clone();
    input["snapshot"]["payload"]["contracts"][0]["contractId"] = selected_txid.clone();
    input["snapshot"]["payload"]["contracts"][0]["creationTxid"] = selected_txid.clone();
    input["snapshot"]["payload"]["contracts"][0]["currentOutpoint"] =
        json!({"txid": selected_txid, "vout": 0});
    input = bind_request(input);
    assert_eq!(
        call_error(EngineMethod::Plan, &input)["code"],
        "INVALID_ANCESTRY"
    );
}

#[test]
fn ft_mixed_contract_snapshot_plans_each_contract_independently() {
    let mut first = transfer_plan_input("direct");
    let (second_utxos, second_parents, second_contract) = asset_material_seed(&[2_000], 0x92);
    first["snapshot"]["payload"]["utxos"]
        .as_array_mut()
        .unwrap()
        .extend(second_utxos);
    first["snapshot"]["payload"]["parents"]
        .as_array_mut()
        .unwrap()
        .extend(second_parents);
    first["snapshot"]["payload"]["contracts"]
        .as_array_mut()
        .unwrap()
        .push(second_contract.clone());
    first = bind_request(first);
    assert_eq!(roles(&call_ok(EngineMethod::Plan, &first)), ["primary"]);

    let mut second = first;
    second["request"]["intent"]["contractId"] = second_contract["contractId"].clone();
    second["request"]["intent"]["amount"] = json!("1500");
    second = bind_request(second);
    assert_eq!(roles(&call_ok(EngineMethod::Plan, &second)), ["primary"]);
}

#[test]
fn ft_asset_inputs_obey_min_confirmations() {
    let mut input = transfer_plan_input("direct");
    input["snapshot"]["payload"]["utxos"][1]["confirmations"] = json!("0");
    input["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&input["snapshot"]["payload"]));
    assert_eq!(
        call_error(EngineMethod::Plan, &input)["code"],
        "INSUFFICIENT_FUNDS"
    );
}

#[test]
fn ft_public_finalize_returns_pending_then_legacy_complete_bundle() {
    for input in [transfer_plan_input("mergeRequired")] {
        let planned = call_ok(EngineMethod::Plan, &input);
        let mut finalize = public_finalize_input(&input, &planned);
        let pending = call_ok(EngineMethod::Finalize, &finalize);
        assert_eq!(pending["status"], "pending");
        assert!(pending["continuation"].is_object());
        assert!(pending["signingRequests"].is_array());

        let mut stage = pending;
        while let Some(next) = pending_or_complete(&mut finalize, stage) {
            stage = next;
        }
    }
}

#[test]
fn ordinary_ft_unlock_keeps_the_legacy_no_coin_marker_layout() {
    let input = transfer_plan_input("direct");
    let planned = call_ok(EngineMethod::Plan, &input);
    let (complete, _) = finish_public_operation(&input, &planned);
    let transaction = Transaction::from_hex(
        complete["bundle"]["transactions"][0]["rawTransaction"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let asset_input = &transaction.inputs[0];
    let parent = input["snapshot"]["payload"]["parents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|record| Transaction::from_hex(record["rawTransaction"].as_str().unwrap()).unwrap())
        .find(|parent| parent.txid() == asset_input.previous_output.txid)
        .unwrap();
    let pre_tx = pre_tx_data(&parent, asset_input.previous_output.vout as usize).unwrap();
    let script = asset_input.script_sig.as_bytes();
    assert!(script.ends_with(&pre_tx));
    let pre_tx_start = script.len() - pre_tx.len();
    assert_eq!(script[pre_tx_start - 34], 33, "ordinary FT preTxData must immediately follow the public key push");
}

fn pending_or_complete(finalize: &mut Value, result: Value) -> Option<Value> {
    if result.get("bundle").is_some() {
        assert!(result.get("status").is_none(), "complete keeps legacy Bundle result shape");
        return None;
    }
    finalize["continuation"] = result["continuation"].clone();
    finalize["signatures"] = sign_public_tasks(&result["signingRequests"]);
    let next = call_ok(EngineMethod::Finalize, finalize);
    if next.get("bundle").is_some() {
        assert!(next.get("status").is_none());
        None
    } else {
        Some(next)
    }
}

#[test]
fn ft_public_finalize_rejects_tampered_swapped_and_out_of_order_continuations() {
    // Two distinct supported multi-stage transfers retain continuation-swap
    // coverage now that historical creation is no longer executable.
    let mut create_input = transfer_plan_input("mergeRequired");
    create_input["request"]["intent"]["amount"] = json!("599");
    let create_input = bind_request(create_input);
    let create_plan = call_ok(EngineMethod::Plan, &create_input);
    let create_finalize = public_finalize_input(&create_input, &create_plan);
    let create_pending = call_ok(EngineMethod::Finalize, &create_finalize);

    let merge_input = transfer_plan_input("mergeRequired");
    let merge_plan = call_ok(EngineMethod::Plan, &merge_input);
    let mut merge_finalize = public_finalize_input(&merge_input, &merge_plan);
    let merge_pending = call_ok(EngineMethod::Finalize, &merge_finalize);

    merge_finalize["continuation"] = create_pending["continuation"].clone();
    merge_finalize["signatures"] = sign_public_tasks(&create_pending["signingRequests"]);
    assert_eq!(
        call_error(EngineMethod::Finalize, &merge_finalize)["code"],
        "INVALID_PLAN"
    );

    let mut tampered = create_finalize.clone();
    tampered["continuation"] = create_pending["continuation"].clone();
    tampered["continuation"]["signingStage"]["continuation"]["nextStage"] = json!(99);
    tampered["signatures"] = sign_public_tasks(&create_pending["signingRequests"]);
    assert_eq!(
        call_error(EngineMethod::Finalize, &tampered)["code"],
        "INVALID_PLAN"
    );

    let mut replayed = create_finalize;
    replayed["continuation"] = create_pending["continuation"].clone();
    assert_eq!(
        call_error(EngineMethod::Finalize, &replayed)["code"],
        "INVALID_SIGNATURE"
    );

    assert_eq!(merge_pending["status"], "pending");
}

#[test]
fn ft_realistic_500_input_plan_and_continuation_fit_bounded_wire_sizes() {
    let balances = vec![1u64; 500];
    let (asset_utxos, asset_parents, contract) = asset_material_seed(&balances, 0xa5);
    let mut input = base_plan_input();
    let native_utxo = input["snapshot"]["payload"]["utxos"][0].clone();
    let native_parent = input["snapshot"]["payload"]["parents"][0].clone();
    input["request"]["intent"] = json!({
        "type": "tbc.ft.transfer",
        "version": "1.0",
        "contractId": contract["contractId"],
        "to": "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP",
        "amount": "500"
    });
    input["request"]["constraints"]["maxFee"] = json!("10000000");
    input["snapshot"]["payload"]["utxos"] = json!([native_utxo]);
    input["snapshot"]["payload"]["utxos"]
        .as_array_mut()
        .unwrap()
        .extend(asset_utxos);
    input["snapshot"]["payload"]["parents"] = json!([native_parent]);
    input["snapshot"]["payload"]["parents"]
        .as_array_mut()
        .unwrap()
        .extend(asset_parents);
    input["snapshot"]["payload"]["contracts"] = json!([contract]);
    input["policy"]["payload"]["maxBundleTransactions"] = json!(200);
    input["policy"]["payload"]["amountLimits"] = json!([]);
    replace_native_funding(
        &mut input,
        "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        "751e76e8199196d454941c45d1b3a323f1433bd6",
        100_000_000,
    );
    append_native_funding(&mut input, 124, 100_000_000);
    input = bind_request(input);
    let planned = call_ok(EngineMethod::Plan, &input);
    let plan_bytes = serde_json::to_vec(&planned).unwrap().len();
    assert!(plan_bytes <= 4 * 1024 * 1024, "plan bytes: {plan_bytes}");
    let mut finalize = public_finalize_input(&input, &planned);
    let pending = call_ok(EngineMethod::Finalize, &finalize);
    let continuation_bytes = serde_json::to_vec(&pending["continuation"]).unwrap().len();
    assert!(
        continuation_bytes <= 8 * 1024 * 1024,
        "continuation bytes: {continuation_bytes}"
    );
    assert!(
        pending["continuation"]["signingStage"]["continuation"]
            .get("plan")
            .is_none(),
        "continuation retained a second unsigned plan"
    );
    let expected_transactions = planned["plan"]["payload"]["transactions"]
        .as_array()
        .unwrap();
    assert_eq!(expected_transactions.len(), 125);
    assert!(expected_transactions[..124]
        .iter()
        .all(|transaction| transaction["role"] == "maintenance"));
    assert_eq!(expected_transactions[124]["role"], "primary");
    let stage_zero_transactions = planned["plan"]["payload"]["signingTasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|task| task["transactionTemplateId"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    let mut stage_transaction_counts = vec![stage_zero_transactions];
    let mut result = pending;
    let mut pending_count = 0usize;
    let mut maximum_continuation_bytes = 0usize;
    let mut previous_stage = 0u64;
    let mut previous_commitment = String::new();
    loop {
        if let Some(bundle) = result.get("bundle") {
            assert!(result.get("status").is_none());
            let transactions = bundle["transactions"].as_array().unwrap();
            assert_eq!(transactions.len(), 125);
            let mut txids = std::collections::BTreeMap::new();
            let mut ids_by_txid =
                std::collections::BTreeMap::<String, String>::new();
            let allowed_external = input["snapshot"]["payload"]["utxos"]
                .as_array()
                .unwrap()
                .iter()
                .map(|utxo| {
                    (
                        utxo["txid"].as_str().unwrap().to_owned(),
                        u32::try_from(utxo["vout"].as_u64().unwrap()).unwrap(),
                    )
                })
                .collect::<std::collections::BTreeSet<_>>();
            let mut spent_outpoints = std::collections::BTreeSet::new();
            for (index, transaction) in transactions.iter().enumerate() {
                assert_eq!(transaction["id"], expected_transactions[index]["id"]);
                assert_eq!(transaction["role"], expected_transactions[index]["role"]);
                assert_eq!(
                    transaction["dependsOn"],
                    expected_transactions[index]["dependsOn"]
                );
                let parsed = Transaction::from_hex(
                    transaction["rawTransaction"].as_str().unwrap(),
                )
                .unwrap();
                assert_eq!(parsed.txid().to_string(), transaction["txid"]);
                let dependencies = transaction["dependsOn"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|dependency| dependency.as_str().unwrap())
                    .collect::<std::collections::BTreeSet<_>>();
                let mut terminal_fee_edges = 0usize;
                for actual_input in &parsed.inputs {
                    let txid = actual_input.previous_output.txid.to_string();
                    let outpoint = (txid.clone(), actual_input.previous_output.vout);
                    assert!(
                        spent_outpoints.insert(outpoint.clone()),
                        "global duplicate spend at {}:{}",
                        outpoint.0,
                        outpoint.1
                    );
                    if let Some(parent_id) = ids_by_txid.get(&txid) {
                        assert!(
                            dependencies.contains(parent_id.as_str()),
                            "{} spends unplanned internal parent {parent_id}",
                            transaction["id"]
                        );
                        match actual_input.previous_output.vout {
                            0 => {}
                            2 if transaction["role"] == "primary" => {
                                terminal_fee_edges += 1;
                                assert_eq!(parent_id, "ft-merge-121");
                            }
                            vout => panic!(
                                "{} spends unexpected internal output {parent_id}:{vout}",
                                transaction["id"]
                            ),
                        }
                    } else {
                        assert!(
                            allowed_external.contains(&outpoint),
                            "{} spends unplanned external outpoint {}:{}",
                            transaction["id"],
                            outpoint.0,
                            outpoint.1
                        );
                    }
                }
                for dependency in transaction["dependsOn"].as_array().unwrap() {
                    let dependency = dependency.as_str().unwrap();
                    let expected_txid = txids.get(dependency).unwrap();
                    assert!(parsed.inputs.iter().any(|input| {
                        input.previous_output.txid.to_string() == *expected_txid
                            && input.previous_output.vout == 0
                    }), "{} does not spend dependency {dependency}", transaction["id"]);
                }
                if transaction["role"] == "primary" {
                    assert_eq!(terminal_fee_edges, 1);
                } else {
                    assert_eq!(terminal_fee_edges, 0);
                }
                txids.insert(
                    transaction["id"].as_str().unwrap().to_owned(),
                    transaction["txid"].as_str().unwrap().to_owned(),
                );
                ids_by_txid.insert(
                    transaction["txid"].as_str().unwrap().to_owned(),
                    transaction["id"].as_str().unwrap().to_owned(),
                );
            }
            assert_eq!(spent_outpoints.len(), 749);
            break;
        }

        assert_eq!(result["status"], "pending");
        pending_count += 1;
        let stage = result["continuation"]["stage"].as_u64().unwrap();
        assert_eq!(stage, pending_count as u64);
        assert!(stage > previous_stage);
        let commitment = result["continuation"]["stageCommitment"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(commitment, previous_commitment);
        let bytes = serde_json::to_vec(&result["continuation"]).unwrap().len();
        maximum_continuation_bytes = maximum_continuation_bytes.max(bytes);
        assert!(bytes <= 8 * 1024 * 1024, "stage {stage} continuation bytes: {bytes}");
        stage_transaction_counts.push(
            result["signingRequests"]
                .as_array()
                .unwrap()
                .iter()
                .map(|task| task["transactionTemplateId"].as_str().unwrap())
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
        );

        finalize["continuation"] = result["continuation"].take();
        finalize["signatures"] = sign_public_tasks(&result["signingRequests"]);
        result = call_ok(EngineMethod::Finalize, &finalize);
        previous_stage = stage;
        previous_commitment = commitment;
    }
    assert_eq!(pending_count, 3);
    assert_eq!(stage_transaction_counts, vec![100, 20, 4, 1]);
    eprintln!(
        "FT_500_DAG_EVIDENCE plan_bytes={plan_bytes} max_continuation_bytes={maximum_continuation_bytes} pending_stages={pending_count} signing_stages=4 transactions=125"
    );

    let (too_many, parents, contract) = asset_material_seed(&vec![1u64; 501], 0xa6);
    let mut rejected = input;
    rejected["snapshot"]["payload"]["utxos"]
        .as_array_mut()
        .unwrap()
        .truncate(1);
    rejected["snapshot"]["payload"]["utxos"]
        .as_array_mut()
        .unwrap()
        .extend(too_many);
    rejected["snapshot"]["payload"]["parents"] = Value::Array(parents);
    rejected["snapshot"]["payload"]["contracts"] = json!([contract.clone()]);
    rejected["request"]["intent"]["contractId"] = contract["contractId"].clone();
    rejected["request"]["intent"]["amount"] = json!("501");
    rejected = bind_request(rejected);
    assert_eq!(
        call_error(EngineMethod::Plan, &rejected)["code"],
        "INVALID_INPUT"
    );
}

#[test]
fn ft_501_contract_candidates_fail_before_ancestry_parsing() {
    let (asset_utxos, _, contract) = asset_material_seed(&vec![1u64; 501], 0xb7);
    let mut input = base_plan_input();
    input["request"]["intent"] = json!({
        "type": "tbc.ft.transfer",
        "version": "1.0",
        "contractId": contract["contractId"],
        "to": "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP",
        "amount": "1"
    });
    input["snapshot"]["payload"]["utxos"]
        .as_array_mut().unwrap().extend(asset_utxos);
    input["snapshot"]["payload"]["parents"] = json!([]);
    input["snapshot"]["payload"]["contracts"] = json!([contract]);
    input["policy"]["payload"]["amountLimits"] = json!([]);
    input = bind_request(input);

    let error = call_error(EngineMethod::Plan, &input);
    assert_eq!(error["code"], "INVALID_INPUT");
    assert_eq!(error["path"], "snapshot.payload.utxos");
    assert_eq!(
        error["message"],
        "selected FT contract candidates exceed the 500 input limit"
    );
}

fn sign_public_tasks_with(tasks: &Value, secret_last_byte: u8, digest_override: Option<[u8; 32]>) -> Value {
    let mut secret_bytes = [0u8; 32];
    secret_bytes[31] = secret_last_byte;
    let secret = SecretKey::from_byte_array(secret_bytes).unwrap();
    let secp = Secp256k1::new();
    Value::Array(
        tasks
            .as_array()
            .unwrap()
            .iter()
            .map(|task| {
                let digest = digest_override.unwrap_or_else(|| {
                    decode_hex(task["digest"].as_str().unwrap())
                        .try_into()
                        .unwrap()
                });
                let compact = secp
                    .sign_ecdsa(Message::from_digest(digest), &secret)
                    .serialize_compact();
                json!({
                    "taskId": task["taskId"],
                    "signatureEncoding": "compact64",
                    "signature": encode_hex(&compact)
                })
            })
            .collect(),
    )
}

fn make_first_signature_high_s(signatures: &mut Value) {
    const ORDER: [u8; 32] = [
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2,
        0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
    ];
    let mut compact = decode_hex(signatures[0]["signature"].as_str().unwrap());
    let mut high = [0u8; 32];
    let mut borrow = 0i16;
    for index in (0..32).rev() {
        let value = ORDER[index] as i16 - compact[32 + index] as i16 - borrow;
        if value < 0 {
            high[index] = (value + 256) as u8;
            borrow = 1;
        } else {
            high[index] = value as u8;
            borrow = 0;
        }
    }
    compact[32..].copy_from_slice(&high);
    signatures[0]["signature"] = json!(encode_hex(&compact));
}

#[test]
fn ft_public_finalize_rejects_wrong_key_wrong_digest_and_high_s_covenant_signatures() {
    let input = transfer_plan_input("mergeRequired");
    let planned = call_ok(EngineMethod::Plan, &input);
    let tasks = &planned["plan"]["payload"]["signingTasks"];
    let mut wrong_key = public_finalize_input(&input, &planned);
    wrong_key["signatures"] = sign_public_tasks_with(tasks, 2, None);
    assert_eq!(
        call_error(EngineMethod::Finalize, &wrong_key)["code"],
        "INVALID_SIGNATURE"
    );

    let mut wrong_digest = public_finalize_input(&input, &planned);
    wrong_digest["signatures"] = sign_public_tasks_with(tasks, 1, Some([0x42; 32]));
    assert_eq!(
        call_error(EngineMethod::Finalize, &wrong_digest)["code"],
        "INVALID_SIGNATURE"
    );

    let mut high_s = public_finalize_input(&input, &planned);
    make_first_signature_high_s(&mut high_s["signatures"]);
    assert_eq!(
        call_error(EngineMethod::Finalize, &high_s)["code"],
        "INVALID_SIGNATURE"
    );
}

#[test]
fn ft_pending_validates_as_a_typed_nonfinal_artifact() {
    let input = transfer_plan_input("mergeRequired");
    let planned = call_ok(EngineMethod::Plan, &input);
    let finalize = public_finalize_input(&input, &planned);
    let pending = call_ok(EngineMethod::Finalize, &finalize);
    for phase in ["finalized", "pre-broadcast"] {
        let validate = json!({
            "version": input["version"],
            "phase": phase,
            "request": input["request"],
            "requestHash": input["requestHash"],
            "snapshot": input["snapshot"],
            "policy": input["policy"],
            "plan": planned["plan"],
            "binding": finalize["binding"],
            "approval": finalize["approval"],
            "signatures": finalize["signatures"],
            "pending": pending
        });
        assert_eq!(call_ok(EngineMethod::Validate, &validate)["valid"], true);
    }
}

#[test]
fn ft_validation_distinguishes_approval_failures_from_artifact_tampering() {
    let input = transfer_plan_input("mergeRequired");
    let planned = call_ok(EngineMethod::Plan, &input);
    let initial = public_finalize_input(&input, &planned);
    let first_pending = call_ok(EngineMethod::Finalize, &initial);
    let signatures = sign_public_tasks(&first_pending["signingRequests"]);
    let mut advance = initial.clone();
    advance["continuation"] = first_pending["continuation"].clone();
    advance["signatures"] = signatures.clone();
    let complete = call_ok(EngineMethod::Finalize, &advance);
    assert!(complete.get("bundle").is_some());
    let validation = json!({
        "version": input["version"],
        "phase": "finalized",
        "request": input["request"],
        "requestHash": input["requestHash"],
        "snapshot": input["snapshot"],
        "policy": input["policy"],
        "plan": planned["plan"],
        "binding": advance["binding"],
        "approval": advance["approval"],
        "signatures": signatures,
        "continuation": first_pending["continuation"],
        "bundle": complete["bundle"]
    });

    let mut artifact_tampering = validation.clone();
    artifact_tampering["continuation"]["signingStage"]["continuation"]
        ["finalizedTransactions"][0]["rawTransaction"] = json!("00");
    let artifact_result = call_ok(EngineMethod::Validate, &artifact_tampering);
    let artifact_codes = artifact_result["violations"]
        .as_array().unwrap().iter().map(|item| item["code"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(artifact_codes.contains(&"ARTIFACT_MISMATCH"), "{artifact_result}");
    assert!(!artifact_codes.contains(&"APPROVAL_BINDING_MISMATCH"), "{artifact_result}");

    let mut approval_tampering = validation;
    approval_tampering["approval"]["bindingHash"] = json!("00".repeat(32));
    let approval_result = call_ok(EngineMethod::Validate, &approval_tampering);
    let approval_codes = approval_result["violations"]
        .as_array().unwrap().iter().map(|item| item["code"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(approval_codes.contains(&"APPROVAL_BINDING_MISMATCH"), "{approval_result}");
}

#[test]
fn ft_public_finalize_revalidates_compact_evidence_on_every_advance() {
    let input = transfer_plan_input("mergeRequired");
    let planned = call_ok(EngineMethod::Plan, &input);
    let initial = public_finalize_input(&input, &planned);
    let pending = call_ok(EngineMethod::Finalize, &initial);

    let mut duplicate = initial.clone();
    duplicate["continuation"] = pending["continuation"].clone();
    let duplicate_parent = duplicate["snapshot"]["payload"]["parents"][0].clone();
    duplicate["snapshot"]["payload"]["parents"]
        .as_array_mut().unwrap().push(duplicate_parent);
    duplicate["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&duplicate["snapshot"]["payload"]));
    duplicate["signatures"] = sign_public_tasks(&pending["signingRequests"]);
    assert_eq!(
        call_error(EngineMethod::Finalize, &duplicate)["code"],
        "INVALID_ANCESTRY"
    );

    let mut missing = initial;
    missing["continuation"] = pending["continuation"].clone();
    missing["snapshot"]["payload"]["parents"].as_array_mut().unwrap().clear();
    missing["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&missing["snapshot"]["payload"]));
    missing["signatures"] = sign_public_tasks(&pending["signingRequests"]);
    assert_eq!(
        call_error(EngineMethod::Finalize, &missing)["code"],
        "INVALID_ANCESTRY"
    );
}

#[test]
fn ft_rejects_regenerated_wrong_genesis_output_roles_and_rebased_origin() {
    let mut wrong_roles = transfer_plan_input("direct");
    let contract_id = wrong_roles["request"]["intent"]["contractId"]
        .as_str()
        .unwrap()
        .to_owned();
    let creation_index = wrong_roles["snapshot"]["payload"]["parents"]
        .as_array()
        .unwrap()
        .iter()
        .position(|parent| parent["txid"] == contract_id)
        .unwrap();
    let mut creation = Transaction::from_hex(
        wrong_roles["snapshot"]["payload"]["parents"][creation_index]["rawTransaction"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    creation.outputs.swap(0, 1);
    let changed_id = creation.txid().to_string();
    wrong_roles["snapshot"]["payload"]["parents"][creation_index] =
        json!({"txid": changed_id, "rawTransaction": creation.to_hex()});
    wrong_roles["snapshot"]["payload"]["contracts"][0]["contractId"] = json!(changed_id);
    wrong_roles["snapshot"]["payload"]["contracts"][0]["creationTxid"] = json!(changed_id);
    wrong_roles["request"]["intent"]["contractId"] = json!(changed_id);
    wrong_roles["snapshot"]["payload"]["utxos"][1]["contractId"] = json!(changed_id);
    wrong_roles = bind_request(wrong_roles);
    assert_eq!(
        call_error(EngineMethod::Plan, &wrong_roles)["code"],
        "INVALID_ANCESTRY"
    );

    let mut rebased = transfer_plan_input("direct");
    let source_index = 1usize;
    let mut source = Transaction::from_hex(
        rebased["snapshot"]["payload"]["parents"][source_index]["rawTransaction"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    source.lock_time = 1;
    let new_source_id = source.txid().to_string();
    rebased["snapshot"]["payload"]["parents"][source_index] =
        json!({"txid": new_source_id, "rawTransaction": source.to_hex()});
    let original_contract = rebased["request"]["intent"]["contractId"]
        .as_str()
        .unwrap()
        .to_owned();
    let creation_index = rebased["snapshot"]["payload"]["parents"]
        .as_array()
        .unwrap()
        .iter()
        .position(|parent| parent["txid"] == original_contract)
        .unwrap();
    let mut creation = Transaction::from_hex(
        rebased["snapshot"]["payload"]["parents"][creation_index]["rawTransaction"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    creation.inputs[0].previous_output.txid = source.txid();
    let rebased_contract = creation.txid().to_string();
    rebased["snapshot"]["payload"]["parents"][creation_index] =
        json!({"txid": rebased_contract, "rawTransaction": creation.to_hex()});
    rebased["snapshot"]["payload"]["contracts"][0]["contractId"] = json!(rebased_contract);
    rebased["snapshot"]["payload"]["contracts"][0]["creationTxid"] = json!(rebased_contract);
    rebased["request"]["intent"]["contractId"] = json!(rebased_contract);
    rebased["snapshot"]["payload"]["utxos"][1]["contractId"] = json!(rebased_contract);
    rebased = bind_request(rebased);
    assert_eq!(
        call_error(EngineMethod::Plan, &rebased)["code"],
        "INVALID_ANCESTRY"
    );
}

fn comparator_funding_utxo(record: &Value) -> Value {
    json!({
        "txid": record["txid"],
        "vout": record["vout"],
        "satoshis": record["satoshis"],
        "scriptPubKey": record["scriptPubKey"],
        "confirmations": "100",
        "classification": "native"
    })
}

fn comparator_parent(record: &Value) -> Value {
    json!({
        "txid": record["txid"],
        "rawTransaction": record["rawTransaction"]
    })
}

fn comparator_account(input: &mut Value, source: &Value) {
    let address = source["owner"]["address"].clone();
    input["request"]["from"] = address.clone();
    input["snapshot"]["payload"]["account"]["address"] = address.clone();
    input["snapshot"]["payload"]["account"]["accountId"] = json!(format!(
        "{}:{}",
        input["request"]["chainId"].as_str().unwrap(),
        address.as_str().unwrap()
    ));
    input["snapshot"]["payload"]["account"]["publicKey"] =
        source["owner"]["publicKey"].clone();
    input["policy"]["payload"]["feeRateSatPerKb"] = json!("80");
    input["policy"]["payload"]["dustThreshold"] = json!("24");
    input["policy"]["payload"]["amountLimits"] = json!([]);
}

fn comparator_contract(source: &Value, current: &Value) -> Value {
    json!({
        "contractId": source["token"]["contractId"],
        "family": "ft",
        "protocolVersion": "4.0",
        "creationTxid": source["token"]["contractId"],
        "currentOutpoint": {"txid": current["txid"], "vout": current["vout"]}
    })
}

fn finish_public_operation(input: &Value, planned: &Value) -> (Value, Vec<Vec<String>>) {
    let mut digests = vec![planned["plan"]["payload"]["signingTasks"]
        .as_array().unwrap().iter()
        .map(|task| task["digest"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>()];
    let mut finalize = public_finalize_input(input, planned);
    loop {
        let result = call_ok(EngineMethod::Finalize, &finalize);
        if result.get("bundle").is_some() {
            return (result, digests);
        }
        let requests = &result["signingRequests"];
        digests.push(requests.as_array().unwrap().iter()
            .map(|task| task["digest"].as_str().unwrap().to_owned())
            .collect());
        finalize["continuation"] = result["continuation"].clone();
        finalize["signatures"] = sign_public_tasks(requests);
    }
}

fn assert_source_transactions(
    expected: &[Value],
    planned: &Value,
    finalized: &Value,
    digests: &[Vec<String>],
) {
    let actual = finalized["bundle"]["transactions"].as_array().unwrap();
    let plan_transactions = planned["plan"]["payload"]["transactions"].as_array().unwrap();
    assert_eq!(actual.len(), expected.len());
    assert_eq!(digests.len(), expected.len());
    for (index, expected_tx) in expected.iter().enumerate() {
        let planned_unsigned = Transaction::from_hex(
            plan_transactions[index]["unsignedTransaction"].as_str().unwrap(),
        ).unwrap();
        let source_unsigned = Transaction::from_hex(
            expected_tx["unsignedTransaction"].as_str().unwrap(),
        ).unwrap();
        if plan_transactions[index]["dependsOn"].as_array().unwrap().is_empty() {
            assert_eq!(planned_unsigned, source_unsigned);
        } else {
            assert_eq!(planned_unsigned.version, source_unsigned.version);
            assert_eq!(planned_unsigned.lock_time, source_unsigned.lock_time);
            assert_eq!(planned_unsigned.inputs.len(), source_unsigned.inputs.len());
            for (planned_input, source_input) in
                planned_unsigned.inputs.iter().zip(&source_unsigned.inputs)
            {
                assert_eq!(planned_input.previous_output.vout, source_input.previous_output.vout);
                assert_eq!(planned_input.sequence, source_input.sequence);
                assert!(planned_input.script_sig.as_bytes().is_empty());
            }
        }
        assert_eq!(plan_transactions[index]["fee"], expected_tx["fee"]);
        let actual_transaction = Transaction::from_hex(
            actual[index]["rawTransaction"].as_str().unwrap(),
        ).unwrap();
        let expected_transaction = Transaction::from_hex(
            expected_tx["rawTransaction"].as_str().unwrap(),
        ).unwrap();
        assert_eq!(
            digests[index],
            expected_tx["digests"].as_array().unwrap().iter()
                .map(|digest| digest.as_str().unwrap().to_owned()).collect::<Vec<_>>(),
            "source digest mismatch for {} at index {index}; inputs={:?}; outputs={:?}",
            plan_transactions[index]["id"].as_str().unwrap_or("unknown"),
            actual_transaction.inputs.iter().zip(&expected_transaction.inputs)
                .map(|(actual, expected)| (
                    (actual.previous_output.txid.to_string(), actual.previous_output.vout),
                    (expected.previous_output.txid.to_string(), expected.previous_output.vout),
                )).collect::<Vec<_>>(),
            actual_transaction.outputs.iter().zip(&expected_transaction.outputs)
                .map(|(actual, expected)| (
                    actual.satoshis,
                    expected.satoshis,
                    encode_hex(actual.script_pubkey.as_bytes()),
                    encode_hex(expected.script_pubkey.as_bytes()),
                )).collect::<Vec<_>>(),
        );
        assert_eq!(
            actual[index]["rawTransaction"],
            expected_tx["rawTransaction"],
            "source raw mismatch for {} at index {index}",
            plan_transactions[index]["id"].as_str().unwrap_or("unknown")
        );
        assert_eq!(actual[index]["txid"], expected_tx["txid"]);
        let transaction = actual_transaction;
        assert_eq!(transaction.inputs.len(), expected_tx["inputCount"].as_u64().unwrap() as usize);
        assert_eq!(transaction.outputs.len(), expected_tx["outputCount"].as_u64().unwrap() as usize);
        assert_eq!(transaction.outputs.iter()
            .map(|output| encode_hex(output.script_pubkey.as_bytes())).collect::<Vec<_>>(),
            expected_tx["outputScripts"].as_array().unwrap().iter()
                .map(|script| script.as_str().unwrap().to_owned()).collect::<Vec<_>>());
        assert_eq!(
            transaction.inputs.iter().map(|input| json!({
                "txid": input.previous_output.txid.to_string(),
                "vout": input.previous_output.vout,
                "sequence": input.sequence,
                "signature": encode_hex(input.script_sig.as_bytes())
            })).collect::<Vec<_>>(),
            expected_tx["inputs"].as_array().unwrap().clone()
        );
        assert_eq!(
            transaction.outputs.iter().map(|output| json!({
                "satoshis": output.satoshis.to_string(),
                "script": encode_hex(output.script_pubkey.as_bytes())
            })).collect::<Vec<_>>(),
            expected_tx["outputs"].as_array().unwrap().clone()
        );
    }
}

#[test]
#[ignore = "executed by scripts/compare-ft-source.sh against an exported pinned Git object"]
fn pinned_source_comparator() {
    let path = std::env::var("TBC_PINNED_FT_VECTOR")
        .expect("TBC_PINNED_FT_VECTOR is required; fixture fallback is forbidden");
    let source: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(source["pin"], "923497e8b2473c0e179fa0b86dbb32a2f188d25a");
    assert_eq!(source["wrapperExecuted"], json!({
        "mint": true, "transfer": true, "batchTransfer": true,
        "transferPreMaintenance": true, "merge": true
    }));
    assert_eq!(
        source["walletHighLevelExecution"]["entrypoint"],
        "hooks/use-ft-transaction.tsx#buildNativeAssetTransfer"
    );
    assert_eq!(source["walletHighLevelExecution"]["executed"], true);
    assert_eq!(source["walletHighLevelExecution"]["inputSchemaVersion"], "1");
    assert_eq!(source["processIsolation"], json!({
        "sourceReceivedInputsOnly": true,
        "expectedRawInjectionRejected": true,
        "comparisonStartedAfterSourceExit": true
    }));
    assert_eq!(source["walletHighLevelExecution"]["wrapperExecuted"], json!({
        "mergeDag": true,
        "mergeBuilder": true,
        "mergeFundingPlanner": true,
        "finalFundingResolver": true,
        "transferBuilder": true,
        "transferFundingPlanner": true
    }));
    assert_eq!(source["walletHighLevelExecution"]["mutation"]["success"], true);
    assert_eq!(source["walletHighLevelExecution"]["mutation"]["fromAmount"], "600");
    assert_eq!(source["walletHighLevelExecution"]["mutation"]["toAmount"], "599");
    assert_eq!(source["walletHighLevelExecution"]["mutation"]["maintenanceRawChanged"], false);
    assert_eq!(source["walletHighLevelExecution"]["mutation"]["primaryRawChanged"], true);
    assert_ne!(
        source["walletHighLevelExecution"]["mutation"]["primaryTapeSlotsBefore"],
        source["walletHighLevelExecution"]["mutation"]["primaryTapeSlotsAfter"]
    );
    assert_eq!(
        source["walletHighLevelExecution"]["mutation"]["primaryTapeSlotsBefore"],
        json!(["100", "500", "0", "0", "0", "0"])
    );
    assert_eq!(
        source["walletHighLevelExecution"]["mutation"]["primaryTapeSlotsAfter"],
        json!(["100", "499", "0", "0", "0", "0"])
    );
    assert!(source["walletHighLevelExecution"]["mutation"]["differingPrimarySighashIndexes"]
        .as_array().unwrap().len() > 0);
    assert_eq!(
        source["walletHighLevelExecution"]["sourceSha256"],
        "38181962d1df9b5cd5bc0b95f1bbffee2b126c2ce55ee809db0aaace745c13e3"
    );
    assert_eq!(
        source["walletHighLevelExecution"]["trace"].as_array().unwrap()
            .iter().map(|entry| entry["call"].as_str().unwrap()).collect::<Vec<_>>(),
        vec![
            "getOptimalFtUtxos",
            "executeNativeAssetMerge",
            "selectOptimalUtxoValues",
            "planFtTransferFunding",
            "resolveNativeAssetOperationFunding",
            "buildFtTransfer",
        ]
    );
    assert_eq!(source["walletHighLevelExecution"]["chain"].as_array().unwrap().len(), 2);

    let mut create = create_plan_input();
    comparator_account(&mut create, &source);
    create["request"]["clientRequestId"] = json!("pinned-ft-create-comparator");
    create["request"]["intent"] = json!({
        "type": "tbc.ft.create",
        "version": "1.0",
        "name": source["token"]["name"],
        "symbol": source["token"]["symbol"],
        "decimals": source["token"]["decimals"],
        "initialSupply": source["token"]["totalSupply"]
    });
    create["request"]["constraints"]["maxFee"] = json!("100000");
    create["snapshot"]["payload"]["utxos"] =
        json!([comparator_funding_utxo(&source["funding"]["mint"])]);
    create["snapshot"]["payload"]["parents"] =
        json!([comparator_parent(&source["funding"]["mint"])]);
    create["snapshot"]["payload"]["contracts"] = json!([]);
    create = bind_request(create);
    // Source mint bytes remain provenance for holdings, not a supported public
    // issuance operation. Transfer/maintenance comparisons below remain exact.
    assert_eq!(call_error(EngineMethod::Plan, &create)["code"], "UNSUPPORTED_INTENT");

    let mut direct = base_plan_input();
    comparator_account(&mut direct, &source);
    direct["request"]["clientRequestId"] = json!("pinned-ft-direct-comparator");
    direct["request"]["intent"] = json!({
        "type": "tbc.ft.transfer",
        "version": "1.0",
        "contractId": source["token"]["contractId"],
        "to": source["recipient"],
        "amount": "200"
    });
    direct["request"]["constraints"]["maxFee"] = json!("100000");
    direct["snapshot"]["payload"]["utxos"] = json!([
        comparator_funding_utxo(&source["funding"]["direct"]),
        {
            "txid": source["create"]["mint"]["txid"], "vout": 0,
            "satoshis": "500", "scriptPubKey": source["token"]["codeScript"],
            "confirmations": "100", "classification": "ft",
            "contractId": source["token"]["contractId"]
        }
    ]);
    direct["snapshot"]["payload"]["parents"] = json!([
        comparator_parent(&source["funding"]["direct"]),
        comparator_parent(&source["parents"][0]),
        comparator_parent(&source["parents"][1])
    ]);
    direct["snapshot"]["payload"]["contracts"] =
        json!([comparator_contract(&source, &json!({"txid": source["create"]["mint"]["txid"], "vout": 0}))]);
    direct = bind_request(direct);
    let direct_plan = call_ok(EngineMethod::Plan, &direct);
    let (direct_result, direct_digests) = finish_public_operation(&direct, &direct_plan);
    assert_source_transactions(
        &[source["direct"].clone()], &direct_plan, &direct_result, &direct_digests,
    );

    let mut transfer_chain = base_plan_input();
    comparator_account(&mut transfer_chain, &source);
    transfer_chain["request"]["clientRequestId"] = json!("pinned-ft-transfer-chain-comparator");
    transfer_chain["request"]["intent"] = json!({
        "type": "tbc.ft.transfer", "version": "1.0",
        "contractId": source["token"]["contractId"],
        "to": source["recipient"], "amount": "600"
    });
    transfer_chain["request"]["constraints"]["maxFee"] = json!("1000000");
    let mut transfer_chain_utxos = vec![comparator_funding_utxo(&source["funding"]["transferChain"])];
    transfer_chain_utxos.extend(source["holdings"].as_array().unwrap().iter().map(|holding| json!({
        "txid": holding["txid"], "vout": holding["vout"],
        "satoshis": holding["satoshis"], "scriptPubKey": holding["scriptPubKey"],
        "confirmations": "100", "classification": "ft",
        "contractId": source["token"]["contractId"]
    })));
    transfer_chain["snapshot"]["payload"]["utxos"] = Value::Array(transfer_chain_utxos);
    let mut transfer_chain_parents = vec![comparator_parent(&source["funding"]["transferChain"])];
    transfer_chain_parents.extend(source["parents"].as_array().unwrap().iter().map(comparator_parent));
    transfer_chain["snapshot"]["payload"]["parents"] = Value::Array(transfer_chain_parents);
    transfer_chain["snapshot"]["payload"]["contracts"] = json!([comparator_contract(
        &source, source["holdings"].as_array().unwrap().last().unwrap(),
    )]);
    transfer_chain = bind_request(transfer_chain);
    let transfer_chain_plan = call_ok(EngineMethod::Plan, &transfer_chain);
    let (transfer_chain_result, transfer_chain_digests) =
        finish_public_operation(&transfer_chain, &transfer_chain_plan);
    assert_source_transactions(
        source["transferChain"].as_array().unwrap(),
        &transfer_chain_plan,
        &transfer_chain_result,
        &transfer_chain_digests,
    );
    let wallet_transfer_chain = source["walletHighLevelExecution"]["chain"].as_array().unwrap();
    let sdk_transfer_chain = source["transferChain"].as_array().unwrap();
    assert_eq!(wallet_transfer_chain.len(), 2);
    assert_eq!(source["transferChainRuling"]["selected"], "sdk-protocol-valid");
    assert_eq!(source["transferChainRuling"]["walletMaintenanceFeeDelta"], "2");
    assert_eq!(source["walletSdkDivergence"]["source"], "walletHighLevelExecution.chain");
    assert_eq!(source["walletSdkDivergence"]["topology"], json!({
        "walletTransactionCount": 2,
        "sdkTransactionCount": 2,
        "sameDependencyShape": true
    }));
    assert_ne!(wallet_transfer_chain[0]["rawTransaction"], sdk_transfer_chain[0]["rawTransaction"]);
    assert_ne!(wallet_transfer_chain[0]["txid"], sdk_transfer_chain[0]["txid"]);
    let divergence = source["walletSdkDivergence"]["transactions"].as_array().unwrap();
    assert_eq!(divergence.len(), 2);
    for required in ["outputAmounts", "fee", "sighashes", "signatures", "unsignedRaw", "raw", "txid", "finalNativeOutputs"] {
        assert!(divergence[0]["differingFields"].as_array().unwrap()
            .iter().any(|field| field == required), "missing maintenance divergence {required}");
    }
    for required in ["inputOutpoints", "inputOrder", "outputAmounts", "outputScripts", "outputOrder", "tapeSlots", "sighashes", "signatures", "unsignedRaw", "raw", "txid", "downstreamParentOutpoint", "finalNativeOutputs"] {
        assert!(divergence[1]["differingFields"].as_array().unwrap()
            .iter().any(|field| field == required), "missing downstream divergence {required}");
    }
    assert_eq!(divergence[0]["equalFields"], json!([
        "inputOutpoints", "inputOrder", "sequences", "outputScripts",
        "tapeSlots", "downstreamParentOutpoint", "topology", "finalTokenOutputs"
    ]));
    assert_eq!(divergence[1]["equalFields"], json!([
        "sequences", "fee", "topology", "finalTokenOutputs"
    ]));
    let wallet_maintenance_fee = divergence[0]["values"]["fee"]["wallet"]
        .as_str().unwrap().parse::<u64>().unwrap();
    let sdk_maintenance_fee = divergence[0]["values"]["fee"]["sdk"]
        .as_str().unwrap().parse::<u64>().unwrap();
    assert_eq!(wallet_maintenance_fee, sdk_maintenance_fee + 2);
    assert_eq!(divergence[1]["values"]["tapeSlots"]["wallet"],
        json!(["100", "500", "0", "0", "0", "0"]));
    assert_eq!(divergence[1]["values"]["tapeSlots"]["sdk"],
        json!(["500", "100", "0", "0", "0", "0"]));
    assert_eq!(divergence[1]["values"]["finalTokenOutputs"]["wallet"], json!(["600"]));
    assert_eq!(divergence[1]["values"]["finalTokenOutputs"]["sdk"], json!(["600"]));

    let mut merge = base_plan_input();
    comparator_account(&mut merge, &source);
    merge["request"]["clientRequestId"] = json!("pinned-ft-terminal-merge-comparator");
    merge["request"]["intent"] = json!({
        "type": "tbc.ft.transfer", "version": "1.0",
        "contractId": source["token"]["contractId"],
        "to": source["owner"]["address"], "amount": "600"
    });
    merge["request"]["constraints"]["maxFee"] = json!("1000000");
    let mut merge_utxos = vec![comparator_funding_utxo(&source["funding"]["merge"])];
    merge_utxos.extend(source["holdings"].as_array().unwrap().iter().map(|holding| json!({
        "txid": holding["txid"], "vout": holding["vout"],
        "satoshis": holding["satoshis"], "scriptPubKey": holding["scriptPubKey"],
        "confirmations": "100", "classification": "ft",
        "contractId": source["token"]["contractId"]
    })));
    merge["snapshot"]["payload"]["utxos"] = Value::Array(merge_utxos);
    let mut merge_parents = vec![comparator_parent(&source["funding"]["merge"])];
    merge_parents.extend(source["parents"].as_array().unwrap().iter().map(comparator_parent));
    merge["snapshot"]["payload"]["parents"] = Value::Array(merge_parents);
    merge["snapshot"]["payload"]["contracts"] = json!([comparator_contract(
        &source, source["holdings"].as_array().unwrap().last().unwrap(),
    )]);
    merge = bind_request(merge);
    let merge_plan = call_ok(EngineMethod::Plan, &merge);
    let (merge_result, merge_digests) = finish_public_operation(&merge, &merge_plan);
    assert_source_transactions(
        source["explicitMerge"].as_array().unwrap(),
        &merge_plan,
        &merge_result,
        &merge_digests,
    );
}

// Native funding descriptors come from the wallet's address-UTXO endpoint;
// only FT/contract inputs require ancestry material before planning.
fn without_native_funding_parents(mut input: Value) -> Value {
    let native_txids: Vec<String> = input["snapshot"]["payload"]["utxos"]
        .as_array().unwrap().iter()
        .filter(|utxo| utxo["classification"] == "native")
        .map(|utxo| utxo["txid"].as_str().unwrap().to_owned())
        .collect();
    input["snapshot"]["payload"]["parents"].as_array_mut().unwrap()
        .retain(|parent| !native_txids.iter().any(|txid| parent["txid"] == txid.as_str()));
    bind_request(input)
}

#[test]
fn native_funding_descriptors_do_not_reenable_historical_ft_create() {
    assert_eq!(call_error(EngineMethod::Plan, &without_native_funding_parents(create_plan_input()))["code"], "UNSUPPORTED_INTENT");
}

#[test]
fn native_funding_descriptors_allow_ft_direct_without_native_parents() {
    call_ok(EngineMethod::Plan, &without_native_funding_parents(transfer_plan_input("direct")));
}

#[test]
fn fragmented_native_funding_can_pay_ft_transfer() {
    let mut input = without_native_funding_parents(transfer_plan_input("direct"));
    input["request"]["intent"]["attachedTbcAmount"] = json!("10000");
    let native = input["snapshot"]["payload"]["utxos"].as_array().unwrap().iter()
        .find(|utxo| utxo["classification"] == "native").unwrap().clone();
    let utxos = input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap();
    utxos.retain(|utxo| utxo["classification"] != "native");
    let mut whole = native.clone();
    whole["satoshis"] = json!("12000");
    utxos.push(whole);
    call_ok(EngineMethod::Plan, &bind_request(input.clone()));
    let utxos = input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap();
    utxos.retain(|utxo| utxo["classification"] != "native");
    for index in 1..=2 {
        let mut fragment = native.clone();
        fragment["txid"] = json!(format!("{index:064x}"));
        fragment["satoshis"] = json!("6000");
        utxos.push(fragment);
    }
    let input = bind_request(input);
    let planned = call_ok(EngineMethod::Plan, &input);
    let (finalized, _) = finish_public_operation(&input, &planned);
    assert_eq!(finalized["bundle"]["transactions"].as_array().unwrap().len(), 2);
    let mut validation = input.clone();
    validation["phase"] = json!("plan");
    validation["plan"] = planned["plan"].clone();
    assert_eq!(call_ok(EngineMethod::Validate, &validation)["valid"], true);
    let total = planned["plan"]["payload"]["preview"]["totalFee"].as_str().unwrap().parse::<u64>().unwrap();
    let mut capped = input.clone();
    capped["request"]["constraints"]["maxFee"] = json!((total - 1).to_string());
    assert_eq!(call_error(EngineMethod::Plan, &bind_request(capped))["code"], "FEE_CAP_EXCEEDED");
    let mut bounded = input.clone();
    bounded["policy"]["payload"]["maxBundleTransactions"] = json!(1);
    assert_eq!(call_error(EngineMethod::Plan, &bind_request(bounded))["code"], "INVALID_INPUT");
    let mut unconfirmed = input.clone();
    for utxo in unconfirmed["snapshot"]["payload"]["utxos"].as_array_mut().unwrap() {
        if utxo["classification"] == "native" { utxo["confirmations"] = json!("0"); }
    }
    unconfirmed["policy"]["payload"]["minConfirmations"] = json!("1");
    assert_eq!(call_error(EngineMethod::Plan, &bind_request(unconfirmed))["code"], "INSUFFICIENT_FUNDS");
    let mut restricted = input.clone();
    restricted["request"]["constraints"]["inputOutpoints"] = json!([{"txid": format!("{:064x}", 1), "vout": 0}]);
    assert_eq!(call_error(EngineMethod::NormalizeRequest, &json!({"version":"1.0", "request":restricted["request"]}))["code"], "INVALID_INPUT");
    let mut tampered = validation;
    tampered["plan"]["payload"]["transactions"][0]["fee"] = json!("0");
    tampered["plan"]["planHash"] = json!(canonical_hash(&tampered["plan"]["payload"]));
    assert_eq!(call_ok(EngineMethod::Validate, &tampered)["valid"], false);
}

#[test]
fn fragmented_native_funding_does_not_reenable_historical_ft_create() {
    let mut input = create_plan_input();
    fragmented_funding::replace(&mut input, 2, 6000);
    input["policy"]["payload"]["maxBundleTransactions"] = json!(3);
    let input = bind_request(input);
    assert_eq!(call_error(EngineMethod::Plan, &input)["code"], "UNSUPPORTED_INTENT");
}

#[test]
fn native_funding_descriptors_allow_ft_merge_without_native_parents() {
    call_ok(EngineMethod::Plan, &without_native_funding_parents(transfer_plan_input("mergeRequired")));
}

#[test]
fn native_funding_descriptors_still_reject_supplied_bad_parent() {
    let mut input = transfer_plan_input("direct");
    let txid = input["snapshot"]["payload"]["utxos"].as_array().unwrap().iter()
        .find(|utxo| utxo["classification"] == "native").unwrap()["txid"].clone();
    let parent = input["snapshot"]["payload"]["parents"].as_array_mut().unwrap().iter_mut()
        .find(|parent| parent["txid"] == txid).unwrap();
    parent["rawTransaction"] = json!("00");
    assert_eq!(call_error(EngineMethod::Plan, &bind_request(input))["code"], "INVALID_ANCESTRY");
}

#[test]
fn native_funding_descriptors_do_not_relax_ft_ancestry() {
    let mut input = transfer_plan_input("direct");
    input["snapshot"]["payload"]["parents"] = json!([]);
    assert_eq!(call_error(EngineMethod::Plan, &bind_request(input))["code"], "INVALID_ANCESTRY");
}

#[test]
fn native_funding_descriptors_still_reject_foreign_script() {
    let mut input = without_native_funding_parents(transfer_plan_input("direct"));
    let native = input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().iter_mut()
        .find(|utxo| utxo["classification"] == "native").unwrap();
    native["scriptPubKey"] = json!("51");
    assert_eq!(call_error(EngineMethod::Plan, &bind_request(input))["code"], "INVALID_ANCESTRY");
}

#[test]
fn native_funding_descriptors_reject_invalid_txids_without_panicking() {
    for txid in [
        String::new(),
        "invalid-txid".to_owned(),
        "0".repeat(63),
        "0".repeat(65),
        "g".repeat(64),
        "A".repeat(64),
    ] {
        let mut input = without_native_funding_parents(transfer_plan_input("direct"));
        let native = input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().iter_mut()
            .find(|utxo| utxo["classification"] == "native").unwrap();
        native["txid"] = json!(txid);
        assert_eq!(call_error(EngineMethod::Plan, &bind_request(input))["code"], "INVALID_INPUT");
    }
}
