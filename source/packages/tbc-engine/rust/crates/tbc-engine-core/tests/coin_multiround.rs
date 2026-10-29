//! Public Plan/Validate/Finalize tests with offline, public-only fixture inputs.
#[path = "support/coin_fragments.rs"]
mod support;
use secp256k1::{Message, Secp256k1, SecretKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use support::{bytes, fragmented, hex};
use tbc_engine_core::{call_json, EngineMethod};
use tbc_sdk::Transaction;
fn base() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/tbc-transfer.json")).unwrap()
}
fn hash(v: &Value) -> String {
    hex(&Sha256::digest(serde_json::to_vec(v).unwrap()))
}
fn call(m: EngineMethod, p: &Value) -> Value {
    let result: Value = serde_json::from_str(&call_json(m, &p.to_string())).unwrap();
    if std::env::var_os("COIN_MULTIROUND_DUMP_WIRE").is_some() {
        let method = match m {
            EngineMethod::NormalizeRequest => "normalizeRequest",
            EngineMethod::Plan => "plan",
            EngineMethod::Validate => "validate",
            EngineMethod::Finalize => "finalize",
        };
        println!(
            "COIN_MULTIROUND_WIRE:{}",
            json!({"method":method,"input":p,"result":result})
        );
    }
    result
}
fn ok(m: EngineMethod, p: &Value) -> Value {
    let r = call(m, p);
    assert_eq!(r["ok"], true, "{r}");
    r["result"].clone()
}
fn bind(mut p: Value) -> Value {
    let n = ok(
        EngineMethod::NormalizeRequest,
        &json!({"version":"1.0","request":p["request"]}),
    );
    p["request"] = n["request"].clone();
    p["requestHash"] = n["requestHash"].clone();
    p["snapshot"]["snapshotHash"] = json!(hash(&p["snapshot"]["payload"]));
    p["policy"]["policyHash"] = json!(hash(&p["policy"]["payload"]));
    p
}
fn input(count: usize, merge: bool) -> Value {
    let m = fragmented(count);
    let mut p = base()["planInput"].clone();
    p["request"]["intent"] = json!({"type":if merge{"tbc20-stablecoin-merge"}else{"tbc20-stablecoin-transfer"},"version":"1.0","contractId":m.contract});
    if !merge {
        p["request"]["intent"]["to"] = p["request"]["from"].clone();
        p["request"]["intent"]["amount"] = json!("1000");
    }
    p["request"]["constraints"]["maxFee"] = json!("50000");
    let mut utxos:Vec<_>=m.points.iter().map(|point|json!({"txid":point.txid.to_string(),"vout":point.vout,"satoshis":"500",
        "scriptPubKey":hex(m.known[&point.txid.to_string()].outputs[point.vout as usize].script_pubkey.as_bytes()),
        "classification":"stablecoin","contractId":m.contract,"confirmations":"0"})).collect();
    let fee = &m.known[&m.fee.txid.to_string()].outputs[m.fee.vout as usize];
    utxos.push(json!({"txid":m.fee.txid.to_string(),"vout":m.fee.vout,"satoshis":fee.satoshis.to_string(),
        "scriptPubKey":hex(fee.script_pubkey.as_bytes()),"classification":"native","confirmations":"0"}));
    p["snapshot"]["payload"]["utxos"] = json!(utxos);
    p["snapshot"]["payload"]["parents"] = json!(m
        .known
        .values()
        .map(|tx| json!({"txid":tx.txid().to_string(),"rawTransaction":tx.to_hex()}))
        .collect::<Vec<_>>());
    p["snapshot"]["payload"]["contracts"] = json!([{"contractId":m.contract,"family":"stablecoin","protocolVersion":"coin",
        "standardId":"tbc20-stablecoin","templateRevision":"c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3",
        "creationTxid":m.contract,"genesisOutpoint":{"txid":m.contract,"vout":0},
        "currentOutpoint":{"txid":m.points[0].txid.to_string(),"vout":m.points[0].vout}}]);
    p["policy"]["payload"]["dustThreshold"] = json!("24");
    p["policy"]["payload"]["minConfirmations"] = json!("0");
    p["policy"]["payload"]["maxBundleTransactions"] = json!(32);
    p["policy"]["payload"]["contractPolicies"] =
        json!([{"family":"stablecoin","allowedVersions":["coin"]}]);
    bind(p)
}
fn exact(mut p: Value) -> Value {
    p["request"]["constraints"]["inputOutpoints"] = json!(p["snapshot"]["payload"]["utxos"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| json!({"txid":u["txid"],"vout":u["vout"]}))
        .collect::<Vec<_>>());
    bind(p)
}
fn fee_fragments(mut p: Value, count: usize, amount: u64) -> Value {
    let utxos = p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap();
    let mut native = utxos
        .iter()
        .find(|u| u["classification"] == "native")
        .unwrap()
        .clone();
    utxos.retain(|u| u["classification"] != "native");
    for i in 0..count {
        native["txid"] = json!(format!("{:064x}", 10000 + i));
        native["vout"] = json!(0);
        native["satoshis"] = json!(amount.to_string());
        utxos.push(native.clone());
    }
    bind(p)
}
fn signatures(tasks: &Value) -> Value {
    let mut scalar = [0; 32];
    scalar[31] = 1;
    let key = SecretKey::from_byte_array(scalar).unwrap();
    json!(tasks.as_array().unwrap().iter().map(|t|json!({"taskId":t["taskId"],"signatureEncoding":"compact64",
        "signature":hex(&Secp256k1::new().sign_ecdsa(Message::from_digest(bytes(t["digest"].as_str().unwrap()).try_into().unwrap()),&key).serialize_compact())})).collect::<Vec<_>>())
}
fn finalize(p: &Value, plan: &Value) -> Value {
    let mut binding = base()["finalizeInput"]["binding"].clone();
    binding["payload"]["requestHash"] = p["requestHash"].clone();
    binding["payload"]["operationHash"] = plan["plan"]["planHash"].clone();
    binding["payload"]["expiresAt"] = plan["plan"]["payload"]["expiresAt"].clone();
    binding["bindingHash"] = json!(hash(&binding["payload"]));
    let mut approval = base()["finalizeInput"]["approval"].clone();
    approval["bindingHash"] = binding["bindingHash"].clone();
    approval["expiresAt"] = binding["payload"]["expiresAt"].clone();
    let mut f = p.clone();
    f["plan"] = plan["plan"].clone();
    f["binding"] = binding;
    f["approval"] = approval;
    f["signatures"] = signatures(&plan["plan"]["payload"]["signingTasks"]);
    let mut result = ok(EngineMethod::Finalize, &f);
    let mut rounds = 1;
    while result.get("continuation").is_some() {
        f["continuation"] = result["continuation"].clone();
        f["signatures"] = signatures(&result["signingRequests"]);
        result = ok(EngineMethod::Finalize, &f);
        rounds += 1;
        assert!(rounds <= 33);
    }
    f["phase"] = json!("pre-broadcast");
    f["bundle"] = result["bundle"].clone();
    assert_eq!(ok(EngineMethod::Validate, &f)["valid"], true);
    result
}
#[test]
fn coin_six_required_inputs_use_bound_multi_round_plan() {
    let p = input(6, false);
    let plan = ok(EngineMethod::Plan, &p);
    assert_eq!(
        plan["plan"]["payload"]["transactions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let result = finalize(&p, &plan);
    assert_eq!(
        result["bundle"]["transactions"].as_array().unwrap().len(),
        2
    );
}
#[test]
fn coin_exact_fragmented_native_funding_uses_existing_prerequisite() {
    let p = exact(fee_fragments(input(1, false), 12, 100));
    let plan = ok(EngineMethod::Plan, &p);
    assert_eq!(
        plan["plan"]["payload"]["transactions"][0]["id"],
        "native-funding-1"
    );
    let result = finalize(&p, &plan);
    let tx = Transaction::from_hex(
        result["bundle"]["transactions"][0]["rawTransaction"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(tx.inputs.len(), 12);
}
#[test]
fn coin_nonexact_fragmented_native_funding_is_checked_through_public_entry() {
    let p = fee_fragments(input(1, false), 12, 100);
    let plan = ok(EngineMethod::Plan, &p);
    assert_eq!(
        plan["plan"]["payload"]["transactions"][0]["id"],
        "native-funding-1"
    );
    finalize(&p, &plan);
}

fn audit(p: &Value, plan: &Value, result: &Value) {
    use std::collections::{BTreeMap, BTreeSet};
    use tbc_engine_core::protocols::coin::{parse_code, parse_tape};
    let mut values: BTreeMap<_, _> = p["snapshot"]["payload"]["utxos"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| {
            (
                (
                    u["txid"].as_str().unwrap().to_owned(),
                    u["vout"].as_u64().unwrap() as u32,
                ),
                u["satoshis"].as_str().unwrap().parse::<u64>().unwrap(),
            )
        })
        .collect();
    let mut spent = BTreeSet::new();
    let mut resolved = BTreeMap::<String, String>::new();
    let mut total_fee = 0u64;
    let rows = result["bundle"]["transactions"].as_array().unwrap();
    for (i, row) in rows.iter().enumerate() {
        let tx = Transaction::from_hex(row["rawTransaction"].as_str().unwrap()).unwrap();
        let txid = tx.txid().to_string();
        assert_eq!(row["txid"], txid);
        let template = &plan["plan"]["payload"]["transactions"][i];
        let total_in: u64 = tx
            .inputs
            .iter()
            .map(|input| {
                let point = (
                    input.previous_output.txid.to_string(),
                    input.previous_output.vout,
                );
                assert!(spent.insert(point.clone()), "spent twice");
                values[&point]
            })
            .sum();
        let fee = total_in - tx.outputs.iter().map(|o| o.satoshis).sum::<u64>();
        assert_eq!(template["fee"], fee.to_string());
        total_fee += fee;
        for d in template["dependsOn"].as_array().unwrap() {
            assert!(tx.inputs.iter().any(
                |input| input.previous_output.txid.to_string() == resolved[d.as_str().unwrap()]
            ));
        }
        for (vout, output) in tx.outputs.iter().enumerate() {
            values.insert((txid.clone(), vout as u32), output.satoshis);
        }
        let coin_inputs = tx
            .inputs
            .iter()
            .filter(|input| {
                !template["id"]
                    .as_str()
                    .unwrap()
                    .starts_with("native-funding")
                    && input.sequence == 0xfffffffe
            })
            .count();
        assert!(coin_inputs <= 5);
        assert!(tx.inputs.len() <= 6 || template["id"] == "native-funding-1");
        if i + 1 < rows.len() && template["id"] != "native-funding-1" {
            for output in &tx.outputs {
                if let Ok(code) = parse_code(output.script_pubkey.as_bytes()) {
                    let account = tbc_sdk::PublicKey::from_slice(&bytes(
                        p["snapshot"]["payload"]["account"]["publicKey"]
                            .as_str()
                            .unwrap(),
                    ))
                    .unwrap();
                    assert_eq!(code.controller, support::controller(&account));
                }
            }
        }
        resolved.insert(template["id"].as_str().unwrap().to_owned(), txid);
    }
    let final_tx =
        Transaction::from_hex(rows.last().unwrap()["rawTransaction"].as_str().unwrap()).unwrap();
    let amount: u128 = final_tx
        .outputs
        .iter()
        .filter_map(|o| parse_tape(o.script_pubkey.as_bytes(), None).ok())
        .map(|t| t.balance)
        .sum();
    assert_eq!(amount, 1000);
    assert_eq!(
        plan["plan"]["payload"]["preview"]["totalFee"],
        total_fee.to_string()
    );
    for u in p["snapshot"]["payload"]["utxos"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|u| {
            u["classification"] == "stablecoin"
                || p["request"]["constraints"].get("inputOutpoints").is_some()
        })
    {
        assert!(spent.contains(&(
            u["txid"].as_str().unwrap().into(),
            u["vout"].as_u64().unwrap() as u32
        )));
    }
}

#[test]
fn coin_single_and_large_merge_transfer_exact_conserve_bound_inputs_outputs_and_fees() {
    for (count, merge) in [
        (1, false),
        (2, false),
        (3, false),
        (4, false),
        (5, false),
        (6, true),
        (20, false),
        (20, true),
    ] {
        let p = exact(input(count, merge));
        let plan = ok(EngineMethod::Plan, &p);
        let result = finalize(&p, &plan);
        assert_eq!(
            plan["plan"]["payload"]["transactions"]
                .as_array()
                .unwrap()
                .len(),
            if count <= 5 { 1 } else { (count - 2) / 4 + 1 }
        );
        audit(&p, &plan, &result);
    }
}

#[test]
fn coin_multi_round_and_native_funding_compose_without_extra_external_inputs() {
    let p = exact(fee_fragments(input(20, false), 12, 100));
    let plan = ok(EngineMethod::Plan, &p);
    assert_eq!(
        plan["plan"]["payload"]["transactions"][0]["id"],
        "native-funding-1"
    );
    audit(&p, &plan, &finalize(&p, &plan));
}

#[test]
fn coin_limits_material_and_actual_balance_have_distinct_failures() {
    let p = exact(input(6, false));
    let good = ok(EngineMethod::Plan, &p);
    let total = good["plan"]["payload"]["preview"]["totalFee"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    for (case, code) in [
        ("single-policy", "INVALID_INPUT"),
        ("fee", "FEE_CAP_EXCEEDED"),
        ("balance", "INSUFFICIENT_FUNDS"),
        ("missing-exact", "MISSING_MATERIAL"),
        ("missing-parent", "MISSING_MATERIAL"),
        ("confirmation", "MISSING_MATERIAL"),
    ] {
        let mut bad = p.clone();
        match case {
            "single-policy" => bad["policy"]["payload"]["maxBundleTransactions"] = json!(1),
            "fee" => bad["request"]["constraints"]["maxFee"] = json!((total - 1).to_string()),
            "balance" => bad["request"]["intent"]["amount"] = json!("1001"),
            "missing-exact" => bad["request"]["constraints"]["inputOutpoints"]
                .as_array_mut()
                .unwrap()
                .push(json!({"txid":"55".repeat(32),"vout":0})),
            "missing-parent" => bad["snapshot"]["payload"]["parents"] = json!([]),
            _ => bad["policy"]["payload"]["minConfirmations"] = json!("1"),
        }
        let result = call(EngineMethod::Plan, &bind(bad));
        assert_eq!(result["ok"], false, "{case}");
        assert_eq!(result["error"]["code"], code, "{case}: {result}");
    }
}

// One deterministic public-only wire stream for frozen Native/WASM replay and
// independent script VM checks. Never emits actual wallet material.
#[test]
fn coin_multiround_artifact_vectors() {
    for (count, merge, funding) in [
        (1, false, false),
        (5, false, false),
        (6, false, false),
        (20, true, false),
        (6, false, true),
    ] {
        let p = input(count, merge);
        let p = exact(if funding {
            fee_fragments(p, 12, 100)
        } else {
            p
        });
        let plan = ok(EngineMethod::Plan, &p);
        let result = finalize(&p, &plan);
        audit(&p, &plan, &result);
        // Every continuation and signed result remain tied to the original
        // approval: changing a recipient after approval is not a new consent.
        let mut bad = p.clone();
        bad["request"]["intent"]["to"] = json!("1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP");
        if !merge {
            bad["plan"] = plan["plan"].clone();
            bad["phase"] = json!("pre-sign");
            let rejected = call(EngineMethod::Validate, &bad);
            assert!(rejected["ok"] == false || rejected["result"]["valid"] == false);
        }
    }
}
