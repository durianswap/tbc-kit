// Public isolated fixture material only; the existing helper signs with test key 1.
#[allow(dead_code, unused_imports)]
mod fixtures {
    include!("../tests/ft.rs");

    pub fn complete(input: Value) -> Value {
        let planned = call_ok(EngineMethod::Plan, &input);
        let finalize = public_finalize_input(&input, &planned);
        let completed = call_ok(EngineMethod::Finalize, &finalize);
        assert!(completed["bundle"].is_object(), "compatibility fixture must be single-stage");
        json!({"planInput": input, "planned": planned, "finalizeInput": finalize, "complete": completed})
    }

    pub fn native() -> Value {
        let mut input = base_plan_input();
        input["snapshot"]["payload"]["parents"] = json!([]);
        complete(bind_request(input))
    }

    pub fn token(name: &str, symbol: &str) -> Value {
        let (utxos, parents, contract) = asset_material_seed_with_metadata(&[2_000], 0x91, name, symbol);
        let mut input = transfer_plan_input("direct");
        input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().truncate(1);
        input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().extend(utxos);
        input["snapshot"]["payload"]["parents"].as_array_mut().unwrap().truncate(1);
        input["snapshot"]["payload"]["parents"].as_array_mut().unwrap().extend(parents);
        input["snapshot"]["payload"]["contracts"] = json!([contract.clone()]);
        input["request"]["intent"]["contractId"] = contract["contractId"].clone();
        input["request"]["intent"]["amount"] = json!("1500");
        let mut result = complete(bind_request(input));
        result["expectedName"] = json!(name);
        result["expectedSymbol"] = json!(symbol);
        result
    }
}

fn main() {
    let vectors = serde_json::json!({
        "nativePrevoutOnly": fixtures::native(),
        "lowercaseFt": fixtures::token("lowercase token", "tws"),
        "unicodeFt": fixtures::token("\u{6d4b}\u{8bd5} token", "\u{5e01}-tws"),
        "longMetadataFt": fixtures::token(&"n".repeat(65), "lowercase.symbol-17"),
    });
    println!("{}", serde_json::to_string(&vectors).expect("public compatibility vectors must serialize"));
}
