use super::*;

// Process A test expectations are local semantic assertions, never another
// producer's output, helper, or generated fixture.
fn spec(name: &str) -> Value {
    let input: Value = serde_json::from_str(include_str!("../inputs/full-matrix.json")).unwrap();
    input["scenarios"].as_array().unwrap().iter()
        .find(|value| value["name"] == name).unwrap().clone()
}

fn transactions(value: &Value) -> Vec<Transaction> {
    value["transactions"].as_array().unwrap().iter()
        .map(|tx| Transaction::from_hex(tx["finalizedRaw"].as_str().unwrap()).unwrap())
        .collect()
}

fn expected_public_intent(operation: Option<&str>) -> &'static str {
    match operation {
        Some("create") => "tbc.pool.create",
        Some("add") => "tbc.pool.liquidity.add",
        Some("remove") => "tbc.pool.liquidity.remove",
        Some("close") => "tbc.pool.liquidity.close",
        Some("swap-tbc-for-token") => "tbc.pool.swap.exactTbcForToken",
        Some("swap-token-for-tbc") => "tbc.pool.swap.exactTokenForTbc",
        Some(operation) => panic!("unknown Pool operation: {operation}"),
        None => panic!("missing Pool operation"),
    }
}

#[test]
fn public_intent_names_are_the_exact_closed_schema_set() {
    for (operation, expected) in [
        ("create", "tbc.pool.create"),
        ("add", "tbc.pool.liquidity.add"),
        ("remove", "tbc.pool.liquidity.remove"),
        ("close", "tbc.pool.liquidity.close"),
        ("swap-tbc-for-token", "tbc.pool.swap.exactTbcForToken"),
        ("swap-token-for-tbc", "tbc.pool.swap.exactTokenForTbc"),
    ] {
        assert_eq!(expected_public_intent(Some(operation)), expected);
    }
    assert!(std::panic::catch_unwind(|| expected_public_intent(None)).is_err());
    assert!(std::panic::catch_unwind(|| expected_public_intent(Some("swap"))).is_err());
}

fn assert_workflow(name: &str, roles: &[&str]) -> (Value, Vec<Transaction>) {
    let scenario = spec(name);
    let expected_intent = expected_public_intent(scenario["operation"].as_str());
    let value = create_scenario(&scenario);
    let evidence = value["transactions"].as_array().unwrap();
    assert_eq!(evidence.iter().map(|tx| tx["role"].as_str().unwrap()).collect::<Vec<_>>(), roles,
        "{name}: released workflow topology");
    assert_eq!(evidence.last().unwrap()["publicIntent"], expected_intent,
        "{name}: exactly one public primary");
    let txs = transactions(&value);
    for (index, tx) in txs.iter().enumerate() {
        assert!(tx.inputs.iter().all(|input| !input.script_sig.as_bytes().is_empty()),
            "{name}[{index}]: every input must be finalized by the released builder");
        let declared = evidence[index]["dependencies"].as_array().unwrap();
        let resolved = txs[..index].iter().enumerate()
            .filter(|(_, parent)| tx.inputs.iter().any(|input| input.previous_output.txid == parent.txid()))
            .map(|(parent, _)| evidence[parent]["templateId"].clone()).collect::<Vec<_>>();
        assert_eq!(*declared, resolved, "{name}[{index}]: independent finalized parent txids");
    }
    (value, txs)
}

#[test]
fn create_matrix_retains_seven_released_variants() {
    let input: Value = serde_json::from_str(include_str!("../inputs/create-matrix.json")).unwrap();
    assert_eq!(input["scenarios"].as_array().unwrap().len(), 7);
    for entry in input["scenarios"].as_array().unwrap() {
        let value = create_scenario(entry);
        let txs = transactions(&value);
        assert_eq!(txs.len(), 2);
        assert_eq!(txs[1].inputs[0].previous_output.txid, txs[0].txid());
    }
}

macro_rules! direct_case {
    ($test:ident, $name:literal) => {
        #[test]
        fn $test() { assert_workflow($name, &["primary"]); }
    };
}
direct_case!(add_standard, "add-standard");
direct_case!(add_locked, "add-locked");
direct_case!(remove_standard, "remove-standard");
direct_case!(close_standard, "close-standard");
direct_case!(swap_tbc_for_token_standard, "swap-tbc-for-token-standard");
direct_case!(swap_tbc_for_token_locked, "swap-tbc-for-token-locked");
direct_case!(swap_token_for_tbc_standard, "swap-token-for-tbc-standard");
direct_case!(swap_token_for_tbc_locked, "swap-token-for-tbc-locked");
#[test]
fn pool_ft_no_merge_threshold() {
    let (_, txs) = assert_workflow("pool-ft-no-merge-threshold", &["primary"]);
    assert_eq!(txs[0].inputs.len(), 4, "Pool, FTLP, one sufficient Pool-held FT input, and fee");
}
direct_case!(ftlp_no_merge_threshold, "ftlp-no-merge-threshold");

