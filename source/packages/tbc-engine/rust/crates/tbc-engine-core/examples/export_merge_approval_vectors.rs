mod tbc_suite {
    include!("../tests/tbc_transfer.rs");

    pub fn export_vector() -> serde_json::Value {
        let fixture = fixture();
        let mut input = fixture["planInput"].clone();
        input["request"]["clientRequestId"] = serde_json::json!("tbc-public-merge");
        input["request"]["intent"] = serde_json::json!({
            "type": "tbc.maintenance.merge",
            "version": "1.0",
        });
        input["request"]["constraints"]["maxFee"] = serde_json::json!("1000");
        input["requestHash"] = serde_json::json!(canonical_hash(&input["request"]));
        let script = input["snapshot"]["payload"]["utxos"][0]["scriptPubKey"]
            .as_str()
            .unwrap();
        let first = native_parent(2_000, 41, script);
        let second = native_parent(3_000, 42, script);
        input["snapshot"]["payload"]["utxos"] = serde_json::json!([second.0, first.0]);
        input["snapshot"]["payload"]["parents"] = serde_json::json!([second.1, first.1]);
        input["snapshot"]["snapshotHash"] =
            serde_json::json!(canonical_hash(&input["snapshot"]["payload"]));
        let normalized = call_ok(
            tbc_engine_core::EngineMethod::NormalizeRequest,
            &serde_json::json!({"version":"1.0", "request":input["request"]}),
        );
        assert_eq!(normalized["requestHash"], input["requestHash"]);
        serde_json::json!({
            "input": input,
            "result": call_ok(tbc_engine_core::EngineMethod::Plan, &input),
        })
    }
}

mod ft_suite {
    include!("../tests/ft.rs");

    pub fn export_vector() -> serde_json::Value {
        let mut input = transfer_plan_input("mergeRequired");
        let contract_id = input["request"]["intent"]["contractId"].clone();
        input["request"]["clientRequestId"] = serde_json::json!("ft-public-merge");
        input["request"]["intent"] = serde_json::json!({
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
        let normalized = call_ok(
            tbc_engine_core::EngineMethod::NormalizeRequest,
            &serde_json::json!({"version":"1.0", "request":input["request"]}),
        );
        assert_eq!(normalized["requestHash"], input["requestHash"]);
        serde_json::json!({
            "input": input,
            "result": call_ok(tbc_engine_core::EngineMethod::Plan, &input),
        })
    }
}

mod pool_suite {
    include!("../tests/pool.rs");

    fn merge_vector(intent_type: &str, pool_ft: &[u64], ftlp: &[u64]) -> serde_json::Value {
        let mut input = fragmented_plan_input("pool-liquidity-remove.json", pool_ft, ftlp);
        let pool_contract_id = input["snapshot"]["payload"]["contracts"][1]["contractId"].clone();
        input["request"]["intent"] = serde_json::json!({
            "type": intent_type,
            "version": "1.0",
            "poolContractId": pool_contract_id,
        });
        input["requestHash"] = serde_json::json!(canonical_hash(&input["request"]));
        let normalized = call_ok(
            tbc_engine_core::EngineMethod::NormalizeRequest,
            &serde_json::json!({"version":"1.0", "request":input["request"]}),
        );
        assert_eq!(normalized["requestHash"], input["requestHash"]);
        serde_json::json!({
            "input": input,
            "result": call_ok(tbc_engine_core::EngineMethod::Plan, &input),
        })
    }

    pub fn pool_ft() -> serde_json::Value {
        merge_vector("tbc.pool.ft.merge", &[1_000_000, 1_500_000], &[10_000])
    }

    pub fn ftlp() -> serde_json::Value {
        merge_vector("tbc.pool.ftlp.merge", &[2_500_000], &[4_000, 6_000])
    }
}

fn main() {
    println!("{}", serde_json::json!({
        "tbc": tbc_suite::export_vector(),
        "ft": ft_suite::export_vector(),
        "poolFt": pool_suite::pool_ft(),
        "ftlp": pool_suite::ftlp(),
    }));
}
