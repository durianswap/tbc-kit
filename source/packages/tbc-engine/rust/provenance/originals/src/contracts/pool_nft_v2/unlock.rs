#[cfg(test)]
mod tests {
    use serde_json::Value;

    use crate::{PublicKey, Transaction, UtxoInfo};

    use super::*;
    use crate::contracts::pool_nft_v2::data::{
        PoolAmounts, PoolSpendContext, PoolState, PoolUnlockContext, PoolUnlockOption,
        PoolUnlockSignature,
    };

    const JS_FIXTURE: &str = include_str!("../../../tests/fixtures/pool-v2-unlock-js-165.json");
    const SCRIPT_FIXTURE: &str = include_str!("../../../tests/fixtures/pool-v2-js-165.json");
    const SOURCE_AUTHORITY: &str =
        include_str!("../../../tests/fixtures/pool-v2-source-authority.json");

    fn fixture() -> Value {
        serde_json::from_str(JS_FIXTURE).unwrap()
    }

    fn source_authority() -> Value {
        serde_json::from_str(SOURCE_AUTHORITY).unwrap()
    }

    fn string_at(value: &Value, path: &[&str]) -> String {
        let mut current = value;
        for component in path {
            current = &current[*component];
        }
        current.as_str().unwrap().to_string()
    }

    fn tx_at(value: &Value, vector: &str, field: &str) -> Transaction {
        Transaction::from_hex(&string_at(value, &["vectors", vector, field])).unwrap()
    }

    fn state(locked: bool, ft_a_contract_id: crate::Txid) -> PoolState {
        PoolState {
            amounts: PoolAmounts {
                ft_lp_raw: 30_000_000,
                ft_a_raw: 100_000_000,
                tbc_sat: 30_000_000,
            },
            ft_lp_partial_hash: vec![0x11; 32],
            ft_a_partial_hash: vec![0x22; 32],
            ft_a_contract_id,
            service_fee_rate: 35,
            service_provider: "fixture".to_string(),
            lp_plan: 1,
            public_key_locked: locked,
            ftlp_lock_time_enabled: true,
        }
    }

    fn spend_context(value: &Value, vector: &str, locked: bool) -> PoolSpendContext {
        let current = tx_at(value, vector, "currentRaw");
        let pre = tx_at(value, vector, "poolPreRaw");
        let pre_pre = tx_at(value, vector, "poolPrePreRaw");
        let contract = tx_at(value, vector, "contractRaw");
        let input = &current.inputs[0];
        let output = &pre.outputs[input.previous_output.vout as usize];
        PoolSpendContext {
            pool_utxo: UtxoInfo {
                outpoint: input.previous_output.clone(),
                satoshis: output.satoshis,
                script_pubkey: output.script_pubkey.clone(),
            },
            pool_pre_tx: pre,
            pool_pre_pre_tx: pre_pre,
            state: state(locked, contract.txid()),
            contract_tx: contract,
        }
    }

    fn input_parents(value: &Value, vector: &str) -> Vec<Transaction> {
        value["vectors"][vector]["inputParentRaws"]
            .as_array()
            .unwrap()
            .iter()
            .map(|raw| Transaction::from_hex(raw.as_str().unwrap()).unwrap())
            .collect()
    }

    fn signature(value: &Value, vector: &str) -> PoolUnlockSignature {
        PoolUnlockSignature {
            signature_with_hashtype: hex::decode(string_at(
                value,
                &["vectors", vector, "signatureHex"],
            ))
            .unwrap(),
            public_key: PublicKey::from_slice(
                &hex::decode(string_at(value, &["vectors", vector, "signingPublicKey"])).unwrap(),
            )
            .unwrap(),
        }
    }

    fn option_at(value: &Value, vector: &str) -> PoolUnlockOption {
        match value["vectors"][vector]["option"].as_u64().unwrap() {
            1 => PoolUnlockOption::IncreaseLiquidity,
            2 => PoolUnlockOption::ConsumeLiquidity,
            3 => PoolUnlockOption::Swap,
            4 => PoolUnlockOption::MergePoolFt,
            _ => unreachable!(),
        }
    }

    fn swap_at(value: &Value, vector: &str) -> Option<PoolSwapOption> {
        match value["vectors"][vector]["swapOption"].as_u64() {
            Some(1) => Some(PoolSwapOption::TbcToFt),
            Some(2) => Some(PoolSwapOption::FtToTbc),
            None => None,
            _ => unreachable!(),
        }
    }

