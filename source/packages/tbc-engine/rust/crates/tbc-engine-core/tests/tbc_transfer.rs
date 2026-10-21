use serde_json::{Value, json};
#[path = "support/optional_confirmations.rs"]
mod optional_confirmations;

#[test]
fn optional_confirmations_native_thresholds_and_hash_binding() {
    optional_confirmations::exercise(fixture()["planInput"].clone());
}

use tbc_engine_core::{EngineMethod, call_json};
use tbc_sdk::{OutPoint, Transaction, TxIn, TxOut, Txid, script::Script};

fn fixture() -> Value {
    let mut fixture: Value = serde_json::from_str(include_str!("../../../fixtures/tbc-transfer.json"))
        .expect("the checked-in TBC transfer fixture must be valid JSON");
    // Keep the original SDK wire/signature vector immutable. The later review
    // envelope commits to these two independently specified outputs, not to
    // freshly generated Engine output (which would make the test circular).
    let mut plan = fixture["plan"]["plan"].clone();
    plan["payload"]["transactions"][0]["outputReview"] = json!([
        {"kind":"native", "outputIndices":[0], "amountAtomic":"1000",
         "nativeValueAtomic":"1000", "recipient":"1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP", "warnings":[]},
        {"kind":"native", "outputIndices":[1], "amountAtomic":"8920",
         "nativeValueAtomic":"8920", "recipient":"1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", "warnings":[]}
    ]);
    plan["planHash"] = json!(canonical_hash(&plan["payload"]));
    fixture["plan"]["plan"] = plan.clone();
    fixture["validateInput"]["plan"] = plan.clone();
    fixture["finalizeInput"]["plan"] = plan.clone();
    fixture["finalizeInput"]["binding"]["payload"]["operationHash"] = plan["planHash"].clone();
    let binding_hash = canonical_hash(&fixture["finalizeInput"]["binding"]["payload"]);
    fixture["finalizeInput"]["binding"]["bindingHash"] = json!(binding_hash);
    fixture["finalizeInput"]["approval"]["bindingHash"] = json!(binding_hash);
    fixture
}

fn call(method: EngineMethod, input: &Value) -> Value {
    serde_json::from_str(&call_json(method, &input.to_string()))
        .expect("the Engine must always return JSON")
}

fn call_ok(method: EngineMethod, input: &Value) -> Value {
    let envelope = call(method, input);
    assert_eq!(envelope["version"], "1.0", "{envelope}");
    assert_eq!(envelope["ok"], true, "{envelope}");
    envelope["result"].clone()
}

fn call_error(method: EngineMethod, input: &Value) -> Value {
    let envelope = call(method, input);
    assert_eq!(envelope["version"], "1.0", "{envelope}");
    assert_eq!(envelope["ok"], false, "{envelope}");
    envelope["error"].clone()
}

#[test]
fn tbc_transfer_matches_the_source_vector_through_all_four_methods() {
    let fixture = fixture();
    let normalized = call_ok(EngineMethod::NormalizeRequest, &fixture["normalizeInput"]);
    assert_eq!(normalized, fixture["normalizedRequest"]);

    let plan = call_ok(EngineMethod::Plan, &fixture["planInput"]);
    assert_eq!(plan, fixture["plan"]);
    assert_eq!(plan["plan"]["payload"]["transactions"][0]["role"], "primary");
    assert_eq!(
        plan["plan"]["payload"]["signingTasks"],
        fixture["plan"]["plan"]["payload"]["signingTasks"]
    );

    assert_eq!(
        call_ok(EngineMethod::Validate, &fixture["validateInput"]),
        fixture["validation"]
    );
    assert_eq!(
        call_ok(EngineMethod::Finalize, &fixture["finalizeInput"]),
        fixture["finalized"]
    );
}

