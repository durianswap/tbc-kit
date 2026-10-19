use std::collections::BTreeSet;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tbc_engine_core::{EngineMethod, call_json};
use tbc_sdk::Transaction;

fn hash(value: &Value) -> String {
    Sha256::digest(serde_json::to_vec(value).unwrap())
        .iter().map(|byte| format!("{byte:02x}")).collect()
}

fn bind(input: &mut Value) {
    input["snapshot"]["snapshotHash"] = json!(hash(&input["snapshot"]["payload"]));
    input["policy"]["policyHash"] = json!(hash(&input["policy"]["payload"]));
}

fn call(method: EngineMethod, input: &Value) -> Value {
    serde_json::from_str(&call_json(method, &input.to_string())).unwrap()
}

fn plan(input: &Value) -> Value {
    let result = call(EngineMethod::Plan, input);
    assert_eq!(result["ok"], true, "{result}");
    result["result"].clone()
}

fn validation(input: &Value, planned: &Value) -> Value {
    let mut input = input.clone();
    input["phase"] = json!("plan");
    input["plan"] = planned["plan"].clone();
    call(EngineMethod::Validate, &input)
}

fn set_counts(input: &mut Value, class: Option<&str>, count: Option<Value>) {
    for utxo in input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap() {
        if class.is_none_or(|class| utxo["classification"] == class) {
            match &count {
                Some(value) => { utxo["confirmations"] = value.clone(); }
                None => { utxo.as_object_mut().unwrap().remove("confirmations"); }
            }
        }
    }
    bind(input);
}

fn assert_same_execution(left: &Value, right: &Value) {
    assert_eq!(left["plan"]["payload"]["transactions"], right["plan"]["payload"]["transactions"]);
    assert_eq!(left["plan"]["payload"]["preview"], right["plan"]["payload"]["preview"]);
    let digests = |value: &Value| value["plan"]["payload"]["signingTasks"]
        .as_array().unwrap().iter().map(|task| task["digest"].clone()).collect::<Vec<_>>();
    assert_eq!(digests(left), digests(right));
}

pub fn exercise(mut input: Value) {
    let intent = input["request"]["intent"]["type"].as_str().unwrap().to_owned();
    input["policy"]["payload"]["minConfirmations"] = json!("0");
    set_counts(&mut input, None, Some(json!("2")));
    let known = plan(&input);
    let mut missing = input.clone();
    set_counts(&mut missing, None, None);
    let unknown = plan(&missing);
    assert_same_execution(&known, &unknown);
    assert_eq!(unknown["plan"]["payload"]["snapshotHash"], missing["snapshot"]["snapshotHash"]);
    assert_ne!(known["plan"]["planHash"], unknown["plan"]["planHash"]);
    assert_eq!(validation(&missing, &unknown)["result"]["valid"], true);

    let mut zero = input.clone();
    set_counts(&mut zero, None, Some(json!("0")));
    let zero_plan = plan(&zero);
    assert_same_execution(&unknown, &zero_plan);
    assert_ne!(missing["snapshot"]["snapshotHash"], zero["snapshot"]["snapshotHash"]);
    assert_ne!(unknown["plan"]["planHash"], zero_plan["plan"]["planHash"]);
    assert_eq!(validation(&zero, &zero_plan)["result"]["valid"], true);
    assert_ne!(validation(&missing, &zero_plan)["result"]["valid"], true);

    let mut upper = input.clone();
    upper["policy"]["payload"]["minConfirmations"] = json!(u32::MAX.to_string());
    set_counts(&mut upper, None, Some(json!(u32::MAX.to_string())));
    assert_same_execution(&known, &plan(&upper));

    for minimum in ["4294967296", "18446744073709551616", "00", "-1"] {
        for empty in [false, true] {
            let mut invalid = input.clone();
            invalid["policy"]["payload"]["minConfirmations"] = json!(minimum);
            if empty { invalid["snapshot"]["payload"]["utxos"] = json!([]); }
            bind(&mut invalid);
            let rejected = call(EngineMethod::Plan, &invalid);
            assert_eq!(rejected["ok"], false, "{rejected}");
            assert_eq!(rejected["error"]["code"], "INVALID_INPUT", "{rejected}");
            assert_eq!(rejected["error"]["path"], "policy.payload.minConfirmations", "{rejected}");
        }
    }

    input["policy"]["payload"]["minConfirmations"] = json!("2");
    bind(&mut input);
    let confirmed = plan(&input);
    assert_eq!(validation(&input, &confirmed)["result"]["valid"], true);
    let mut selected_classes = BTreeSet::new();
    for template in confirmed["plan"]["payload"]["transactions"].as_array().unwrap() {
        let transaction = Transaction::from_hex(template["unsignedTransaction"].as_str().unwrap()).unwrap();
        for selected in transaction.inputs {
            for utxo in input["snapshot"]["payload"]["utxos"].as_array().unwrap() {
                if utxo["txid"] == selected.previous_output.txid.to_string()
                    && utxo["vout"] == selected.previous_output.vout {
                    selected_classes.insert(utxo["classification"].as_str().unwrap().to_owned());
                }
            }
        }
    }
    assert!(!selected_classes.is_empty());
    for class in &selected_classes {
        for count in [None, Some(json!("0")), Some(json!("1"))] {
            let mut insufficient = input.clone();
            set_counts(&mut insufficient, Some(class), count.clone());
            let rejected = call(EngineMethod::Plan, &insufficient);
            assert_eq!(rejected["ok"], false, "{intent}/{class}/{count:?}: {rejected}");
            assert_ne!(rejected["error"]["message"], "snapshot hash does not bind the supplied wallet material");
            let checked = validation(&insufficient, &confirmed);
            assert!(checked["ok"] == false || checked["result"]["valid"] == false, "{checked}");
        }
    }
    // Malformed supplied values are invalid even with a zero threshold and
    // even on an unselected holding; absence is the only new wire allowance.
    let classes = input["snapshot"]["payload"]["utxos"].as_array().unwrap().iter()
        .map(|utxo| utxo["classification"].as_str().unwrap().to_owned()).collect::<BTreeSet<_>>();
    for class in &classes {
        for value in [json!(null), json!(0), json!(true), json!(""), json!("00"),
            json!("01"), json!("-1"), json!("+1"), json!(" 1"), json!("1.0"),
            json!("4294967296"), json!("18446744073709551616")] {
            let mut invalid = input.clone();
            invalid["policy"]["payload"]["minConfirmations"] = json!("0");
            set_counts(&mut invalid, Some(class), Some(value.clone()));
            let rejected = call(EngineMethod::Plan, &invalid);
            assert_eq!(rejected["ok"], false, "{intent}/{class}/{value}: {rejected}");
            assert_eq!(rejected["error"]["code"], "INVALID_INPUT", "{rejected}");
            assert_eq!(validation(&invalid, &known)["ok"], false);
        }
    }
    eprintln!("optional confirmations: {intent}, selected={selected_classes:?}, supplied={classes:?}");
}