    fn pool_keys(value: &Value, vector: &str) -> Vec<PublicKey> {
        value["vectors"][vector]["poolPublicKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| PublicKey::from_slice(&hex::decode(key.as_str().unwrap()).unwrap()).unwrap())
            .collect()
    }

    #[test]
    fn source_authority_is_pinned_and_matches_exact_parent_scripts() {
        let value = fixture();
        let authority = source_authority();
        assert_eq!(authority["schemaVersion"], 1);
        assert_eq!(
            authority["provenance"]["repository"],
            "https://github.com/LoongYearMeta/tx-parser.git"
        );
        assert_eq!(
            authority["provenance"]["commit"],
            "aa846515acbd41f51a0379e9c0c7e0c0cce5195d"
        );

        for (key, family, source_fixture, source_fixture_sha256, byte_length, script_sha256) in [
            (
                "ftV2",
                "FT v2",
                "tests/fixtures/order-book/input-utxo-cache.json",
                "d3a972290eaed64c7f97504b679e4c7ac3d70d7f8e261d2ea5b4d66a6bb73153",
                1_884,
                "d116c3bd36d758059cf5df6c0d80446ac427caf7b15d7078548dfb81f8e0a8f8",
            ),
            (
                "coin",
                "Coin",
                "tests/fixtures/stablecoin/input-utxo-cache.json",
                "584143098e5fde271a595b0db37a7763a2eb2386af3279eb480f8b6362866b3e",
                2_012,
                "3d87a7f0a408d17f22cee1da3d1bbeaa13ffa455e43b8c7dd1339e8f973095c6",
            ),
        ] {
            let record = &authority["scripts"][key];
            assert_eq!(record["contractFamily"], family);
            assert_eq!(record["sourceFixture"], source_fixture);
            assert_eq!(record["sourceFixtureSha256"], source_fixture_sha256);
            assert_eq!(record["byteLength"], byte_length);
            assert_eq!(record["scriptSha256"], script_sha256);
            let bytes = hex::decode(record["hex"].as_str().unwrap()).unwrap();
            assert_eq!(bytes.len(), byte_length);
            assert_eq!(hex::encode(crate::hash::sha256(&bytes)), script_sha256);

            let generated_record = &value["sourceAuthority"]["scripts"][key];
            for field in [
                "contractFamily",
                "sourceFixture",
                "sourceFixtureSha256",
                "byteLength",
                "scriptSha256",
            ] {
                assert_eq!(generated_record[field], record[field]);
            }
        }

        assert_eq!(
            value["sourceAuthority"]["repository"],
            authority["provenance"]["repository"]
        );
        assert_eq!(
            value["sourceAuthority"]["commit"],
            authority["provenance"]["commit"]
        );

        let ft_v2 = hex::decode(authority["scripts"]["ftV2"]["hex"].as_str().unwrap()).unwrap();
        let coin = hex::decode(authority["scripts"]["coin"]["hex"].as_str().unwrap()).unwrap();
        for vector in value["vectors"].as_object().unwrap().keys() {
            let parents = input_parents(&value, vector);
            assert_eq!(parents[1].outputs[0].script_pubkey.as_bytes(), ft_v2);
            assert_eq!(parents[3].outputs[0].script_pubkey.as_bytes(), coin);
        }
    }

    #[test]
    fn javascript_165_all_pool_operations_match_exactly() {
        let value = fixture();
        assert_eq!(value["contractVersion"], "1.6.5");
        assert_eq!(value["sourceTapeBytes"], 81);
        assert_eq!(value["lockTimeTapeBytes"], 81);
        assert_eq!(
            hex::decode(value["lockTimeTapeHex"].as_str().unwrap())
                .unwrap()
                .len(),
            81
        );

        assert_eq!(value["sourceFamilyLengths"]["ft-v1"], 1_564);
        assert_eq!(value["sourceFamilyLengths"]["ft-v2"], 1_884);
        assert_eq!(value["sourceFamilyLengths"]["ft-current"], 1_884);
        assert_eq!(value["sourceFamilyLengths"]["coin"], 2_012);
        assert_eq!(value["sourceFamilyLengths"]["ftlp-current"], 1_884);
        assert_eq!(value["sourceFamilyLengths"]["ftlp-locktime"], 1_884);

        for vector in [
            "option1_standard",
            "option1_locked",
            "option1_locked_init",
            "option2_standard",
            "option2_locked",
            "option3Swap1_standard",
            "option3Swap1_locked",
            "option3Swap2_standard",
            "option3Swap2_locked",
            "option4_standard",
            "option4_locked",
        ] {
            let locked = value["vectors"][vector]["locked"].as_bool().unwrap();
            let with_lock = value["vectors"][vector]["withLock"].as_bool().unwrap();
            let option = option_at(&value, vector);
            let swap_option = swap_at(&value, vector);
            let current = tx_at(&value, vector, "currentRaw");
            assert_eq!(current.inputs.len(), 7);
            let pool = spend_context(&value, vector, locked);
            let parents = input_parents(&value, vector);
            let signing = signature(&value, vector);
            let keys = pool_keys(&value, vector);
            let signature = (locked && option == PoolUnlockOption::Swap).then_some(&signing);
            let context = PoolUnlockContext {
                transaction: &current,
                input_index: 0,
                spent_vout: 0,
                pool: &pool,
                input_parents: &parents,
                option,
                swap_option,
                with_lock,
                signature,
                public_key_lock: &keys,
            };

            assert_eq!(
                hex::encode(pool_unlock(&context).unwrap()),
                string_at(&value, &["vectors", vector, "unlockHex"]),
                "full unlock mismatch for {vector}"
            );
            assert_eq!(
                hex::encode(current_inputs_data(&current).unwrap()),
                string_at(&value, &["vectors", vector, "currentInputsHex"])
            );
            for (index, parent) in parents.iter().enumerate() {
                assert_eq!(
                    hex::encode(
                        input_parent_data(parent, 0, option == PoolUnlockOption::Swap).unwrap()
                    ),
                    value["vectors"][vector]["inputParentDataHex"][index]
                        .as_str()
                        .unwrap(),
                    "source parent {index} mismatch for {vector}"
                );
            }
            assert_eq!(parents[0].outputs[0].script_pubkey.as_bytes().len(), 1_564);
            assert_eq!(parents[1].outputs[0].script_pubkey.as_bytes().len(), 1_884);
            assert_eq!(parents[2].outputs[0].script_pubkey.as_bytes().len(), 1_884);
            assert_eq!(parents[3].outputs[0].script_pubkey.as_bytes().len(), 2_012);
            assert_eq!(parents[4].outputs[0].script_pubkey.as_bytes().len(), 1_884);
            assert_eq!(parents[5].outputs[0].script_pubkey.as_bytes().len(), 1_884);
            assert_eq!(parents[5].outputs[1].script_pubkey.as_bytes().len(), 81);
            assert_eq!(
                hex::encode(pool_parent_data(&pool.pool_pre_tx).unwrap()),
                string_at(&value, &["vectors", vector, "poolPreDataHex"])
            );
            assert_eq!(
                hex::encode(pool_pre_parent_data(&pool.pool_pre_pre_tx).unwrap()),
                string_at(&value, &["vectors", vector, "poolPrePreDataHex"])
            );
            assert_eq!(
                hex::encode(pool_outputs_data(&current, option, with_lock, swap_option).unwrap()),
                string_at(&value, &["vectors", vector, "outputsDataHex"]),
                "output data mismatch for {vector}"
            );
        }
        assert_eq!(value["vectors"]["option1_locked_init"]["locked"], true);
        assert_eq!(value["vectors"]["option1_locked_init"]["withLock"], false);
    }

    fn script(length: usize, fill: u8) -> crate::script::Script {
        crate::script::Script::from_bytes(vec![fill; length])
    }

    fn output(satoshis: u64, length: usize, fill: u8) -> crate::TxOut {
        crate::TxOut {
            satoshis,
            script_pubkey: script(length, fill),
        }
    }

    fn layout_transaction(
        option: PoolUnlockOption,
        swap_option: Option<PoolSwapOption>,
        output_count: usize,
        locked: bool,
    ) -> Transaction {
        let mut transaction = Transaction::new();
        transaction.outputs.push(output(1_001_000, 3_291, 0x51));
        transaction.outputs.push(output(0, 139, 0x52));
        match (option, swap_option) {
            (PoolUnlockOption::IncreaseLiquidity, _) => {
                transaction.outputs.push(output(500, 1_884, 0x53));
                transaction.outputs.push(output(0, 81, 0x54));
                transaction.outputs.push(output(500, 1_884, 0x55));
                transaction.outputs.push(output(0, 81, 0x56));
                if locked {
                    transaction.outputs.push(output(1_250_000, 25, 0x57));
                }
            }
            (PoolUnlockOption::ConsumeLiquidity, _) => {
                transaction.outputs.push(output(500, 1_884, 0x53));
                transaction.outputs.push(output(0, 81, 0x54));
                transaction.outputs.push(output(1_000, 25, 0x55));
                transaction.outputs.push(output(500, 1_884, 0x56));
                transaction.outputs.push(output(0, 81, 0x57));
            }
            (PoolUnlockOption::Swap, Some(PoolSwapOption::TbcToFt)) => {
                transaction.outputs.push(output(500, 1_884, 0x53));
                transaction.outputs.push(output(0, 81, 0x54));
            }
            (PoolUnlockOption::Swap, Some(PoolSwapOption::FtToTbc)) => {
                transaction.outputs.push(output(500, 1_884, 0x53));
                transaction.outputs.push(output(0, 81, 0x54));
                transaction.outputs.push(output(1_000, 25, 0x55));
            }
            (PoolUnlockOption::MergePoolFt, _) => {
                transaction.outputs.push(output(500, 1_884, 0x53));
                transaction.outputs.push(output(0, 81, 0x54));
                transaction.outputs.push(output(1_000, 25, 0x55));
            }
            _ => unreachable!(),
        }

        while transaction.outputs.len() < output_count {
            let remaining = output_count - transaction.outputs.len();
            if remaining >= 2 {
                transaction.outputs.push(output(500, 1_884, 0x58));
                transaction.outputs.push(output(0, 81, 0x59));
            } else {
                transaction.outputs.push(output(1_000, 25, 0x5a));
            }
        }
        transaction.outputs.truncate(output_count);
        transaction
    }

    #[test]
    fn every_released_pool_output_layout_has_a_checked_count() {
        for count in 6..=9 {
            let tx = layout_transaction(PoolUnlockOption::IncreaseLiquidity, None, count, false);
            assert!(
                pool_outputs_data(&tx, PoolUnlockOption::IncreaseLiquidity, false, None).is_ok()
            );
        }
        for count in 7..=10 {
            let tx = layout_transaction(PoolUnlockOption::IncreaseLiquidity, None, count, true);
            assert!(
                pool_outputs_data(&tx, PoolUnlockOption::IncreaseLiquidity, true, None).is_ok()
            );
        }
        for count in 7..=12 {
            let tx = layout_transaction(PoolUnlockOption::ConsumeLiquidity, None, count, false);
            assert!(
                pool_outputs_data(&tx, PoolUnlockOption::ConsumeLiquidity, false, None).is_ok()
            );
        }
        for count in 4..=8 {
            let tx = layout_transaction(
                PoolUnlockOption::Swap,
                Some(PoolSwapOption::TbcToFt),
                count,
                false,
            );
            assert!(
                pool_outputs_data(
                    &tx,
                    PoolUnlockOption::Swap,
                    false,
                    Some(PoolSwapOption::TbcToFt),
                )
                .is_ok()
            );
        }
        for count in 5..=9 {
            let tx = layout_transaction(
                PoolUnlockOption::Swap,
                Some(PoolSwapOption::FtToTbc),
                count,
                false,
            );
            assert!(
                pool_outputs_data(
                    &tx,
                    PoolUnlockOption::Swap,
                    false,
                    Some(PoolSwapOption::FtToTbc),
                )
                .is_ok()
            );
        }
        let merge = layout_transaction(PoolUnlockOption::MergePoolFt, None, 5, false);
        assert!(pool_outputs_data(&merge, PoolUnlockOption::MergePoolFt, false, None).is_ok());

        for (option, swap, count, locked) in [
            (PoolUnlockOption::IncreaseLiquidity, None, 5, false),
            (PoolUnlockOption::IncreaseLiquidity, None, 11, true),
            (PoolUnlockOption::ConsumeLiquidity, None, 13, false),
            (
                PoolUnlockOption::Swap,
                Some(PoolSwapOption::TbcToFt),
                9,
                false,
            ),
            (
                PoolUnlockOption::Swap,
                Some(PoolSwapOption::FtToTbc),
                10,
                false,
            ),
            (PoolUnlockOption::MergePoolFt, None, 6, false),
        ] {
            let tx = layout_transaction(option, swap, count, locked);
            assert!(
                pool_outputs_data(&tx, option, locked, swap).is_err(),
                "unexpectedly accepted option={option:?} swap={swap:?} count={count} locked={locked}"
            );
        }
    }

    #[test]
    fn pool_unlock_rejects_bad_indexes_parents_and_push_lengths() {
        let value = fixture();
        let current = tx_at(&value, "option1_standard", "currentRaw");
        let pool = spend_context(&value, "option1_standard", false);
        let parents = input_parents(&value, "option1_standard");
        let signing = signature(&value, "option1_standard");
        let mut context = PoolUnlockContext {
            transaction: &current,
            input_index: current.inputs.len(),
            spent_vout: 0,
            pool: &pool,
            input_parents: &parents,
            option: PoolUnlockOption::IncreaseLiquidity,
            swap_option: None,
            with_lock: false,
            signature: Some(&signing),
            public_key_lock: &[],
        };
        assert!(pool_unlock(&context).is_err());
        context.input_index = 0;
        context.spent_vout = 1;
        assert!(pool_unlock(&context).is_err());
        context.spent_vout = 0;
        context.input_parents = &[];
        assert!(pool_unlock(&context).is_err());
        assert!(push_data_length(0x1_0000).is_err());
        assert!(script_size_le(0x1_0000).is_err());
        assert_eq!(push_data_length(75).unwrap(), vec![75]);
        assert_eq!(push_data_length(76).unwrap(), vec![0x4c, 76]);
        assert_eq!(push_data_length(256).unwrap(), vec![0x4d, 0, 1]);
    }

    #[test]
    fn optional_signature_prefix_verifies_and_locked_swap_checks_membership() {
        let value = fixture();
        let current = tx_at(&value, "option1_standard", "currentRaw");
        let pool = spend_context(&value, "option1_standard", false);
        let parents = input_parents(&value, "option1_standard");
        let signing = signature(&value, "option1_standard");
        let mut expected = push_data_length(signing.signature_with_hashtype.len()).unwrap();
        expected.extend_from_slice(&signing.signature_with_hashtype);
        expected.extend_from_slice(&push_data_length(signing.public_key.to_bytes().len()).unwrap());
        expected.extend_from_slice(&signing.public_key.to_bytes());

        let mut context = PoolUnlockContext {
            transaction: &current,
            input_index: 0,
            spent_vout: 0,
            pool: &pool,
            input_parents: &parents,
            option: PoolUnlockOption::IncreaseLiquidity,
            swap_option: None,
            with_lock: false,
            signature: Some(&signing),
            public_key_lock: &[],
        };
        assert_eq!(signature_prefix(&context, false).unwrap(), expected);
        assert!(signature_prefix(&context, true).is_err());

        let mut locked_pool = pool.clone();
        locked_pool.state.public_key_locked = true;
        let allowed = [signing.public_key.clone()];
        context.pool = &locked_pool;
        context.option = PoolUnlockOption::Swap;
        context.swap_option = Some(PoolSwapOption::TbcToFt);
        context.public_key_lock = &allowed;
        assert_eq!(signature_prefix(&context, true).unwrap(), expected);
        context.public_key_lock = &[];
        assert!(signature_prefix(&context, true).is_err());

        let mut malformed = signing.clone();
        malformed.signature_with_hashtype.pop();
        malformed.signature_with_hashtype.push(0x42);
        context.public_key_lock = &allowed;
        context.signature = Some(&malformed);
        assert!(signature_prefix(&context, true).is_err());
    }

    #[test]
    fn pool_context_binds_contract_and_actual_spent_successor_lock_scripts() {
        let value = fixture();
        let vector = "option3Swap1_locked";
        let current = tx_at(&value, vector, "currentRaw");
        let pool = spend_context(&value, vector, true);
        let parents = input_parents(&value, vector);
        let signing = signature(&value, vector);
        let keys = pool_keys(&value, vector);
        let context = PoolUnlockContext {
            transaction: &current,
            input_index: 0,
            spent_vout: 0,
            pool: &pool,
            input_parents: &parents,
            option: PoolUnlockOption::Swap,
            swap_option: Some(PoolSwapOption::TbcToFt),
            with_lock: true,
            signature: Some(&signing),
            public_key_lock: &keys,
        };
        assert!(pool_unlock(&context).is_ok());

        let mut wrong_contract = pool.clone();
        wrong_contract.contract_tx.lock_time += 1;
        let wrong_contract_context = PoolUnlockContext {
            pool: &wrong_contract,
            ..context.clone()
        };
        assert!(pool_unlock(&wrong_contract_context).is_err());

        let mut structurally_empty_contract = pool.clone();
        structurally_empty_contract.contract_tx.inputs.clear();
        structurally_empty_contract.state.ft_a_contract_id =
            structurally_empty_contract.contract_tx.txid();
        let structurally_empty_context = PoolUnlockContext {
            pool: &structurally_empty_contract,
            ..context.clone()
        };
        assert!(pool_unlock(&structurally_empty_context).is_err());

        let extra_key = crate::PrivateKey::from_slice(&[9; 32])
            .unwrap()
            .public_key();
        let caller_superset = [keys[0].clone(), extra_key];
        let caller_superset_context = PoolUnlockContext {
            public_key_lock: &caller_superset,
            ..context.clone()
        };
        assert!(pool_unlock(&caller_superset_context).is_err());

        let mut wrong_state = pool.clone();
        wrong_state.state.public_key_locked = false;
        let wrong_state_context = PoolUnlockContext {
            pool: &wrong_state,
            signature: None,
            ..context.clone()
        };
        assert!(pool_unlock(&wrong_state_context).is_err());

        let standard = tx_at(&value, "option2_standard", "currentRaw");
        let mut mixed_current = tx_at(&value, "option2_locked", "currentRaw");
        mixed_current.outputs[0].script_pubkey = standard.outputs[0].script_pubkey.clone();
        let mixed_pool = spend_context(&value, "option2_locked", true);
        let mixed_parents = input_parents(&value, "option2_locked");
        let mixed_keys = pool_keys(&value, "option2_locked");
        let mixed_context = PoolUnlockContext {
            transaction: &mixed_current,
            input_index: 0,
            spent_vout: 0,
            pool: &mixed_pool,
            input_parents: &mixed_parents,
            option: PoolUnlockOption::ConsumeLiquidity,
            swap_option: None,
            with_lock: true,
            signature: None,
            public_key_lock: &mixed_keys,
        };
        assert!(pool_unlock(&mixed_context).is_err());

        let three_key_script =
            Script::from_bytes(hex::decode(value["lockedThreePoolHex"].as_str().unwrap()).unwrap());
        let parsed = pool_code_lock(&three_key_script).unwrap();
        let expected = value["lockedThreePoolPublicKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| PublicKey::from_slice(&hex::decode(key.as_str().unwrap()).unwrap()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(parsed, expected);
    }

    #[test]
    fn pool_script_parser_rejects_truncated_and_nonminimal_pushes() {
        assert!(parsed_script_chunks(&[opcodes::OP_PUSHDATA1]).is_err());
        assert!(parsed_script_chunks(&[opcodes::OP_PUSHDATA2, 1]).is_err());
        assert!(parsed_script_chunks(&[opcodes::OP_PUSHDATA4, 1, 0, 0]).is_err());
        assert!(parsed_script_chunks(&[opcodes::OP_PUSHDATA1, 1, 0xaa]).is_err());
        assert!(parsed_script_chunks(&[opcodes::OP_PUSHDATA2, 75, 0]).is_err());
        assert!(parsed_script_chunks(&[opcodes::OP_PUSHDATA4, 0, 1, 0, 0]).is_err());

        let mut minimal_pushdata1 = vec![opcodes::OP_PUSHDATA1, 76];
        minimal_pushdata1.extend_from_slice(&[0xaa; 76]);
        assert!(parsed_script_chunks(&minimal_pushdata1).is_ok());
        let mut minimal_pushdata2 = vec![opcodes::OP_PUSHDATA2, 0, 1];
        minimal_pushdata2.extend_from_slice(&[0xbb; 256]);
        assert!(parsed_script_chunks(&minimal_pushdata2).is_ok());
        let mut minimal_pushdata4 = vec![opcodes::OP_PUSHDATA4, 0, 0, 1, 0];
        minimal_pushdata4.extend_from_slice(&vec![0xcc; 65_536]);
        assert!(parsed_script_chunks(&minimal_pushdata4).is_ok());
    }

    #[test]
    fn locked_key_gate_parser_accepts_released_counts_and_rejects_malformed_grammar() {
        let fixture: Value = serde_json::from_str(SCRIPT_FIXTURE).unwrap();
        let script = |field: &str| {
            Script::from_bytes(
                hex::decode(fixture["scripts"][field]["hex"].as_str().unwrap()).unwrap(),
            )
        };
        for (field, key_count) in [
            ("lockedPoolOneKey", 1),
            ("lockedPoolTwoKeys", 2),
            ("lockedPoolThreeKeys", 3),
            ("lockedPoolTenKeys", 10),
        ] {
            assert_eq!(pool_code_lock(&script(field)).unwrap().len(), key_count);
        }

        let two_key = script("lockedPoolTwoKeys");
        let parsed_keys = pool_code_lock(&two_key).unwrap();
        let first_key = parsed_keys[0].to_bytes();
        let second_key = parsed_keys[1].to_bytes();
        let locate = |bytes: &[u8], key: &[u8; 33]| {
            bytes
                .windows(key.len())
                .position(|window| window == key)
                .unwrap()
        };

        let mut nonminimal = two_key.as_bytes().to_vec();
        let first_start = locate(&nonminimal, &first_key);
        assert_eq!(nonminimal[first_start - 1], 33);
        nonminimal[first_start - 1] = opcodes::OP_PUSHDATA1;
        nonminimal.insert(first_start, 33);
        assert!(pool_code_lock(&Script::from_bytes(nonminimal)).is_err());

        let mut wrong_opcode = two_key.as_bytes().to_vec();
        let first_start = locate(&wrong_opcode, &first_key);
        assert_eq!(wrong_opcode[first_start + 33], opcodes::OP_EQUAL);
        wrong_opcode[first_start + 33] = opcodes::OP_VERIFY;
        assert!(pool_code_lock(&Script::from_bytes(wrong_opcode)).is_err());

        let mut truncated = two_key.as_bytes().to_vec();
        let first_start = locate(&truncated, &first_key);
        truncated.remove(first_start + 10);
        assert!(pool_code_lock(&Script::from_bytes(truncated)).is_err());

        let mut bad_boundary = two_key.as_bytes().to_vec();
        let second_start = locate(&bad_boundary, &second_key);
        let suffix_start = second_start + 33 + 3;
        assert_eq!(bad_boundary[suffix_start], opcodes::OP_ELSE);
        bad_boundary.insert(suffix_start, opcodes::OP_0);
        assert!(pool_code_lock(&Script::from_bytes(bad_boundary)).is_err());

        let mut extra_gate = two_key.as_bytes().to_vec();
        let second_start = locate(&extra_gate, &second_key);
        let suffix_start = second_start + 33 + 3;
        let mut duplicate = vec![
            opcodes::OP_DUP,
            1,
            33,
            opcodes::OP_SPLIT,
            opcodes::OP_DROP,
            33,
        ];
        duplicate.extend_from_slice(&first_key);
        duplicate.extend_from_slice(&[opcodes::OP_EQUALVERIFY, opcodes::OP_CHECKSIGVERIFY]);
        extra_gate.splice(suffix_start..suffix_start, duplicate);
        assert!(pool_code_lock(&Script::from_bytes(extra_gate)).is_err());
    }

    fn two_key_script_and_keys() -> (Script, [u8; 33], [u8; 33]) {
        let fixture: Value = serde_json::from_str(SCRIPT_FIXTURE).unwrap();
        let two_key = Script::from_bytes(
            hex::decode(
                fixture["scripts"]["lockedPoolTwoKeys"]["hex"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap(),
        );
        let parsed_keys = pool_code_lock(&two_key).unwrap();
        let first_key = parsed_keys[0].to_bytes();
        let second_key = parsed_keys[1].to_bytes();
        (two_key, first_key, second_key)
    }

    #[test]
    fn locked_key_gate_parser_preserves_distinct_legacy_order() {
        let (two_key, first_key, second_key) = two_key_script_and_keys();
        let locate = |bytes: &[u8], key: &[u8; 33]| {
            bytes
                .windows(key.len())
                .position(|window| window == key)
                .unwrap()
        };

        let mut legacy_order = two_key.as_bytes().to_vec();
        let first_start = locate(&legacy_order, &first_key);
        let second_start = locate(&legacy_order, &second_key);
        legacy_order[first_start..first_start + 33].copy_from_slice(&second_key);
        legacy_order[second_start..second_start + 33].copy_from_slice(&first_key);
        let legacy_keys = pool_code_lock(&Script::from_bytes(legacy_order))
            .expect("a structurally valid legacy key order must remain spendable");
        assert_eq!(
            legacy_keys
                .iter()
                .map(PublicKey::to_bytes)
                .collect::<Vec<_>>(),
            vec![second_key, first_key]
        );
    }

    #[test]
    fn locked_key_gate_parser_rejects_duplicate_legacy_keys() {
        let (two_key, first_key, second_key) = two_key_script_and_keys();
        let mut duplicate = two_key.as_bytes().to_vec();
        let second_start = duplicate
            .windows(second_key.len())
            .position(|window| window == second_key)
            .unwrap();
        duplicate[second_start..second_start + 33].copy_from_slice(&first_key);
        assert!(pool_code_lock(&Script::from_bytes(duplicate)).is_err());
    }
}
use crate::{
    DEFAULT_SIGHASH, Error, Result, TX_VERSION, Transaction, TxOut, hash,
    script::{Script, opcodes},
    sighash,
};

use super::data::{PoolSwapOption, PoolUnlockContext, PoolUnlockOption};
use crate::contracts::ft::partial_sha256::calculate_partial_hash;

const VERSION_LENGTH: u8 = 0x10;
const AMOUNT_LENGTH: u8 = 0x08;
const HASH_LENGTH: u8 = 0x20;
const FT_V1_LENGTH: usize = 1_564;
const FT_V1_PARTIAL_OFFSET: usize = 1_536;
const FT_V2_LENGTH: usize = 1_884;
const FT_V2_PARTIAL_OFFSET: usize = 1_856;
const FT_V4_LENGTH: usize = 2_076;
const FT_V4_PARTIAL_OFFSET: usize = 2_048;
const COIN_LENGTH: usize = 2_012;
const COIN_PARTIAL_OFFSET: usize = 1_984;

const SERVICE_FEE_HASHES: [[u8; 20]; 5] = [
    [
        0x1e, 0xac, 0xc2, 0x75, 0xe8, 0x37, 0x41, 0xa1, 0x0d, 0x19, 0xf1, 0x39, 0xe1, 0x91, 0xd1,
        0xfe, 0x36, 0x00, 0x55, 0xe8,
    ],
    [
        0x9f, 0xd4, 0x10, 0x63, 0x33, 0xba, 0xf6, 0x9c, 0x11, 0xd5, 0xb1, 0x74, 0x04, 0x6f, 0x92,
        0xc9, 0xac, 0x96, 0x3a, 0xab,
    ],
    [
        0x0b, 0xd9, 0xe3, 0xb2, 0x94, 0x9d, 0xda, 0xde, 0xf0, 0xd3, 0xf7, 0xa9, 0xe0, 0x69, 0x14,
        0x1e, 0x67, 0x70, 0x29, 0x4d,
    ],
    [
        0x5a, 0x25, 0xa1, 0x22, 0x0e, 0x93, 0x5e, 0x1a, 0x00, 0x48, 0xe5, 0x03, 0x44, 0xa1, 0x3f,
        0x22, 0x6f, 0xa5, 0x21, 0x20,
    ],
    [
        0x2e, 0x65, 0xa6, 0xd3, 0x04, 0xba, 0xbe, 0xdd, 0x65, 0x49, 0x3c, 0x9e, 0xe5, 0xb4, 0x23,
        0xfa, 0x4f, 0x20, 0xba, 0x74,
    ],
];

#[derive(Clone, Debug, PartialEq, Eq)]
struct OutputSplit {
    before: Vec<u8>,
    before_length: Vec<u8>,
    after: Vec<u8>,
    after_length: Vec<u8>,
}

/// Released `getLengthHex`: Bitcoin Script push length with little-endian
/// PUSHDATA2. Pool scripts never permit lengths above the released u16 range.
pub fn push_data_length(length: usize) -> Result<Vec<u8>> {
    match length {
        0..=75 => Ok(vec![length as u8]),
        76..=0xff => Ok(vec![opcodes::OP_PUSHDATA1, length as u8]),
        0x100..=0xffff => {
            let mut bytes = vec![opcodes::OP_PUSHDATA2];
            bytes.extend_from_slice(&(length as u16).to_le_bytes());
            Ok(bytes)
        }
        _ => Err(Error::InvalidScript(
            "Pool push length exceeds released u16 encoding".to_string(),
        )),
    }
}

/// Released `getSize`: one or two little-endian bytes describing a script.
pub fn script_size_le(length: usize) -> Result<Vec<u8>> {
    match length {
        0..=0xff => Ok(vec![length as u8]),
        0x100..=0xffff => Ok((length as u16).to_le_bytes().to_vec()),
        _ => Err(Error::InvalidScript(
            "Pool script size exceeds released u16 encoding".to_string(),
        )),
    }
}

fn checked_count(length: usize, description: &str) -> Result<u32> {
    u32::try_from(length)
        .map_err(|_| Error::InvalidUtxo(format!("{description} count exceeds u32")))
}

fn validate_transaction_header(transaction: &Transaction, description: &str) -> Result<()> {
    if transaction.version != TX_VERSION {
        return Err(Error::InvalidUtxo(format!(
            "{description} transaction version must be {TX_VERSION}"
        )));
    }
    checked_count(transaction.inputs.len(), description)?;
    checked_count(transaction.outputs.len(), description)?;
    Ok(())
}

fn write_header(out: &mut Vec<u8>, transaction: &Transaction) -> Result<()> {
    validate_transaction_header(transaction, "Pool")?;
    out.push(VERSION_LENGTH);
    out.extend_from_slice(&(TX_VERSION as u32).to_le_bytes());
    out.extend_from_slice(&transaction.lock_time.to_le_bytes());
    out.extend_from_slice(&checked_count(transaction.inputs.len(), "Pool input")?.to_le_bytes());
    out.extend_from_slice(&checked_count(transaction.outputs.len(), "Pool output")?.to_le_bytes());
    Ok(())
}

fn input_parts(transaction: &Transaction) -> Result<(Vec<u8>, Vec<u8>)> {
    validate_transaction_header(transaction, "Pool input-data")?;
    let input_capacity = transaction
        .inputs
        .len()
        .checked_mul(40)
        .ok_or_else(|| Error::InvalidUtxo("Pool input-data length overflow".to_string()))?;
    let script_capacity =
        transaction.inputs.len().checked_mul(32).ok_or_else(|| {
            Error::InvalidUtxo("Pool script-hash data length overflow".to_string())
        })?;
    let mut inputs = Vec::with_capacity(input_capacity);
    let mut scripts = Vec::with_capacity(script_capacity);
    for input in &transaction.inputs {
        input.previous_output.serialize(&mut inputs);
        inputs.extend_from_slice(&input.sequence.to_le_bytes());
        scripts.extend_from_slice(&input.script_sig.sha256());
    }
    Ok((inputs, scripts))
}

fn write_hash_pair(output: &TxOut, out: &mut Vec<u8>) {
    out.extend_from_slice(&output.satoshis.to_le_bytes());
    out.extend_from_slice(&output.script_pubkey.sha256());
}

fn outputs_split(
    transaction: &Transaction,
    vout: usize,
    include_tape: bool,
) -> Result<OutputSplit> {
    if vout >= transaction.outputs.len() {
        return Err(Error::InvalidUtxo(
            "Pool input parent vout is out of range".to_string(),
        ));
    }
    let mut before = Vec::new();
    for output in transaction.outputs.iter().take(vout) {
        write_hash_pair(output, &mut before);
    }
    let before_length = if before.is_empty() {
        before.push(0);
        Vec::new()
    } else {
        push_data_length(before.len())?
    };

    let skip = if include_tape { 2 } else { 1 };
    let start = vout
        .checked_add(skip)
        .ok_or_else(|| Error::InvalidUtxo("Pool output split index overflow".to_string()))?;
    let mut after = Vec::new();
    for output in transaction.outputs.iter().skip(start) {
        write_hash_pair(output, &mut after);
    }
    let after_length = if after.is_empty() {
        after.push(0);
        Vec::new()
    } else {
        push_data_length(after.len())?
    };
    Ok(OutputSplit {
        before,
        before_length,
        after,
        after_length,
    })
}

fn partial_offset(script_length: usize) -> Option<usize> {
    match script_length {
        FT_V1_LENGTH => Some(FT_V1_PARTIAL_OFFSET),
        FT_V2_LENGTH => Some(FT_V2_PARTIAL_OFFSET),
        FT_V4_LENGTH => Some(FT_V4_PARTIAL_OFFSET),
        COIN_LENGTH => Some(COIN_PARTIAL_OFFSET),
        _ => None,
    }
}

fn write_partial_output(output: &TxOut, out: &mut Vec<u8>) -> Result<()> {
    let script = output.script_pubkey.as_bytes();
    let offset = partial_offset(script.len()).ok_or_else(|| {
        Error::InvalidScript(format!(
            "Pool FT output has unsupported code length {}",
            script.len()
        ))
    })?;
    write_partial_output_at(output, offset, out)
}

fn write_partial_output_at(output: &TxOut, offset: usize, out: &mut Vec<u8>) -> Result<()> {
    let script = output.script_pubkey.as_bytes();
    if offset > script.len() {
        return Err(Error::InvalidScript(format!(
            "Pool FT partial offset {offset} exceeds code length {}",
            script.len()
        )));
    }
    out.push(AMOUNT_LENGTH);
    out.extend_from_slice(&output.satoshis.to_le_bytes());
    let suffix = &script[offset..];
    out.extend_from_slice(&push_data_length(suffix.len())?);
    out.extend_from_slice(suffix);
    out.push(HASH_LENGTH);
    out.extend_from_slice(&calculate_partial_hash(&script[..offset]));
    let size = script_size_le(script.len())?;
    out.extend_from_slice(&push_data_length(size.len())?);
    out.extend_from_slice(&size);
    Ok(())
}

fn write_non_ft_output(output: &TxOut, out: &mut Vec<u8>) -> Result<()> {
    let script = output.script_pubkey.as_bytes();
    if partial_offset(script.len()).is_some() {
        return Err(Error::InvalidScript(
            "Pool non-FT output cannot contain an FT code script".to_string(),
        ));
    }
    out.push(AMOUNT_LENGTH);
    out.extend_from_slice(&output.satoshis.to_le_bytes());
    out.extend_from_slice(&push_data_length(script.len())?);
    out.extend_from_slice(script);
    out.push(0);
    let size = script_size_le(script.len())?;
    out.extend_from_slice(&push_data_length(size.len())?);
    out.extend_from_slice(&size);
    Ok(())
}

fn write_tape_output(output: &TxOut, out: &mut Vec<u8>) -> Result<()> {
    let script = output.script_pubkey.as_bytes();
    out.push(AMOUNT_LENGTH);
    out.extend_from_slice(&output.satoshis.to_le_bytes());
    out.extend_from_slice(&push_data_length(script.len())?);
    out.extend_from_slice(script);
    Ok(())
}

fn write_pool_hash_output(output: &TxOut, out: &mut Vec<u8>) {
    out.push(AMOUNT_LENGTH);
    out.extend_from_slice(&output.satoshis.to_le_bytes());
    out.push(HASH_LENGTH);
    out.extend_from_slice(&output.script_pubkey.sha256());
}

fn write_outputs_from(transaction: &Transaction, index: usize, out: &mut Vec<u8>) -> Result<()> {
    if index > transaction.outputs.len() {
        return Err(Error::InvalidUtxo(
            "Pool output suffix index is out of range".to_string(),
        ));
    }
    let mut outputs = Vec::new();
    for output in transaction.outputs.iter().skip(index) {
        write_hash_pair(output, &mut outputs);
    }
    if outputs.is_empty() {
        out.push(0);
    } else {
        out.extend_from_slice(&push_data_length(outputs.len())?);
        out.extend_from_slice(&outputs);
    }
    Ok(())
}

/// Serializes a non-Pool current input's parent transaction. `include_tape`
/// selects the released swap form, which commits the adjacent FT Tape inline.
pub fn input_parent_data(
    transaction: &Transaction,
    vout: usize,
    include_tape: bool,
) -> Result<Vec<u8>> {
    validate_transaction_header(transaction, "Pool auxiliary parent")?;
    let output = transaction.outputs.get(vout).ok_or_else(|| {
        Error::InvalidUtxo("Pool auxiliary parent vout is out of range".to_string())
    })?;
    let mut data = Vec::new();
    write_header(&mut data, transaction)?;
    let (inputs, scripts) = input_parts(transaction)?;
    data.push(HASH_LENGTH);
    data.extend_from_slice(&hash::sha256(&inputs));
    data.push(HASH_LENGTH);
    data.extend_from_slice(&hash::sha256(&scripts));

    let is_ft = partial_offset(output.script_pubkey.as_bytes().len()).is_some();
    let split = outputs_split(transaction, vout, include_tape && is_ft)?;
    data.extend_from_slice(&split.before_length);
    data.extend_from_slice(&split.before);

    if is_ft {
        write_partial_output(output, &mut data)?;
        if include_tape {
            let tape = transaction.outputs.get(vout + 1).ok_or_else(|| {
                Error::InvalidUtxo(
                    "Pool swap auxiliary FT parent is missing its adjacent Tape".to_string(),
                )
            })?;
            write_tape_output(tape, &mut data)?;
        }
    } else {
        write_non_ft_output(output, &mut data)?;
    }
    data.extend_from_slice(&split.after_length);
    data.extend_from_slice(&split.after);
    data.push(0x52);
    Ok(data)
}

/// Serializes all current outpoints and sequences using the released push
/// prefix. No unlocking script bytes are included in this field.
pub fn current_inputs_data(transaction: &Transaction) -> Result<Vec<u8>> {
    let (inputs, _) = input_parts(transaction)?;
    let mut data = push_data_length(inputs.len())?;
    data.extend_from_slice(&inputs);
    Ok(data)
}

/// Serializes the direct parent of the spent Pool state.
pub fn pool_parent_data(transaction: &Transaction) -> Result<Vec<u8>> {
    validate_transaction_header(transaction, "Pool parent")?;
    let pool_output = transaction.outputs.first().ok_or_else(|| {
        Error::InvalidUtxo("Pool parent is missing Pool Code output 0".to_string())
    })?;
    let tape_output = transaction.outputs.get(1).ok_or_else(|| {
        Error::InvalidUtxo("Pool parent is missing Pool Tape output 1".to_string())
    })?;
    let mut data = Vec::new();
    write_header(&mut data, transaction)?;
    let (inputs, scripts) = input_parts(transaction)?;
    data.extend_from_slice(&push_data_length(inputs.len())?);
    data.extend_from_slice(&inputs);
    data.push(HASH_LENGTH);
    data.extend_from_slice(&hash::sha256(&scripts));
    write_pool_hash_output(pool_output, &mut data);
    write_tape_output(tape_output, &mut data)?;
    write_outputs_from(transaction, 2, &mut data)?;
    Ok(data)
}

/// Serializes the grandparent of the spent Pool state.
pub fn pool_pre_parent_data(transaction: &Transaction) -> Result<Vec<u8>> {
    validate_transaction_header(transaction, "Pool pre-parent")?;
    let pool_output = transaction
        .outputs
        .first()
        .ok_or_else(|| Error::InvalidUtxo("Pool pre-parent is missing output 0".to_string()))?;
    let mut data = Vec::new();
    write_header(&mut data, transaction)?;
    let (inputs, scripts) = input_parts(transaction)?;
    data.push(HASH_LENGTH);
    data.extend_from_slice(&hash::sha256(&inputs));
    data.push(HASH_LENGTH);
    data.extend_from_slice(&hash::sha256(&scripts));
    write_pool_hash_output(pool_output, &mut data);
    write_outputs_from(transaction, 1, &mut data)?;
    Ok(data)
}

fn is_ft_output(output: &TxOut) -> bool {
    partial_offset(output.script_pubkey.as_bytes().len()).is_some()
}

fn write_ft_pair(transaction: &Transaction, index: usize, out: &mut Vec<u8>) -> Result<()> {
    let code = transaction
        .outputs
        .get(index)
        .ok_or_else(|| Error::InvalidUtxo(format!("Pool FT Code output {index} is missing")))?;
    let tape_index = index
        .checked_add(1)
        .ok_or_else(|| Error::InvalidUtxo("Pool FT Tape index overflow".to_string()))?;
    let tape = transaction.outputs.get(tape_index).ok_or_else(|| {
        Error::InvalidUtxo(format!(
            "Pool FT Code output {index} is missing adjacent Tape"
        ))
    })?;
    write_partial_output(code, out)?;
    write_tape_output(tape, out)
}

fn write_dynamic_outputs(
    transaction: &Transaction,
    start: usize,
    end: usize,
    out: &mut Vec<u8>,
) -> Result<()> {
    if end > transaction.outputs.len() || start > end {
        return Err(Error::InvalidUtxo(
            "Pool dynamic output range is invalid".to_string(),
        ));
    }
    let mut index = start;
    while index < end {
        let output = &transaction.outputs[index];
        if is_ft_output(output) {
            if index + 1 >= end {
                return Err(Error::InvalidUtxo(format!(
                    "Pool FT output {index} is missing its Tape inside the layout"
                )));
            }
            write_ft_pair(transaction, index, out)?;
            index += 2;
        } else {
            write_non_ft_output(output, out)?;
            index += 1;
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ParsedScriptChunk<'a> {
    opcode: u8,
    data: &'a [u8],
}

fn parsed_script_chunks(script: &[u8]) -> Result<Vec<ParsedScriptChunk<'_>>> {
    let mut chunks = Vec::new();
    let mut index = 0usize;
    while index < script.len() {
        let opcode = script[index];
        index += 1;
        let length = match opcode {
            0x01..=0x4b => opcode as usize,
            opcodes::OP_PUSHDATA1 => {
                let length = *script.get(index).ok_or_else(|| {
                    Error::InvalidScript("truncated Pool OP_PUSHDATA1".to_string())
                })? as usize;
                index += 1;
                if length < 76 {
                    return Err(Error::InvalidScript(
                        "Pool OP_PUSHDATA1 uses a non-minimal length".to_string(),
                    ));
                }
                length
            }
            opcodes::OP_PUSHDATA2 => {
                let raw: [u8; 2] = script
                    .get(index..index + 2)
                    .ok_or_else(|| Error::InvalidScript("truncated Pool OP_PUSHDATA2".to_string()))?
                    .try_into()
                    .expect("slice length checked");
                index += 2;
                let length = u16::from_le_bytes(raw) as usize;
                if length < 0x100 {
                    return Err(Error::InvalidScript(
                        "Pool OP_PUSHDATA2 uses a non-minimal length".to_string(),
                    ));
                }
                length
            }
            opcodes::OP_PUSHDATA4 => {
                let raw: [u8; 4] = script
                    .get(index..index + 4)
                    .ok_or_else(|| Error::InvalidScript("truncated Pool OP_PUSHDATA4".to_string()))?
                    .try_into()
                    .expect("slice length checked");
                index += 4;
                let length = usize::try_from(u32::from_le_bytes(raw)).map_err(|_| {
                    Error::InvalidScript("Pool push length does not fit usize".to_string())
                })?;
                if length < 0x1_0000 {
                    return Err(Error::InvalidScript(
                        "Pool OP_PUSHDATA4 uses a non-minimal length".to_string(),
                    ));
                }
                length
            }
            _ => 0,
        };
        let end = index.checked_add(length).ok_or_else(|| {
            Error::InvalidScript("Pool script instruction length overflow".to_string())
        })?;
        if end > script.len() {
            return Err(Error::InvalidScript(
                "Pool script contains a truncated push".to_string(),
            ));
        }
        chunks.push(ParsedScriptChunk {
            opcode,
            data: &script[index..end],
        });
        index = end;
    }
    Ok(chunks)
}

fn is_opcode(chunk: &ParsedScriptChunk<'_>, opcode: u8) -> bool {
    chunk.opcode == opcode && chunk.data.is_empty()
}

fn is_push(chunk: &ParsedScriptChunk<'_>, data: &[u8]) -> bool {
    chunk.data == data
}

fn is_canonical_public_key_push(chunk: &ParsedScriptChunk<'_>) -> bool {
    chunk.opcode == 33 && chunk.data.len() == 33
}

/// Extracts the canonical dynamic public-key gate inserted between the
/// released locked-Pool pre/last templates. The gate is either the one-key
/// equality form or the released nested `OP_IF` form for two through ten keys.
pub fn pool_code_lock(script: &Script) -> Result<Vec<crate::PublicKey>> {
    let chunks = parsed_script_chunks(script.as_bytes())?;
    if chunks.last().is_none_or(|chunk| chunk.data != b"2Code") {
        return Err(Error::InvalidScript(
            "Pool Code is missing its 2Code marker".to_string(),
        ));
    }
    let anchors = chunks
        .windows(4)
        .enumerate()
        .filter_map(|(index, window)| {
            (is_opcode(&window[0], opcodes::OP_DUP)
                && is_push(&window[1], &[33])
                && is_opcode(&window[2], opcodes::OP_SPLIT)
                && is_opcode(&window[3], opcodes::OP_DROP))
            .then_some(index)
        })
        .collect::<Vec<_>>();
    let all_key_pushes = chunks
        .iter()
        .enumerate()
        .filter_map(|(index, chunk)| (chunk.data.len() == 33).then_some(index))
        .collect::<Vec<_>>();

    if anchors.is_empty() {
        if !all_key_pushes.is_empty() {
            return Err(Error::InvalidScript(
                "Pool Code has a public-key push without the released key gate".to_string(),
            ));
        }
        return Ok(Vec::new());
    }
    if anchors.len() != 1 {
        return Err(Error::InvalidScript(
            "Pool Code has an ambiguous locked key gate".to_string(),
        ));
    }

    let anchor = anchors[0];
    if anchor < 2
        || !is_opcode(&chunks[anchor - 2], opcodes::OP_ENDIF)
        || !is_opcode(&chunks[anchor - 1], opcodes::OP_ENDIF)
    {
        return Err(Error::InvalidScript(
            "Pool Code locked key gate has an invalid pre-template boundary".to_string(),
        ));
    }

    let gate = anchor + 4;
    let mut cursor = gate;
    let mut key_indexes = Vec::new();
    if chunks.get(cursor).is_some_and(is_canonical_public_key_push) {
        key_indexes.push(cursor);
        cursor += 1;
        if !chunks
            .get(cursor)
            .is_some_and(|chunk| is_opcode(chunk, opcodes::OP_EQUALVERIFY))
        {
            return Err(Error::InvalidScript(
                "Pool Code one-key gate is missing OP_EQUALVERIFY".to_string(),
            ));
        }
        cursor += 1;
    } else {
        let mut nested_branches = 0usize;
        loop {
            let branch_valid = chunks
                .get(cursor)
                .is_some_and(|chunk| is_opcode(chunk, opcodes::OP_DUP))
                && chunks
                    .get(cursor + 1)
                    .is_some_and(is_canonical_public_key_push)
                && chunks
                    .get(cursor + 2)
                    .is_some_and(|chunk| is_opcode(chunk, opcodes::OP_EQUAL))
                && chunks
                    .get(cursor + 3)
                    .is_some_and(|chunk| is_opcode(chunk, opcodes::OP_IF))
                && chunks
                    .get(cursor + 4)
                    .is_some_and(|chunk| is_opcode(chunk, opcodes::OP_DROP))
                && chunks
                    .get(cursor + 5)
                    .is_some_and(|chunk| is_opcode(chunk, opcodes::OP_ELSE));
            if !branch_valid {
                return Err(Error::InvalidScript(
                    "Pool Code contains a malformed nested locked key branch".to_string(),
                ));
            }
            key_indexes.push(cursor + 1);
            nested_branches += 1;
            cursor += 6;

            if chunks.get(cursor).is_some_and(is_canonical_public_key_push) {
                key_indexes.push(cursor);
                cursor += 1;
                break;
            }
        }
        if !chunks
            .get(cursor)
            .is_some_and(|chunk| is_opcode(chunk, opcodes::OP_EQUALVERIFY))
        {
            return Err(Error::InvalidScript(
                "Pool Code nested key gate is missing OP_EQUALVERIFY".to_string(),
            ));
        }
        cursor += 1;
        for _ in 0..nested_branches {
            if !chunks
                .get(cursor)
                .is_some_and(|chunk| is_opcode(chunk, opcodes::OP_ENDIF))
            {
                return Err(Error::InvalidScript(
                    "Pool Code nested key gate has an unbalanced OP_ENDIF".to_string(),
                ));
            }
            cursor += 1;
        }
    }
    if !(1..=10).contains(&key_indexes.len())
        || !chunks
            .get(cursor)
            .is_some_and(|chunk| is_opcode(chunk, opcodes::OP_CHECKSIGVERIFY))
    {
        return Err(Error::InvalidScript(
            "Pool Code locked key gate has an invalid key count or signature boundary".to_string(),
        ));
    }
    cursor += 1;
    if !chunks
        .get(cursor)
        .is_some_and(|chunk| is_opcode(chunk, opcodes::OP_ELSE))
        || !chunks
            .get(cursor + 1)
            .is_some_and(|chunk| is_opcode(chunk, opcodes::OP_1 + 3))
        || !chunks
            .get(cursor + 2)
            .is_some_and(|chunk| is_opcode(chunk, opcodes::OP_EQUALVERIFY))
        || key_indexes != all_key_pushes
    {
        return Err(Error::InvalidScript(
            "Pool Code does not contain the exact released locked key gate".to_string(),
        ));
    }

    let keys = key_indexes
        .iter()
        .map(|index| crate::PublicKey::from_slice(chunks[*index].data))
        .collect::<Result<Vec<_>>>()?;
    // The released JavaScript builder embedded the caller's key order. Preserve that order so
    // historical Pool Code can be recreated byte-for-byte, while still rejecting duplicate keys.
    let mut canonical = keys
        .iter()
        .map(crate::PublicKey::to_bytes)
        .collect::<Vec<_>>();
    canonical.sort_unstable();
    if canonical.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(Error::InvalidScript(
            "Pool Code locked public keys are not distinct".to_string(),
        ));
    }
    Ok(keys)
}

fn pool_code_characteristics(script: &Script) -> Result<(usize, bool)> {
    let bytes = script.as_bytes();
    let chunks = parsed_script_chunks(bytes)?;
    if chunks.len() < 4 {
        return Err(Error::InvalidScript(
            "Pool Code has fewer than four instructions".to_string(),
        ));
    }
    let second_last_data_length = chunks[chunks.len() - 2].data.len();
    let removed = second_last_data_length.checked_add(1).ok_or_else(|| {
        Error::InvalidScript("Pool Code discriminator length overflow".to_string())
    })?;
    let pool_code_length = bytes
        .len()
        .checked_sub(removed)
        .ok_or_else(|| Error::InvalidScript("Pool Code discriminator underflow".to_string()))?;
    Ok((
        pool_code_length,
        chunks[chunks.len() - 4].opcode == opcodes::OP_1,
    ))
}

pub(crate) fn uses_large_pool_unlock(script: &Script) -> Result<bool> {
    let (pool_code_length, has_large_opcode) = pool_code_characteristics(script)?;
    Ok(pool_code_length > 3_284 || has_large_opcode)
}

fn has_ftlp_marker(output: &TxOut) -> bool {
    output
        .script_pubkey
        .as_bytes()
        .get(1_428..1_433)
        .is_some_and(|marker| marker == [0xff; 5])
}

fn p2pkh_hash(output: &TxOut) -> Option<[u8; 20]> {
    let bytes = output.script_pubkey.as_bytes();
    if bytes.len() != 25
        || bytes[0] != opcodes::OP_DUP
        || bytes[1] != opcodes::OP_HASH160
        || bytes[2] != 0x14
        || bytes[23] != opcodes::OP_EQUALVERIFY
        || bytes[24] != opcodes::OP_CHECKSIG
    {
        return None;
    }
    bytes[3..23].try_into().ok()
}

fn is_service_fee_output(output: &TxOut) -> bool {
    p2pkh_hash(output).is_some_and(|hash| SERVICE_FEE_HASHES.contains(&hash))
}

fn increase_outputs(transaction: &Transaction, locked: bool) -> Result<Vec<u8>> {
    let lock_count = usize::from(locked);
    let logical_count = transaction
        .outputs
        .len()
        .checked_sub(lock_count)
        .ok_or_else(|| Error::InvalidUtxo("locked Pool output count underflow".to_string()))?;
    if !(6..=9).contains(&logical_count) {
        return Err(Error::InvalidUtxo(format!(
            "Pool increase requires 6..=9 logical outputs, got {logical_count}"
        )));
    }
    let mut data = Vec::new();
    write_pool_hash_output(&transaction.outputs[0], &mut data);
    write_tape_output(&transaction.outputs[1], &mut data)?;
    write_ft_pair(transaction, 2, &mut data)?;
    write_ft_pair(transaction, 4, &mut data)?;
    if locked {
        write_non_ft_output(&transaction.outputs[6], &mut data)?;
    } else {
        let pool_code_length = pool_code_characteristics(&transaction.outputs[0].script_pubkey)?.0;
        // Pool contracts released before tbc-contract 1.6.6 consume an empty
        // lock-output placeholder when their Code script uses the large ABI.
        // Plan 6 (1.6.6) removed that stack item. Select the ABI from the
        // locking script so existing pools and newly-created pools can both be
        // spent by the same SDK.
        if (3_285..3_746).contains(&pool_code_length) {
            data.push(0);
        }
    }

    let extra_start = 6 + lock_count;
    match logical_count {
        6 => {
            data.push(0);
            data.push(0);
        }
        7 => {
            data.push(0);
            write_non_ft_output(&transaction.outputs[extra_start], &mut data)?;
        }
        8 => {
            write_ft_pair(transaction, extra_start, &mut data)?;
            data.push(0);
        }
        9 => write_dynamic_outputs(
            transaction,
            extra_start,
            transaction.outputs.len(),
            &mut data,
        )?,
        _ => unreachable!(),
    }
    Ok(data)
}

fn consume_outputs(transaction: &Transaction) -> Result<Vec<u8>> {
    if !(7..=12).contains(&transaction.outputs.len()) {
        return Err(Error::InvalidUtxo(format!(
            "Pool consume requires 7..=12 outputs, got {}",
            transaction.outputs.len()
        )));
    }
    let mut data = Vec::new();
    write_pool_hash_output(&transaction.outputs[0], &mut data);
    write_tape_output(&transaction.outputs[1], &mut data)?;
    write_dynamic_outputs(transaction, 2, 7, &mut data)?;
    let outer_offset = partial_offset(transaction.outputs[2].script_pubkey.as_bytes().len())
        .ok_or_else(|| {
            Error::InvalidScript(
                "Pool consume output 2 has an unsupported FT code length".to_string(),
            )
        })?;

    match transaction.outputs.len() {
        7 => data.extend_from_slice(&[0, 0, 0]),
        8 => {
            data.extend_from_slice(&[0, 0]);
            write_non_ft_output(&transaction.outputs[7], &mut data)?;
        }
        9 => {
            if has_ftlp_marker(&transaction.outputs[7]) {
                write_partial_output_at(&transaction.outputs[7], outer_offset, &mut data)?;
                write_tape_output(&transaction.outputs[8], &mut data)?;
                data.extend_from_slice(&[0, 0]);
            } else {
                data.push(0);
                write_ft_pair(transaction, 7, &mut data)?;
                data.push(0);
            }
        }
        10 => {
            if has_ftlp_marker(&transaction.outputs[7]) {
                write_partial_output_at(&transaction.outputs[7], outer_offset, &mut data)?;
                write_tape_output(&transaction.outputs[8], &mut data)?;
                data.push(0);
                write_non_ft_output(&transaction.outputs[9], &mut data)?;
            } else {
                data.push(0);
                write_ft_pair(transaction, 7, &mut data)?;
                write_non_ft_output(&transaction.outputs[9], &mut data)?;
            }
        }
        11 => {
            write_dynamic_outputs(transaction, 7, 11, &mut data)?;
            data.push(0);
        }
        12 => write_dynamic_outputs(transaction, 7, 12, &mut data)?,
        _ => unreachable!(),
    }
    Ok(data)
}

fn swap_tbc_to_ft_outputs(transaction: &Transaction) -> Result<Vec<u8>> {
    if !(4..=8).contains(&transaction.outputs.len()) {
        return Err(Error::InvalidUtxo(format!(
            "Pool TBC-to-FT swap requires 4..=8 outputs, got {}",
            transaction.outputs.len()
        )));
    }
    let mut data = Vec::new();
    write_pool_hash_output(&transaction.outputs[0], &mut data);
    write_tape_output(&transaction.outputs[1], &mut data)?;
    write_ft_pair(transaction, 2, &mut data)?;
    match transaction.outputs.len() {
        4 => data.extend_from_slice(&[0, 0, 0]),
        5 => {
            if is_service_fee_output(&transaction.outputs[4]) {
                write_non_ft_output(&transaction.outputs[4], &mut data)?;
                data.extend_from_slice(&[0, 0]);
            } else {
                data.extend_from_slice(&[0, 0]);
                write_non_ft_output(&transaction.outputs[4], &mut data)?;
            }
        }
        6 => {
            if is_service_fee_output(&transaction.outputs[4]) {
                write_non_ft_output(&transaction.outputs[4], &mut data)?;
                data.push(0);
                write_non_ft_output(&transaction.outputs[5], &mut data)?;
            } else {
                data.push(0);
                write_ft_pair(transaction, 4, &mut data)?;
                data.push(0);
            }
        }
        7 => {
            if is_service_fee_output(&transaction.outputs[4]) {
                write_non_ft_output(&transaction.outputs[4], &mut data)?;
                write_ft_pair(transaction, 5, &mut data)?;
                data.push(0);
            } else {
                data.push(0);
                write_ft_pair(transaction, 4, &mut data)?;
                write_non_ft_output(&transaction.outputs[6], &mut data)?;
            }
        }
        8 => write_dynamic_outputs(transaction, 4, 8, &mut data)?,
        _ => unreachable!(),
    }
    Ok(data)
}

fn swap_ft_to_tbc_outputs(transaction: &Transaction) -> Result<Vec<u8>> {
    if !(5..=9).contains(&transaction.outputs.len()) {
        return Err(Error::InvalidUtxo(format!(
            "Pool FT-to-TBC swap requires 5..=9 outputs, got {}",
            transaction.outputs.len()
        )));
    }
    let mut data = Vec::new();
    write_pool_hash_output(&transaction.outputs[0], &mut data);
    write_tape_output(&transaction.outputs[1], &mut data)?;
    write_dynamic_outputs(transaction, 2, 5, &mut data)?;
    match transaction.outputs.len() {
        5 => data.extend_from_slice(&[0, 0, 0]),
        6 => {
            if is_service_fee_output(&transaction.outputs[5]) {
                write_non_ft_output(&transaction.outputs[5], &mut data)?;
                data.extend_from_slice(&[0, 0]);
            } else {
                data.extend_from_slice(&[0, 0]);
                write_non_ft_output(&transaction.outputs[5], &mut data)?;
            }
        }
        7 => {
            if is_service_fee_output(&transaction.outputs[5]) {
                write_non_ft_output(&transaction.outputs[5], &mut data)?;
                data.push(0);
                write_non_ft_output(&transaction.outputs[6], &mut data)?;
            } else {
                data.push(0);
                write_ft_pair(transaction, 5, &mut data)?;
                data.push(0);
            }
        }
        8 => {
            if is_service_fee_output(&transaction.outputs[5]) {
                write_non_ft_output(&transaction.outputs[5], &mut data)?;
                write_ft_pair(transaction, 6, &mut data)?;
                data.push(0);
            } else {
                data.push(0);
                write_ft_pair(transaction, 5, &mut data)?;
                write_non_ft_output(&transaction.outputs[7], &mut data)?;
            }
        }
        9 => write_dynamic_outputs(transaction, 5, 9, &mut data)?,
        _ => unreachable!(),
    }
    Ok(data)
}

fn merge_pool_ft_outputs(transaction: &Transaction) -> Result<Vec<u8>> {
    if transaction.outputs.len() != 5 {
        return Err(Error::InvalidUtxo(format!(
            "Pool FT merge requires exactly 5 outputs, got {}",
            transaction.outputs.len()
        )));
    }
    let mut data = Vec::new();
    write_pool_hash_output(&transaction.outputs[0], &mut data);
    write_tape_output(&transaction.outputs[1], &mut data)?;
    write_ft_pair(transaction, 2, &mut data)?;
    write_non_ft_output(&transaction.outputs[4], &mut data)?;
    Ok(data)
}

/// Serializes the released PoolNFT v2 output layout for one operation.
pub fn pool_outputs_data(
    transaction: &Transaction,
    option: PoolUnlockOption,
    locked: bool,
    swap_option: Option<PoolSwapOption>,
) -> Result<Vec<u8>> {
    validate_transaction_header(transaction, "Pool current")?;
    match option {
        PoolUnlockOption::IncreaseLiquidity => {
            if swap_option.is_some() {
                return Err(Error::InvalidUtxo(
                    "Pool increase does not accept a swap option".to_string(),
                ));
            }
            increase_outputs(transaction, locked)
        }
        PoolUnlockOption::ConsumeLiquidity => {
            if swap_option.is_some() {
                return Err(Error::InvalidUtxo(
                    "Pool consume does not accept a swap option".to_string(),
                ));
            }
            consume_outputs(transaction)
        }
        PoolUnlockOption::Swap => match swap_option {
            Some(PoolSwapOption::TbcToFt) => swap_tbc_to_ft_outputs(transaction),
            Some(PoolSwapOption::FtToTbc) => swap_ft_to_tbc_outputs(transaction),
            None => Err(Error::InvalidUtxo(
                "Pool swap requires an explicit direction".to_string(),
            )),
        },
        PoolUnlockOption::MergePoolFt => {
            if swap_option.is_some() {
                return Err(Error::InvalidUtxo(
                    "Pool FT merge does not accept a swap option".to_string(),
                ));
            }
            merge_pool_ft_outputs(transaction)
        }
    }
}

fn validate_parent_output<'a>(
    transaction: &'a Transaction,
    expected_txid: crate::Txid,
    vout: u32,
    description: &str,
) -> Result<&'a TxOut> {
    validate_transaction_header(transaction, description)?;
    if transaction.txid() != expected_txid {
        return Err(Error::InvalidUtxo(format!(
            "{description} txid does not match the current input"
        )));
    }
    transaction
        .outputs
        .get(vout as usize)
        .ok_or_else(|| Error::InvalidUtxo(format!("{description} vout {vout} is out of range")))
}

fn canonical_key_set(keys: &[crate::PublicKey]) -> Vec<[u8; 33]> {
    let mut serialized = keys
        .iter()
        .map(crate::PublicKey::to_bytes)
        .collect::<Vec<_>>();
    serialized.sort();
    serialized
}

fn validate_unlock_context(context: &PoolUnlockContext<'_>) -> Result<bool> {
    validate_transaction_header(context.transaction, "Pool current")?;
    if context.input_index != 0 {
        return Err(Error::InvalidUtxo(
            "PoolNFT v2 state must be current input 0".to_string(),
        ));
    }
    let pool_input = context
        .transaction
        .inputs
        .get(context.input_index)
        .ok_or_else(|| Error::InvalidUtxo("Pool input index is out of range".to_string()))?;
    if context.spent_vout != 0
        || context.pool.pool_utxo.outpoint.vout != context.spent_vout
        || pool_input.previous_output.vout != context.spent_vout
    {
        return Err(Error::InvalidUtxo(
            "PoolNFT v2 state must spend output 0".to_string(),
        ));
    }
    if pool_input.previous_output != context.pool.pool_utxo.outpoint {
        return Err(Error::InvalidUtxo(
            "Pool UTXO does not match current input 0".to_string(),
        ));
    }
    let pool_output = validate_parent_output(
        &context.pool.pool_pre_tx,
        pool_input.previous_output.txid,
        context.spent_vout,
        "Pool parent",
    )?;
    if pool_output.satoshis != context.pool.pool_utxo.satoshis
        || pool_output.script_pubkey != context.pool.pool_utxo.script_pubkey
    {
        return Err(Error::InvalidUtxo(
            "Pool UTXO amount or script does not match its parent output".to_string(),
        ));
    }

    let prior_pool_input = context.pool.pool_pre_tx.inputs.first().ok_or_else(|| {
        Error::InvalidUtxo("Pool parent is missing its state input 0".to_string())
    })?;
    if prior_pool_input.previous_output.vout != 0 {
        return Err(Error::InvalidUtxo(
            "Pool parent state input must spend pre-parent output 0".to_string(),
        ));
    }
    validate_parent_output(
        &context.pool.pool_pre_pre_tx,
        prior_pool_input.previous_output.txid,
        prior_pool_input.previous_output.vout,
        "Pool pre-parent",
    )?;
    validate_transaction_header(&context.pool.contract_tx, "Pool contract")?;
    if context.pool.contract_tx.inputs.is_empty() || context.pool.contract_tx.outputs.is_empty() {
        return Err(Error::InvalidUtxo(
            "Pool contract transaction must have inputs and outputs".to_string(),
        ));
    }
    if context.pool.contract_tx.txid() != context.pool.state.ft_a_contract_id {
        return Err(Error::InvalidUtxo(
            "Pool FT contract transaction txid does not match Pool state".to_string(),
        ));
    }

    let expected_parents = context
        .transaction
        .inputs
        .len()
        .checked_sub(1)
        .ok_or_else(|| Error::InvalidUtxo("Pool current transaction has no inputs".to_string()))?;
    if context.input_parents.len() != expected_parents {
        return Err(Error::InvalidUtxo(format!(
            "Pool current transaction requires {expected_parents} auxiliary parents, got {}",
            context.input_parents.len()
        )));
    }
    for (input_index, (input, parent)) in context
        .transaction
        .inputs
        .iter()
        .skip(1)
        .zip(context.input_parents)
        .enumerate()
    {
        validate_parent_output(
            parent,
            input.previous_output.txid,
            input.previous_output.vout,
            &format!("Pool auxiliary parent {}", input_index + 1),
        )?;
    }

    let successor_script = &context
        .transaction
        .outputs
        .first()
        .ok_or_else(|| Error::InvalidUtxo("Pool current output 0 is missing".to_string()))?
        .script_pubkey;
    let spent_keys = pool_code_lock(&context.pool.pool_utxo.script_pubkey)?;
    let successor_keys = pool_code_lock(successor_script)?;
    let expected_locked = !spent_keys.is_empty();
    if expected_locked != context.pool.state.public_key_locked {
        return Err(Error::InvalidUtxo(
            "Pool state lock flag does not match the actually spent Pool Code".to_string(),
        ));
    }
    if canonical_key_set(&spent_keys) != canonical_key_set(&successor_keys) {
        return Err(Error::InvalidUtxo(
            "Pool successor locked public keys do not match the spent Pool Code".to_string(),
        ));
    }
    if canonical_key_set(&spent_keys) != canonical_key_set(context.public_key_lock) {
        return Err(Error::InvalidUtxo(
            "Pool public_key_lock does not exactly match the spent Pool Code".to_string(),
        ));
    }

    let spent_large = uses_large_pool_unlock(&context.pool.pool_utxo.script_pubkey)?;
    let successor_large = uses_large_pool_unlock(successor_script)?;
    if spent_large != successor_large {
        return Err(Error::InvalidUtxo(
            "Pool successor Code uses a different unlock serialization path".to_string(),
        ));
    }
    Ok(spent_large)
}

fn signature_prefix(context: &PoolUnlockContext<'_>, large_pool: bool) -> Result<Vec<u8>> {
    let signature_required = signature_required(context, large_pool);
    let Some(signing) = context.signature else {
        if signature_required {
            return Err(Error::InvalidUtxo(
                "Pool unlock requires a signature".to_string(),
            ));
        }
        return Ok(Vec::new());
    };
    if !signature_required {
        return Err(Error::InvalidUtxo(
            "Pool unlock does not accept a signature for this code path".to_string(),
        ));
    }
    let (&hash_type, der) = signing
        .signature_with_hashtype
        .split_last()
        .ok_or_else(|| Error::InvalidUtxo("Pool signature is empty".to_string()))?;
    if hash_type != DEFAULT_SIGHASH as u8 || der.is_empty() {
        return Err(Error::InvalidUtxo(
            "Pool signature has an invalid sighash type".to_string(),
        ));
    }
    let digest = sighash::forkid_sighash(
        context.transaction,
        context.input_index,
        &context.pool.pool_utxo.script_pubkey,
        context.pool.pool_utxo.satoshis,
        DEFAULT_SIGHASH,
    )?;
    let verifies = signing
        .public_key
        .verify_ecdsa_digest(&digest, der)
        .map_err(|_| Error::InvalidUtxo("Pool signature has malformed DER".to_string()))?;
    if !verifies {
        return Err(Error::InvalidUtxo(
            "Pool signature does not match its public key".to_string(),
        ));
    }
    if large_pool
        && context.option == PoolUnlockOption::Swap
        && context.pool.state.public_key_locked
        && !context.public_key_lock.contains(&signing.public_key)
    {
        return Err(Error::InvalidUtxo(
            "Pool locked swap signer is not present in public_key_lock".to_string(),
        ));
    }

    let mut prefix = push_data_length(signing.signature_with_hashtype.len())?;
    prefix.extend_from_slice(&signing.signature_with_hashtype);
    let public_key = signing.public_key.to_bytes();
    prefix.extend_from_slice(&push_data_length(public_key.len())?);
    prefix.extend_from_slice(&public_key);
    Ok(prefix)
}

fn signature_required(context: &PoolUnlockContext<'_>, large_pool: bool) -> bool {
    !large_pool
        || (context.option == PoolUnlockOption::Swap && context.pool.state.public_key_locked)
}

/// Validates the complete released Pool context and reports whether its Code
/// path requires an externally supplied signature. This performs no signing.
pub fn pool_unlock_requires_signature(context: &PoolUnlockContext<'_>) -> Result<bool> {
    let large_pool = validate_unlock_context(context)?;
    Ok(signature_required(context, large_pool))
}

/// Produces the byte-exact released PoolNFT v2 unlocking script from explicit
/// current, parent, and pre-parent transaction context.
pub fn pool_unlock(context: &PoolUnlockContext<'_>) -> Result<Vec<u8>> {
    let large_pool = validate_unlock_context(context)?;
    pool_unlock_body(context, large_pool, true)
}

/// Produces the released PoolNFT v2 unlocking-script body after validating the
/// complete context, but deliberately omits the optional signature prefix.
/// This supports keyless maximum-size planning; broadcast paths must use
/// `pool_unlock` so the supplied signature is cryptographically verified.
pub fn pool_unlock_unsigned_body(context: &PoolUnlockContext<'_>) -> Result<Vec<u8>> {
    let large_pool = validate_unlock_context(context)?;
    pool_unlock_body(context, large_pool, false)
}

fn pool_unlock_body(
    context: &PoolUnlockContext<'_>,
    large_pool: bool,
    include_signature: bool,
) -> Result<Vec<u8>> {
    let mut auxiliary_segments = Vec::with_capacity(context.input_parents.len());
    for (input, parent) in context
        .transaction
        .inputs
        .iter()
        .skip(1)
        .zip(context.input_parents)
    {
        auxiliary_segments.push(input_parent_data(
            parent,
            input.previous_output.vout as usize,
            context.option == PoolUnlockOption::Swap,
        )?);
    }
    if context.option == PoolUnlockOption::Swap {
        auxiliary_segments.reverse();
    }
    let auxiliary_length = auxiliary_segments
        .iter()
        .try_fold(1usize, |length, segment| {
            length.checked_add(segment.len()).ok_or_else(|| {
                Error::InvalidUtxo("Pool auxiliary parent data length overflow".to_string())
            })
        })?;
    let mut auxiliary = Vec::with_capacity(auxiliary_length);
    auxiliary.push(opcodes::OP_1);
    for segment in auxiliary_segments {
        auxiliary.extend_from_slice(&segment);
    }

    let current_inputs = current_inputs_data(context.transaction)?;
    let outputs = pool_outputs_data(
        context.transaction,
        context.option,
        context.with_lock,
        context.swap_option,
    )?;
    let pre_pre = pool_pre_parent_data(&context.pool.pool_pre_pre_tx)?;
    let pre = pool_parent_data(&context.pool.pool_pre_tx)?;
    let mut unlock = if include_signature {
        signature_prefix(context, large_pool)?
    } else {
        Vec::new()
    };
    if context.option == PoolUnlockOption::IncreaseLiquidity {
        unlock.extend_from_slice(&auxiliary);
        unlock.extend_from_slice(&current_inputs);
        unlock.extend_from_slice(&outputs);
    } else {
        unlock.extend_from_slice(&outputs);
        unlock.extend_from_slice(&auxiliary);
        unlock.extend_from_slice(&current_inputs);
    }
    unlock.push(context.option.tag());
    unlock.extend_from_slice(&pre_pre);
    unlock.extend_from_slice(&pre);
    Ok(unlock)
}