#[test]
fn tbc_transfer_planning_is_deterministic_and_canonically_orders_inputs() {
    let fixture = fixture();
    let mut params = fixture["planInput"].clone();
    params["request"]["intent"]["amount"] = json!("2100");
    params["requestHash"] = json!(canonical_hash(&params["request"]));
    let source_script = params["snapshot"]["payload"]["utxos"][0]["scriptPubKey"]
        .as_str()
        .unwrap();
    let entries = [
        native_parent(900, 1, source_script),
        native_parent(1_400, 2, source_script),
        native_parent(800, 3, source_script),
    ];
    params["snapshot"]["payload"]["utxos"] = json!([
        entries[2].0,
        entries[1].0,
        entries[0].0
    ]);
    params["snapshot"]["payload"]["parents"] = json!([
        entries[2].1,
        entries[1].1,
        entries[0].1
    ]);
    params["snapshot"]["snapshotHash"] = json!(canonical_hash(&params["snapshot"]["payload"]));

    let first = call_ok(EngineMethod::Plan, &params);
    let second = call_ok(EngineMethod::Plan, &params);
    assert_eq!(first, second);
    let transaction = Transaction::from_hex(
        first["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(transaction.inputs.len(), 2);
    let actual = transaction
        .inputs
        .iter()
        .map(|input| input.previous_output.txid.to_string())
        .collect::<Vec<_>>();
    let mut expected = vec![
        entries[0].0["txid"].as_str().unwrap().to_owned(),
        entries[1].0["txid"].as_str().unwrap().to_owned(),
    ];
    expected.sort();
    assert_eq!(actual, expected);
}

#[test]
fn tbc_transfer_honors_an_explicit_bounded_input_set() {
    let fixture = fixture();
    let mut params = fixture["planInput"].clone();
    let source_script = params["snapshot"]["payload"]["utxos"][0]["scriptPubKey"]
        .as_str()
        .unwrap();
    let first = native_parent(5_000, 71, source_script);
    let second = native_parent(6_000, 72, source_script);
    params["snapshot"]["payload"]["utxos"] = json!([first.0, second.0]);
    params["snapshot"]["payload"]["parents"] = json!([first.1, second.1]);
    params["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&params["snapshot"]["payload"]));
    params["request"]["constraints"]["inputOutpoints"] = json!([{
        "txid": params["snapshot"]["payload"]["utxos"][1]["txid"],
        "vout": params["snapshot"]["payload"]["utxos"][1]["vout"],
    }]);
    params["requestHash"] = json!(canonical_hash(&params["request"]));

    let result = call_ok(EngineMethod::Plan, &params);
    let transaction = Transaction::from_hex(
        result["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(transaction.inputs.len(), 1);
    assert_eq!(
        transaction.inputs[0].previous_output.txid.to_string(),
        params["snapshot"]["payload"]["utxos"][1]["txid"].as_str().unwrap(),
    );

    params["request"]["constraints"]["inputOutpoints"][0]["txid"] = json!("ab".repeat(32));
    params["requestHash"] = json!(canonical_hash(&params["request"]));
    let error = call_error(EngineMethod::Plan, &params);
    assert_eq!(error["code"], "MISSING_MATERIAL");
    assert_eq!(error["path"], "request.constraints.inputOutpoints");
}

#[test]
fn tbc_public_merge_consolidates_two_or_more_inputs_into_one_primary_output() {
    let fixture = fixture();
    let mut params = fixture["planInput"].clone();
    params["request"]["clientRequestId"] = json!("tbc-public-merge");
    params["request"]["intent"] = json!({
        "type": "tbc.maintenance.merge",
        "version": "1.0",
    });
    params["request"]["constraints"]["maxFee"] = json!("1000");
    params["requestHash"] = json!(canonical_hash(&params["request"]));
    let source_script = params["snapshot"]["payload"]["utxos"][0]["scriptPubKey"]
        .as_str()
        .unwrap();
    let first = native_parent(2_000, 41, source_script);
    let second = native_parent(3_000, 42, source_script);
    params["snapshot"]["payload"]["utxos"] = json!([second.0, first.0]);
    params["snapshot"]["payload"]["parents"] = json!([second.1, first.1]);
    params["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&params["snapshot"]["payload"]));

    let result = call_ok(EngineMethod::Plan, &params);
    let transaction = Transaction::from_hex(
        result["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result["plan"]["payload"]["transactions"][0]["id"], "tbc-merge-1");
    assert_eq!(result["plan"]["payload"]["transactions"][0]["role"], "primary");
    assert_eq!(transaction.inputs.len(), 2);
    assert_eq!(transaction.outputs.len(), 1);
    assert_eq!(result["plan"]["payload"]["preview"]["assetFlows"][0]["direction"], "merge");

    params["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().truncate(1);
    params["snapshot"]["payload"]["parents"].as_array_mut().unwrap().truncate(1);
    params["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&params["snapshot"]["payload"]));
    assert_eq!(call_error(EngineMethod::Plan, &params)["code"], "INSUFFICIENT_FUNDS");
}

#[test]
fn sdk_gap_native_merge_100_101_500_and_501_boundary() {
    for count in [100, 101, 500, 501] {
        let mut params = fixture()["planInput"].clone();
        params["request"]["intent"] = json!({"type":"tbc.maintenance.merge","version":"1.0"});
        params["request"]["constraints"]["maxFee"] = json!("100000");
        params["requestHash"] = json!(canonical_hash(&params["request"]));
        let script = params["snapshot"]["payload"]["utxos"][0]["scriptPubKey"].as_str().unwrap().to_owned();
        let entries = (1..=count).map(|i| native_parent_index(10000, i, &script)).collect::<Vec<_>>();
        params["snapshot"]["payload"]["utxos"] = json!(entries.iter().map(|e| &e.0).collect::<Vec<_>>());
        params["snapshot"]["payload"]["parents"] = json!(entries.iter().map(|e| &e.1).collect::<Vec<_>>());
        params["snapshot"]["snapshotHash"] = json!(canonical_hash(&params["snapshot"]["payload"]));
        if count == 501 {
            assert_eq!(call_error(EngineMethod::Plan, &params)["code"], "INVALID_INPUT");
        } else {
            let planned = call_ok(EngineMethod::Plan, &params);
            let tx = Transaction::from_hex(planned["plan"]["payload"]["transactions"][0]["unsignedTransaction"].as_str().unwrap()).unwrap();
            assert_eq!(tx.inputs.len(), count as usize);
            assert_eq!(tx.outputs.len(), 1);
            let mut validation = params.clone(); validation["plan"] = planned["plan"].clone(); validation["phase"] = json!("plan");
            assert_eq!(call_ok(EngineMethod::Validate, &validation)["valid"], true);
            let mut finalize = validation_for_plan(&fixture(), &params, &planned, "pre-sign", "2026-08-31T12:01:00Z");
            finalize.as_object_mut().unwrap().remove("phase");
            let mut scalar=[0u8;32];scalar[31]=1;
            let key=secp256k1::SecretKey::from_byte_array(scalar).unwrap();
            finalize["signatures"]=json!(planned["plan"]["payload"]["signingTasks"].as_array().unwrap().iter().map(|task| {
                let digest=task["digest"].as_str().unwrap();
                let bytes=(0..digest.len()).step_by(2).map(|i|u8::from_str_radix(&digest[i..i+2],16).unwrap()).collect::<Vec<_>>();
                let signature=secp256k1::Secp256k1::new().sign_ecdsa(secp256k1::Message::from_digest(bytes.try_into().unwrap()),&key);
                json!({"taskId":task["taskId"],"signatureEncoding":"compact64","signature":signature.serialize_compact().iter().map(|b|format!("{b:02x}")).collect::<String>()})
            }).collect::<Vec<_>>());
            let finalized=call_ok(EngineMethod::Finalize,&finalize);
            let mut validation=finalize.clone();validation["phase"]=json!("pre-broadcast");validation["bundle"]=finalized["bundle"].clone();
            assert_eq!(call_ok(EngineMethod::Validate,&validation)["valid"],true);
            if std::env::var("TBC_SDK_GAP_DUMP").as_deref() == Ok("1") {
                println!("SDK_GAP_VECTOR:{}", json!({"case":format!("native-merge-{count}"),"input":params,"planned":planned,"finalizeInput":finalize,"finalized":finalized}));
            }
            if count == 500 {
                let mut bounded = params.clone();
                bounded["request"]["constraints"]["inputOutpoints"] = json!(entries.iter().take(100)
                    .map(|e| json!({"txid":e.0["txid"],"vout":e.0["vout"]})).collect::<Vec<_>>());
                bounded["requestHash"] = json!(canonical_hash(&bounded["request"]));
                let exact = call_ok(EngineMethod::Plan, &bounded);
                let tx = Transaction::from_hex(exact["plan"]["payload"]["transactions"][0]["unsignedTransaction"].as_str().unwrap()).unwrap();
                assert_eq!(tx.inputs.len(), 100, "a larger available set cannot expand an explicit approval scope");
                if std::env::var("TBC_SDK_GAP_DUMP").as_deref() == Ok("1") {
                    println!("SDK_GAP_VECTOR:{}", json!({"case":"native-merge-exact-100-of-500","input":bounded,"planned":exact}));
                }
                bounded["request"]["constraints"]["inputOutpoints"][0]["txid"] = json!("ff".repeat(32));
                bounded["requestHash"] = json!(canonical_hash(&bounded["request"]));
                assert_eq!(call_error(EngineMethod::Plan, &bounded)["code"], "MISSING_MATERIAL");
            }
        }
    }
}

#[test]
fn tbc_transfer_rejects_unsupported_intent_and_inconsistent_or_unsafe_material() {
    let fixture = fixture();

    let mut unsupported = fixture["normalizeInput"].clone();
    unsupported["request"]["intent"]["type"] = json!("tbc.unsupported");
    assert_eq!(
        call_error(EngineMethod::NormalizeRequest, &unsupported)["code"],
        "UNSUPPORTED_INTENT"
    );

    let mut wrong_hash = fixture["planInput"].clone();
    wrong_hash["requestHash"] = json!("00".repeat(32));
    assert_eq!(
        call_error(EngineMethod::Plan, &wrong_hash)["code"],
        "INVALID_INPUT"
    );

    let mut duplicate = fixture["planInput"].clone();
    let utxo = duplicate["snapshot"]["payload"]["utxos"][0].clone();
    duplicate["snapshot"]["payload"]["utxos"] = json!([utxo.clone(), utxo]);
    duplicate["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&duplicate["snapshot"]["payload"]));
    assert_eq!(
        call_error(EngineMethod::Plan, &duplicate)["code"],
        "INVALID_ANCESTRY"
    );

    let mut insufficient = fixture["planInput"].clone();
    insufficient["request"]["intent"]["amount"] = json!("100000");
    insufficient["requestHash"] = json!(canonical_hash(&insufficient["request"]));
    assert_eq!(
        call_error(EngineMethod::Plan, &insufficient)["code"],
        "INSUFFICIENT_FUNDS"
    );

    let mut dust = fixture["planInput"].clone();
    dust["request"]["intent"]["amount"] = json!("23");
    dust["requestHash"] = json!(canonical_hash(&dust["request"]));
    assert_eq!(
        call_error(EngineMethod::Plan, &dust)["code"],
        "INVALID_INPUT"
    );

    let mut overflow = fixture["planInput"].clone();
    let source_script = overflow["snapshot"]["payload"]["utxos"][0]["scriptPubKey"]
        .as_str()
        .unwrap();
    let first = native_parent(u64::MAX - 1, 11, source_script);
    let second = native_parent(2, 12, source_script);
    overflow["snapshot"]["payload"]["utxos"] = json!([first.0, second.0]);
    overflow["snapshot"]["payload"]["parents"] = json!([first.1, second.1]);
    overflow["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&overflow["snapshot"]["payload"]));
    overflow["request"]["intent"]["amount"] = json!((u64::MAX - 80).to_string());
    overflow["requestHash"] = json!(canonical_hash(&overflow["request"]));
    overflow["policy"]["payload"]["amountLimits"][0]["maximum"] =
        json!(u64::MAX.to_string());
    overflow["policy"]["policyHash"] = json!(canonical_hash(&overflow["policy"]["payload"]));
    assert_eq!(
        call_error(EngineMethod::Plan, &overflow)["code"],
        "INVALID_INPUT"
    );
}

#[test]
fn tbc_transfer_recomputes_plan_validation_and_rejects_bad_signatures() {
    let fixture = fixture();
    let mut validate = fixture["validateInput"].clone();
    validate["plan"]["payload"]["transactions"][0]["fee"] = json!("81");
    validate["plan"]["planHash"] = json!(canonical_hash(&validate["plan"]["payload"]));
    let result = call_ok(EngineMethod::Validate, &validate);
    assert_eq!(result["valid"], false);
    assert!(
        result["violations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|violation| violation["code"] == "FEE_MISMATCH")
    );

    let mut finalize = fixture["finalizeInput"].clone();
    finalize["signatures"][0]["signature"] = json!("00".repeat(64));
    assert_eq!(
        call_error(EngineMethod::Finalize, &finalize)["code"],
        "INVALID_SIGNATURE"
    );
}

#[test]
fn tbc_transfer_fee_selection_accepts_the_first_legal_envelope_candidate() {
    let fixture = fixture();
    let mut params = fixture["planInput"].clone();
    params["request"]["intent"]["amount"] = json!("24");
    params["request"]["constraints"]["maxFee"] = json!("20000");
    params["requestHash"] = json!(canonical_hash(&params["request"]));
    params["policy"]["payload"]["feeRateSatPerKb"] = json!("1000");
    params["policy"]["policyHash"] = json!(canonical_hash(&params["policy"]["payload"]));
    let source_script = params["snapshot"]["payload"]["utxos"][0]["scriptPubKey"]
        .as_str()
        .unwrap();
    let entries = (1..=110)
        .map(|marker| native_parent(150, marker, source_script))
        .collect::<Vec<_>>();
    params["snapshot"]["payload"]["utxos"] =
        Value::Array(entries.iter().map(|entry| entry.0.clone()).collect());
    params["snapshot"]["payload"]["parents"] =
        Value::Array(entries.iter().map(|entry| entry.1.clone()).collect());
    params["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&params["snapshot"]["payload"]));

    let result = call_ok(EngineMethod::Plan, &params);
    let transaction = Transaction::from_hex(
        result["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(transaction.inputs.len(), 34);
    assert_eq!(transaction.outputs.len(), 1);
    assert_eq!(result["plan"]["payload"]["transactions"][0]["fee"], "5076");

    let mut capped = params;
    capped["request"]["constraints"]["maxFee"] = json!("5075");
    capped["requestHash"] = json!(canonical_hash(&capped["request"]));
    assert_eq!(
        call_error(EngineMethod::Plan, &capped)["code"],
        "FEE_CAP_EXCEEDED"
    );
}

#[test]
fn tbc_transfer_accepts_no_change_when_value_covers_only_the_no_change_envelope() {
    let fixture = fixture();
    let mut params = fixture["planInput"].clone();
    params["request"]["constraints"]["maxFee"] = json!("2000");
    params["requestHash"] = json!(canonical_hash(&params["request"]));
    params["policy"]["payload"]["feeRateSatPerKb"] = json!("1000");
    params["policy"]["policyHash"] = json!(canonical_hash(&params["policy"]["payload"]));
    let source_script = params["snapshot"]["payload"]["utxos"][0]["scriptPubKey"]
        .as_str()
        .unwrap();
    let entries = (1..=7)
        .map(|marker| native_parent(300, marker, source_script))
        .collect::<Vec<_>>();
    params["snapshot"]["payload"]["utxos"] =
        Value::Array(entries.iter().map(|entry| entry.0.clone()).collect());
    params["snapshot"]["payload"]["parents"] =
        Value::Array(entries.iter().map(|entry| entry.1.clone()).collect());
    params["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&params["snapshot"]["payload"]));

    let result = call_ok(EngineMethod::Plan, &params);
    let transaction = Transaction::from_hex(
        result["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
            .as_str()
            .unwrap(),
    )
    .unwrap();

    assert_eq!(transaction.inputs.len(), 7);
    assert_eq!(transaction.outputs.len(), 1);
    assert_eq!(result["plan"]["payload"]["transactions"][0]["fee"], "1100");
}

#[test]
fn tbc_transfer_accepts_only_closed_native_inputs() {
    let fixture = fixture();
    for (classification, contract_id) in [
        ("unknown", None),
        ("ft", Some("contract-1")),
        ("native", Some("contract-1")),
    ] {
        let mut params = fixture["planInput"].clone();
        params["snapshot"]["payload"]["utxos"][0]["classification"] =
            json!(classification);
        if let Some(contract_id) = contract_id {
            params["snapshot"]["payload"]["utxos"][0]["contractId"] = json!(contract_id);
        }
        params["snapshot"]["snapshotHash"] =
            json!(canonical_hash(&params["snapshot"]["payload"]));
        assert_eq!(
            call_error(EngineMethod::Plan, &params)["code"],
            "INVALID_ANCESTRY"
        );
    }
}

#[test]
fn tbc_transfer_covers_selection_change_and_malformed_material_boundaries() {
    let fixture = fixture();
    let source_script = fixture["planInput"]["snapshot"]["payload"]["utxos"][0]
        ["scriptPubKey"]
        .as_str()
        .unwrap();

    let mut smallest = fixture["planInput"].clone();
    let small = native_parent(1_104, 20, source_script);
    let large = native_parent(2_000, 21, source_script);
    smallest["snapshot"]["payload"]["utxos"] = json!([large.0, small.0]);
    smallest["snapshot"]["payload"]["parents"] = json!([large.1, small.1]);
    smallest["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&smallest["snapshot"]["payload"]));
    let result = call_ok(EngineMethod::Plan, &smallest);
    let transaction = Transaction::from_hex(
        result["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(transaction.inputs.len(), 1);
    assert_eq!(transaction.inputs[0].previous_output.txid.to_string(), small.0["txid"]);

    for (input_value, output_count, expected_fee) in [(1_103, 1, "103"), (1_104, 2, "80")] {
        let mut boundary = fixture["planInput"].clone();
        let entry = native_parent(input_value, input_value as u8, source_script);
        boundary["snapshot"]["payload"]["utxos"] = json!([entry.0]);
        boundary["snapshot"]["payload"]["parents"] = json!([entry.1]);
        boundary["snapshot"]["snapshotHash"] =
            json!(canonical_hash(&boundary["snapshot"]["payload"]));
        boundary["request"]["constraints"]["maxFee"] = json!("200");
        boundary["requestHash"] = json!(canonical_hash(&boundary["request"]));
        let result = call_ok(EngineMethod::Plan, &boundary);
        let transaction = Transaction::from_hex(
            result["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(transaction.outputs.len(), output_count);
        assert_eq!(result["plan"]["payload"]["transactions"][0]["fee"], expected_fee);
    }

    let mut bad_address = fixture["planInput"].clone();
    bad_address["request"]["intent"]["to"] = json!("not-an-address");
    bad_address["requestHash"] = json!(canonical_hash(&bad_address["request"]));
    assert_eq!(call_error(EngineMethod::Plan, &bad_address)["code"], "INVALID_INPUT");

    let mut bad_script = fixture["planInput"].clone();
    bad_script["snapshot"]["payload"]["utxos"][0]["scriptPubKey"] = json!("zz");
    bad_script["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&bad_script["snapshot"]["payload"]));
    assert_eq!(call_error(EngineMethod::Plan, &bad_script)["code"], "INVALID_ANCESTRY");

    let mut bad_parent = fixture["planInput"].clone();
    bad_parent["snapshot"]["payload"]["parents"][0]["rawTransaction"] = json!("00");
    bad_parent["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&bad_parent["snapshot"]["payload"]));
    assert_eq!(call_error(EngineMethod::Plan, &bad_parent)["code"], "INVALID_ANCESTRY");
}

#[test]
fn tbc_transfer_validation_is_phase_aware_and_cryptographic() {
    let fixture = fixture();

    let mut pre_sign = fixture["validateInput"].clone();
    pre_sign["phase"] = json!("pre-sign");
    pre_sign["binding"] = fixture["finalizeInput"]["binding"].clone();
    pre_sign["approval"] = fixture["finalizeInput"]["approval"].clone();
    assert_eq!(call_ok(EngineMethod::Validate, &pre_sign)["valid"], true);

    for phase in ["finalized", "pre-broadcast"] {
        let mut validate = pre_sign.clone();
        validate["phase"] = json!(phase);
        validate["signatures"] = fixture["finalizeInput"]["signatures"].clone();
        validate["bundle"] = fixture["finalized"]["bundle"].clone();
        assert_eq!(call_ok(EngineMethod::Validate, &validate)["valid"], true);

        let mut missing_signature = validate.clone();
        missing_signature.as_object_mut().unwrap().remove("signatures");
        let result = call_ok(EngineMethod::Validate, &missing_signature);
        assert_eq!(result["valid"], false);
        assert!(result["violations"].as_array().unwrap().iter().any(|v| v["code"] == "SIGNATURE_INVALID"));

        let mut tampered_bundle = validate.clone();
        tampered_bundle["bundle"]["transactions"][0]["rawTransaction"] = json!("00");
        let result = call_ok(EngineMethod::Validate, &tampered_bundle);
        assert_eq!(result["valid"], false);
        assert!(result["violations"].as_array().unwrap().iter().any(|v| v["code"] == "ARTIFACT_MISMATCH"));

        let mut tampered_signature = validate;
        tampered_signature["signatures"][0]["signature"] = json!("00".repeat(64));
        let result = call_ok(EngineMethod::Validate, &tampered_signature);
        assert_eq!(result["valid"], false);
        assert!(result["violations"].as_array().unwrap().iter().any(|v| v["code"] == "SIGNATURE_INVALID"));
    }
}

#[test]
fn tbc_transfer_validation_enforces_phase_fields_and_registry_violation_order() {
    let fixture = fixture();
    let mut plan = fixture["validateInput"].clone();
    plan["binding"] = fixture["finalizeInput"]["binding"].clone();
    plan["approval"] = fixture["finalizeInput"]["approval"].clone();
    plan["signatures"] = fixture["finalizeInput"]["signatures"].clone();
    plan["bundle"] = fixture["finalized"]["bundle"].clone();
    let result = call_ok(EngineMethod::Validate, &plan);
    assert_eq!(result["valid"], false);
    let codes = result["violations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|violation| violation["code"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        codes,
        vec!["APPROVAL_BINDING_MISMATCH", "SIGNATURE_INVALID", "ARTIFACT_MISMATCH"]
    );

    let mut pre_sign = fixture["validateInput"].clone();
    pre_sign["phase"] = json!("pre-sign");
    pre_sign["signatures"] = fixture["finalizeInput"]["signatures"].clone();
    let result = call_ok(EngineMethod::Validate, &pre_sign);
    assert_eq!(result["valid"], false);
    assert!(result["violations"].as_array().unwrap().iter().any(|v| v["code"] == "APPROVAL_BINDING_MISMATCH"));
    assert!(result["violations"].as_array().unwrap().iter().any(|v| v["code"] == "SIGNATURE_INVALID"));
}

#[test]
fn tbc_transfer_finalization_rejects_missing_duplicate_and_misdirected_signatures() {
    let fixture = fixture();

    let mut missing = fixture["finalizeInput"].clone();
    missing["signatures"] = json!([]);
    assert_eq!(call_error(EngineMethod::Finalize, &missing)["code"], "MISSING_SIGNATURE");

    let mut duplicate = fixture["finalizeInput"].clone();
    duplicate["signatures"] = json!([
        fixture["finalizeInput"]["signatures"][0],
        fixture["finalizeInput"]["signatures"][0]
    ]);
    assert_eq!(call_error(EngineMethod::Finalize, &duplicate)["code"], "INVALID_SIGNATURE");

    let mut wrong_task = fixture["finalizeInput"].clone();
    wrong_task["signatures"][0]["taskId"] = json!("sign-tx-1-input-99");
    assert_eq!(call_error(EngineMethod::Finalize, &wrong_task)["code"], "INVALID_SIGNATURE");

    let mut malformed = fixture["finalizeInput"].clone();
    malformed["signatures"][0]["signature"] = json!("00");
    assert_eq!(call_error(EngineMethod::Finalize, &malformed)["code"], "INVALID_SIGNATURE");
}

#[test]
fn tbc_transfer_accepts_transaction_and_workflow_approval_methods() {
    let fixture = fixture();
    for (method, operation_kind) in [
        ("tbc_signTransaction", "transaction"),
        ("tbc_signPreparedTransaction", "transaction"),
        ("tbc_sendTransaction", "transaction"),
        ("tbc_sendPreparedTransaction", "transaction"),
        ("tbc_signWorkflow", "workflow"),
        ("tbc_signPreparedWorkflow", "workflow"),
        ("tbc_sendWorkflow", "workflow"),
        ("tbc_sendPreparedWorkflow", "workflow"),
    ] {
        for phase in ["finalized", "pre-broadcast"] {
            let mut validate = fixture["validateInput"].clone();
            validate["phase"] = json!(phase);
            let mut binding = fixture["finalizeInput"]["binding"].clone();
            binding["payload"]["method"] = json!(method);
            binding["payload"]["operationKind"] = json!(operation_kind);
            if operation_kind == "workflow" {
                binding["payload"]["requestHash"] = json!("11".repeat(32));
                binding["payload"]["operationHash"] = json!("22".repeat(32));
            }
            binding["bindingHash"] = json!(canonical_hash(&binding["payload"]));
            let mut approval = fixture["finalizeInput"]["approval"].clone();
            approval["bindingHash"] = binding["bindingHash"].clone();
            validate["binding"] = binding;
            validate["approval"] = approval;
            validate["signatures"] = fixture["finalizeInput"]["signatures"].clone();
            validate["bundle"] = fixture["finalized"]["bundle"].clone();
            assert_eq!(call_ok(EngineMethod::Validate, &validate)["valid"], true);
        }
    }

    let mut unsupported = fixture["validateInput"].clone();
    unsupported["phase"] = json!("finalized");
    let mut binding = fixture["finalizeInput"]["binding"].clone();
    binding["payload"]["method"] = json!("tbc_signMessage");
    binding["bindingHash"] = json!(canonical_hash(&binding["payload"]));
    let mut approval = fixture["finalizeInput"]["approval"].clone();
    approval["bindingHash"] = binding["bindingHash"].clone();
    unsupported["binding"] = binding;
    unsupported["approval"] = approval;
    unsupported["signatures"] = fixture["finalizeInput"]["signatures"].clone();
    unsupported["bundle"] = fixture["finalized"]["bundle"].clone();
    let result = call_ok(EngineMethod::Validate, &unsupported);
    assert_eq!(result["valid"], false);
    assert!(result["violations"].as_array().unwrap().iter().any(|v| v["code"] == "APPROVAL_BINDING_MISMATCH"));

    let mut replay = fixture["validateInput"].clone();
    replay["phase"] = json!("finalized");
    replay["binding"] = fixture["finalizeInput"]["binding"].clone();
    replay["binding"]["payload"]["method"] = json!("tbc_signTransaction");
    replay["approval"] = fixture["finalizeInput"]["approval"].clone();
    replay["signatures"] = fixture["finalizeInput"]["signatures"].clone();
    replay["bundle"] = fixture["finalized"]["bundle"].clone();
    assert_eq!(call_ok(EngineMethod::Validate, &replay)["valid"], false);
}

#[test]
fn tbc_transfer_accepts_utc_milliseconds_without_changing_signed_transaction() {
    let fixture = fixture();
    for timestamp in ["2026-08-31T12:02:00.0Z", "2026-08-31T12:02:00.00Z", "2026-08-31T12:02:00.000Z"] {
        let mut params = fixture["planInput"].clone();
        params["request"]["constraints"]["expiresAt"] = json!(timestamp);
        params["requestHash"] = json!(canonical_hash(&params["request"]));
        let planned = call_ok(EngineMethod::Plan, &params);
        assert_eq!(planned["plan"]["payload"]["transactions"], fixture["plan"]["plan"]["payload"]["transactions"]);
        let mut finalize = fixture["finalizeInput"].clone();
        finalize["approval"]["approvedAt"] = json!("2026-08-31T12:00:10.123Z");
        finalize["approval"]["expiresAt"] = json!(timestamp);
        assert_eq!(call_ok(EngineMethod::Finalize, &finalize), fixture["finalized"]);
    }
}

#[test]
fn tbc_transfer_rejects_noncanonical_or_invalid_timestamps_before_planning() {
    let fixture = fixture();
    for timestamp in [
        "not-a-time",
        "2026-08-31T20:02:00+08:00",
        "2026-08-31T12:02:00.0001Z",
        "2026-08-31T12:02:00.Z",
        "2026-02-30T12:02:00Z",
        "2026-08-31T24:02:00Z",
    ] {
        let mut params = fixture["planInput"].clone();
        params["request"]["constraints"]["expiresAt"] = json!(timestamp);
        params["requestHash"] = json!(canonical_hash(&params["request"]));
        assert_eq!(call_error(EngineMethod::Plan, &params)["code"], "INVALID_INPUT");
    }

    let mut valid_leap_day = fixture["planInput"].clone();
    valid_leap_day["request"]["constraints"]["expiresAt"] = json!("2028-02-29T12:02:00Z");
    valid_leap_day["requestHash"] = json!(canonical_hash(&valid_leap_day["request"]));
    assert_eq!(call_ok(EngineMethod::Plan, &valid_leap_day)["plan"]["payload"]["expiresAt"], "2026-08-31T12:02:00Z");

    for (field, timestamp) in [
        ("approvedAt", "2026-02-30T12:00:10Z"),
        ("expiresAt", "2026-08-31T12:02:00+00:00"),
        ("expiresAt", "2026-08-31T12:02:00.0001Z"),
    ] {
        let mut finalize = fixture["finalizeInput"].clone();
        finalize["approval"][field] = json!(timestamp);
        assert_eq!(call_error(EngineMethod::Finalize, &finalize)["code"], "INVALID_PLAN");
    }

    let mut extended_receipt = fixture["finalizeInput"].clone();
    extended_receipt["approval"]["expiresAt"] = json!("2026-08-31T12:02:01Z");
    assert_eq!(call_error(EngineMethod::Finalize, &extended_receipt)["code"], "INVALID_PLAN");

    let mut expiry_mismatch = fixture["finalizeInput"].clone();
    expiry_mismatch["binding"]["payload"]["expiresAt"] = json!("2026-08-31T12:01:59Z");
    expiry_mismatch["binding"]["bindingHash"] =
        json!(canonical_hash(&expiry_mismatch["binding"]["payload"]));
    expiry_mismatch["approval"]["bindingHash"] = expiry_mismatch["binding"]["bindingHash"].clone();
    assert_eq!(call_error(EngineMethod::Finalize, &expiry_mismatch)["code"], "INVALID_PLAN");
}

#[test]
fn tbc_transfer_finalization_accepts_before_and_equal_approval_times() {
    let fixture = fixture();
    for method in ["tbc_signTransaction", "tbc_sendTransaction"] {
        for approved_at in ["2026-08-31T12:01:59Z", "2026-08-31T12:02:00Z"] {
            let finalize = finalize_for_method_and_time(&fixture, method, approved_at);
            assert_eq!(call_ok(EngineMethod::Finalize, &finalize), fixture["finalized"]);
        }
        let later = finalize_for_method_and_time(
            &fixture,
            method,
            "2026-08-31T12:02:01Z",
        );
        assert_eq!(call_error(EngineMethod::Finalize, &later)["code"], "INVALID_PLAN");
    }
}

#[test]
fn approval_may_shorten_but_never_extend_the_transaction_plan() {
    let fixture = fixture();
    for method in ["tbc_signTransaction", "tbc_sendTransaction", "tbc_signPreparedTransaction",
        "tbc_sendPreparedTransaction", "tbc_signWorkflow", "tbc_sendWorkflow",
        "tbc_signPreparedWorkflow", "tbc_sendPreparedWorkflow"] {
        let mut input = fixture["finalizeInput"].clone();
        input["binding"]["payload"]["method"] = json!(method);
        input["binding"]["payload"]["operationKind"] = json!(if method.ends_with("Workflow") { "workflow" } else { "transaction" });
        input["binding"]["payload"]["expiresAt"] = json!("2026-08-31T12:00:30Z");
        input["binding"]["bindingHash"] = json!(canonical_hash(&input["binding"]["payload"]));
        input["approval"]["bindingHash"] = input["binding"]["bindingHash"].clone();
        input["approval"]["expiresAt"] = input["binding"]["payload"]["expiresAt"].clone();
        assert_eq!(call_ok(EngineMethod::Finalize, &input), fixture["finalized"]);
        let mut validation = input.clone();
        validation.as_object_mut().unwrap().remove("signatures");
        validation["phase"] = json!("pre-sign");
        assert_eq!(call_ok(EngineMethod::Validate, &validation)["valid"], true);

        // A short receipt cannot legitimize an overlong binding, even in a batch.
        input["binding"]["payload"]["expiresAt"] = json!("2026-08-31T12:02:01Z");
        input["binding"]["bindingHash"] = json!(canonical_hash(&input["binding"]["payload"]));
        input["approval"]["bindingHash"] = input["binding"]["bindingHash"].clone();
        assert_eq!(call_error(EngineMethod::Finalize, &input)["code"], "INVALID_PLAN");
        input.as_object_mut().unwrap().remove("signatures");
        input["phase"] = json!("pre-sign");
        assert_eq!(call_ok(EngineMethod::Validate, &input)["valid"], false);
    }
}

#[test]
fn tbc_transfer_validation_matches_frozen_snapshot_expiry_boundaries_in_all_phases() {
    let fixture = fixture();
    for (snapshot_expiry, approved_at, expected) in [
        (
            "2026-08-31T11:59:59Z",
            "2026-08-31T11:59:58Z",
            vec!["PLAN_EXPIRED", "SNAPSHOT_EXPIRED"],
        ),
        (
            "2026-08-31T12:00:00Z",
            "2026-08-31T11:59:59Z",
            vec!["PLAN_EXPIRED", "SNAPSHOT_EXPIRED"],
        ),
        ("2026-08-31T12:00:01Z", "2026-08-31T12:00:00Z", vec![]),
    ] {
        let mut plan_input = fixture["planInput"].clone();
        plan_input["snapshot"]["payload"]["expiresAt"] = json!(snapshot_expiry);
        plan_input["snapshot"]["snapshotHash"] =
            json!(canonical_hash(&plan_input["snapshot"]["payload"]));
        let plan = call_ok(EngineMethod::Plan, &plan_input);
        for phase in ["plan", "pre-sign", "finalized", "pre-broadcast"] {
            let validate = validation_for_plan(
                &fixture,
                &plan_input,
                &plan,
                phase,
                approved_at,
            );
            let result = call_ok(EngineMethod::Validate, &validate);
            let codes = result["violations"]
                .as_array()
                .unwrap()
                .iter()
                .map(|violation| violation["code"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(codes, expected, "{phase} {snapshot_expiry}: {result}");
        }
    }
}

#[test]
fn tbc_transfer_validation_matches_frozen_plan_expiry_relationships() {
    let fixture = fixture();

    let mut changed_plan = fixture["validateInput"].clone();
    changed_plan["plan"]["payload"]["expiresAt"] = json!("2026-08-31T12:01:59Z");
    changed_plan["plan"]["planHash"] =
        json!(canonical_hash(&changed_plan["plan"]["payload"]));
    let result = call_ok(EngineMethod::Validate, &changed_plan);
    assert!(result["violations"].as_array().unwrap().iter().any(|v| v["code"] == "PLAN_EXPIRED"));

    let mut request_at_capture = fixture["planInput"].clone();
    request_at_capture["request"]["constraints"]["expiresAt"] = json!("2026-08-31T12:00:00Z");
    request_at_capture["requestHash"] = json!(canonical_hash(&request_at_capture["request"]));
    let plan = call_ok(EngineMethod::Plan, &request_at_capture);
    let validate = validation_for_plan(
        &fixture,
        &request_at_capture,
        &plan,
        "plan",
        "2026-08-31T11:59:59Z",
    );
    let result = call_ok(EngineMethod::Validate, &validate);
    assert_eq!(
        result["violations"].as_array().unwrap().iter().map(|v| v["code"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["PLAN_EXPIRED"]
    );
}

#[test]
fn tbc_transfer_validation_maps_malformed_expiries_without_amount_violations() {
    let fixture = fixture();
    let mut malformed_plan = fixture["validateInput"].clone();
    malformed_plan["request"]["constraints"]["expiresAt"] = json!("not-a-time");
    malformed_plan["requestHash"] = json!(canonical_hash(&malformed_plan["request"]));
    let result = call_ok(EngineMethod::Validate, &malformed_plan);
    let codes = result["violations"].as_array().unwrap();
    assert!(codes.iter().any(|v| v["code"] == "PLAN_EXPIRED"));
    assert!(!codes.iter().any(|v| v["code"] == "AMOUNT_OUT_OF_RANGE"));

    let mut malformed_snapshot = fixture["validateInput"].clone();
    malformed_snapshot["snapshot"]["payload"]["capturedAt"] = json!("2026-02-30T12:00:00Z");
    malformed_snapshot["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&malformed_snapshot["snapshot"]["payload"]));
    let result = call_ok(EngineMethod::Validate, &malformed_snapshot);
    let codes = result["violations"].as_array().unwrap();
    assert!(codes.iter().any(|v| v["code"] == "SNAPSHOT_EXPIRED"));
    assert!(!codes.iter().any(|v| v["code"] == "AMOUNT_OUT_OF_RANGE"));
}

#[test]
fn tbc_transfer_prevalidates_schema_cardinality_and_selected_input_cap() {
    let fixture = fixture();
    let mut oversized = fixture["planInput"].clone();
    let repeated = oversized["snapshot"]["payload"]["utxos"][0].clone();
    oversized["snapshot"]["payload"]["utxos"] =
        Value::Array((0..10_001).map(|_| repeated.clone()).collect());
    oversized["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&oversized["snapshot"]["payload"]));
    assert_eq!(call_error(EngineMethod::Plan, &oversized)["code"], "INVALID_INPUT");

    let mut capped = fixture["planInput"].clone();
    capped["request"]["intent"]["amount"] = json!("1921");
    capped["requestHash"] = json!(canonical_hash(&capped["request"]));
    let source_script = capped["snapshot"]["payload"]["utxos"][0]["scriptPubKey"]
        .as_str()
        .unwrap();
    let entries = (1..=1_001)
        .map(|index| native_parent_index(2, index, source_script))
        .collect::<Vec<_>>();
    capped["snapshot"]["payload"]["utxos"] =
        Value::Array(entries.iter().map(|entry| entry.0.clone()).collect());
    capped["snapshot"]["payload"]["parents"] =
        Value::Array(entries.iter().map(|entry| entry.1.clone()).collect());
    capped["snapshot"]["snapshotHash"] =
        json!(canonical_hash(&capped["snapshot"]["payload"]));
    assert_eq!(call_error(EngineMethod::Plan, &capped)["code"], "INVALID_INPUT");
}

#[test]
fn tbc_transfer_facade_rejects_validly_encoded_wrong_key_digest_and_high_s_signatures() {
    let fixture = fixture();
    let signatures = [
        "a9ab9a50f455d5b0504e4ea8c32348a9b971dca8aa5ad921fe8dfd19387b189048e55ee205aa261e382ec8722817ae65c69387d563b510c2384e5038250c5204",
        "a0b37f8fba683cc68f6574cd43b39f0343a50008bf6ccea9d13231d9e7e2e1e411edc8d307254296264aebfc3dc76cd8b668373a072fd64665b50000e9fcce52",
        "5f8792e014eb953efc9c563e18c8024a750e7513ec575775b371102fde8ceb22a959209b01e1d261ce3d1cb0ca7eb9b1f42c05d83c5c54c2f28d9003bb357b34",
    ];
    for signature in signatures {
        assert_eq!(call_ok(EngineMethod::NormalizeRequest, &fixture["normalizeInput"]), fixture["normalizedRequest"]);
        assert_eq!(call_ok(EngineMethod::Plan, &fixture["planInput"]), fixture["plan"]);

        let mut finalize = fixture["finalizeInput"].clone();
        finalize["signatures"][0]["signature"] = json!(signature);
        assert_eq!(call_error(EngineMethod::Finalize, &finalize)["code"], "INVALID_SIGNATURE");

        let mut validate = fixture["validateInput"].clone();
        validate["phase"] = json!("finalized");
        validate["binding"] = fixture["finalizeInput"]["binding"].clone();
        validate["approval"] = fixture["finalizeInput"]["approval"].clone();
        validate["signatures"] = finalize["signatures"].clone();
        validate["bundle"] = fixture["finalized"]["bundle"].clone();
        let result = call_ok(EngineMethod::Validate, &validate);
        assert_eq!(result["valid"], false);
        assert!(result["violations"].as_array().unwrap().iter().any(|v| v["code"] == "SIGNATURE_INVALID"));
    }
}

fn canonical_hash(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(serde_json::to_vec(value).unwrap());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn native_parent(satoshis: u64, marker: u8, source_script: &str) -> (Value, Value) {
    native_parent_index(satoshis, marker as u32, source_script)
}

fn native_parent_index(satoshis: u64, marker: u32, source_script: &str) -> (Value, Value) {
    let mut previous_txid = [0u8; 32];
    previous_txid[..4].copy_from_slice(&marker.to_le_bytes());
    let transaction = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn {
            previous_output: OutPoint {
                txid: Txid::from_le_bytes(previous_txid),
                vout: marker,
            },
            script_sig: Script::from_bytes([vec![0x54], marker.to_le_bytes().to_vec()].concat()),
            sequence: tbc_sdk::DEFAULT_SEQUENCE,
        }],
        outputs: vec![TxOut {
            satoshis,
            script_pubkey: Script::from_bytes(decode_hex(source_script)),
        }],
        lock_time: marker,
    };
    let txid = transaction.txid().to_string();
    (
        json!({
            "txid": txid,
            "vout": 0,
            "satoshis": satoshis.to_string(),
            "scriptPubKey": source_script,
            "confirmations": "100",
            "classification": "native"
        }),
        json!({
            "txid": txid,
            "rawTransaction": transaction.to_hex()
        }),
    )
}

fn decode_hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |byte: u8| match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                _ => panic!("fixture script must be lower-case hexadecimal"),
            };
            (digit(pair[0]) << 4) | digit(pair[1])
        })
        .collect()
}

fn finalize_for_method_and_time(fixture: &Value, method: &str, approved_at: &str) -> Value {
    let mut finalize = fixture["finalizeInput"].clone();
    finalize["binding"]["payload"]["method"] = json!(method);
    finalize["binding"]["bindingHash"] =
        json!(canonical_hash(&finalize["binding"]["payload"]));
    finalize["approval"]["bindingHash"] = finalize["binding"]["bindingHash"].clone();
    finalize["approval"]["approvedAt"] = json!(approved_at);
    finalize
}

fn validation_for_plan(
    fixture: &Value,
    plan_input: &Value,
    plan: &Value,
    phase: &str,
    approved_at: &str,
) -> Value {
    let mut validate = json!({
        "version": plan_input["version"],
        "phase": phase,
        "request": plan_input["request"],
        "requestHash": plan_input["requestHash"],
        "snapshot": plan_input["snapshot"],
        "policy": plan_input["policy"],
        "plan": plan["plan"]
    });
    if phase != "plan" {
        let mut binding = fixture["finalizeInput"]["binding"].clone();
        binding["payload"]["requestHash"] = plan_input["requestHash"].clone();
        binding["payload"]["operationHash"] = plan["plan"]["planHash"].clone();
        binding["payload"]["expiresAt"] = plan["plan"]["payload"]["expiresAt"].clone();
        binding["bindingHash"] = json!(canonical_hash(&binding["payload"]));
        let mut approval = fixture["finalizeInput"]["approval"].clone();
        approval["bindingHash"] = binding["bindingHash"].clone();
        approval["approvedAt"] = json!(approved_at);
        approval["expiresAt"] = plan["plan"]["payload"]["expiresAt"].clone();
        validate["binding"] = binding;
        validate["approval"] = approval;
    }
    if matches!(phase, "finalized" | "pre-broadcast") {
        validate["signatures"] = fixture["finalizeInput"]["signatures"].clone();
        let mut bundle = fixture["finalized"]["bundle"].clone();
        bundle["requestHash"] = plan_input["requestHash"].clone();
        validate["bundle"] = bundle;
    }
    validate
}
