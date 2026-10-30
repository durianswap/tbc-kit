use super::*;
use std::collections::BTreeSet;

fn exact(mut p: Value) -> Value {
    p["request"]["constraints"]["inputOutpoints"] = json!(p["snapshot"]["payload"]["utxos"]
        .as_array().unwrap().iter().map(|u| json!({"txid":u["txid"],"vout":u["vout"]})).collect::<Vec<_>>());
    bind_request(p)
}

fn check(p: &Value) -> Value {
    let planned = call_ok(EngineMethod::Plan, p);
    let mut validation = p.clone();
    validation["phase"] = json!("plan"); validation["plan"] = planned["plan"].clone();
    assert_eq!(call_ok(EngineMethod::Validate, &validation)["valid"], true);
    let id = &p["request"]["intent"]["contractId"];
    for flow in planned["plan"]["payload"]["preview"]["assetFlows"].as_array().unwrap() {
        if flow["kind"] == "ft" { assert_eq!(&flow["contractId"], id); }
        else { assert!(flow.get("contractId").is_none()); }
    }
    let (result, _) = finish_public_operation(p, &planned);
    let txs = result["bundle"]["transactions"].as_array().unwrap();
    let ids: BTreeSet<_> = txs.iter().map(|t| t["txid"].as_str().unwrap().to_owned()).collect();
    let external: Vec<_> = txs.iter().flat_map(|t| Transaction::from_hex(t["rawTransaction"].as_str().unwrap()).unwrap().inputs)
        .filter(|i| !ids.contains(&i.previous_output.txid.to_string()))
        .map(|i| (i.previous_output.txid.to_string(), i.previous_output.vout)).collect();
    let wanted: BTreeSet<_> = p["request"]["constraints"]["inputOutpoints"].as_array().unwrap().iter()
        .map(|i| (i["txid"].as_str().unwrap().to_owned(), i["vout"].as_u64().unwrap() as u32)).collect();
    assert_eq!(external.len(), wanted.len());
    assert_eq!(external.into_iter().collect::<BTreeSet<_>>(), wanted);
    planned
}

#[test]
fn summary_contract_id_is_complete_and_bound() {
    for variant in ["direct", "mergeRequired"] {
        let p = transfer_plan_input(variant);
        let planned = call_ok(EngineMethod::Plan, &p);
        assert_eq!(planned["plan"]["payload"]["preview"]["assetFlows"][0]["contractId"], p["request"]["intent"]["contractId"]);
        for replacement in [None, Some(json!("ff".repeat(32)))] {
            let mut tampered = planned["plan"].clone();
            let flow = tampered["payload"]["preview"]["assetFlows"][0].as_object_mut().unwrap();
            if let Some(value) = replacement { flow.insert("contractId".into(), value); } else { flow.remove("contractId"); }
            tampered["planHash"] = json!(canonical_hash(&tampered["payload"]));
            let mut validation = p.clone(); validation["phase"] = json!("plan"); validation["plan"] = tampered.clone();
            assert_eq!(call_ok(EngineMethod::Validate, &validation)["valid"], false);
            let mut signing = public_finalize_input(&p, &planned);
            signing["plan"] = tampered;
            assert_eq!(call(EngineMethod::Finalize, &signing)["ok"], false);
        }
    }
}

#[test]
fn exact_single_and_six_asset_inputs_finalize_with_no_extra_input() {
    for variant in ["direct", "mergeRequired"] { check(&exact(transfer_plan_input(variant))); }
}

#[test]
fn exact_does_not_drop_surplus_specified_assets_or_select_unspecified_fees() {
    let mut p = transfer_plan_input("mergeRequired");
    p["request"]["intent"]["amount"] = json!("50");
    let mut p = exact(p);
    let mut spare = p["snapshot"]["payload"]["utxos"][0].clone();
    spare["txid"] = json!("ee".repeat(32)); spare["satoshis"] = json!("100000000");
    p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(spare);
    let planned = check(&bind_request(p));
    assert_eq!(roles(&planned), ["maintenance", "primary"]);
}

#[test]
fn exact_subset_and_merge_preserve_selection() {
    for merge in [false, true] {
        let mut p = transfer_plan_input("mergeRequired");
        if merge { p["request"]["intent"] = json!({"type":"tbc.ft.merge","version":"1.0","contractId":p["request"]["intent"]["contractId"]}); }
        else { p["request"]["intent"]["amount"] = json!("150"); }
        let mut p = exact(p);
        p["request"]["constraints"]["inputOutpoints"].as_array_mut().unwrap().truncate(3);
        check(&bind_request(p));
    }
}

