// Isolated public fixtures only. Signatures use the existing fixed public test key.
#[allow(dead_code, unused_imports)]
mod fixtures {
    include!("../tests/ft.rs");

    fn create(name: &str, symbol: &str) -> Value {
        let mut input = create_plan_input();
        input["request"]["intent"]["name"] = json!(name);
        input["request"]["intent"]["symbol"] = json!(symbol);
        let input = bind_request(input);
        assert_eq!(input["request"]["intent"]["name"], name);
        assert_eq!(input["request"]["intent"]["symbol"], symbol);
        let planned = call_ok(EngineMethod::Plan, &input);
        let mint = Transaction::from_hex(
            planned["plan"]["payload"]["transactions"][1]["unsignedTransaction"]
                .as_str().unwrap(),
        ).unwrap();
        let mut amount = [0u8; 48];
        amount[..8].copy_from_slice(&1_000_000u64.to_le_bytes());
        let expected_tape = mint_tape_script(&amount, 6, name, symbol);
        assert!(mint.outputs.iter().any(|output| output.script_pubkey == expected_tape));
        let mut finalize = public_finalize_input(&input, &planned);
        let mut stages = Vec::new();
        for _ in 0..4 {
            let result = call_ok(EngineMethod::Finalize, &finalize);
            stages.push(json!({"input": finalize, "expected": result}));
            if result["bundle"].is_object() {
                return json!({"planInput": input, "planned": planned, "finalizeStages": stages,
                    "encodedTapeBytes": expected_tape.as_bytes().len()});
            }
            finalize["continuation"] = result["continuation"].clone();
            finalize["signatures"] = sign_public_tasks(&result["signingRequests"]);
        }
        panic!("FT creation did not finish within its bounded signing stages");
    }

    fn transfer(name: &str, symbol: &str) -> Value {
        let (utxos, parents, contract) = asset_material_seed_with_metadata(&[2_000], 0x91, name, symbol);
        let mut input = transfer_plan_input("direct");
        input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().truncate(1);
        input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().extend(utxos);
        input["snapshot"]["payload"]["parents"].as_array_mut().unwrap().truncate(1);
        input["snapshot"]["payload"]["parents"].as_array_mut().unwrap().extend(parents);
        input["snapshot"]["payload"]["contracts"] = json!([contract.clone()]);
        input["request"]["intent"]["contractId"] = contract["contractId"].clone();
        input["request"]["intent"]["amount"] = json!("1500");
        input["policy"]["payload"]["amountLimits"] = json!([
            {"scope": "native", "maximum": "2100000000000000"},
            {"scope": "ft-total", "contractId": contract["contractId"], "maximum": "1000000"}
        ]);
        let input = bind_request(input);
        let planned = call_ok(EngineMethod::Plan, &input);
        let finalize = public_finalize_input(&input, &planned);
        let result = call_ok(EngineMethod::Finalize, &finalize);
        assert!(result["bundle"].is_object());
        json!({"planInput": input, "planned": planned, "finalizeStages": [{"input": finalize, "expected": result}]})
    }

    pub fn vectors() -> Value {
        let samples = [
            ("lowercase", "lowercase token".to_owned(), "tws".to_owned()),
            ("mixedCase", "Mixed Token".to_owned(), "TwS9".to_owned()),
            ("unicode", "\u{6d4b}\u{8bd5} token".to_owned(), "\u{5e01}-tws".to_owned()),
            ("spacesPunctuation", " token.name " .to_owned(), " tws-._ " .to_owned()),
            ("ascii75", "n".repeat(75), "s".repeat(75)),
            ("ascii76", "n".repeat(76), "s".repeat(76)),
            ("tape253", "n".repeat(190), "s".to_owned()),
            ("tape254", "n".repeat(191), "s".to_owned()),
            ("tape255", "n".repeat(192), "s".to_owned()),
            ("unicodeTape255", "\u{5e01}".repeat(64), "s".to_owned()),
        ];
        let accepted: Vec<Value> = samples.iter().map(|(id, name, symbol)| {
            eprintln!("FT UTF-8 fixture {id}: create");
            let created = create(name, symbol);
            if let Some(length) = id.strip_prefix("tape") {
                assert_eq!(created["encodedTapeBytes"], length.parse::<usize>().unwrap());
            }
            if *id == "unicodeTape255" {
                assert_eq!(created["encodedTapeBytes"], 255);
            }
            eprintln!("FT UTF-8 fixture {id}: same-metadata transfer");
            let transferred = transfer(name, symbol);
            json!({"id": id, "name": name, "symbol": symbol,
                "create": created, "sameMetadataTransfer": transferred})
        }).collect();
        let mut rejected = Vec::new();
        for field in ["name", "symbol"] {
            for (id, value, schema_accepted) in [
                ("empty", String::new(), false),
                ("ascii257", "a".repeat(257), false),
                ("unicode257", format!("{}aa", "\u{5e01}".repeat(85)), true),
            ] {
                let mut input = create_plan_input();
                input["request"]["intent"][field] = json!(value);
                let params = json!({"version": "1.0", "request": input["request"]});
                let error = call_error(EngineMethod::NormalizeRequest, &params);
                assert_eq!(error["code"], "INVALID_INPUT");
                rejected.push(json!({"id": format!("{field}-{id}"), "params": params, "schemaAccepted": schema_accepted, "expectedError": error}));
            }
        }
        for (id, name, symbol) in [
            ("tape256", "n".repeat(193), "s".to_owned()),
            ("name256TapeOverflow", "n".repeat(256), "s".to_owned()),
            ("symbol256TapeOverflow", "n".to_owned(), "s".repeat(256)),
        ] {
            let mut input = create_plan_input();
            input["request"]["intent"]["name"] = json!(name);
            input["request"]["intent"]["symbol"] = json!(symbol);
            let params = json!({"version": "1.0", "request": input["request"]});
            let error = call_error(EngineMethod::NormalizeRequest, &params);
            assert_eq!(error["code"], "INVALID_INPUT");
            assert_eq!(error["path"], "request.intent");
            rejected.push(json!({"id": id, "params": params, "schemaAccepted": true, "expectedError": error}));
        }
        json!({"accepted": accepted, "rejected": rejected,
            "boundary": "Public test-key fixtures only; transfers use separately constructed authenticated same-metadata material, not a real-chain spend of the generated mint."})
    }
}

fn main() {
    println!("{}", fixtures::vectors());
}