fn locked_consume(name: &str) {
    let (_, txs) = assert_workflow(name, &["maintenance", "primary"]);
    assert_eq!(txs[0].lock_time, 800101);
    assert_eq!(txs[0].inputs[0].sequence, 0xffff_fffe);
    assert_eq!(txs[1].inputs[1].previous_output, OutPoint { txid: txs[0].txid(), vout: 0 });
    assert_eq!(txs[1].inputs.last().unwrap().previous_output, OutPoint { txid: txs[0].txid(), vout: 2 });
}
#[test] fn remove_locked() { locked_consume("remove-locked"); }
#[test] fn close_locked() { locked_consume("close-locked"); }
#[test]
fn pool_ft_merge() {
    let (_, txs) = assert_workflow("pool-ft-merge", &["maintenance", "primary"]);
    assert_eq!(txs[0].inputs.len(), 6, "Pool plus four necessary candidates plus fee");
    assert_eq!(txs[1].inputs.len(), 4, "Pool, FTLP, merged Pool-FT, and fee");
    assert_eq!(txs[1].inputs[2].previous_output, OutPoint { txid: txs[0].txid(), vout: 2 });
    assert_eq!(txs[1].inputs.last().unwrap().previous_output, OutPoint { txid: txs[0].txid(), vout: 4 });
}
#[test] fn ftlp_merge_standard() { assert_workflow("ftlp-merge-standard", &["maintenance", "primary"]); }
#[test] fn ftlp_merge_locked() { locked_consume("ftlp-merge-locked"); }

#[test]
fn pool_ft_multi_round() {
    let (_, txs) = assert_workflow("pool-ft-multi-round", &["maintenance", "maintenance", "primary"]);
    assert_eq!(txs[1].inputs[0].previous_output, OutPoint { txid: txs[0].txid(), vout: 0 });
    assert_eq!(txs[1].inputs[1].previous_output, OutPoint { txid: txs[0].txid(), vout: 2 },
        "second round must merge the authenticated first-round successor");
    assert_eq!(txs[1].inputs.last().unwrap().previous_output, OutPoint { txid: txs[0].txid(), vout: 4 });
    assert_eq!(txs[0].inputs.len(), 6);
    assert_eq!(txs[1].inputs.len(), 6);
    assert_eq!(txs[2].inputs.len(), 5,
        "primary must retain only the shortest one-tail direct frontier");
    assert_eq!(txs[2].inputs[2].previous_output, OutPoint { txid: txs[1].txid(), vout: 2 });
    assert_eq!(txs[2].inputs.last().unwrap().previous_output, OutPoint { txid: txs[1].txid(), vout: 4 });
    assert!(txs[2].inputs.iter().all(|input|
        input.previous_output != OutPoint { txid: txs[0].txid(), vout: 2 }),
        "primary must not retain a consumed first-round successor");
}

#[test]
fn ftlp_multi_round() {
    let (_, txs) = assert_workflow("ftlp-multi-round", &["maintenance", "maintenance", "primary"]);
    assert_eq!(txs[0].inputs.len(), 6);
    assert_eq!(txs[1].inputs.len(), 3,
        "second round must merge the successor with only one necessary tail");
    assert_eq!(txs[1].inputs[0].previous_output, OutPoint { txid: txs[0].txid(), vout: 0 });
    assert_eq!(txs[1].inputs.last().unwrap().previous_output, OutPoint { txid: txs[0].txid(), vout: 2 });
}

#[test]
fn simultaneous_maintenance_is_ftlp_then_pool_ft_then_primary() {
    let (_, txs) = assert_workflow("simultaneous-pool-ft-and-ftlp-maintenance", &["maintenance", "maintenance", "primary"]);
    assert_eq!(txs[0].outputs.len(), 3);
    assert_eq!(txs[1].outputs.len(), 5);
    assert_eq!(txs[1].inputs.last().unwrap().previous_output, OutPoint { txid: txs[0].txid(), vout: 2 });
    assert_eq!(txs[2].inputs[0].previous_output, OutPoint { txid: txs[1].txid(), vout: 0 });
    assert_eq!(txs[2].inputs[1].previous_output, OutPoint { txid: txs[0].txid(), vout: 0 });
    assert_eq!(txs[2].inputs.len(), 4,
        "a sufficient Pool-FT successor must not drag unused tails into primary");
    assert_eq!(txs[2].inputs[2].previous_output, OutPoint { txid: txs[1].txid(), vout: 2 });
    assert_eq!(txs[2].inputs[3].previous_output, OutPoint { txid: txs[1].txid(), vout: 4 });
}