#[test]
fn exact_twenty_assets_and_fee_consolidation_keep_one_dependency_plan() {
    let mut p = transfer_plan_input("mergeRequired");
    let (utxos, parents, contract) = asset_material(&[100; 20]);
    p["request"]["intent"]["contractId"] = contract["contractId"].clone();
    p["request"]["intent"]["amount"] = json!("1950");
    p["request"]["constraints"]["maxFee"] = json!("50000");
    p["snapshot"]["payload"]["contracts"] = json!([contract]);
    p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().retain(|u| u["classification"] == "native");
    p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().extend(utxos);
    p["snapshot"]["payload"]["parents"] = json!(parents);
    fragmented_funding::replace(&mut p, 2, 10000);
    let result = check(&exact(p));
    assert_eq!(result["plan"]["payload"]["transactions"].as_array().unwrap().len(), 6);
}

#[test]
fn exact_input_scope_cannot_be_replaced_after_approval() {
    let p = exact(transfer_plan_input("mergeRequired"));
    let planned = call_ok(EngineMethod::Plan, &p);
    let mut changed = p.clone();
    changed["request"]["constraints"]["inputOutpoints"].as_array_mut().unwrap().pop();
    let mut changed = bind_request(changed);
    changed["phase"] = json!("plan"); changed["plan"] = planned["plan"].clone();
    assert_eq!(call_ok(EngineMethod::Validate, &changed)["valid"], false);
    let mut finalize = public_finalize_input(&p, &planned);
    finalize["request"] = changed["request"].clone(); finalize["requestHash"] = changed["requestHash"].clone();
    assert_eq!(call(EngineMethod::Finalize, &finalize)["ok"], false);
}

#[test]
fn exact_fee_consolidation_is_bound_and_respects_limits() {
    let mut p = transfer_plan_input("direct");
    fragmented_funding::replace(&mut p, 2, 10000);
    let p = exact(p);
    let planned = check(&p);
    assert_eq!(roles(&planned), ["maintenance", "primary"]);
    assert_eq!(planned["plan"]["payload"]["transactions"][0]["id"], "native-funding-1");
    let mut limited = p.clone(); limited["policy"]["payload"]["maxBundleTransactions"] = json!(1);
    assert_eq!(call_error(EngineMethod::Plan, &bind_request(limited))["code"], "INVALID_INPUT");
    let fee = planned["plan"]["payload"]["preview"]["totalFee"].as_str().unwrap().parse::<u64>().unwrap();
    let mut capped = p; capped["request"]["constraints"]["maxFee"] = json!((fee - 1).to_string());
    assert_eq!(call_error(EngineMethod::Plan, &bind_request(capped))["code"], "FEE_CAP_EXCEEDED");
}

#[test]
fn exact_missing_ineligible_wrong_contract_and_duplicate_inputs_fail() {
    for mutation in ["missing", "wrong-contract", "confirmations", "duplicate", "foreign-owner"] {
        let mut p = exact(transfer_plan_input("direct"));
        match mutation {
            "missing" => p["request"]["constraints"]["inputOutpoints"][0]["txid"] = json!("ff".repeat(32)),
            "wrong-contract" => p["snapshot"]["payload"]["utxos"][1]["contractId"] = json!("ff".repeat(32)),
            "confirmations" => { p["snapshot"]["payload"]["utxos"][1]["confirmations"] = json!("0"); p["policy"]["payload"]["minConfirmations"] = json!("1"); }
            "duplicate" => { let u = p["snapshot"]["payload"]["utxos"][1].clone(); p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(u); }
            _ => p["snapshot"]["payload"]["utxos"][1]["scriptPubKey"] = json!("51"),
        }
        assert_eq!(call(EngineMethod::Plan, &bind_request(p))["ok"], false, "{mutation}");
    }
    let mut p = exact(transfer_plan_input("direct"));
    let point = p["request"]["constraints"]["inputOutpoints"][0].clone();
    p["request"]["constraints"]["inputOutpoints"].as_array_mut().unwrap().push(point);
    assert_eq!(call(EngineMethod::NormalizeRequest, &json!({"version":"1.0","request":p["request"]}))["ok"], false);
}

#[test]
#[ignore = "local before/after benchmark; no network or production keys"]
fn legacy_ft_plan_timings() {
    for variant in ["direct", "mergeRequired"] {
        let p = transfer_plan_input(variant); let plan = call_ok(EngineMethod::Plan, &p);
        let mut validation = p.clone(); validation["phase"] = json!("plan"); validation["plan"] = plan["plan"].clone();
        for (name, method, params) in [("plan", EngineMethod::Plan, &p), ("validate", EngineMethod::Validate, &validation)] {
            let mut times = Vec::new();
            for _ in 0..11 { let start=std::time::Instant::now(); for _ in 0..10 { call_ok(method, params); } times.push(start.elapsed().as_secs_f64()*100.0); }
            times.sort_by(f64::total_cmp); println!("FT_TIMING {variant} {name} median_ms={:.3}", times[5]);
        }
    }
}
