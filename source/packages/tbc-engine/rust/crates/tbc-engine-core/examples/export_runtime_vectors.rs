mod ft_suite {
    include!("../tests/ft.rs");

    pub fn runtime_vectors() -> serde_json::Value {
        let create_plan_input = create_plan_input();
        let create_planned = call_ok(
            tbc_engine_core::EngineMethod::Plan,
            &create_plan_input,
        );
        let mut create_finalize = public_finalize_input(
            &create_plan_input,
            &create_planned,
        );
        let mut create_finalize_inputs = Vec::new();
        let create_complete = loop {
            create_finalize_inputs.push(create_finalize.clone());
            let result = call_ok(
                tbc_engine_core::EngineMethod::Finalize,
                &create_finalize,
            );
            if result.get("bundle").is_some() {
                break result;
            }
            create_finalize["continuation"] = result["continuation"].clone();
            create_finalize["signatures"] =
                sign_public_tasks(&result["signingRequests"]);
        };
        serde_json::json!({
            "create": {
                "planInput": create_plan_input,
                "finalizeInputs": create_finalize_inputs,
                "complete": create_complete,
            },
            "direct": transfer_plan_input("direct"),
            "mergeRequired": transfer_plan_input("mergeRequired"),
        })
    }
}

mod pool_suite {
    include!("../tests/pool.rs");

    fn public_plan_input(name: &str) -> serde_json::Value {
        let mut input = plan_input(name);
        input["policy"]["payload"]["amountLimits"] = serde_json::json!([{
            "scope": "native",
            "maximum": "1000000000",
        }]);
        input["policy"]["policyHash"] =
            serde_json::json!(canonical_hash(&input["policy"]["payload"]));
        input
    }

    fn public_complete_vector(name: &str) -> serde_json::Value {
        let plan_input = public_plan_input(name);
        public_complete_vector_from(plan_input)
    }

    fn public_complete_vector_from(mut plan_input: serde_json::Value) -> serde_json::Value {
        plan_input["policy"]["payload"]["amountLimits"] = serde_json::json!([{
            "scope": "native",
            "maximum": "1000000000",
        }]);
        plan_input["policy"]["policyHash"] =
            serde_json::json!(canonical_hash(&plan_input["policy"]["payload"]));
        let planned = call_ok(tbc_engine_core::EngineMethod::Plan, &plan_input);
        let mut finalize = pool_finalize_input(&plan_input, &planned);
        let mut finalize_inputs = Vec::new();
        let complete = loop {
            finalize_inputs.push(finalize.clone());
            let result = call_ok(tbc_engine_core::EngineMethod::Finalize, &finalize);
            if result.get("bundle").is_some() {
                break result;
            }
            finalize["continuation"] = result["continuation"].clone();
            finalize["signatures"] = sign_tasks(&result["signingRequests"]);
        };
        serde_json::json!({
            "planInput": plan_input,
            "finalizeInputs": finalize_inputs,
            "complete": complete,
        })
    }

    pub fn runtime_vectors() -> serde_json::Value {
        let input = plan_input("pool-swap-tbc-for-token.json");
        let planned = call_ok(tbc_engine_core::EngineMethod::Plan, &input);
        let finalize = pool_finalize_input(&input, &planned);
        let mut ftlp_burn = fragmented_plan_input(
            "pool-liquidity-remove.json", &[2_500_000], &[4_000, 6_000],
        );
        let pool_contract_id =
            ftlp_burn["snapshot"]["payload"]["contracts"][1]["contractId"].clone();
        ftlp_burn["request"]["intent"] = serde_json::json!({
            "type": "tbc.pool.ftlp.burn",
            "version": "1.0",
            "poolContractId": pool_contract_id,
        });
        ftlp_burn["requestHash"] =
            serde_json::json!(canonical_hash(&ftlp_burn["request"]));
        serde_json::json!({
            "swap": {
                "planInput": input,
                "finalizeInput": finalize,
            },
            "tokenSwapPlanInput": plan_input("pool-swap-token-for-tbc.json"),
            "addLiquidity": public_complete_vector("pool-liquidity-add.json"),
            "removeLiquidity": public_complete_vector("pool-liquidity-remove.json"),
            "tokenSwap": public_complete_vector("pool-swap-token-for-tbc.json"),
            "fragmentedRemove": public_complete_vector_from(fragmented_plan_input(
                "pool-liquidity-remove.json", &[1_000_000, 1_500_000], &[10_000],
            )),
            "maintenanceRemove": public_complete_vector_from(fragmented_plan_input(
                "pool-liquidity-remove.json", &[500_000, 500_000, 500_000, 1_000_000], &[5_000, 5_000],
            )),
            "ftlpBurn": public_complete_vector_from(ftlp_burn),
            "createPlanInput": public_plan_input("pool-create.json"),
            "createMint": public_complete_vector_from(split_create_mint_input()),
            "createInitialize": public_complete_vector_from(split_create_initialize_input()),
        })
    }
}

fn main() {
    println!("{}", serde_json::json!({
        "ft": ft_suite::runtime_vectors(),
        "pool": pool_suite::runtime_vectors(),
    }));
}
