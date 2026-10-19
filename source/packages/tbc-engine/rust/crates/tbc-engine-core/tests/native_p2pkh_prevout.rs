use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tbc_engine_core::{EngineMethod, call_json};
use tbc_sdk::Transaction;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/tbc-transfer.json"))
        .expect("public native transfer fixture must parse")
}

fn hash(value: &Value) -> String {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(object) => {
                let mut keys = object.keys().collect::<Vec<_>>();
                keys.sort();
                Value::Object(keys.into_iter().map(|key| (key.clone(), sorted(&object[key]))).collect())
            }
            Value::Array(array) => Value::Array(array.iter().map(sorted).collect()),
            _ => value.clone(),
        }
    }
    let bytes = serde_json::to_vec(&sorted(value)).expect("public JSON must serialize");
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn plan(params: &Value) -> Value {
    serde_json::from_str(&call_json(EngineMethod::Plan, &params.to_string()))
        .expect("Engine plan response must parse")
}

fn refresh_snapshot(params: &mut Value) {
    params["snapshot"]["snapshotHash"] = json!(hash(&params["snapshot"]["payload"]));
}

fn prevout_only() -> Value {
    let mut params = fixture()["planInput"].clone();
    params["snapshot"]["payload"]["parents"] = json!([]);
    refresh_snapshot(&mut params);
    params
}

#[test]
fn native_prevout_only_preserves_unsigned_transaction_and_preview() {
    let baseline = plan(&fixture()["planInput"]);
    let without_parents = plan(&prevout_only());
    assert_eq!(baseline["ok"], json!(true));
    assert_eq!(without_parents["ok"], json!(true));
    assert!(
        baseline["result"]["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
            == without_parents["result"]["plan"]["payload"]["transactions"][0]["unsignedTransaction"],
        "removing optional evidence must not change the unsigned native transaction"
    );
    assert!(
        baseline["result"]["plan"]["payload"]["preview"]
            == without_parents["result"]["plan"]["payload"]["preview"],
        "removing optional evidence must not change the native approval preview"
    );
}

#[test]
fn native_prevout_only_supports_multiple_inputs_when_one_is_insufficient() {
    let mut params = prevout_only();
    params["request"]["intent"]["amount"] = json!("2100");
    params["requestHash"] = json!(hash(&params["request"]));
    let template = params["snapshot"]["payload"]["utxos"][0].clone();
    let inputs = [900_u64, 1400, 800].into_iter().enumerate().map(|(index, value)| {
        let mut input = template.clone();
        input["txid"] = json!(format!("{:064x}", index + 1));
        input["vout"] = json!(0);
        input["satoshis"] = json!(value.to_string());
        input
    }).collect::<Vec<_>>();
    params["snapshot"]["payload"]["utxos"] = json!(inputs);
    refresh_snapshot(&mut params);
    let result = plan(&params);
    assert_eq!(result["ok"], json!(true));
    let transaction = Transaction::from_hex(
        result["result"]["plan"]["payload"]["transactions"][0]["unsignedTransaction"]
            .as_str().expect("unsigned native transaction must be present")
    ).expect("unsigned native transaction must parse");
    assert!(transaction.inputs.len() > 1, "insufficient single inputs must retain multi-input funding");
}

#[test]
fn native_prevout_only_still_rejects_wrong_account_script() {
    let mut params = prevout_only();
    params["snapshot"]["payload"]["utxos"][0]["scriptPubKey"] = json!("51");
    refresh_snapshot(&mut params);
    let result = plan(&params);
    assert_eq!(result["ok"], json!(false));
    assert_eq!(result["error"]["code"], json!("INVALID_ANCESTRY"));
}

#[test]
fn native_prevout_only_still_rejects_duplicate_outpoints() {
    let mut params = prevout_only();
    let input = params["snapshot"]["payload"]["utxos"][0].clone();
    params["snapshot"]["payload"]["utxos"] = json!([input.clone(), input]);
    refresh_snapshot(&mut params);
    assert_eq!(plan(&params)["ok"], json!(false));
}

#[test]
fn native_prevout_only_still_rejects_zero_and_overflow_values() {
    for value in ["0", "18446744073709551616"] {
        let mut params = prevout_only();
        params["snapshot"]["payload"]["utxos"][0]["satoshis"] = json!(value);
        refresh_snapshot(&mut params);
        assert_eq!(plan(&params)["ok"], json!(false));
    }
}

#[test]
fn native_prevout_only_still_rejects_asset_classification() {
    let mut params = prevout_only();
    params["snapshot"]["payload"]["utxos"][0]["classification"] = json!("ft");
    refresh_snapshot(&mut params);
    assert_eq!(plan(&params)["ok"], json!(false));
}

#[test]
fn native_optional_parent_still_rejects_amount_mismatch() {
    let mut params = fixture()["planInput"].clone();
    let amount = params["snapshot"]["payload"]["utxos"][0]["satoshis"]
        .as_str().expect("public input amount must be decimal").parse::<u64>()
        .expect("public input amount must fit uint64");
    params["snapshot"]["payload"]["utxos"][0]["satoshis"] = json!((amount + 1).to_string());
    refresh_snapshot(&mut params);
    let result = plan(&params);
    assert_eq!(result["ok"], json!(false));
    assert_eq!(result["error"]["code"], json!("INVALID_ANCESTRY"));
}

#[test]
fn native_optional_parent_still_rejects_invalid_output_index() {
    let mut params = fixture()["planInput"].clone();
    params["snapshot"]["payload"]["utxos"][0]["vout"] = json!(u32::MAX);
    refresh_snapshot(&mut params);
    let result = plan(&params);
    assert_eq!(result["ok"], json!(false));
    assert_eq!(result["error"]["code"], json!("INVALID_ANCESTRY"));
}

#[test]
fn native_prevout_only_requires_a_fresh_canonical_snapshot_binding() {
    let mut params = fixture()["planInput"].clone();
    params["snapshot"]["payload"]["parents"] = json!([]);
    assert_eq!(plan(&params)["ok"], json!(false));
}
