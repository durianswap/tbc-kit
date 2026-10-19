use secp256k1::{Message, PublicKey as SecpPublicKey, Secp256k1, SecretKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tbc_engine_core::{
    ErrorCode,
    signing::{
        EvidenceEntry, ExternalSignature, FtlpLockMode, FtlpUnlockRecipe, PlannedInput,
        PlannedOutput, PlannedTransaction, PoolHeldFtUnlockRecipe, PoolRecipeOperation,
        PoolRecipeSwap, PoolUnlockRecipe, ProofReference, PublicSigningContext, SigningRequest,
        StageOutcome, TransactionSource, UnsignedPlan, begin_signing, finalize_signing_stage,
        ftlp_unlocking_descriptor, pool_held_ft_unlocking_descriptor, pool_unlocking_descriptor,
        MAX_POOL_AUXILIARY_PARENTS, MAX_POOL_RECIPE_RAW_BYTES,
        MAX_POOL_RECIPE_SERIALIZED_BYTES, MAX_STANDARD_FTLP_INPUTS,
    },
};
use tbc_sdk::{
    Address, OutPoint, Transaction, TxIn, TxOut, Txid,
    contracts::{
        ft::{
            amount::{balance_from_tape, build_tape_amount},
            partial_sha256::calculate_partial_hash,
            scripts::transfer_tape_script,
            unlock::classify_ft_script,
        },
        pool_nft_v2::{
            FtlpCodeParams, FtlpTapeLayout, FtlpTapeParams, FtScriptVersion, PoolState,
            ftlp_code, ftlp_lock_time_code, ftlp_tape, pool_held_ft_code, pool_tape,
            scripts::transfer_ftlp_code_script,
        },
    },
    hash, script::Script,
};

const OWNER_PUBLIC_KEY: &str =
    "031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";
const OWNER_PUBLIC_KEY_HASH: &str = "79b000887626b294a914501a4cd226b58b235983";
const OWNER_ADDRESS: &str = "1C6Rc3w25VHud3dLDamutaqfKWqhrLRTaD";
const OWNER_SCRIPT: &str = "76a91479b000887626b294a914501a4cd226b58b23598388ac";
const LOCKED_FTLP_INPUT_LIMIT: usize = 6;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/pool-signing-recipes.json")).unwrap()
}

fn vector(name: &str) -> Value {
    fixture()["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["name"] == name)
        .unwrap()
        .clone()
}

fn public_context() -> PublicSigningContext {
    PublicSigningContext {
        address: OWNER_ADDRESS.to_owned(),
        public_key: OWNER_PUBLIC_KEY.to_owned(),
        public_key_hash: OWNER_PUBLIC_KEY_HASH.to_owned(),
    }
}

fn raw_source(value: &Value, field: &str) -> TransactionSource {
    TransactionSource::Raw(value[field].as_str().unwrap().to_owned())
}

fn proofs(value: &Value) -> Vec<ProofReference> {
    value["proofRaws"]
        .as_array()
        .unwrap()
        .iter()
        .map(|raw| ProofReference {
            source: TransactionSource::Raw(raw.as_str().unwrap().to_owned()),
            output_index: 0,
        })
        .collect()
}

fn planned_from_tx(id: &str, stage: u32, depends_on: Vec<String>, tx: &Transaction) -> PlannedTransaction {
    PlannedTransaction {
        transaction_id: id.to_owned(),
        role: "primary".to_owned(),
        stage,
        depends_on,
        version: tx.version,
        inputs: tx
            .inputs
            .iter()
            .map(|input| PlannedInput {
                previous_transaction_id: input.previous_output.txid.to_string(),
                previous_output_index: input.previous_output.vout,
                previous_output_script: OWNER_SCRIPT.to_owned(),
                previous_output_satoshis: 1_000,
                sequence: input.sequence,
                unlocking_script: String::new(),
                signer: public_context(),
            })
            .collect(),
        outputs: tx
            .outputs
            .iter()
            .map(|output| PlannedOutput {
                satoshis: output.satoshis,
                locking_script: hex(output.script_pubkey.as_bytes()),
            })
            .collect(),
        lock_time: tx.lock_time,
    }
}

fn pool_recipe(value: &Value) -> PoolUnlockRecipe {
    PoolUnlockRecipe {
        parent: raw_source(value, "parentRaw"),
        pre_parent: raw_source(value, "preParentRaw"),
        contract: raw_source(value, "contractRaw").into(),
        auxiliary_parents: value["auxiliaryParentRaws"]
            .as_array()
            .unwrap()
            .iter()
            .map(|raw| TransactionSource::Raw(raw.as_str().unwrap().to_owned()))
            .collect(),
        spent_vout: 0,
        operation: PoolRecipeOperation::Swap,
        swap: Some(PoolRecipeSwap::TbcToFt),
        with_lock: value["withLock"].as_bool().unwrap(),
        service_provider: "source-fixture".to_owned(),
        public_key_lock: value["publicKeyLock"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| key.as_str().unwrap().to_owned())
            .collect(),
    }
}

fn pool_held_ft_recipe(value: &Value) -> PoolHeldFtUnlockRecipe {
    PoolHeldFtUnlockRecipe {
        parent: raw_source(value, "parentRaw"),
        proof_references: proofs(value),
        contract: raw_source(value, "contractRaw"),
        ft_version: value["ftVersion"].as_u64().unwrap() as u8,
        coin_mode: value["coinMode"].as_bool().unwrap(),
        logical_swap_input_index: value["logicalSwapInputIndex"].as_u64().unwrap() as u8,
    }
}

fn assert_pool_held_ft_recipe_rejected(
    value: &Value,
    recipe: PoolHeldFtUnlockRecipe,
    message: &str,
) {
    let descriptor = pool_held_ft_unlocking_descriptor(recipe).unwrap();
    let error = begin_signing(&single_recipe_plan(value, descriptor)).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(error.message, message);
}

fn ftlp_plan(value: &Value, count: usize, lock: FtlpLockMode) -> UnsignedPlan {
    let current = Transaction::from_hex(value["currentRaw"].as_str().unwrap()).unwrap();
    let base_parent = Transaction::from_hex(value["parentRaw"].as_str().unwrap()).unwrap();
    let base_proof = Transaction::from_hex(value["proofRaws"][0].as_str().unwrap()).unwrap();
    let mut planned = planned_from_tx("ftlp", 0, vec![], &current);
    planned.inputs.clear();
    for index in 0..count {
        let mut proof = base_proof.clone();
        proof.inputs[0].previous_output.txid = Txid::from_le_bytes([0x90 + index as u8; 32]);
        let mut parent = base_parent.clone();
        parent.inputs[0].previous_output.txid = proof.txid();
        let descriptor = ftlp_unlocking_descriptor(FtlpUnlockRecipe {
            parent: TransactionSource::Raw(parent.to_hex()),
            proof_references: vec![ProofReference {
                source: TransactionSource::Raw(proof.to_hex()),
                output_index: 0,
            }],
            lock,
            ordered_input_index: index as u8,
            ordered_input_count: count as u8,
        })
        .unwrap();
        planned.inputs.push(PlannedInput {
            previous_transaction_id: parent.txid().to_string(),
            previous_output_index: 0,
            previous_output_script: hex(parent.outputs[0].script_pubkey.as_bytes()),
            previous_output_satoshis: parent.outputs[0].satoshis,
            sequence: match lock {
                FtlpLockMode::Standard => tbc_sdk::DEFAULT_SEQUENCE,
                FtlpLockMode::BlockHeight { .. } => tbc_sdk::DEFAULT_SEQUENCE - 1,
            },
            unlocking_script: descriptor,
            signer: public_context(),
        });
    }
    UnsignedPlan { transactions: vec![planned], evidence_table: vec![] }
}

fn pool_plan(value: &Value, recipe: PoolUnlockRecipe) -> UnsignedPlan {
    let current = Transaction::from_hex(value["currentRaw"].as_str().unwrap()).unwrap();
    let parent = Transaction::from_hex(value["parentRaw"].as_str().unwrap()).unwrap();
    let auxiliary = value["auxiliaryParentRaws"].as_array().unwrap();
    let mut planned = planned_from_tx("pool", 0, vec![], &current);
    planned.inputs[0].previous_output_script = hex(parent.outputs[0].script_pubkey.as_bytes());
    planned.inputs[0].previous_output_satoshis = parent.outputs[0].satoshis;
    planned.inputs[0].unlocking_script = pool_unlocking_descriptor(recipe).unwrap();
    for (index, raw) in auxiliary.iter().enumerate() {
        let parent = Transaction::from_hex(raw.as_str().unwrap()).unwrap();
        let vout = current.inputs[index + 1].previous_output.vout as usize;
        planned.inputs[index + 1].previous_output_satoshis = parent.outputs[vout].satoshis;
    }
    UnsignedPlan { transactions: vec![planned], evidence_table: vec![] }
}

fn single_recipe_plan(value: &Value, descriptor: String) -> UnsignedPlan {
    let current = Transaction::from_hex(value["currentRaw"].as_str().unwrap()).unwrap();
    let parent = Transaction::from_hex(value["parentRaw"].as_str().unwrap()).unwrap();
    let mut planned = planned_from_tx("primary", 0, vec![], &current);
    let input_index = value["inputIndex"].as_u64().unwrap_or(0) as usize;
    planned.inputs[input_index].previous_output_script = hex(parent.outputs[0].script_pubkey.as_bytes());
    planned.inputs[input_index].previous_output_satoshis = parent.outputs[0].satoshis;
    planned.inputs[input_index].unlocking_script = descriptor;
    UnsignedPlan { transactions: vec![planned], evidence_table: vec![] }
}

fn fixed_signature(request: &SigningRequest, value: &Value, field: &str) -> ExternalSignature {
    let with_sighash = decode_hex(value[field].as_str().unwrap());
    assert_eq!(with_sighash.last(), Some(&(tbc_sdk::DEFAULT_SIGHASH as u8)));
    ExternalSignature {
        session_id: request.session_id.clone(),
        stage: request.stage,
        stage_commitment: request.stage_commitment.clone(),
        transaction_id: request.transaction_id.clone(),
        input_index: request.input_index,
        digest: request.digest.clone(),
        public_key: value["publicKey"].as_str().unwrap().to_owned(),
        signature: hex(&with_sighash[..with_sighash.len() - 1]),
    }
}

fn dynamic_signature(request: &SigningRequest) -> ExternalSignature {
    let secp = Secp256k1::new();
    let secret = SecretKey::from_byte_array([1; 32]).unwrap();
    let digest: [u8; 32] = decode_hex(&request.digest).try_into().unwrap();
    let signature = secp
        .sign_ecdsa(Message::from_digest(digest), &secret)
        .serialize_der();
    ExternalSignature {
        session_id: request.session_id.clone(),
        stage: request.stage,
        stage_commitment: request.stage_commitment.clone(),
        transaction_id: request.transaction_id.clone(),
        input_index: request.input_index,
        digest: request.digest.clone(),
        public_key: hex(&SecpPublicKey::from_secret_key(&secp, &secret).serialize()),
        signature: hex(&signature),
    }
}

fn complete(plan: &UnsignedPlan, value: &Value, fixed_input: u32) -> Transaction {
    let stage = begin_signing(plan).unwrap();
    let signatures = stage
        .signing_requests
        .iter()
        .map(|request| {
            if request.input_index == fixed_input {
                fixed_signature(request, value, "signatureWithSighash")
            } else {
                dynamic_signature(request)
            }
        })
        .collect::<Vec<_>>();
    let StageOutcome::Complete(bundle) = finalize_signing_stage(plan, stage, &signatures).unwrap()
    else {
        panic!("expected complete stage")
    };
    Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap()
}

fn pending_pool_held_stage(value: &Value) -> (UnsignedPlan, tbc_engine_core::signing::SigningStage, usize) {
    let descriptor = pool_held_ft_unlocking_descriptor(pool_held_ft_recipe(value)).unwrap();
    let mut plan = single_recipe_plan(value, descriptor);
    let input_index = value["inputIndex"].as_u64().unwrap() as usize;
    plan.transactions[0].transaction_id = "recipe-parent".to_owned();
    plan.transactions[0].outputs[0].locking_script = OWNER_SCRIPT.to_owned();
    let parent_output = plan.transactions[0].outputs[0].clone();
    let child = PlannedTransaction {
        transaction_id: "recipe-child".to_owned(),
        role: "child".to_owned(),
        stage: 1,
        depends_on: vec!["recipe-parent".to_owned()],
        version: tbc_sdk::TX_VERSION,
        inputs: vec![PlannedInput {
            previous_transaction_id: "recipe-parent".to_owned(),
            previous_output_index: 0,
            previous_output_script: parent_output.locking_script,
            previous_output_satoshis: parent_output.satoshis,
            sequence: tbc_sdk::DEFAULT_SEQUENCE,
            unlocking_script: String::new(),
            signer: public_context(),
        }],
        outputs: vec![PlannedOutput { satoshis: 100, locking_script: OWNER_SCRIPT.to_owned() }],
        lock_time: 0,
    };
    plan.transactions.push(child);
    let first = begin_signing(&plan).unwrap();
    let signatures = first.signing_requests.iter().map(dynamic_signature).collect::<Vec<_>>();
    let StageOutcome::Pending(second) = finalize_signing_stage(&plan, first, &signatures).unwrap()
    else {
        panic!("expected second stage")
    };
    (plan, second, input_index)
}

fn tamper_finalized_pool_held_script(
    value: &Value,
    mutate: impl FnOnce(&mut Vec<u8>),
) -> String {
    let (plan, mut stage, input_index) = pending_pool_held_stage(value);
    let record = stage.continuation.finalized_transactions[0].as_mut().unwrap();
    let mut transaction = Transaction::from_hex(&record.raw_transaction).unwrap();
    let mut script = transaction.inputs[input_index].script_sig.as_bytes().to_vec();
    mutate(&mut script);
    transaction.inputs[input_index].script_sig = Script::from_bytes(script);
    record.txid = transaction.txid().to_string();
    record.raw_transaction = transaction.to_hex();
    finalize_signing_stage(&plan, stage, &[]).unwrap_err().message
}

fn assert_fixture_hash(value: &Value) {
    let expected = decode_hex(value["expectedUnlockHex"].as_str().unwrap());
    assert_eq!(
        hex(&Sha256::digest(&expected)),
        value["expectedByteHash"].as_str().unwrap()
    );
}

#[test]
fn standard_large_pool_is_unsigned_and_materializes_source_exactly() {
    let value = vector("standard-large-pool");
    assert_fixture_hash(&value);
    let plan = pool_plan(&value, pool_recipe(&value));
    let stage = begin_signing(&plan).unwrap();
    assert!(stage.signing_requests.iter().all(|request| request.input_index != 0));
    let signatures = stage.signing_requests.iter().map(dynamic_signature).collect::<Vec<_>>();
    let StageOutcome::Complete(bundle) = finalize_signing_stage(&plan, stage, &signatures).unwrap()
    else { panic!("expected complete") };
    let transaction = Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap();
    assert_eq!(
        hex(transaction.inputs[0].script_sig.as_bytes()),
        value["expectedUnlockHex"].as_str().unwrap()
    );
}

#[test]
fn locked_pool_swap_has_one_ordered_external_request_and_source_exact_bytes() {
    let value = vector("locked-pool-swap");
    let plan = pool_plan(&value, pool_recipe(&value));
    let stage = begin_signing(&plan).unwrap();
    assert_eq!(
        stage.signing_requests.iter().filter(|request| request.input_index == 0).count(),
        1
    );
    let transaction = complete(&plan, &value, 0);
    assert_eq!(
        hex(transaction.inputs[0].script_sig.as_bytes()),
        value["expectedUnlockHex"].as_str().unwrap()
    );
}

#[test]
fn pool_held_ft_swap_layout_matches_both_released_directions() {
    for name in ["tbc-to-ft-pool-held-ft-v3", "ft-to-tbc-pool-held-ft-v2-coin"] {
        let value = vector(name);
        assert_fixture_hash(&value);
        let descriptor = pool_held_ft_unlocking_descriptor(pool_held_ft_recipe(&value)).unwrap();
        let plan = single_recipe_plan(&value, descriptor);
        let input_index = value["inputIndex"].as_u64().unwrap() as usize;
        let transaction = complete(&plan, &value, input_index as u32);
        assert_eq!(
            hex(transaction.inputs[input_index].script_sig.as_bytes()),
            value["expectedUnlockHex"].as_str().unwrap(),
            "{name}"
        );
    }
}

#[test]
fn pool_held_ft_contract_is_authenticated_by_the_transaction_pool_input() {
    let value = vector("tbc-to-ft-pool-held-ft-v3");
    let mut recipe = pool_held_ft_recipe(&value);
    recipe.contract = TransactionSource::Raw(value["proofRaws"][0].as_str().unwrap().to_owned());
    assert_pool_held_ft_recipe_rejected(
        &value,
        recipe,
        "Pool-held FT contract does not match the transaction Pool input",
    );
}

#[test]
fn pool_held_ft_version_is_derived_from_the_authenticated_parent_covenant() {
    let value = vector("tbc-to-ft-pool-held-ft-v3");
    let mut recipe = pool_held_ft_recipe(&value);
    recipe.ft_version = 4;
    assert_pool_held_ft_recipe_rejected(
        &value,
        recipe,
        "Pool-held FT version does not match authenticated parent covenant",
    );
}

#[test]
fn pool_held_ft_coin_mode_is_derived_from_the_authenticated_parent_covenant() {
    let value = vector("tbc-to-ft-pool-held-ft-v3");
    let mut recipe = pool_held_ft_recipe(&value);
    recipe.coin_mode = true;
    assert_pool_held_ft_recipe_rejected(
        &value,
        recipe,
        "Pool-held FT coin mode does not match authenticated parent covenant",
    );
}

#[test]
fn pool_held_ft_logical_index_is_derived_from_absolute_recipe_order() {
    let value = vector("tbc-to-ft-pool-held-ft-v3");
    let mut recipe = pool_held_ft_recipe(&value);
    recipe.logical_swap_input_index = 1;
    assert_pool_held_ft_recipe_rejected(
        &value,
        recipe,
        "Pool-held FT logical swap input index does not match ordered input",
    );
}

#[test]
fn pool_held_ft_second_logical_index_requires_a_preceding_ordered_recipe_input() {
    let first = vector("tbc-to-ft-pool-held-ft-v3");
    let second = vector("ft-to-tbc-pool-held-ft-v2-coin");
    assert_eq!(first["contractRaw"], second["contractRaw"]);
    let contract = Transaction::from_hex(first["contractRaw"].as_str().unwrap()).unwrap();
    let first_parent = Transaction::from_hex(first["parentRaw"].as_str().unwrap()).unwrap();
    let second_parent = Transaction::from_hex(second["parentRaw"].as_str().unwrap()).unwrap();
    let mut second_recipe = pool_held_ft_recipe(&second);
    second_recipe.logical_swap_input_index = 1;
    let descriptors = [
        pool_held_ft_unlocking_descriptor(pool_held_ft_recipe(&first)).unwrap(),
        pool_held_ft_unlocking_descriptor(second_recipe).unwrap(),
    ];
    let planned_input = |parent: &Transaction, descriptor: String| PlannedInput {
        previous_transaction_id: parent.txid().to_string(),
        previous_output_index: 0,
        previous_output_script: hex(parent.outputs[0].script_pubkey.as_bytes()),
        previous_output_satoshis: parent.outputs[0].satoshis,
        sequence: tbc_sdk::DEFAULT_SEQUENCE,
        unlocking_script: descriptor,
        signer: public_context(),
    };
    let plan = UnsignedPlan {
        transactions: vec![PlannedTransaction {
            transaction_id: "ordered-pool-ft".to_owned(),
            role: "primary".to_owned(),
            stage: 0,
            depends_on: vec![],
            version: tbc_sdk::TX_VERSION,
            inputs: vec![
                PlannedInput {
                    previous_transaction_id: contract.txid().to_string(),
                    previous_output_index: 0,
                    previous_output_script: OWNER_SCRIPT.to_owned(),
                    previous_output_satoshis: contract.outputs[0].satoshis,
                    sequence: tbc_sdk::DEFAULT_SEQUENCE,
                    unlocking_script: String::new(),
                    signer: public_context(),
                },
                planned_input(&first_parent, descriptors[0].clone()),
                planned_input(&second_parent, descriptors[1].clone()),
            ],
            outputs: vec![PlannedOutput { satoshis: 100, locking_script: OWNER_SCRIPT.to_owned() }],
            lock_time: 0,
        }],
        evidence_table: vec![],
    };

    let stage = begin_signing(&plan).unwrap();
    assert_eq!(stage.signing_requests.len(), 3);
    assert_eq!(stage.signing_requests[1].input_index, 1);
    assert_eq!(stage.signing_requests[2].input_index, 2);

    let mut gapped = plan;
    let mut fee = gapped.transactions[0].inputs[0].clone();
    fee.previous_transaction_id = "84".repeat(32);
    fee.previous_output_index = 4;
    fee.unlocking_script.clear();
    gapped.transactions[0].inputs.insert(1, fee);
    assert_eq!(
        begin_signing(&gapped).unwrap_err().message,
        "Pool-held FT logical swap input index does not match ordered input"
    );
}

#[test]
fn standard_and_locked_ftlp_insert_external_signatures_and_enforce_lock_domain() {
    for name in ["standard-ftlp", "locked-ftlp-height"] {
        let value = vector(name);
        let lock = if value["locked"].as_bool().unwrap() {
            FtlpLockMode::BlockHeight {
                lock_height: value["lockHeight"].as_u64().unwrap() as u32,
                current_height: value["currentHeight"].as_u64().unwrap() as u32,
            }
        } else {
            FtlpLockMode::Standard
        };
        let descriptor = ftlp_unlocking_descriptor(FtlpUnlockRecipe {
            parent: raw_source(&value, "parentRaw"),
            proof_references: proofs(&value),
            lock,
            ordered_input_index: 0,
            ordered_input_count: 1,
        })
        .unwrap();
        let plan = single_recipe_plan(&value, descriptor);
        let transaction = complete(&plan, &value, 0);
        assert_eq!(
            hex(transaction.inputs[0].script_sig.as_bytes()),
            value["expectedUnlockHex"].as_str().unwrap(),
            "{name}"
        );
    }

    let value = vector("locked-ftlp-height");
    let descriptor = ftlp_unlocking_descriptor(FtlpUnlockRecipe {
        parent: raw_source(&value, "parentRaw"),
        proof_references: proofs(&value),
        lock: FtlpLockMode::BlockHeight { lock_height: 90, current_height: 500_000_000 },
        ordered_input_index: 0,
        ordered_input_count: 1,
    })
    .unwrap();
    assert_eq!(
        begin_signing(&single_recipe_plan(&value, descriptor)).unwrap_err().code,
        ErrorCode::InvalidPlan
    );
}

#[test]
fn ftlp_inputs_must_start_at_absolute_transaction_input_zero() {
    let value = vector("standard-ftlp");
    let descriptor = ftlp_unlocking_descriptor(FtlpUnlockRecipe {
        parent: raw_source(&value, "parentRaw"),
        proof_references: proofs(&value),
        lock: FtlpLockMode::Standard,
        ordered_input_index: 0,
        ordered_input_count: 1,
    })
    .unwrap();
    let mut plan = single_recipe_plan(&value, descriptor);
    let mut fee = plan.transactions[0].inputs[0].clone();
    fee.previous_transaction_id = "81".repeat(32);
    fee.previous_output_index = 7;
    fee.previous_output_script = OWNER_SCRIPT.to_owned();
    fee.unlocking_script.clear();
    plan.transactions[0].inputs.insert(0, fee);

    let error = begin_signing(&plan).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(error.message, "FTLP inputs must occupy the absolute transaction prefix");
}

#[test]
fn ftlp_inputs_must_not_be_interleaved_with_non_ftlp_inputs() {
    let value = vector("locked-ftlp-height");
    let mut proof = Transaction::from_hex(value["proofRaws"][0].as_str().unwrap()).unwrap();
    proof.inputs[0].previous_output.txid = Txid::from_le_bytes([0x82; 32]);
    let mut parent = Transaction::from_hex(value["parentRaw"].as_str().unwrap()).unwrap();
    parent.inputs[0].previous_output.txid = proof.txid();

    let descriptor = |parent: TransactionSource,
                      proof: TransactionSource,
                      ordered_input_index| {
        ftlp_unlocking_descriptor(FtlpUnlockRecipe {
            parent,
            proof_references: vec![ProofReference { source: proof, output_index: 0 }],
            lock: FtlpLockMode::BlockHeight { lock_height: 90, current_height: 100 },
            ordered_input_index,
            ordered_input_count: 2,
        })
        .unwrap()
    };
    let first = descriptor(
        raw_source(&value, "parentRaw"),
        TransactionSource::Raw(value["proofRaws"][0].as_str().unwrap().to_owned()),
        0,
    );
    let second = descriptor(
        TransactionSource::Raw(parent.to_hex()),
        TransactionSource::Raw(proof.to_hex()),
        1,
    );
    let mut plan = single_recipe_plan(&value, first);
    let mut fee = plan.transactions[0].inputs[0].clone();
    fee.previous_transaction_id = "83".repeat(32);
    fee.previous_output_index = 9;
    fee.previous_output_script = OWNER_SCRIPT.to_owned();
    fee.unlocking_script.clear();
    let mut second_input = plan.transactions[0].inputs[0].clone();
    second_input.previous_transaction_id = parent.txid().to_string();
    second_input.previous_output_index = 0;
    second_input.previous_output_script = hex(parent.outputs[0].script_pubkey.as_bytes());
    second_input.previous_output_satoshis = parent.outputs[0].satoshis;
    second_input.unlocking_script = second;
    plan.transactions[0].inputs.push(fee);
    plan.transactions[0].inputs.push(second_input);

    let error = begin_signing(&plan).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(error.message, "FTLP inputs must occupy the absolute transaction prefix");
}

fn unique_ftlp_candidate_plan(
    value: &Value,
    candidate_count: u8,
    transaction_id: &str,
    role: &str,
    lock: FtlpLockMode,
) -> UnsignedPlan {
    let base_parent = Transaction::from_hex(value["parentRaw"].as_str().unwrap()).unwrap();
    let base_proof = Transaction::from_hex(value["proofRaws"][0].as_str().unwrap()).unwrap();
    let mut candidates = Vec::new();
    for index in 0..candidate_count {
        let mut proof = base_proof.clone();
        proof.inputs[0].previous_output.txid = Txid::from_le_bytes([0x90 + index; 32]);
        let mut parent = base_parent.clone();
        parent.inputs[0].previous_output.txid = proof.txid();
        let descriptor = ftlp_unlocking_descriptor(FtlpUnlockRecipe {
            parent: TransactionSource::Raw(parent.to_hex()),
            proof_references: vec![ProofReference {
                source: TransactionSource::Raw(proof.to_hex()),
                output_index: 0,
            }],
            lock: lock.clone(),
            ordered_input_index: index,
            ordered_input_count: candidate_count,
        })
        .unwrap();
        let mut input = single_recipe_plan(&value, descriptor).transactions.remove(0).inputs.remove(0);
        input.previous_transaction_id = parent.txid().to_string();
        input.previous_output_index = 0;
        input.previous_output_script = hex(parent.outputs[0].script_pubkey.as_bytes());
        input.previous_output_satoshis = parent.outputs[0].satoshis;
        candidates.push(input);
    }
    assert_eq!(
        candidates
            .iter()
            .map(|input| (&input.previous_transaction_id, input.previous_output_index))
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        usize::from(candidate_count),
    );
    let mut plan = single_recipe_plan(&value, candidates[0].unlocking_script.clone());
    plan.transactions[0].transaction_id = transaction_id.to_owned();
    plan.transactions[0].role = role.to_owned();
    plan.transactions[0].inputs = candidates;
    plan
}

fn base_semantic_ftlp_maintenance_plan(
    value: &Value,
    candidate_count: u8,
    lock: FtlpLockMode,
) -> UnsignedPlan {
    let mut plan = unique_ftlp_candidate_plan(
        value,
        candidate_count,
        "ftlp-merge-0",
        "maintenance",
        lock.clone(),
    );
    let parent = Transaction::from_hex(value["parentRaw"].as_str().unwrap()).unwrap();
    let balance = balance_from_tape(&parent.outputs[1].script_pubkey).unwrap();
    let balances = vec![balance; usize::from(candidate_count)];
    let total = balances.iter().copied().sum::<u128>();
    let (merged_amount, _) = build_tape_amount(total, &balances).unwrap();
    let tape_base = match lock {
        FtlpLockMode::Standard => parent.outputs[1].script_pubkey.clone(),
        FtlpLockMode::BlockHeight { current_height, .. } => {
            plan.transactions[0].lock_time = current_height;
            ftlp_tape(&FtlpTapeParams {
                amount_raw: 0,
                layout: FtlpTapeLayout::LockTime {
                    lock_time: 0,
                    source_ft_tape_size: parent.outputs[1].script_pubkey.as_bytes().len(),
                },
            })
            .unwrap()
        }
    };
    for input in &mut plan.transactions[0].inputs {
        input.sequence = match lock {
            FtlpLockMode::Standard => tbc_sdk::DEFAULT_SEQUENCE,
            FtlpLockMode::BlockHeight { .. } => tbc_sdk::DEFAULT_SEQUENCE - 1,
        };
    }
    let fee_satoshis = 100_000u64;
    plan.transactions[0].inputs.push(PlannedInput {
        previous_transaction_id: Txid::from_le_bytes([0x77; 32]).to_string(),
        previous_output_index: 0,
        previous_output_script: OWNER_SCRIPT.to_owned(),
        previous_output_satoshis: fee_satoshis,
        sequence: tbc_sdk::DEFAULT_SEQUENCE,
        unlocking_script: String::new(),
        signer: public_context(),
    });
    let input_satoshis = u64::from(candidate_count)
        .checked_mul(parent.outputs[0].satoshis)
        .unwrap()
        .checked_add(fee_satoshis)
        .unwrap();
    plan.transactions[0].outputs = vec![
        PlannedOutput {
            satoshis: parent.outputs[0].satoshis,
            locking_script: hex(parent.outputs[0].script_pubkey.as_bytes()),
        },
        PlannedOutput {
            satoshis: 0,
            locking_script: hex(
                transfer_tape_script(&tape_base, &merged_amount)
                    .unwrap()
                    .as_bytes(),
            ),
        },
        PlannedOutput {
            satoshis: tbc_sdk::SDK_DUST_SAT,
            locking_script: OWNER_SCRIPT.to_owned(),
        },
    ];
    let fee = independent_ftlp_maintenance_fee(&plan.transactions[0]);
    plan.transactions[0].outputs[2].satoshis = input_satoshis
        .checked_sub(parent.outputs[0].satoshis)
        .unwrap()
        .checked_sub(fee)
        .unwrap();
    plan
}

fn compact_size_len(value: usize) -> usize {
    match value {
        0..=0xfc => 1,
        0xfd..=0xffff => 3,
        0x1_0000..=0xffff_ffff => 5,
        _ => 9,
    }
}

fn independent_ftlp_maintenance_fee(transaction: &PlannedTransaction) -> u64 {
    const FEE_RATE: u64 = 80;
    const MAX_SCRIPT_SIG_BYTES: usize = 108;
    let input_count = transaction.inputs.len();
    let output_count = 3usize;
    let base_outputs = &transaction.outputs[..2];
    let size = 4usize
        + compact_size_len(input_count)
        + input_count * 41
        + compact_size_len(output_count)
        + base_outputs
            .iter()
            .map(|output| {
                let script_len = decode_hex(&output.locking_script).len();
                8 + compact_size_len(script_len) + script_len
            })
            .sum::<usize>()
        + 34
        + 4;
    let signed_upper_bound = size + input_count * MAX_SCRIPT_SIG_BYTES;
    u64::try_from(signed_upper_bound)
        .unwrap()
        .checked_mul(FEE_RATE)
        .unwrap()
        .div_ceil(1_000)
        .max(FEE_RATE)
}

#[derive(Clone)]
struct FtlpAuthorityFixture {
    pool: Value,
    pool_hash: [u8; 32],
    version: FtScriptVersion,
    is_coin: bool,
    tape_size: usize,
    locked: bool,
}

fn ftlp_authority_fixture(locked: bool) -> FtlpAuthorityFixture {
    let mut pool = vector(if locked { "locked-pool-swap" } else { "standard-large-pool" });
    let mut parent = Transaction::from_hex(pool["parentRaw"].as_str().unwrap()).unwrap();
    let mut pre_parent =
        Transaction::from_hex(pool["preParentRaw"].as_str().unwrap()).unwrap();
    let contract = Transaction::from_hex(pool["contractRaw"].as_str().unwrap()).unwrap();
    let mut state = PoolState::from_v2_tape(
        &parent.outputs[1].script_pubkey,
        "source-fixture".to_owned(),
    )
    .unwrap();
    assert_eq!(contract.txid(), state.ft_a_contract_id);
    let mut authority = Vec::new();
    for (code_vout, tape_vout) in [(0usize, 1usize), (3usize, 4usize)] {
        let (Some(code), Some(tape)) = (
            contract.outputs.get(code_vout),
            contract.outputs.get(tape_vout),
        ) else {
            continue;
        };
        let Ok(classified) = classify_ft_script(&code.script_pubkey) else {
            continue;
        };
        if tape.satoshis == 0
            && ((!classified.is_coin && (code_vout, tape_vout) == (0, 1))
                || (classified.is_coin && (code_vout, tape_vout) == (3, 4)))
        {
            authority.push((classified, code_vout, tape.script_pubkey.as_bytes().len()));
        }
    }
    assert_eq!(authority.len(), 1, "fixture must expose one released FT authority");
    let (classified, code_vout, tape_size) = authority[0];
    let authority_code = &contract.outputs[code_vout].script_pubkey;
    let partial_end = authority_code.as_bytes().len().checked_sub(28).unwrap();
    state.ft_a_partial_hash =
        calculate_partial_hash(&authority_code.as_bytes()[..partial_end]).to_vec();
    state.ftlp_lock_time_enabled = locked;
    let owner = Address::from_string(OWNER_ADDRESS).unwrap();
    let ftlp_params = FtlpCodeParams {
        tape_size,
        ft_version: match classified.version {
            1 => FtScriptVersion::V1,
            2 => FtScriptVersion::V2,
            3 => FtScriptVersion::V3,
            4 => FtScriptVersion::V4,
            _ => panic!("unsupported fixture FT version"),
        },
        is_coin: classified.is_coin,
    };
    let released_ftlp_code = if locked {
        ftlp_lock_time_code(
            hash::sha256(parent.outputs[0].script_pubkey.as_bytes()),
            &owner,
            &ftlp_params,
        )
        .unwrap()
    } else {
        ftlp_code(
            hash::sha256(parent.outputs[0].script_pubkey.as_bytes()),
            &owner,
            &ftlp_params,
        )
        .unwrap()
    };
    let ftlp_partial_end = released_ftlp_code
        .as_bytes()
        .len()
        .checked_sub(28)
        .unwrap();
    state.ft_lp_partial_hash = calculate_partial_hash(
        &released_ftlp_code.as_bytes()[..ftlp_partial_end],
    )
    .to_vec();
    let mut prior_state = PoolState::from_v2_tape(
        &pre_parent.outputs[1].script_pubkey,
        "source-fixture".to_owned(),
    )
    .unwrap();
    prior_state.ft_lp_partial_hash = state.ft_lp_partial_hash.clone();
    prior_state.ft_a_contract_id = state.ft_a_contract_id;
    prior_state.ft_a_partial_hash = state.ft_a_partial_hash.clone();
    prior_state.service_fee_rate = state.service_fee_rate;
    prior_state.lp_plan = state.lp_plan;
    prior_state.public_key_locked = state.public_key_locked;
    prior_state.ftlp_lock_time_enabled = state.ftlp_lock_time_enabled;
    pre_parent.outputs[1].script_pubkey = pool_tape(&prior_state).unwrap();
    parent.inputs[0].previous_output.txid = pre_parent.txid();
    parent.outputs[1].script_pubkey = pool_tape(&state).unwrap();
    pool["preParentRaw"] = serde_json::json!(pre_parent.to_hex());
    pool["parentRaw"] = serde_json::json!(parent.to_hex());
    let version = match classified.version {
        1 => FtScriptVersion::V1,
        2 => FtScriptVersion::V2,
        3 => FtScriptVersion::V3,
        4 => FtScriptVersion::V4,
        _ => panic!("unsupported fixture FT version"),
    };
    FtlpAuthorityFixture {
        pool,
        pool_hash: hash::sha256(parent.outputs[0].script_pubkey.as_bytes()),
        version,
        is_coin: classified.is_coin,
        tape_size,
        locked,
    }
}

fn authority_code(
    authority: &FtlpAuthorityFixture,
    owner: &Address,
    pool_hash: [u8; 32],
    version: FtScriptVersion,
    is_coin: bool,
    tape_size: usize,
) -> Script {
    let params = FtlpCodeParams { tape_size, ft_version: version, is_coin };
    if authority.locked {
        ftlp_lock_time_code(pool_hash, owner, &params).unwrap()
    } else {
        ftlp_code(pool_hash, owner, &params).unwrap()
    }
}

fn replace_maintenance_codes(plan: &mut UnsignedPlan, replacement: &Script) {
    let maintenance_id = plan.transactions[0].transaction_id.clone();
    {
        let transaction = &mut plan.transactions[0];
        let recipe_count = transaction.inputs.len() - 1;
        for input in &mut transaction.inputs[..recipe_count] {
            let mut recipe = decoded_ftlp_recipe(input);
            let TransactionSource::Raw(parent_raw) = &recipe.parent else {
                panic!("round-zero FTLP parent must be raw")
            };
            let mut parent = Transaction::from_hex(parent_raw).unwrap();
            parent.outputs[0].script_pubkey = replacement.clone();
            recipe.parent = TransactionSource::Raw(parent.to_hex());
            input.previous_transaction_id = parent.txid().to_string();
            input.previous_output_script = hex(replacement.as_bytes());
            replace_ftlp_recipe(input, recipe);
        }
        transaction.outputs[0].locking_script = hex(replacement.as_bytes());
    }
    for transaction in &mut plan.transactions[1..] {
        for input in &mut transaction.inputs {
            if input.previous_transaction_id == maintenance_id && input.previous_output_index == 0 {
                input.previous_output_script = hex(replacement.as_bytes());
            }
        }
    }
}

fn fixture_parent(nonce: u8, outputs: Vec<TxOut>) -> Transaction {
    let mut parent = Transaction::new();
    parent.inputs.push(TxIn::new(OutPoint {
        txid: Txid::from_le_bytes([nonce; 32]),
        vout: 0,
    }));
    parent.outputs = outputs;
    parent
}

fn authority_bound_ftlp_maintenance_plan(
    candidate_count: u8,
    lock: FtlpLockMode,
) -> (UnsignedPlan, FtlpAuthorityFixture) {
    let locked = matches!(lock, FtlpLockMode::BlockHeight { .. });
    let source = vector(if locked { "locked-ftlp-height" } else { "standard-ftlp" });
    let mut plan = base_semantic_ftlp_maintenance_plan(&source, candidate_count, lock);
    let authority = ftlp_authority_fixture(locked);
    let owner = Address::from_string(OWNER_ADDRESS).unwrap();
    let expected = authority_code(
        &authority,
        &owner,
        authority.pool_hash,
        authority.version,
        authority.is_coin,
        authority.tape_size,
    );
    replace_maintenance_codes(&mut plan, &expected);

    let pool_parent = Transaction::from_hex(authority.pool["parentRaw"].as_str().unwrap()).unwrap();
    let pool_pre_parent = authority.pool["preParentRaw"].as_str().unwrap().to_owned();
    let contract = authority.pool["contractRaw"].as_str().unwrap().to_owned();
    let contract_tx = Transaction::from_hex(&contract).unwrap();
    let (authority_code, authority_tape) = [(0usize, 1usize), (3usize, 4usize)]
        .into_iter()
        .find_map(|(code_vout, tape_vout)| {
            let code = contract_tx.outputs.get(code_vout)?;
            let tape = contract_tx.outputs.get(tape_vout)?;
            classify_ft_script(&code.script_pubkey)
                .is_ok_and(|classified| classified.is_coin == authority.is_coin)
                .then(|| (code.clone(), tape.clone()))
        })
        .expect("authority contract contains one matching released FT Code/Tape pair");
    let owner_script = Script::from_bytes(decode_hex(OWNER_SCRIPT));
    let pool_ft_proof = fixture_parent(
        0x61,
        vec![TxOut { satoshis: 1_000, script_pubkey: owner_script.clone() }],
    );
    let pool_ft_balance = balance_from_tape(&authority_tape.script_pubkey).unwrap();
    let (pool_ft_amount, _) = build_tape_amount(1, &[pool_ft_balance]).unwrap();
    let pool_ft_parent = {
        let mut parent = Transaction::new();
        parent.inputs.push(TxIn::new(OutPoint { txid: pool_ft_proof.txid(), vout: 0 }));
        parent.outputs = vec![
            TxOut {
                satoshis: authority_code.satoshis,
                script_pubkey: pool_held_ft_code(
                    &authority_code.script_pubkey,
                    hash::hash160(&authority.pool_hash),
                )
                .unwrap(),
            },
            TxOut {
                satoshis: 0,
                script_pubkey: transfer_tape_script(
                    &authority_tape.script_pubkey,
                    &pool_ft_amount,
                )
                .unwrap(),
            },
        ];
        parent
    };
    let fee_parent = fixture_parent(
        0x62,
        vec![TxOut { satoshis: 100_000, script_pubkey: owner_script.clone() }],
    );
    let maintenance = &plan.transactions[0];
    let planned_parent = TransactionSource::Planned(maintenance.transaction_id.clone());
    let pool_ft_source = TransactionSource::Raw(pool_ft_parent.to_hex());
    let fee_source = TransactionSource::Raw(fee_parent.to_hex());
    let pool_descriptor = pool_unlocking_descriptor(PoolUnlockRecipe {
        parent: TransactionSource::Raw(pool_parent.to_hex()),
        pre_parent: TransactionSource::Raw(pool_pre_parent),
        contract: TransactionSource::Raw(contract).into(),
        auxiliary_parents: vec![
            planned_parent.clone(),
            pool_ft_source.clone(),
            fee_source.clone(),
        ],
        spent_vout: 0,
        operation: PoolRecipeOperation::ConsumeLiquidity,
        swap: None,
        with_lock: authority.locked,
        service_provider: "source-fixture".to_owned(),
        public_key_lock: authority.pool["publicKeyLock"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| key.as_str().unwrap().to_owned())
            .collect(),
    })
    .unwrap();
    let pool_ft_descriptor = pool_held_ft_unlocking_descriptor(PoolHeldFtUnlockRecipe {
        parent: pool_ft_source,
        proof_references: vec![ProofReference {
            source: TransactionSource::Raw(pool_ft_proof.to_hex()),
            output_index: 0,
        }],
        contract: TransactionSource::Raw(pool_parent.to_hex()),
        ft_version: match authority.version {
            FtScriptVersion::V1 => 1,
            FtScriptVersion::V2 => 2,
            FtScriptVersion::V3 => 3,
            FtScriptVersion::V4 => 4,
        },
        coin_mode: authority.is_coin,
        logical_swap_input_index: 1,
    })
    .unwrap();
    let proof_references = maintenance.inputs[..usize::from(candidate_count)]
        .iter()
        .rev()
        .map(|input| {
            let recipe = decoded_ftlp_recipe(input);
            ProofReference { source: recipe.parent, output_index: input.previous_output_index }
        })
        .collect::<Vec<_>>();
    let ftlp_descriptor = ftlp_unlocking_descriptor(FtlpUnlockRecipe {
        parent: planned_parent,
        proof_references,
        lock: match lock {
            FtlpLockMode::Standard => FtlpLockMode::Standard,
            FtlpLockMode::BlockHeight { .. } => FtlpLockMode::BlockHeight {
                lock_height: 0,
                current_height: 0,
            },
        },
        ordered_input_index: 0,
        ordered_input_count: 1,
    })
    .unwrap();
    let primary = PlannedTransaction {
        transaction_id: "pool-liquidity-remove".to_owned(),
        role: "primary".to_owned(),
        stage: 1,
        depends_on: vec![maintenance.transaction_id.clone()],
        version: tbc_sdk::TX_VERSION,
        inputs: vec![
            PlannedInput {
                previous_transaction_id: pool_parent.txid().to_string(),
                previous_output_index: 0,
                previous_output_script: hex(pool_parent.outputs[0].script_pubkey.as_bytes()),
                previous_output_satoshis: pool_parent.outputs[0].satoshis,
                sequence: tbc_sdk::DEFAULT_SEQUENCE,
                unlocking_script: pool_descriptor,
                signer: public_context(),
            },
            PlannedInput {
                previous_transaction_id: maintenance.transaction_id.clone(),
                previous_output_index: 0,
                previous_output_script: maintenance.outputs[0].locking_script.clone(),
                previous_output_satoshis: maintenance.outputs[0].satoshis,
                sequence: if authority.locked {
                    tbc_sdk::DEFAULT_SEQUENCE - 1
                } else {
                    tbc_sdk::DEFAULT_SEQUENCE
                },
                unlocking_script: ftlp_descriptor,
                signer: public_context(),
            },
            PlannedInput {
                previous_transaction_id: pool_ft_parent.txid().to_string(),
                previous_output_index: 0,
                previous_output_script: hex(pool_ft_parent.outputs[0].script_pubkey.as_bytes()),
                previous_output_satoshis: pool_ft_parent.outputs[0].satoshis,
                sequence: if authority.is_coin {
                    tbc_sdk::DEFAULT_SEQUENCE - 1
                } else {
                    tbc_sdk::DEFAULT_SEQUENCE
                },
                unlocking_script: pool_ft_descriptor,
                signer: public_context(),
            },
            PlannedInput {
                previous_transaction_id: fee_parent.txid().to_string(),
                previous_output_index: 0,
                previous_output_script: OWNER_SCRIPT.to_owned(),
                previous_output_satoshis: fee_parent.outputs[0].satoshis,
                sequence: tbc_sdk::DEFAULT_SEQUENCE,
                unlocking_script: String::new(),
                signer: public_context(),
            },
        ],
        outputs: vec![
            TxOut {
                satoshis: pool_parent.outputs[0].satoshis,
                script_pubkey: pool_parent.outputs[0].script_pubkey.clone(),
            },
            TxOut {
                satoshis: pool_parent.outputs[1].satoshis,
                script_pubkey: pool_parent.outputs[1].script_pubkey.clone(),
            },
            TxOut {
                satoshis: authority_code.satoshis,
                script_pubkey: authority_code.script_pubkey,
            },
            TxOut {
                satoshis: authority_tape.satoshis,
                script_pubkey: authority_tape.script_pubkey,
            },
            TxOut {
                satoshis: 1_000,
                script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
            },
            TxOut {
                satoshis: 1_000,
                script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
            },
            TxOut {
                satoshis: 1_000,
                script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
            },
        ]
        .into_iter()
        .map(|output| PlannedOutput {
            satoshis: output.satoshis,
            locking_script: hex(output.script_pubkey.as_bytes()),
        })
        .collect(),
        lock_time: 0,
    };
    plan.transactions.push(primary);
    (plan, authority)
}

fn decoded_pool_recipe(input: &PlannedInput) -> PoolUnlockRecipe {
    let encoded = input.unlocking_script.strip_prefix("pool1:").unwrap();
    serde_json::from_slice(&decode_hex(encoded)).unwrap()
}

fn replace_pool_recipe(input: &mut PlannedInput, recipe: PoolUnlockRecipe) {
    input.unlocking_script = pool_unlocking_descriptor(recipe).unwrap();
}

fn mutate_descendant_pool_authority(
    plan: &mut UnsignedPlan,
    mutate: impl FnOnce(&mut Transaction),
) {
    let primary = plan.transactions.last_mut().unwrap();
    let pool_input = &mut primary.inputs[0];
    let mut recipe = decoded_pool_recipe(pool_input);
    let TransactionSource::Raw(parent_raw) = &recipe.parent else {
        panic!("authority Pool parent must be raw")
    };
    let TransactionSource::Raw(pre_parent_raw) = &recipe.pre_parent else {
        panic!("authority Pool pre-parent must be raw")
    };
    let tbc_engine_core::signing::PoolContractSource::Transaction(TransactionSource::Raw(contract_raw)) = &recipe.contract else {
        panic!("authority FT contract must be raw")
    };
    let mut parent = Transaction::from_hex(parent_raw).unwrap();
    let mut pre_parent = Transaction::from_hex(pre_parent_raw).unwrap();
    let mut contract = Transaction::from_hex(contract_raw).unwrap();
    mutate(&mut contract);
    let mut state = PoolState::from_v2_tape(
        &parent.outputs[1].script_pubkey,
        recipe.service_provider.clone(),
    )
    .unwrap();
    let mut prior_state = PoolState::from_v2_tape(
        &pre_parent.outputs[1].script_pubkey,
        recipe.service_provider.clone(),
    )
    .unwrap();
    state.ft_a_contract_id = contract.txid();
    prior_state.ft_a_contract_id = state.ft_a_contract_id;
    pre_parent.outputs[1].script_pubkey = pool_tape(&prior_state).unwrap();
    parent.inputs[0].previous_output.txid = pre_parent.txid();
    parent.outputs[1].script_pubkey = pool_tape(&state).unwrap();
    recipe.parent = TransactionSource::Raw(parent.to_hex());
    recipe.pre_parent = TransactionSource::Raw(pre_parent.to_hex());
    recipe.contract = TransactionSource::Raw(contract.to_hex()).into();
    pool_input.previous_transaction_id = parent.txid().to_string();
    pool_input.previous_output_script = hex(parent.outputs[0].script_pubkey.as_bytes());
    pool_input.previous_output_satoshis = parent.outputs[0].satoshis;
    replace_pool_recipe(pool_input, recipe);
    synchronize_descendant_pool_held_contract(primary, &parent);
}

fn mutate_descendant_pool_states(
    plan: &mut UnsignedPlan,
    mutate: impl FnOnce(&mut PoolState, &mut PoolState),
) {
    let primary = plan.transactions.last_mut().unwrap();
    let pool_input = &mut primary.inputs[0];
    let mut recipe = decoded_pool_recipe(pool_input);
    let TransactionSource::Raw(parent_raw) = &recipe.parent else {
        panic!("authority Pool parent must be raw")
    };
    let TransactionSource::Raw(pre_parent_raw) = &recipe.pre_parent else {
        panic!("authority Pool pre-parent must be raw")
    };
    let mut parent = Transaction::from_hex(parent_raw).unwrap();
    let mut pre_parent = Transaction::from_hex(pre_parent_raw).unwrap();
    let mut state = PoolState::from_v2_tape(
        &parent.outputs[1].script_pubkey,
        recipe.service_provider.clone(),
    )
    .unwrap();
    let mut prior_state = PoolState::from_v2_tape(
        &pre_parent.outputs[1].script_pubkey,
        recipe.service_provider.clone(),
    )
    .unwrap();
    mutate(&mut state, &mut prior_state);
    pre_parent.outputs[1].script_pubkey = pool_tape(&prior_state).unwrap();
    parent.inputs[0].previous_output.txid = pre_parent.txid();
    parent.outputs[1].script_pubkey = pool_tape(&state).unwrap();
    recipe.parent = TransactionSource::Raw(parent.to_hex());
    recipe.pre_parent = TransactionSource::Raw(pre_parent.to_hex());
    pool_input.previous_transaction_id = parent.txid().to_string();
    pool_input.previous_output_script = hex(parent.outputs[0].script_pubkey.as_bytes());
    pool_input.previous_output_satoshis = parent.outputs[0].satoshis;
    replace_pool_recipe(pool_input, recipe);
    synchronize_descendant_pool_held_contract(primary, &parent);
}

fn assert_pool_immutable_rejected(plan: &UnsignedPlan) {
    assert_eq!(
        begin_signing(plan).unwrap_err().message,
        "FTLP maintenance Pool immutable state or LP partial hash is inconsistent"
    );
}

fn assert_descendant_pool_context_rejected(plan: &UnsignedPlan) {
    assert_eq!(
        begin_signing(plan).unwrap_err().message,
        "FTLP maintenance descendant Pool operation context is invalid"
    );
}

fn assert_descendant_pool_input_shape_rejected(plan: &UnsignedPlan) {
    assert_eq!(
        begin_signing(plan).unwrap_err().message,
        "FTLP maintenance descendant Pool input shape is invalid"
    );
}

fn replace_pool_held_recipe(input: &mut PlannedInput, recipe: PoolHeldFtUnlockRecipe) {
    input.unlocking_script = pool_held_ft_unlocking_descriptor(recipe).unwrap();
}

fn synchronize_descendant_pool_held_contract(
    primary: &mut PlannedTransaction,
    pool_parent: &Transaction,
) {
    for input in primary.inputs.iter_mut().skip(1).filter(|input| {
        input.unlocking_script.starts_with("pool-ft1:")
    }) {
        let mut recipe = pool_held_ft_recipe_from_descriptor(&input.unlocking_script);
        recipe.contract = TransactionSource::Raw(pool_parent.to_hex());
        replace_pool_held_recipe(input, recipe);
    }
}

fn clone_unique_pool_held_input(input: &PlannedInput, nonce: u8, logical_index: u8) -> PlannedInput {
    let mut cloned = input.clone();
    let mut recipe = pool_held_ft_recipe_from_descriptor(&cloned.unlocking_script);
    let TransactionSource::Raw(parent_raw) = &recipe.parent else {
        panic!("fixture Pool-held FT parent must be raw")
    };
    let mut parent = Transaction::from_hex(parent_raw).unwrap();
    let mut proof = fixture_parent(
        nonce,
        vec![TxOut {
            satoshis: 1_000,
            script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
        }],
    );
    proof.inputs[0].previous_output.vout = u32::from(nonce);
    parent.inputs[0].previous_output = OutPoint { txid: proof.txid(), vout: 0 };
    recipe.parent = TransactionSource::Raw(parent.to_hex());
    recipe.proof_references = vec![ProofReference {
        source: TransactionSource::Raw(proof.to_hex()),
        output_index: 0,
    }];
    recipe.logical_swap_input_index = logical_index;
    cloned.previous_transaction_id = parent.txid().to_string();
    replace_pool_held_recipe(&mut cloned, recipe);
    cloned
}

fn pool_held_ft_recipe_from_descriptor(descriptor: &str) -> PoolHeldFtUnlockRecipe {
    let encoded = descriptor.strip_prefix("pool-ft1:").unwrap();
    serde_json::from_slice(&decode_hex(encoded)).unwrap()
}

fn planned_preview(transaction: &PlannedTransaction) -> Transaction {
    Transaction {
        version: transaction.version,
        inputs: transaction
            .inputs
            .iter()
            .map(|input| TxIn {
                previous_output: OutPoint {
                    txid: input.previous_transaction_id.parse().unwrap(),
                    vout: input.previous_output_index,
                },
                script_sig: Script::empty(),
                sequence: input.sequence,
            })
            .collect(),
        outputs: transaction
            .outputs
            .iter()
            .map(|output| TxOut {
                satoshis: output.satoshis,
                script_pubkey: Script::from_bytes(decode_hex(&output.locking_script)),
            })
            .collect(),
        lock_time: transaction.lock_time,
    }
}

fn staged_non_ftlp_consume_plan(transaction_id: &str) -> UnsignedPlan {
    let (plan, _) = authority_bound_ftlp_maintenance_plan(
        2,
        FtlpLockMode::BlockHeight { lock_height: 90, current_height: 100 },
    );
    let ftlp_parent = planned_preview(&plan.transactions[0]);
    let mut primary = plan.transactions[1].clone();
    primary.transaction_id = transaction_id.to_owned();
    primary.depends_on = vec!["pool-ft-merge-0".to_owned()];

    let mut ftlp_recipe = decoded_ftlp_recipe(&primary.inputs[1]);
    ftlp_recipe.parent = TransactionSource::Raw(ftlp_parent.to_hex());
    replace_ftlp_recipe(&mut primary.inputs[1], ftlp_recipe);
    primary.inputs[1].previous_transaction_id = ftlp_parent.txid().to_string();

    let precursor_parent = fixture_parent(
        0x70,
        vec![TxOut {
            satoshis: 100_000,
            script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
        }],
    );
    let precursor = PlannedTransaction {
        transaction_id: "pool-ft-merge-0".to_owned(),
        role: "maintenance".to_owned(),
        stage: 0,
        depends_on: vec![],
        version: tbc_sdk::TX_VERSION,
        inputs: vec![PlannedInput {
            previous_transaction_id: precursor_parent.txid().to_string(),
            previous_output_index: 0,
            previous_output_script: OWNER_SCRIPT.to_owned(),
            previous_output_satoshis: 100_000,
            sequence: tbc_sdk::DEFAULT_SEQUENCE,
            unlocking_script: String::new(),
            signer: public_context(),
        }],
        outputs: vec![PlannedOutput {
            satoshis: 90_000,
            locking_script: OWNER_SCRIPT.to_owned(),
        }],
        lock_time: 0,
    };
    let fee = primary.inputs.last_mut().unwrap();
    fee.previous_transaction_id = precursor.transaction_id.clone();
    fee.previous_output_index = 0;
    fee.previous_output_script = OWNER_SCRIPT.to_owned();
    fee.previous_output_satoshis = 90_000;
    let mut pool_recipe = decoded_pool_recipe(&primary.inputs[0]);
    pool_recipe.auxiliary_parents[0] = TransactionSource::Raw(ftlp_parent.to_hex());
    *pool_recipe.auxiliary_parents.last_mut().unwrap() =
        TransactionSource::Planned(precursor.transaction_id.clone());
    replace_pool_recipe(&mut primary.inputs[0], pool_recipe);
    UnsignedPlan { transactions: vec![precursor, primary], evidence_table: vec![] }
}

fn direct_consume_plan(transaction_id: &str) -> UnsignedPlan {
    let staged = staged_non_ftlp_consume_plan(transaction_id);
    let precursor = planned_preview(&staged.transactions[0]);
    let mut primary = staged.transactions[1].clone();
    primary.stage = 0;
    primary.depends_on.clear();
    let fee = primary.inputs.last_mut().unwrap();
    fee.previous_transaction_id = precursor.txid().to_string();
    let mut pool_recipe = decoded_pool_recipe(&primary.inputs[0]);
    *pool_recipe.auxiliary_parents.last_mut().unwrap() =
        TransactionSource::Raw(precursor.to_hex());
    replace_pool_recipe(&mut primary.inputs[0], pool_recipe);
    UnsignedPlan { transactions: vec![primary], evidence_table: vec![] }
}

fn append_second_locked_ftlp(plan: &mut UnsignedPlan) {
    let primary = plan.transactions.last_mut().unwrap();
    let first_recipe = decoded_ftlp_recipe(&primary.inputs[1]);
    let TransactionSource::Raw(parent_raw) = &first_recipe.parent else {
        panic!("staged FTLP parent must be raw")
    };
    let mut parent = Transaction::from_hex(parent_raw).unwrap();
    let proof = fixture_parent(
        0x71,
        vec![TxOut {
            satoshis: 1_000,
            script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
        }],
    );
    parent.inputs[0].previous_output = OutPoint { txid: proof.txid(), vout: 0 };
    let mut first_recipe = first_recipe;
    first_recipe.ordered_input_count = 2;
    replace_ftlp_recipe(&mut primary.inputs[1], first_recipe);
    let descriptor = ftlp_unlocking_descriptor(FtlpUnlockRecipe {
        parent: TransactionSource::Raw(parent.to_hex()),
        proof_references: vec![ProofReference {
            source: TransactionSource::Raw(proof.to_hex()),
            output_index: 0,
        }],
        lock: FtlpLockMode::BlockHeight { lock_height: 0, current_height: 0 },
        ordered_input_index: 1,
        ordered_input_count: 2,
    })
    .unwrap();
    primary.inputs.insert(
        2,
        PlannedInput {
            previous_transaction_id: parent.txid().to_string(),
            previous_output_index: 0,
            previous_output_script: hex(parent.outputs[0].script_pubkey.as_bytes()),
            previous_output_satoshis: parent.outputs[0].satoshis,
            sequence: tbc_sdk::DEFAULT_SEQUENCE - 1,
            unlocking_script: descriptor,
            signer: public_context(),
        },
    );
    let mut pool_recipe = decoded_pool_recipe(&primary.inputs[0]);
    pool_recipe
        .auxiliary_parents
        .insert(1, TransactionSource::Raw(parent.to_hex()));
    replace_pool_recipe(&mut primary.inputs[0], pool_recipe);
}

#[test]
fn staged_non_ftlp_consume_accepts_exact_remove_and_close_shape() {
    for transaction_id in ["pool-liquidity-remove", "pool-liquidity-close"] {
        let plan = staged_non_ftlp_consume_plan(transaction_id);
        let stage = begin_signing(&plan).expect("canonical staged consume plan");
        assert!(!stage.signing_requests.is_empty());
        assert!(stage
            .signing_requests
            .iter()
            .all(|request| request.transaction_id == "pool-ft-merge-0"));
    }
}

#[test]
fn delayed_pool_consume_rejects_id_only_relabel_before_precursor_requests() {
    let mut plan = staged_non_ftlp_consume_plan("pool-liquidity-remove");
    plan.transactions.last_mut().unwrap().transaction_id = "renamed-pool-consume".to_owned();
    assert_eq!(
        begin_signing(&plan).unwrap_err().message,
        "delayed Pool consume identity, role, and recipe must agree"
    );
}

#[test]
fn delayed_pool_consume_rejects_role_only_relabel_before_precursor_requests() {
    let mut plan = staged_non_ftlp_consume_plan("pool-liquidity-close");
    plan.transactions.last_mut().unwrap().role = "maintenance".to_owned();
    assert_eq!(
        begin_signing(&plan).unwrap_err().message,
        "delayed Pool consume identity, role, and recipe must agree"
    );
}

#[test]
fn direct_pool_consume_passes_exact_preflight_and_finalizes() {
    for transaction_id in ["pool-liquidity-remove", "pool-liquidity-close"] {
        let plan = direct_consume_plan(transaction_id);
        let stage = begin_signing(&plan).expect("canonical direct consume plan");
        assert_eq!(stage.stage, 0);
        assert!(stage
            .signing_requests
            .iter()
            .all(|request| request.transaction_id == transaction_id));
        let signatures = stage.signing_requests.iter().map(dynamic_signature).collect::<Vec<_>>();
        let StageOutcome::Complete(bundle) =
            finalize_signing_stage(&plan, stage, &signatures).expect("finalize direct consume")
        else {
            panic!("direct consume must complete in one stage")
        };
        assert_eq!(bundle.transactions.len(), 1);
        assert_eq!(bundle.transactions[0].transaction_id, transaction_id);
    }
}

#[test]
fn ft_above_v2_consume_authenticates_order_one_but_emits_released_contract_zero_tag() {
    let plan = direct_consume_plan("pool-liquidity-remove");
    let input = &plan.transactions[0].inputs[2];
    let recipe = pool_held_ft_recipe_from_descriptor(&input.unlocking_script);
    assert!(recipe.ft_version > 2);
    assert_eq!(recipe.logical_swap_input_index, 1);
    let stage = begin_signing(&plan).unwrap();
    let signatures = stage.signing_requests.iter().map(dynamic_signature).collect::<Vec<_>>();
    let StageOutcome::Complete(bundle) = finalize_signing_stage(&plan, stage, &signatures).unwrap()
    else { panic!("consume must complete") };
    let transaction = Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap();
    let TransactionSource::Raw(parent_raw) = &recipe.parent else { panic!("raw parent") };
    let parent = Transaction::from_hex(parent_raw).unwrap();
    let parent_suffix = tbc_sdk::contracts::ft::unlock::pre_tx_data(
        &parent, input.previous_output_index as usize,
    ).unwrap();
    let script = transaction.inputs[2].script_sig.as_bytes();
    let tag_offset = script.len() - parent_suffix.len() - usize::from(recipe.coin_mode) - 1;
    // Released getFTunlockSwap(..., isContractTXs=false) selects the Pool
    // contract branch, not the authenticated absolute-input ordering slot.
    assert_eq!(script[tag_offset], tbc_sdk::script::opcodes::OP_0);
}

#[test]
fn direct_pool_consume_rejects_second_locked_ftlp_before_requests() {
    let mut plan = direct_consume_plan("pool-liquidity-remove");
    append_second_locked_ftlp(&mut plan);
    assert_descendant_pool_input_shape_rejected(&plan);
}

#[test]
fn direct_pool_consume_rejects_fourth_pool_held_ft_before_requests() {
    let mut plan = direct_consume_plan("pool-liquidity-remove");
    let primary = plan.transactions.last_mut().unwrap();
    for (nonce, logical_index) in [(0x79, 2), (0x7a, 3), (0x7b, 4)] {
        let cloned = clone_unique_pool_held_input(&primary.inputs[2], nonce, logical_index);
        let recipe = pool_held_ft_recipe_from_descriptor(&cloned.unlocking_script);
        let insert_at = primary.inputs.len() - 1;
        primary.inputs.insert(insert_at, cloned);
        let mut pool_recipe = decoded_pool_recipe(&primary.inputs[0]);
        let auxiliary_at = pool_recipe.auxiliary_parents.len() - 1;
        pool_recipe.auxiliary_parents.insert(auxiliary_at, recipe.parent);
        replace_pool_recipe(&mut primary.inputs[0], pool_recipe);
    }
    assert_descendant_pool_input_shape_rejected(&plan);
}

#[test]
fn direct_pool_consume_rejects_extra_funding_before_requests() {
    let mut plan = direct_consume_plan("pool-liquidity-close");
    let extra = fixture_parent(
        0x7c,
        vec![TxOut {
            satoshis: 50_000,
            script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
        }],
    );
    let primary = plan.transactions.last_mut().unwrap();
    primary.inputs.push(PlannedInput {
        previous_transaction_id: extra.txid().to_string(),
        previous_output_index: 0,
        previous_output_script: OWNER_SCRIPT.to_owned(),
        previous_output_satoshis: 50_000,
        sequence: tbc_sdk::DEFAULT_SEQUENCE,
        unlocking_script: String::new(),
        signer: public_context(),
    });
    let mut pool_recipe = decoded_pool_recipe(&primary.inputs[0]);
    pool_recipe.auxiliary_parents.push(TransactionSource::Raw(extra.to_hex()));
    replace_pool_recipe(&mut primary.inputs[0], pool_recipe);
    assert_descendant_pool_input_shape_rejected(&plan);
}

#[test]
fn direct_pool_consume_rejects_malformed_outputs_before_requests() {
    let mut plan = direct_consume_plan("pool-liquidity-remove");
    plan.transactions.last_mut().unwrap().outputs.swap(2, 4);
    assert_descendant_pool_context_rejected(&plan);
}

#[test]
fn staged_non_ftlp_consume_rejects_second_locked_ftlp_before_precursor_requests() {
    let mut plan = staged_non_ftlp_consume_plan("pool-liquidity-remove");
    begin_signing(&plan).expect("canonical staged consume precondition");
    append_second_locked_ftlp(&mut plan);
    assert_descendant_pool_input_shape_rejected(&plan);
}

#[test]
fn staged_non_ftlp_consume_rejects_fourth_pool_held_ft_before_precursor_requests() {
    let mut plan = staged_non_ftlp_consume_plan("pool-liquidity-remove");
    begin_signing(&plan).expect("canonical staged consume precondition");
    let primary = plan.transactions.last_mut().unwrap();
    for (nonce, logical_index) in [(0x72, 2), (0x73, 3), (0x74, 4)] {
        let cloned = clone_unique_pool_held_input(&primary.inputs[2], nonce, logical_index);
        let recipe = pool_held_ft_recipe_from_descriptor(&cloned.unlocking_script);
        let insert_at = primary.inputs.len() - 1;
        primary.inputs.insert(insert_at, cloned);
        let mut pool_recipe = decoded_pool_recipe(&primary.inputs[0]);
        let auxiliary_at = pool_recipe.auxiliary_parents.len() - 1;
        pool_recipe.auxiliary_parents.insert(auxiliary_at, recipe.parent);
        replace_pool_recipe(&mut primary.inputs[0], pool_recipe);
    }
    assert_descendant_pool_input_shape_rejected(&plan);
}

#[test]
fn staged_non_ftlp_consume_rejects_extra_funding_before_precursor_requests() {
    let mut plan = staged_non_ftlp_consume_plan("pool-liquidity-close");
    begin_signing(&plan).expect("canonical staged consume precondition");
    let extra = fixture_parent(
        0x75,
        vec![TxOut {
            satoshis: 50_000,
            script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
        }],
    );
    let primary = plan.transactions.last_mut().unwrap();
    primary.inputs.push(PlannedInput {
        previous_transaction_id: extra.txid().to_string(),
        previous_output_index: 0,
        previous_output_script: OWNER_SCRIPT.to_owned(),
        previous_output_satoshis: 50_000,
        sequence: tbc_sdk::DEFAULT_SEQUENCE,
        unlocking_script: String::new(),
        signer: public_context(),
    });
    let mut pool_recipe = decoded_pool_recipe(&primary.inputs[0]);
    pool_recipe.auxiliary_parents.push(TransactionSource::Raw(extra.to_hex()));
    replace_pool_recipe(&mut primary.inputs[0], pool_recipe);
    assert_descendant_pool_input_shape_rejected(&plan);
}

fn descendant_with_two_ordered_pool_held_proofs() -> UnsignedPlan {
    let mut plan = authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
    let primary = plan.transactions.last_mut().unwrap();
    let held_input = &mut primary.inputs[2];
    let mut held_recipe = pool_held_ft_recipe_from_descriptor(&held_input.unlocking_script);
    let TransactionSource::Raw(parent_raw) = &held_recipe.parent else {
        panic!("Pool-held FT parent must be raw")
    };
    let first_proof = fixture_parent(
        0x78,
        vec![
            TxOut {
                satoshis: 1_000,
                script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
            },
            TxOut {
                satoshis: 2_000,
                script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
            },
        ],
    );
    let second_proof = fixture_parent(
        0x76,
        vec![
            TxOut {
                satoshis: 1_000,
                script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
            },
            TxOut {
                satoshis: 2_000,
                script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
            },
        ],
    );
    let unreferenced_proof = fixture_parent(
        0x77,
        vec![TxOut {
            satoshis: 1_000,
            script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
        }],
    );
    let mut parent = Transaction::from_hex(parent_raw).unwrap();
    parent.inputs = vec![
        TxIn::new(OutPoint { txid: first_proof.txid(), vout: 0 }),
        TxIn::new(OutPoint { txid: second_proof.txid(), vout: 0 }),
        TxIn::new(OutPoint { txid: unreferenced_proof.txid(), vout: 0 }),
    ];
    let (amounts, _) = build_tape_amount(2, &[1, 1, 1]).unwrap();
    parent.outputs[1].script_pubkey =
        transfer_tape_script(&parent.outputs[1].script_pubkey, &amounts).unwrap();
    held_recipe.parent = TransactionSource::Raw(parent.to_hex());
    held_recipe.proof_references = vec![
        ProofReference {
            source: TransactionSource::Raw(second_proof.to_hex()),
            output_index: 0,
        },
        ProofReference {
            source: TransactionSource::Raw(first_proof.to_hex()),
            output_index: 0,
        },
    ];
    held_input.previous_transaction_id = parent.txid().to_string();
    replace_pool_held_recipe(held_input, held_recipe.clone());
    let mut pool_recipe = decoded_pool_recipe(&primary.inputs[0]);
    pool_recipe.auxiliary_parents[1] = held_recipe.parent;
    replace_pool_recipe(&mut primary.inputs[0], pool_recipe);
    plan
}

fn mutate_first_pool_held_proof_to_existing_vout(plan: &mut UnsignedPlan, evidence: bool) {
    let primary = plan.transactions.last_mut().unwrap();
    let mut recipe = pool_held_ft_recipe_from_descriptor(&primary.inputs[2].unlocking_script);
    let TransactionSource::Raw(raw) = &recipe.proof_references[0].source else {
        panic!("canonical Pool-held FT proof must be raw")
    };
    let proof = Transaction::from_hex(raw).unwrap();
    assert_eq!(proof.outputs.len(), 2);
    let TransactionSource::Raw(parent_raw) = &recipe.parent else {
        panic!("Pool-held FT parent must be raw")
    };
    let parent = Transaction::from_hex(parent_raw).unwrap();
    assert_eq!(parent.inputs[1].previous_output.txid, proof.txid());
    assert_eq!(parent.inputs[1].previous_output.vout, 0);
    if evidence {
        plan.evidence_table.push(EvidenceEntry {
            txid: proof.txid().to_string(),
            raw_transaction: proof.to_hex(),
        });
        recipe.proof_references[0].source = TransactionSource::Evidence(0);
    }
    recipe.proof_references[0].output_index = 1;
    replace_pool_held_recipe(&mut primary.inputs[2], recipe);
}

fn use_one_pool_held_proof_parent(
    plan: &mut UnsignedPlan,
    second_vout: u32,
    evidence: bool,
) {
    let primary = plan.transactions.last_mut().unwrap();
    let mut recipe = pool_held_ft_recipe_from_descriptor(&primary.inputs[2].unlocking_script);
    let TransactionSource::Raw(parent_raw) = &recipe.parent else {
        panic!("Pool-held FT parent must be raw")
    };
    let mut parent = Transaction::from_hex(parent_raw).unwrap();
    assert_ne!(parent.inputs[0].previous_output, parent.inputs[1].previous_output);
    let TransactionSource::Raw(proof_raw) = &recipe.proof_references[0].source else {
        panic!("canonical Pool-held FT proof must be raw")
    };
    let proof = Transaction::from_hex(proof_raw).unwrap();
    assert_eq!(parent.inputs[1].previous_output.txid, proof.txid());
    assert_eq!(parent.inputs[1].previous_output.vout, 0);
    assert!(proof.outputs.get(second_vout as usize).is_some());
    parent.inputs[0].previous_output = OutPoint { txid: proof.txid(), vout: second_vout };
    let source = if evidence {
        plan.evidence_table.push(EvidenceEntry {
            txid: proof.txid().to_string(),
            raw_transaction: proof.to_hex(),
        });
        TransactionSource::Evidence(0)
    } else {
        TransactionSource::Raw(proof.to_hex())
    };
    recipe.parent = TransactionSource::Raw(parent.to_hex());
    recipe.proof_references = vec![
        ProofReference { source: source.clone(), output_index: 0 },
        ProofReference { source, output_index: second_vout },
    ];
    primary.inputs[2].previous_transaction_id = parent.txid().to_string();
    replace_pool_held_recipe(&mut primary.inputs[2], recipe.clone());
    let mut pool_recipe = decoded_pool_recipe(&primary.inputs[0]);
    pool_recipe.auxiliary_parents[1] = recipe.parent;
    replace_pool_recipe(&mut primary.inputs[0], pool_recipe);
}

fn assert_descendant_pool_held_proofs_rejected(plan: &UnsignedPlan) {
    assert_eq!(
        begin_signing(plan).unwrap_err().message,
        "FTLP maintenance descendant Pool-held FT proof set is invalid"
    );
}

#[test]
fn descendant_pool_held_proofs_accept_exact_released_source_order() {
    begin_signing(&descendant_with_two_ordered_pool_held_proofs())
        .expect("exact released Pool-held FT proof order");
}

#[test]
fn descendant_pool_held_proofs_accept_exact_evidence_vout() {
    let mut plan = descendant_with_two_ordered_pool_held_proofs();
    let primary = plan.transactions.last_mut().unwrap();
    let mut recipe = pool_held_ft_recipe_from_descriptor(&primary.inputs[2].unlocking_script);
    let TransactionSource::Raw(raw) = &recipe.proof_references[0].source else {
        panic!("canonical Pool-held FT proof must be raw")
    };
    let proof = Transaction::from_hex(raw).unwrap();
    plan.evidence_table.push(EvidenceEntry {
        txid: proof.txid().to_string(),
        raw_transaction: proof.to_hex(),
    });
    recipe.proof_references[0].source = TransactionSource::Evidence(0);
    replace_pool_held_recipe(&mut primary.inputs[2], recipe);
    begin_signing(&plan).expect("exact evidence Pool-held FT proof vout");
}

#[test]
fn descendant_pool_held_proofs_reject_wrong_existing_raw_vout_before_requests() {
    let mut plan = descendant_with_two_ordered_pool_held_proofs();
    mutate_first_pool_held_proof_to_existing_vout(&mut plan, false);
    assert_descendant_pool_held_proofs_rejected(&plan);
}

#[test]
fn descendant_pool_held_proofs_reject_wrong_existing_evidence_vout_before_requests() {
    let mut plan = descendant_with_two_ordered_pool_held_proofs();
    mutate_first_pool_held_proof_to_existing_vout(&mut plan, true);
    assert_descendant_pool_held_proofs_rejected(&plan);
}

#[test]
fn descendant_pool_held_proofs_allow_one_parent_with_distinct_selected_vouts() {
    let mut plan = descendant_with_two_ordered_pool_held_proofs();
    use_one_pool_held_proof_parent(&mut plan, 1, false);
    begin_signing(&plan).expect("one proof transaction may supply distinct selected vouts");
}

#[test]
fn descendant_pool_held_proofs_reject_duplicate_selected_raw_outpoint_before_requests() {
    let mut plan = descendant_with_two_ordered_pool_held_proofs();
    use_one_pool_held_proof_parent(&mut plan, 0, false);
    assert_descendant_pool_held_proofs_rejected(&plan);
}

#[test]
fn descendant_pool_held_proofs_reject_duplicate_selected_evidence_outpoint_before_requests() {
    let mut plan = descendant_with_two_ordered_pool_held_proofs();
    use_one_pool_held_proof_parent(&mut plan, 0, true);
    assert_descendant_pool_held_proofs_rejected(&plan);
}

#[test]
fn descendant_pool_held_proofs_reject_duplicate_before_precursor_requests() {
    let mut plan = descendant_with_two_ordered_pool_held_proofs();
    let primary = plan.transactions.last_mut().unwrap();
    let mut recipe = pool_held_ft_recipe_from_descriptor(&primary.inputs[2].unlocking_script);
    recipe.proof_references[1] = recipe.proof_references[0].clone();
    replace_pool_held_recipe(&mut primary.inputs[2], recipe);
    assert_descendant_pool_held_proofs_rejected(&plan);
}

#[test]
fn descendant_pool_held_proofs_reject_omission_before_precursor_requests() {
    let mut plan = descendant_with_two_ordered_pool_held_proofs();
    let primary = plan.transactions.last_mut().unwrap();
    let mut recipe = pool_held_ft_recipe_from_descriptor(&primary.inputs[2].unlocking_script);
    recipe.proof_references.pop();
    replace_pool_held_recipe(&mut primary.inputs[2], recipe);
    assert_descendant_pool_held_proofs_rejected(&plan);
}

#[test]
fn descendant_pool_held_proofs_reject_reorder_before_precursor_requests() {
    let mut plan = descendant_with_two_ordered_pool_held_proofs();
    let primary = plan.transactions.last_mut().unwrap();
    let mut recipe = pool_held_ft_recipe_from_descriptor(&primary.inputs[2].unlocking_script);
    recipe.proof_references.reverse();
    replace_pool_held_recipe(&mut primary.inputs[2], recipe);
    assert_descendant_pool_held_proofs_rejected(&plan);
}

#[test]
fn descendant_pool_held_proofs_reject_unreferenced_parent_substitution() {
    let mut plan = descendant_with_two_ordered_pool_held_proofs();
    let primary = plan.transactions.last_mut().unwrap();
    let mut recipe = pool_held_ft_recipe_from_descriptor(&primary.inputs[2].unlocking_script);
    let TransactionSource::Raw(parent_raw) = &recipe.parent else {
        panic!("Pool-held FT parent must be raw")
    };
    let parent = Transaction::from_hex(parent_raw).unwrap();
    let unreferenced = fixture_parent(
        0x77,
        vec![TxOut {
            satoshis: 1_000,
            script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
        }],
    );
    assert_eq!(unreferenced.txid(), parent.inputs[2].previous_output.txid);
    recipe.proof_references[0] = ProofReference {
        source: TransactionSource::Raw(unreferenced.to_hex()),
        output_index: 0,
    };
    replace_pool_held_recipe(&mut primary.inputs[2], recipe);
    assert_descendant_pool_held_proofs_rejected(&plan);
}

#[test]
fn ftlp_descendant_consume_accepts_exact_remove_and_close_input_shapes() {
    for transaction_id in ["pool-liquidity-remove", "pool-liquidity-close"] {
        let mut plan = authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
        plan.transactions.last_mut().unwrap().transaction_id = transaction_id.to_owned();
        begin_signing(&plan).expect("released final consume input shape");
    }
}

#[test]
fn ftlp_descendant_consume_rejects_second_locked_ftlp_input() {
    let mut plan = authority_bound_ftlp_maintenance_plan(
        2,
        FtlpLockMode::BlockHeight { lock_height: 90, current_height: 100 },
    )
    .0;
    begin_signing(&plan).expect("canonical locked final consume precondition");
    let maintenance = &plan.transactions[0];
    let proof = fixture_parent(
        0x63,
        vec![TxOut {
            satoshis: 1_000,
            script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
        }],
    );
    let mut parent = Transaction::new();
    parent.inputs.push(TxIn::new(OutPoint { txid: proof.txid(), vout: 0 }));
    parent.outputs = maintenance
        .outputs
        .iter()
        .take(2)
        .map(|output| TxOut {
            satoshis: output.satoshis,
            script_pubkey: Script::from_bytes(decode_hex(&output.locking_script)),
        })
        .collect();
    let primary = plan.transactions.last_mut().unwrap();
    let mut first_recipe = decoded_ftlp_recipe(&primary.inputs[1]);
    first_recipe.ordered_input_count = 2;
    replace_ftlp_recipe(&mut primary.inputs[1], first_recipe);
    let second_recipe = ftlp_unlocking_descriptor(FtlpUnlockRecipe {
        parent: TransactionSource::Raw(parent.to_hex()),
        proof_references: vec![ProofReference {
            source: TransactionSource::Raw(proof.to_hex()),
            output_index: 0,
        }],
        lock: FtlpLockMode::BlockHeight { lock_height: 0, current_height: 0 },
        ordered_input_index: 1,
        ordered_input_count: 2,
    })
    .unwrap();
    primary.inputs.insert(
        2,
        PlannedInput {
            previous_transaction_id: parent.txid().to_string(),
            previous_output_index: 0,
            previous_output_script: hex(parent.outputs[0].script_pubkey.as_bytes()),
            previous_output_satoshis: parent.outputs[0].satoshis,
            sequence: tbc_sdk::DEFAULT_SEQUENCE - 1,
            unlocking_script: second_recipe,
            signer: public_context(),
        },
    );
    let mut pool_ft_recipe = pool_held_ft_recipe_from_descriptor(&primary.inputs[3].unlocking_script);
    pool_ft_recipe.logical_swap_input_index = 2;
    replace_pool_held_recipe(&mut primary.inputs[3], pool_ft_recipe);
    let mut pool_recipe = decoded_pool_recipe(&primary.inputs[0]);
    pool_recipe.auxiliary_parents.insert(1, TransactionSource::Raw(parent.to_hex()));
    replace_pool_recipe(&mut primary.inputs[0], pool_recipe);
    assert_descendant_pool_input_shape_rejected(&plan);
}

#[test]
fn ftlp_descendant_consume_rejects_fourth_pool_held_ft_input() {
    let mut plan = authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
    begin_signing(&plan).expect("canonical Pool-held FT cardinality precondition");
    let primary = plan.transactions.last_mut().unwrap();
    for (nonce, logical_index) in [(0x64, 2), (0x65, 3), (0x66, 4)] {
        let cloned = clone_unique_pool_held_input(&primary.inputs[2], nonce, logical_index);
        let recipe = pool_held_ft_recipe_from_descriptor(&cloned.unlocking_script);
        let insert_at = primary.inputs.len() - 1;
        primary.inputs.insert(insert_at, cloned);
        let mut pool_recipe = decoded_pool_recipe(&primary.inputs[0]);
        let auxiliary_at = pool_recipe.auxiliary_parents.len() - 1;
        pool_recipe.auxiliary_parents.insert(auxiliary_at, recipe.parent);
        replace_pool_recipe(&mut primary.inputs[0], pool_recipe);
    }
    assert_descendant_pool_input_shape_rejected(&plan);
}

#[test]
fn ftlp_descendant_consume_rejects_extra_owned_funding_input() {
    let mut plan = authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
    begin_signing(&plan).expect("canonical trailing fee precondition");
    let extra = fixture_parent(
        0x67,
        vec![TxOut {
            satoshis: 50_000,
            script_pubkey: Script::from_bytes(decode_hex(OWNER_SCRIPT)),
        }],
    );
    let primary = plan.transactions.last_mut().unwrap();
    primary.inputs.push(PlannedInput {
        previous_transaction_id: extra.txid().to_string(),
        previous_output_index: 0,
        previous_output_script: OWNER_SCRIPT.to_owned(),
        previous_output_satoshis: extra.outputs[0].satoshis,
        sequence: tbc_sdk::DEFAULT_SEQUENCE,
        unlocking_script: String::new(),
        signer: public_context(),
    });
    let mut recipe = decoded_pool_recipe(&primary.inputs[0]);
    recipe.auxiliary_parents.push(TransactionSource::Raw(extra.to_hex()));
    replace_pool_recipe(&mut primary.inputs[0], recipe);
    assert_descendant_pool_input_shape_rejected(&plan);
}

#[test]
fn ftlp_begin_signing_validates_actual_descendant_output_layout() {
    let mut plan = authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
    begin_signing(&plan).expect("canonical descendant Pool operation precondition");
    plan.transactions.last_mut().unwrap().outputs.swap(2, 4);
    assert_descendant_pool_context_rejected(&plan);
}

#[test]
fn ftlp_begin_signing_binds_actual_descendant_operation() {
    let mut plan = authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
    begin_signing(&plan).expect("canonical descendant Pool operation precondition");
    let pool_input = &mut plan.transactions.last_mut().unwrap().inputs[0];
    let mut recipe = decoded_pool_recipe(pool_input);
    recipe.operation = PoolRecipeOperation::IncreaseLiquidity;
    replace_pool_recipe(pool_input, recipe);
    assert_descendant_pool_context_rejected(&plan);
}

#[test]
fn ftlp_begin_signing_rejects_actual_descendant_swap_direction_substitution() {
    for swap in [PoolRecipeSwap::TbcToFt, PoolRecipeSwap::FtToTbc] {
        let mut plan = authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
        begin_signing(&plan).expect("canonical descendant Pool operation precondition");
        let pool_input = &mut plan.transactions.last_mut().unwrap().inputs[0];
        let mut recipe = decoded_pool_recipe(pool_input);
        recipe.operation = PoolRecipeOperation::Swap;
        recipe.swap = Some(swap);
        replace_pool_recipe(pool_input, recipe);
        assert_descendant_pool_context_rejected(&plan);
    }
}

#[test]
fn ftlp_begin_signing_binds_actual_descendant_auxiliary_input_layout() {
    let mut plan = authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
    begin_signing(&plan).expect("canonical descendant Pool operation precondition");
    let pool_input = &mut plan.transactions.last_mut().unwrap().inputs[0];
    let mut recipe = decoded_pool_recipe(pool_input);
    recipe.auxiliary_parents.clear();
    replace_pool_recipe(pool_input, recipe);
    assert_descendant_pool_context_rejected(&plan);
}

#[test]
fn ftlp_begin_signing_binds_released_ftlp_partial_hash() {
    let mut plan = authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
    begin_signing(&plan).expect("canonical immutable Pool state precondition");
    mutate_descendant_pool_states(&mut plan, |state, prior| {
        state.ft_lp_partial_hash[0] ^= 1;
        prior.ft_lp_partial_hash = state.ft_lp_partial_hash.clone();
    });
    assert_pool_immutable_rejected(&plan);
}

#[test]
fn ftlp_begin_signing_binds_pool_lp_plan_across_lineage() {
    let mut plan = authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
    begin_signing(&plan).expect("canonical immutable Pool state precondition");
    mutate_descendant_pool_states(&mut plan, |state, _| {
        state.lp_plan = if state.lp_plan == 6 { 5 } else { state.lp_plan + 1 };
    });
    assert_pool_immutable_rejected(&plan);
}

#[test]
fn ftlp_begin_signing_binds_pool_service_fee_rate_across_lineage() {
    let mut plan = authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
    begin_signing(&plan).expect("canonical immutable Pool state precondition");
    mutate_descendant_pool_states(&mut plan, |state, _| {
        state.service_fee_rate = state.service_fee_rate.checked_add(1).unwrap();
    });
    assert_pool_immutable_rejected(&plan);
}

#[test]
fn ftlp_begin_signing_binds_prior_pool_lock_flags() {
    let mut plan = authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
    begin_signing(&plan).expect("canonical immutable Pool state precondition");
    mutate_descendant_pool_states(&mut plan, |_, prior| {
        prior.public_key_locked = !prior.public_key_locked;
    });
    assert_pool_immutable_rejected(&plan);
}

fn assert_released_pool_authority_rejected(plan: &UnsignedPlan) {
    assert_eq!(
        begin_signing(plan).unwrap_err().message,
        "FTLP maintenance Pool authority released context is invalid"
    );
}

#[test]
fn ftlp_begin_signing_authenticates_pool_predecessor_lineage() {
    let mut broken_predecessor =
        authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
    begin_signing(&broken_predecessor).expect("canonical released Pool authority precondition");
    {
        let pool_input = &mut broken_predecessor.transactions.last_mut().unwrap().inputs[0];
        let mut recipe = decoded_pool_recipe(pool_input);
        let TransactionSource::Raw(pre_parent_raw) = &recipe.pre_parent else {
            panic!("authority Pool pre-parent must be raw")
        };
        let mut pre_parent = Transaction::from_hex(pre_parent_raw).unwrap();
        pre_parent.inputs[0].previous_output.txid = Txid::from_le_bytes([0x52; 32]);
        recipe.pre_parent = TransactionSource::Raw(pre_parent.to_hex());
        replace_pool_recipe(pool_input, recipe);
    }
    assert_eq!(
        begin_signing(&broken_predecessor).unwrap_err().message,
        "FTLP maintenance Pool authority predecessor lineage is invalid"
    );
}

#[test]
fn ftlp_begin_signing_authenticates_pool_authority_mint_input() {
    let mut missing_mint_input =
        authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
    begin_signing(&missing_mint_input).expect("canonical released Pool authority precondition");
    mutate_descendant_pool_authority(&mut missing_mint_input, |contract| {
        contract.inputs.clear();
    });
    assert_released_pool_authority_rejected(&missing_mint_input);
}

#[test]
fn ftlp_begin_signing_authenticates_canonical_pool_authority_tape() {
    let mut noncanonical_tape =
        authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
    begin_signing(&noncanonical_tape).expect("canonical released Pool authority precondition");
    mutate_descendant_pool_authority(&mut noncanonical_tape, |contract| {
        let tape_vout = if classify_ft_script(&contract.outputs[0].script_pubkey)
            .is_ok_and(|classified| !classified.is_coin)
        {
            1
        } else {
            4
        };
        let bytes = contract.outputs[tape_vout].script_pubkey.as_bytes().to_vec();
        assert!(bytes.ends_with(b"FTape"));
        let mut mutated = bytes;
        *mutated.last_mut().unwrap() ^= 1;
        contract.outputs[tape_vout].script_pubkey = Script::from_bytes(mutated);
    });
    assert_released_pool_authority_rejected(&noncanonical_tape);
}

fn semantic_ftlp_maintenance_plan(
    _value: &Value,
    candidate_count: u8,
    lock: FtlpLockMode,
) -> UnsignedPlan {
    authority_bound_ftlp_maintenance_plan(candidate_count, lock).0
}

#[test]
fn ftlp_begin_signing_rejects_fee_only_descendant_pool_dependency() {
    let (mut plan, _) =
        authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard);
    begin_signing(&plan).expect("canonical asset-consuming descendant precondition");

    let maintenance = plan.transactions[0].clone();
    let mut unrelated_asset = maintenance.inputs[0].clone();
    let mut unrelated_recipe = decoded_ftlp_recipe(&unrelated_asset);
    let TransactionSource::Raw(parent_raw) = &unrelated_recipe.parent else {
        panic!("round-zero unrelated FTLP parent must be raw")
    };
    let mut parent = Transaction::from_hex(parent_raw).unwrap();
    let TransactionSource::Raw(proof_raw) = &unrelated_recipe.proof_references[0].source else {
        panic!("round-zero unrelated FTLP proof must be raw")
    };
    let mut proof = Transaction::from_hex(proof_raw).unwrap();
    proof.inputs[0].previous_output.txid = Txid::from_le_bytes([0x41; 32]);
    parent.inputs[0].previous_output.txid = proof.txid();
    unrelated_recipe.parent = TransactionSource::Raw(parent.to_hex());
    unrelated_recipe.proof_references[0].source = TransactionSource::Raw(proof.to_hex());
    unrelated_recipe.ordered_input_index = 0;
    unrelated_recipe.ordered_input_count = 1;
    replace_ftlp_recipe(&mut unrelated_asset, unrelated_recipe);
    unrelated_asset.previous_transaction_id = parent.txid().to_string();
    unrelated_asset.previous_output_script = hex(parent.outputs[0].script_pubkey.as_bytes());
    unrelated_asset.previous_output_satoshis = parent.outputs[0].satoshis;

    let primary = &mut plan.transactions[1];
    primary.inputs[1] = unrelated_asset;
    primary.inputs.push(PlannedInput {
        previous_transaction_id: maintenance.transaction_id.clone(),
        previous_output_index: 2,
        previous_output_script: maintenance.outputs[2].locking_script.clone(),
        previous_output_satoshis: maintenance.outputs[2].satoshis,
        sequence: tbc_sdk::DEFAULT_SEQUENCE,
        unlocking_script: String::new(),
        signer: public_context(),
    });
    assert!(primary.inputs.iter().any(|input| {
        input.previous_transaction_id == maintenance.transaction_id
            && input.previous_output_index == 2
    }));
    assert!(!primary.inputs.iter().any(|input| {
        input.previous_transaction_id == maintenance.transaction_id
            && input.previous_output_index == 0
    }));

    assert_eq!(
        begin_signing(&plan).unwrap_err().message,
        "FTLP maintenance descendant Pool input shape is invalid"
    );
}

#[test]
fn ftlp_begin_signing_binds_released_identity_to_pool_authority_and_signer() {
    let (plan, authority) =
        authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard);
    begin_signing(&plan).expect("canonical authority-bound precondition");
    let owner = Address::from_string(OWNER_ADDRESS).unwrap();
    let other_owner = Address::from_string("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH").unwrap();

    let mut mutations = Vec::new();
    mutations.push((
        "owner",
        transfer_ftlp_code_script(
            &authority_code(
                &authority,
                &owner,
                authority.pool_hash,
                authority.version,
                authority.is_coin,
                authority.tape_size,
            ),
            &other_owner,
        )
        .unwrap(),
    ));
    let mut wrong_pool_hash = authority.pool_hash;
    wrong_pool_hash[0] ^= 1;
    mutations.push((
        "poolHash",
        authority_code(
            &authority,
            &owner,
            wrong_pool_hash,
            authority.version,
            authority.is_coin,
            authority.tape_size,
        ),
    ));
    let wrong_version = if authority.version == FtScriptVersion::V4 {
        FtScriptVersion::V3
    } else {
        FtScriptVersion::V4
    };
    mutations.push((
        "version",
        authority_code(
            &authority,
            &owner,
            authority.pool_hash,
            wrong_version,
            authority.is_coin,
            authority.tape_size,
        ),
    ));
    mutations.push((
        "coinMode",
        authority_code(
            &authority,
            &owner,
            authority.pool_hash,
            authority.version,
            !authority.is_coin,
            authority.tape_size,
        ),
    ));
    mutations.push((
        "tapeSize",
        authority_code(
            &authority,
            &owner,
            authority.pool_hash,
            authority.version,
            authority.is_coin,
            authority.tape_size + 1,
        ),
    ));

    for (field, replacement) in mutations {
        let mut changed = plan.clone();
        replace_maintenance_codes(&mut changed, &replacement);
        let error = begin_signing(&changed).expect_err(field);
        assert_eq!(error.code, ErrorCode::InvalidPlan, "{field}");
        assert_eq!(
            error.message,
            "FTLP maintenance identity does not match authenticated Pool authority and signer",
            "{field}",
        );
    }
}

#[test]
fn ftlp_begin_signing_accepts_policy_reconciled_spendable_fee_change() {
    let (plan, _) = authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard);
    begin_signing(&plan).expect("canonical fixed-fee precondition");
    let canonical = plan.transactions[0].outputs[2].satoshis;
    assert!(canonical > tbc_sdk::SDK_DUST_SAT + 2);
    for (mutation, changed_value) in [
        ("minusOne", canonical - 1),
        ("plusOne", canonical + 1),
        ("dustOnly", tbc_sdk::SDK_DUST_SAT),
        ("excessiveFee", canonical / 2),
    ] {
        let mut changed = plan.clone();
        changed.transactions[0].outputs[2].satoshis = changed_value;
        begin_signing(&changed).expect(mutation);
    }
}

fn decoded_ftlp_recipe(input: &PlannedInput) -> FtlpUnlockRecipe {
    serde_json::from_slice(&decode_hex(
        input
            .unlocking_script
            .strip_prefix("ftlp1:")
            .expect("FTLP descriptor prefix"),
    ))
    .unwrap()
}

fn replace_ftlp_recipe(input: &mut PlannedInput, recipe: FtlpUnlockRecipe) {
    input.unlocking_script = ftlp_unlocking_descriptor(recipe).unwrap();
}

#[derive(Clone, Copy)]
enum TwoVoutProofSource {
    Raw,
    Evidence,
}

#[derive(Clone, Copy)]
enum TwoVoutProofMutation {
    Exact,
    Swapped,
    Duplicated,
}

fn two_vout_proof_material(
    parent_source: &TransactionSource,
    first_reference: &ProofReference,
    spent_vout: usize,
    source_mode: TwoVoutProofSource,
    mutation: TwoVoutProofMutation,
    evidence_table: &mut Vec<EvidenceEntry>,
) -> (Transaction, Vec<ProofReference>) {
    let TransactionSource::Raw(parent_raw) = parent_source else {
        panic!("two-vout fixture parent must start as raw")
    };
    let TransactionSource::Raw(proof_raw) = &first_reference.source else {
        panic!("two-vout fixture proof must start as raw")
    };
    let mut parent = Transaction::from_hex(parent_raw).unwrap();
    let mut proof = Transaction::from_hex(proof_raw).unwrap();
    let proof_output = proof
        .outputs
        .get(first_reference.output_index as usize)
        .expect("fixture proof output")
        .clone();
    proof.outputs = vec![proof_output.clone(), proof_output];

    let first_input = parent.inputs.first().expect("fixture parent input").clone();
    let mut source_zero = first_input.clone();
    source_zero.previous_output = OutPoint { txid: proof.txid(), vout: 0 };
    let mut source_one = first_input;
    source_one.previous_output = OutPoint { txid: proof.txid(), vout: 1 };
    parent.inputs = vec![source_zero, source_one];

    let tape = parent.outputs.get(spent_vout + 1).expect("adjacent fixture Tape");
    let total = balance_from_tape(&tape.script_pubkey).expect("fixture Tape balance");
    assert!(total >= 2, "two-vout fixture requires two positive source amounts");
    let first = total / 2;
    let second = total - first;
    let (amounts, _) = build_tape_amount(total, &[first, second]).unwrap();
    parent.outputs[spent_vout + 1].script_pubkey =
        transfer_tape_script(&tape.script_pubkey, &amounts).unwrap();

    let source = match source_mode {
        TwoVoutProofSource::Raw => TransactionSource::Raw(proof.to_hex()),
        TwoVoutProofSource::Evidence => {
            let index = u32::try_from(evidence_table.len()).unwrap();
            evidence_table.push(EvidenceEntry {
                txid: proof.txid().to_string(),
                raw_transaction: proof.to_hex(),
            });
            TransactionSource::Evidence(index)
        }
    };
    let output_indexes = match mutation {
        TwoVoutProofMutation::Exact => [1, 0],
        TwoVoutProofMutation::Swapped => [0, 1],
        TwoVoutProofMutation::Duplicated => [1, 1],
    };
    let references = output_indexes
        .into_iter()
        .map(|output_index| ProofReference { source: source.clone(), output_index })
        .collect::<Vec<_>>();
    assert_eq!(parent.inputs[0].previous_output, OutPoint { txid: proof.txid(), vout: 0 });
    assert_eq!(parent.inputs[1].previous_output, OutPoint { txid: proof.txid(), vout: 1 });
    assert!(proof.outputs.get(0).is_some() && proof.outputs.get(1).is_some());
    (parent, references)
}

fn bind_ftlp_two_vout_proofs(
    plan: &mut UnsignedPlan,
    transaction_index: usize,
    input_index: usize,
    source_mode: TwoVoutProofSource,
    mutation: TwoVoutProofMutation,
) {
    let mut recipe = decoded_ftlp_recipe(&plan.transactions[transaction_index].inputs[input_index]);
    let old_parent = recipe.parent.clone();
    let (parent, references) = two_vout_proof_material(
        &recipe.parent,
        &recipe.proof_references[0],
        plan.transactions[transaction_index].inputs[input_index].previous_output_index as usize,
        source_mode,
        mutation,
        &mut plan.evidence_table,
    );
    recipe.parent = TransactionSource::Raw(parent.to_hex());
    recipe.proof_references = references;
    let input = &mut plan.transactions[transaction_index].inputs[input_index];
    input.previous_transaction_id = parent.txid().to_string();
    input.previous_output_script = hex(parent.outputs[input.previous_output_index as usize].script_pubkey.as_bytes());
    input.previous_output_satoshis = parent.outputs[input.previous_output_index as usize].satoshis;
    replace_ftlp_recipe(input, recipe);
    let replacement = TransactionSource::Raw(parent.to_hex());
    for transaction in &mut plan.transactions[transaction_index + 1..] {
        for later_input in &mut transaction.inputs {
            if !later_input.unlocking_script.starts_with("ftlp1:") {
                continue;
            }
            let mut later_recipe = decoded_ftlp_recipe(later_input);
            let mut changed = false;
            for proof in &mut later_recipe.proof_references {
                if proof.source == old_parent {
                    proof.source = replacement.clone();
                    changed = true;
                }
            }
            if changed {
                replace_ftlp_recipe(later_input, later_recipe);
            }
        }
    }
}

fn bind_pool_held_two_vout_proofs(
    plan: &mut UnsignedPlan,
    transaction_index: usize,
    input_index: usize,
    source_mode: TwoVoutProofSource,
    mutation: TwoVoutProofMutation,
) {
    let input = &plan.transactions[transaction_index].inputs[input_index];
    let mut recipe = pool_held_ft_recipe_from_descriptor(&input.unlocking_script);
    let (parent, references) = two_vout_proof_material(
        &recipe.parent,
        &recipe.proof_references[0],
        input.previous_output_index as usize,
        source_mode,
        mutation,
        &mut plan.evidence_table,
    );
    recipe.parent = TransactionSource::Raw(parent.to_hex());
    recipe.proof_references = references;
    let input = &mut plan.transactions[transaction_index].inputs[input_index];
    input.previous_transaction_id = parent.txid().to_string();
    input.previous_output_script = hex(parent.outputs[input.previous_output_index as usize].script_pubkey.as_bytes());
    input.previous_output_satoshis = parent.outputs[input.previous_output_index as usize].satoshis;
    replace_pool_held_recipe(input, recipe);
}

fn assert_all_signing_stages_finalize(plan: &UnsignedPlan) {
    let mut stage = begin_signing(plan).expect("canonical exact-proof plan must begin signing");
    loop {
        let signatures = stage
            .signing_requests
            .iter()
            .map(dynamic_signature)
            .collect::<Vec<_>>();
        match finalize_signing_stage(plan, stage, &signatures).unwrap() {
            StageOutcome::Pending(next) => stage = next,
            StageOutcome::Complete(_) => break,
        }
    }
}

fn assert_two_vout_proof_mutations_rejected(
    build: impl Fn(TwoVoutProofSource, TwoVoutProofMutation) -> UnsignedPlan,
    expected_message: &str,
) {
    for source in [TwoVoutProofSource::Raw, TwoVoutProofSource::Evidence] {
        let canonical = build(source, TwoVoutProofMutation::Exact);
        assert_all_signing_stages_finalize(&canonical);
        for mutation in [TwoVoutProofMutation::Swapped, TwoVoutProofMutation::Duplicated] {
            let changed = build(source, mutation);
            let error = begin_signing(&changed).expect_err("inexact proof vout reached requests");
            assert_eq!(error.code, ErrorCode::InvalidPlan);
            assert_eq!(error.message, expected_message);
        }
    }
}

#[test]
fn direct_ftlp_recipe_binds_same_transaction_proof_vouts_exactly() {
    let value = vector("standard-ftlp");
    assert_two_vout_proof_mutations_rejected(
        |source, mutation| {
            let mut plan = ftlp_plan(&value, 1, FtlpLockMode::Standard);
            bind_ftlp_two_vout_proofs(&mut plan, 0, 0, source, mutation);
            plan
        },
        "Pool proof does not match its ordered parent input",
    );
}

#[test]
fn first_round_ftlp_maintenance_binds_same_transaction_proof_vouts_exactly() {
    assert_two_vout_proof_mutations_rejected(
        |source, mutation| {
            let mut plan = authority_bound_ftlp_maintenance_plan(2, FtlpLockMode::Standard).0;
            bind_ftlp_two_vout_proofs(&mut plan, 0, 0, source, mutation);
            plan
        },
        "FTLP maintenance pre-pre proof set is invalid",
    );
}

#[test]
fn earlier_pool_ft_maintenance_binds_same_transaction_proof_vouts_exactly() {
    let value = vector("tbc-to-ft-pool-held-ft-v3");
    assert_two_vout_proof_mutations_rejected(
        |source, mutation| {
            let descriptor = pool_held_ft_unlocking_descriptor(pool_held_ft_recipe(&value)).unwrap();
            let mut plan = single_recipe_plan(&value, descriptor);
            plan.transactions[0].transaction_id = "pool-ft-merge-0".to_owned();
            plan.transactions[0].role = "maintenance".to_owned();
            let input_index = usize::try_from(value["inputIndex"].as_u64().unwrap()).unwrap();
            bind_pool_held_two_vout_proofs(&mut plan, 0, input_index, source, mutation);
            plan
        },
        "Pool proof does not match its ordered parent input",
    );
}

fn assert_single_stage_ftlp_complete(plan: &UnsignedPlan) {
    let stage = begin_signing(plan).unwrap();
    let signatures = stage
        .signing_requests
        .iter()
        .map(dynamic_signature)
        .collect::<Vec<_>>();
    let StageOutcome::Pending(next) =
        finalize_signing_stage(plan, stage, &signatures).unwrap()
    else {
        panic!("FTLP maintenance must finalize into its authenticated primary continuation")
    };
    let primary_id = &plan.transactions.last().unwrap().transaction_id;
    assert!(next.signing_requests.iter().all(|request| &request.transaction_id == primary_id));
}

fn two_proof_ftlp_maintenance_plan(value: &Value) -> UnsignedPlan {
    let mut plan = semantic_ftlp_maintenance_plan(value, 2, FtlpLockMode::Standard);
    let mut balances = Vec::new();
    let mut first_tape = None;
    for (index, input) in plan.transactions[0].inputs[..2].iter_mut().enumerate() {
        let mut recipe = decoded_ftlp_recipe(input);
        let TransactionSource::Raw(parent_raw) = &recipe.parent else {
            panic!("round-zero FTLP parent must be raw")
        };
        let mut parent = Transaction::from_hex(parent_raw).unwrap();
        let TransactionSource::Raw(first_proof_raw) = &recipe.proof_references[0].source else {
            panic!("round-zero FTLP proof must be raw")
        };
        let first_proof = Transaction::from_hex(first_proof_raw).unwrap();
        let mut second_proof = first_proof.clone();
        second_proof.inputs[0].previous_output.txid =
            Txid::from_le_bytes([0x40 + u8::try_from(index).unwrap(); 32]);
        let mut second_parent_input = parent.inputs[0].clone();
        second_parent_input.previous_output.txid = second_proof.txid();
        parent.inputs.push(second_parent_input);
        let source_balance = balance_from_tape(&parent.outputs[1].script_pubkey).unwrap();
        let candidate_balance = source_balance.checked_mul(2).unwrap();
        let (source_amounts, _) =
            build_tape_amount(candidate_balance, &[source_balance, source_balance]).unwrap();
        parent.outputs[1].script_pubkey =
            transfer_tape_script(&parent.outputs[1].script_pubkey, &source_amounts).unwrap();
        recipe.parent = TransactionSource::Raw(parent.to_hex());
        recipe.proof_references = vec![
            ProofReference {
                source: TransactionSource::Raw(second_proof.to_hex()),
                output_index: parent.inputs[1].previous_output.vout,
            },
            ProofReference {
                source: TransactionSource::Raw(first_proof.to_hex()),
                output_index: parent.inputs[0].previous_output.vout,
            },
        ];
        input.previous_transaction_id = parent.txid().to_string();
        input.previous_output_script = hex(parent.outputs[0].script_pubkey.as_bytes());
        input.previous_output_satoshis = parent.outputs[0].satoshis;
        replace_ftlp_recipe(input, recipe);
        balances.push(candidate_balance);
        first_tape.get_or_insert(parent.outputs[1].script_pubkey.clone());
    }
    let total = balances.iter().copied().sum::<u128>();
    let (merged_amounts, _) = build_tape_amount(total, &balances).unwrap();
    plan.transactions[0].outputs[1].locking_script = hex(
        transfer_tape_script(&first_tape.unwrap(), &merged_amounts)
            .unwrap()
            .as_bytes(),
    );
    plan
}

#[test]
fn ftlp_begin_signing_semantics_accept_canonical_standard_and_locked_finalization() {
    let standard = semantic_ftlp_maintenance_plan(
        &vector("standard-ftlp"),
        2,
        FtlpLockMode::Standard,
    );
    assert_single_stage_ftlp_complete(&standard);

    let locked = semantic_ftlp_maintenance_plan(
        &vector("locked-ftlp-height"),
        2,
        FtlpLockMode::BlockHeight {
            lock_height: 90,
            current_height: 100,
        },
    );
    assert_single_stage_ftlp_complete(&locked);
}

#[test]
fn ftlp_begin_signing_semantics_rejects_non_ftlp_code_parents() {
    let value = vector("standard-ftlp");
    let mut plan = semantic_ftlp_maintenance_plan(&value, 2, FtlpLockMode::Standard);
    for input in &mut plan.transactions[0].inputs[..2] {
        let mut recipe = decoded_ftlp_recipe(input);
        let TransactionSource::Raw(parent_raw) = &recipe.parent else {
            panic!("round-zero FTLP parent must be raw")
        };
        let mut parent = Transaction::from_hex(parent_raw).unwrap();
        parent.outputs[0].script_pubkey = Script::from_bytes(decode_hex(OWNER_SCRIPT));
        recipe.parent = TransactionSource::Raw(parent.to_hex());
        input.previous_transaction_id = parent.txid().to_string();
        input.previous_output_script = OWNER_SCRIPT.to_owned();
        replace_ftlp_recipe(input, recipe);
    }
    plan.transactions[0].outputs[0].locking_script = OWNER_SCRIPT.to_owned();
    plan.transactions.last_mut().unwrap().inputs[1].previous_output_script = OWNER_SCRIPT.to_owned();

    let error = begin_signing(&plan).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(
        error.message,
        "FTLP maintenance identity does not match authenticated Pool authority and signer"
    );
}

#[test]
fn ftlp_begin_signing_semantics_rejects_standard_locked_recipe_swaps() {
    let mut locked_as_standard = semantic_ftlp_maintenance_plan(
        &vector("locked-ftlp-height"),
        2,
        FtlpLockMode::BlockHeight {
            lock_height: 90,
            current_height: 100,
        },
    );
    for input in &mut locked_as_standard.transactions[0].inputs[..2] {
        let mut recipe = decoded_ftlp_recipe(input);
        recipe.lock = FtlpLockMode::Standard;
        replace_ftlp_recipe(input, recipe);
        input.sequence = tbc_sdk::DEFAULT_SEQUENCE;
    }
    locked_as_standard.transactions[0].lock_time = 0;
    let error = begin_signing(&locked_as_standard).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(
        error.message,
        "FTLP maintenance recipe lock does not match authenticated Tape and transaction"
    );

    let mut standard_as_locked = semantic_ftlp_maintenance_plan(
        &vector("standard-ftlp"),
        2,
        FtlpLockMode::Standard,
    );
    for input in &mut standard_as_locked.transactions[0].inputs[..2] {
        let mut recipe = decoded_ftlp_recipe(input);
        recipe.lock = FtlpLockMode::BlockHeight {
            lock_height: 0,
            current_height: 100,
        };
        replace_ftlp_recipe(input, recipe);
        input.sequence = tbc_sdk::DEFAULT_SEQUENCE - 1;
    }
    standard_as_locked.transactions[0].lock_time = 100;
    let error = begin_signing(&standard_as_locked).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(
        error.message,
        "FTLP maintenance recipe lock does not match authenticated Tape and transaction"
    );
}

#[test]
fn ftlp_begin_signing_semantics_rejects_wrong_authenticated_lock_height() {
    let plan = semantic_ftlp_maintenance_plan(
        &vector("locked-ftlp-height"),
        2,
        FtlpLockMode::BlockHeight {
            lock_height: 89,
            current_height: 100,
        },
    );
    let error = begin_signing(&plan).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(
        error.message,
        "FTLP maintenance recipe lock does not match authenticated Tape and transaction"
    );
}

#[test]
fn ftlp_begin_signing_semantics_rejects_current_height_locktime_mismatch() {
    let mut plan = semantic_ftlp_maintenance_plan(
        &vector("locked-ftlp-height"),
        2,
        FtlpLockMode::BlockHeight {
            lock_height: 90,
            current_height: 100,
        },
    );
    plan.transactions[0].lock_time = 101;
    let error = begin_signing(&plan).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(error.message, "FTLP block-height lock domain is invalid");
}

#[test]
fn ftlp_begin_signing_semantics_rejects_reordered_proof_references() {
    let mut plan = two_proof_ftlp_maintenance_plan(&vector("standard-ftlp"));
    assert!(begin_signing(&plan).is_ok(), "valid ordered proof precondition");
    let mut recipe = decoded_ftlp_recipe(&plan.transactions[0].inputs[0]);
    recipe.proof_references.reverse();
    replace_ftlp_recipe(&mut plan.transactions[0].inputs[0], recipe);

    let error = begin_signing(&plan).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(error.message, "FTLP maintenance pre-pre proof set is invalid");
}

#[test]
fn ftlp_begin_signing_semantics_rejects_substituted_proof_references() {
    let mut plan = two_proof_ftlp_maintenance_plan(&vector("standard-ftlp"));
    assert!(begin_signing(&plan).is_ok(), "valid ordered proof precondition");
    let mut recipe = decoded_ftlp_recipe(&plan.transactions[0].inputs[0]);
    recipe.proof_references[1] = recipe.proof_references[0].clone();
    replace_ftlp_recipe(&mut plan.transactions[0].inputs[0], recipe);

    let error = begin_signing(&plan).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(error.message, "FTLP maintenance pre-pre proof set is invalid");
}

#[test]
fn ftlp_merge_recipe_accepts_five_candidates_and_rejects_six() {
    let value = vector("standard-ftlp");
    let five = semantic_ftlp_maintenance_plan(&value, 5, FtlpLockMode::Standard);
    let accepted = begin_signing(&five).unwrap();
    assert_eq!(accepted.signing_requests.len(), 6);
    assert!(accepted.signing_requests[..5].iter().all(|request| request.script_class == "ftlp-covenant"));
    assert_eq!(accepted.signing_requests[5].script_class, "p2pkh");

    let six = semantic_ftlp_maintenance_plan(&value, 6, FtlpLockMode::Standard);

    let error = begin_signing(&six).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(error.message, "FTLP recipe input count exceeds the released limit");
    assert_eq!(error.path.as_deref(), Some("plan"));
}

#[test]
fn ftlp_maintenance_semantics_accept_canonical_public_signing_topology() {
    let value = vector("standard-ftlp");
    let plan = semantic_ftlp_maintenance_plan(&value, 2, FtlpLockMode::Standard);
    let stage = begin_signing(&plan).unwrap();
    assert_eq!(stage.signing_requests.len(), 3);
    assert_eq!(stage.signing_requests[0].transaction_id, "ftlp-merge-0");
}

#[test]
fn ftlp_maintenance_semantics_reject_combined_role_and_id_relabel() {
    let value = vector("standard-ftlp");
    let mut plan = unique_ftlp_candidate_plan(
        &value,
        2,
        "primary",
        "primary",
        FtlpLockMode::Standard,
    );
    plan.transactions[0].transaction_id = "ftlp-merge-0".to_owned();
    plan.transactions[0].role = "maintenance".to_owned();

    let error = begin_signing(&plan).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(
        error.message,
        "FTLP maintenance must contain only FTLP inputs followed by one fee input"
    );
}

#[test]
fn ftlp_maintenance_semantics_reject_primary_output_shape() {
    let value = vector("standard-ftlp");
    let mut plan = semantic_ftlp_maintenance_plan(&value, 2, FtlpLockMode::Standard);
    plan.transactions[0].outputs.push(PlannedOutput {
        satoshis: 0,
        locking_script: hex(Script::op_return(&[b"primary".to_vec()]).as_bytes()),
    });

    let error = begin_signing(&plan).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(
        error.message,
        "FTLP maintenance outputs must be merged Code, Tape, and fee change"
    );
}

#[test]
fn ftlp_maintenance_semantics_reject_merged_balance_mutation() {
    let value = vector("standard-ftlp");
    let mut plan = semantic_ftlp_maintenance_plan(&value, 2, FtlpLockMode::Standard);
    let mut tape = decode_hex(&plan.transactions[0].outputs[1].locking_script);
    tape[3] ^= 1;
    plan.transactions[0].outputs[1].locking_script = hex(&tape);

    let error = begin_signing(&plan).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(
        error.message,
        "FTLP maintenance merged Tape does not conserve authenticated balance and lock layout"
    );
}

#[test]
fn ftlp_maintenance_semantics_reject_locked_successor_height_mutation() {
    let value = vector("locked-ftlp-height");
    let lock = FtlpLockMode::BlockHeight {
        lock_height: 90,
        current_height: 100,
    };
    let mut plan = semantic_ftlp_maintenance_plan(&value, 2, lock);
    let mut tape = decode_hex(&plan.transactions[0].outputs[1].locking_script);
    assert!(tape.len() > 55);
    tape[52] ^= 1;
    plan.transactions[0].outputs[1].locking_script = hex(&tape);

    let error = begin_signing(&plan).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(
        error.message,
        "FTLP maintenance merged Tape does not conserve authenticated balance and lock layout"
    );
}

#[test]
fn ftlp_maintenance_semantics_reject_round_stage_mismatch() {
    let value = vector("standard-ftlp");
    let mut plan = semantic_ftlp_maintenance_plan(&value, 2, FtlpLockMode::Standard);
    plan.transactions[0].transaction_id = "ftlp-merge-1".to_owned();

    let error = begin_signing(&plan).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(
        error.message,
        "FTLP maintenance stage or dependency chain is invalid"
    );
}

#[test]
fn ftlp_maintenance_identity_rejects_role_only_standard_relabel() {
    let value = vector("standard-ftlp");
    let mut plan = unique_ftlp_candidate_plan(
        &value,
        2,
        "primary",
        "primary",
        FtlpLockMode::Standard,
    );
    plan.transactions[0].role = "maintenance".to_owned();

    let error = begin_signing(&plan).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(
        error.message,
        "FTLP recipe input count exceeds the released limit"
    );
    assert_eq!(error.path.as_deref(), Some("plan"));
}

#[test]
fn ftlp_maintenance_identity_rejects_id_only_standard_relabel() {
    let value = vector("standard-ftlp");
    let mut plan = unique_ftlp_candidate_plan(
        &value,
        2,
        "primary",
        "primary",
        FtlpLockMode::Standard,
    );
    plan.transactions[0].transaction_id = "ftlp-merge-0".to_owned();

    let error = begin_signing(&plan).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(
        error.message,
        "FTLP recipe input count exceeds the released limit"
    );
    assert_eq!(error.path.as_deref(), Some("plan"));
}

#[test]
fn locked_ftlp_primary_accepts_the_released_six_input_bound() {
    let value = vector("locked-ftlp-height");
    let plan = unique_ftlp_candidate_plan(
        &value,
        6,
        "locked-ftlp-primary",
        "primary",
        FtlpLockMode::BlockHeight { lock_height: 90, current_height: 100 },
    );
    let accepted = begin_signing(&plan).unwrap();
    assert_eq!(accepted.signing_requests.len(), 6);
    assert!(accepted.signing_requests.iter().all(|request| request.script_class == "ftlp-covenant"));
}

#[test]
fn planned_parent_resolves_only_after_stage_one_finalizes() {
    let value = vector("stage-two-planned-parent");
    let parent_unsigned = Transaction::from_hex(value["parentUnsignedRaw"].as_str().unwrap()).unwrap();
    let parent_signed = Transaction::from_hex(value["parentSignedRaw"].as_str().unwrap()).unwrap();
    let child = Transaction::from_hex(value["currentRaw"].as_str().unwrap()).unwrap();
    let proof = Transaction::from_hex(value["proofRaws"][0].as_str().unwrap()).unwrap();
    let mut parent_plan = planned_from_tx("parent", 0, vec![], &parent_unsigned);
    parent_plan.inputs[0].previous_output_script = OWNER_SCRIPT.to_owned();
    parent_plan.inputs[0].previous_output_satoshis = proof.outputs[0].satoshis;
    let descriptor = ftlp_unlocking_descriptor(FtlpUnlockRecipe {
        parent: TransactionSource::Planned("parent".to_owned()),
        proof_references: vec![ProofReference {
            source: TransactionSource::Raw(proof.to_hex()),
            output_index: 0,
        }],
        lock: FtlpLockMode::Standard,
        ordered_input_index: 0,
        ordered_input_count: 1,
    })
    .unwrap();
    let mut child_plan = planned_from_tx("child", 1, vec!["parent".to_owned()], &child);
    child_plan.inputs[0].previous_transaction_id = "parent".to_owned();
    child_plan.inputs[0].previous_output_script = hex(parent_signed.outputs[0].script_pubkey.as_bytes());
    child_plan.inputs[0].previous_output_satoshis = parent_signed.outputs[0].satoshis;
    child_plan.inputs[0].unlocking_script = descriptor;
    let plan = UnsignedPlan { transactions: vec![parent_plan, child_plan], evidence_table: vec![] };

    let first = begin_signing(&plan).unwrap();
    assert_eq!(first.stage, 0);
    assert!(first.signing_requests.iter().all(|request| request.transaction_id == "parent"));
    let first_signature = fixed_signature(&first.signing_requests[0], &value, "parentSignatureWithSighash");
    let StageOutcome::Pending(second) = finalize_signing_stage(&plan, first, &[first_signature]).unwrap()
    else { panic!("expected stage two") };
    assert_eq!(second.stage, 1);
    assert_eq!(second.signing_requests[0].transaction_id, "child");
    let child_signature = fixed_signature(&second.signing_requests[0], &value, "signatureWithSighash");
    let StageOutcome::Complete(bundle) = finalize_signing_stage(&plan, second, &[child_signature]).unwrap()
    else { panic!("expected complete") };
    assert_eq!(bundle.transactions[0].raw_transaction, value["parentSignedRaw"]);
    let child = Transaction::from_hex(&bundle.transactions[1].raw_transaction).unwrap();
    assert_eq!(hex(child.inputs[0].script_sig.as_bytes()), value["expectedUnlockHex"]);
}

#[test]
fn recipe_mutations_and_unexpected_unsigned_signatures_are_rejected() {
    let value = vector("standard-large-pool");
    let mut recipe = pool_recipe(&value);
    recipe.spent_vout = 1;
    assert_eq!(
        begin_signing(&pool_plan(&value, recipe)).unwrap_err().code,
        ErrorCode::InvalidPlan
    );

    let plan = pool_plan(&value, pool_recipe(&value));
    let stage = begin_signing(&plan).unwrap();
    let mut signatures = stage.signing_requests.iter().map(dynamic_signature).collect::<Vec<_>>();
    let mut unexpected = dynamic_signature(&stage.signing_requests[0]);
    unexpected.input_index = 0;
    signatures.push(unexpected);
    assert_eq!(
        finalize_signing_stage(&plan, stage, &signatures).unwrap_err().code,
        ErrorCode::InvalidSignature
    );

    let signed = vector("locked-pool-swap");
    let signed_plan = pool_plan(&signed, pool_recipe(&signed));
    let signed_stage = begin_signing(&signed_plan).unwrap();
    let mut supplied = signed_stage
        .signing_requests
        .iter()
        .map(|request| if request.input_index == 0 { fixed_signature(request, &signed, "signatureWithSighash") } else { dynamic_signature(request) })
        .collect::<Vec<_>>();
    supplied[0].public_key = hex(&Address::from_string("1BitcoinEaterAddressDontSendf59kuE").unwrap().hash160());
    assert_eq!(
        finalize_signing_stage(&signed_plan, signed_stage, &supplied).unwrap_err().code,
        ErrorCode::InvalidSignature
    );
}

#[test]
fn pool_recipe_source_operation_and_lock_substitutions_fail_for_their_intended_reason() {
    let value = vector("standard-large-pool");
    let auxiliary = value["auxiliaryParentRaws"].as_array().unwrap();

    let mut recipe = pool_recipe(&value);
    recipe.parent = TransactionSource::Raw(auxiliary[0].as_str().unwrap().to_owned());
    assert_eq!(
        begin_signing(&pool_plan(&value, recipe)).unwrap_err().message,
        "Pool recipe parent does not bind the planned outpoint"
    );

    let mut recipe = pool_recipe(&value);
    recipe.pre_parent = raw_source(&value, "contractRaw");
    assert_eq!(
        begin_signing(&pool_plan(&value, recipe)).unwrap_err().message,
        "released Pool context rejected the authenticated recipe"
    );

    let mut recipe = pool_recipe(&value);
    recipe.contract = raw_source(&value, "preParentRaw").into();
    assert_eq!(
        begin_signing(&pool_plan(&value, recipe)).unwrap_err().message,
        "Pool contract does not match authenticated Pool state"
    );

    let mut recipe = pool_recipe(&value);
    recipe.auxiliary_parents.swap(0, 1);
    assert_eq!(
        begin_signing(&pool_plan(&value, recipe)).unwrap_err().message,
        "released Pool context rejected the authenticated recipe"
    );

    let mut recipe = pool_recipe(&value);
    recipe.operation = PoolRecipeOperation::ConsumeLiquidity;
    recipe.swap = None;
    let plan = pool_plan(&value, recipe);
    let stage = begin_signing(&plan).unwrap();
    let signatures = stage.signing_requests.iter().map(dynamic_signature).collect::<Vec<_>>();
    assert_eq!(
        finalize_signing_stage(&plan, stage, &signatures)
            .unwrap_err()
            .message,
        "released Pool unlock rejected the authenticated recipe"
    );

    let mut recipe = pool_recipe(&value);
    recipe.swap = Some(PoolRecipeSwap::FtToTbc);
    let plan = pool_plan(&value, recipe);
    let stage = begin_signing(&plan).unwrap();
    let signatures = stage.signing_requests.iter().map(dynamic_signature).collect::<Vec<_>>();
    assert_eq!(
        finalize_signing_stage(&plan, stage, &signatures)
            .unwrap_err()
            .message,
        "released Pool unlock rejected the authenticated recipe"
    );

    let locked = vector("locked-pool-swap");
    let mut recipe = pool_recipe(&locked);
    let secp = Secp256k1::new();
    let other = SecretKey::from_byte_array([2; 32]).unwrap();
    recipe.public_key_lock = vec![hex(&SecpPublicKey::from_secret_key(&secp, &other).serialize())];
    assert_eq!(
        begin_signing(&pool_plan(&locked, recipe)).unwrap_err().message,
        "released Pool context rejected the authenticated recipe"
    );

    let held = vector("tbc-to-ft-pool-held-ft-v3");
    let mut recipe = pool_held_ft_recipe(&held);
    recipe.parent = TransactionSource::Raw(held["proofRaws"][0].as_str().unwrap().to_owned());
    assert_pool_held_ft_recipe_rejected(
        &held,
        recipe,
        "Pool covenant parent does not match the planned outpoint",
    );
}

#[test]
fn finalized_pool_held_ft_sighash_tag_coin_and_suffix_mutations_are_rejected() {
    let regular = vector("tbc-to-ft-pool-held-ft-v3");
    let public_key = decode_hex(OWNER_PUBLIC_KEY);
    assert_eq!(
        tamper_finalized_pool_held_script(&regular, |script| {
            let mut public_key_push = vec![public_key.len() as u8];
            public_key_push.extend_from_slice(&public_key);
            let offset = script
                .windows(public_key_push.len())
                .position(|window| window == public_key_push)
                .unwrap();
            script[offset - 1] ^= 1;
        }),
        "finalized signature has the wrong sighash type"
    );
    assert_eq!(
        tamper_finalized_pool_held_script(&regular, |script| {
            let parent = Transaction::from_hex(regular["parentRaw"].as_str().unwrap()).unwrap();
            let parent_data = tbc_sdk::contracts::ft::unlock::pre_tx_data(&parent, 0).unwrap();
            let tag = script.len() - parent_data.len() - 1;
            script[tag] = 0x51;
        }),
        "finalized Pool-held FT unlocking script does not match its recipe"
    );

    let coin = vector("ft-to-tbc-pool-held-ft-v2-coin");
    assert_eq!(
        tamper_finalized_pool_held_script(&coin, |script| {
            let parent = Transaction::from_hex(coin["parentRaw"].as_str().unwrap()).unwrap();
            let parent_data = tbc_sdk::contracts::ft::unlock::pre_tx_data(&parent, 0).unwrap();
            let flag = script.len() - parent_data.len() - 1;
            script[flag] = 0;
        }),
        "finalized Pool-held FT unlocking script does not match its recipe"
    );
    assert_eq!(
        tamper_finalized_pool_held_script(&regular, |script| {
            *script.last_mut().unwrap() ^= 1;
        }),
        "finalized Pool-held FT unlocking script does not match its recipe"
    );
}

#[test]
fn exact_recipe_resource_limits_accept_boundary_and_reject_plus_one() {
    let value = vector("standard-large-pool");
    let mut recipe = pool_recipe(&value);
    recipe.public_key_lock = vec![OWNER_PUBLIC_KEY.to_owned(); 10];
    let descriptor = pool_unlocking_descriptor(recipe.clone()).unwrap();
    assert!(!descriptor.is_empty());
    recipe.public_key_lock.push(OWNER_PUBLIC_KEY.to_owned());
    assert_eq!(pool_unlocking_descriptor(recipe).unwrap_err().code, ErrorCode::InvalidPlan);

    let mut recipe = pool_recipe(&value);
    let source = recipe.auxiliary_parents[0].clone();
    recipe.auxiliary_parents = vec![source.clone(); MAX_POOL_AUXILIARY_PARENTS];
    pool_unlocking_descriptor(recipe.clone()).unwrap();
    recipe.auxiliary_parents.push(source);
    let error = pool_unlocking_descriptor(recipe).unwrap_err();
    assert_eq!(error.message, "Pool recipe exceeds the auxiliary-parent budget");

    let ft = vector("tbc-to-ft-pool-held-ft-v3");
    let mut proof_set = proofs(&ft);
    while proof_set.len() < 6 {
        proof_set.push(proof_set[0].clone());
    }
    pool_held_ft_unlocking_descriptor(PoolHeldFtUnlockRecipe {
        parent: raw_source(&ft, "parentRaw"),
        proof_references: proof_set.clone(),
        contract: raw_source(&ft, "contractRaw"),
        ft_version: 4,
        coin_mode: false,
        logical_swap_input_index: 0,
    })
    .unwrap();
    proof_set.push(proof_set[0].clone());
    assert_eq!(
        pool_held_ft_unlocking_descriptor(PoolHeldFtUnlockRecipe {
            parent: raw_source(&ft, "parentRaw"),
            proof_references: proof_set,
            contract: raw_source(&ft, "contractRaw"),
            ft_version: 4,
            coin_mode: false,
            logical_swap_input_index: 0,
        })
        .unwrap_err()
        .code,
        ErrorCode::InvalidPlan
    );

    let raw_exact = "00".repeat(MAX_POOL_RECIPE_RAW_BYTES);
    let exact_raw_recipe = PoolHeldFtUnlockRecipe {
        parent: TransactionSource::Raw(raw_exact),
        proof_references: vec![ProofReference {
            source: TransactionSource::Evidence(0),
            output_index: 0,
        }],
        contract: TransactionSource::Evidence(1),
        ft_version: 1,
        coin_mode: false,
        logical_swap_input_index: 0,
    };
    pool_held_ft_unlocking_descriptor(exact_raw_recipe).unwrap();
    let plus_one_raw_recipe = PoolHeldFtUnlockRecipe {
        parent: TransactionSource::Raw("00".repeat(MAX_POOL_RECIPE_RAW_BYTES + 1)),
        proof_references: vec![ProofReference {
            source: TransactionSource::Evidence(0),
            output_index: 0,
        }],
        contract: TransactionSource::Evidence(1),
        ft_version: 1,
        coin_mode: false,
        logical_swap_input_index: 0,
    };
    assert_eq!(
        pool_held_ft_unlocking_descriptor(plus_one_raw_recipe)
            .unwrap_err()
            .message,
        "Pool recipe raw source exceeds the byte budget"
    );

    let mut serialized = PoolUnlockRecipe {
        parent: TransactionSource::Evidence(0),
        pre_parent: TransactionSource::Evidence(1),
        contract: TransactionSource::Evidence(2).into(),
        auxiliary_parents: vec![],
        spent_vout: 0,
        operation: PoolRecipeOperation::Swap,
        swap: Some(PoolRecipeSwap::TbcToFt),
        with_lock: false,
        service_provider: String::new(),
        public_key_lock: vec![],
    };
    let empty_size = serde_json::to_vec(&serialized).unwrap().len();
    serialized.service_provider = "x".repeat(MAX_POOL_RECIPE_SERIALIZED_BYTES - empty_size);
    assert_eq!(serde_json::to_vec(&serialized).unwrap().len(), MAX_POOL_RECIPE_SERIALIZED_BYTES);
    pool_unlocking_descriptor(serialized.clone()).unwrap();
    serialized.service_provider.push('x');
    assert_eq!(
        pool_unlocking_descriptor(serialized).unwrap_err().message,
        "Pool recipe exceeds the serialized byte budget"
    );

    let standard = vector("standard-ftlp");
    begin_signing(&ftlp_plan(&standard, MAX_STANDARD_FTLP_INPUTS, FtlpLockMode::Standard)).unwrap();
    assert_eq!(
        begin_signing(&ftlp_plan(
            &standard,
            MAX_STANDARD_FTLP_INPUTS + 1,
            FtlpLockMode::Standard,
        ))
        .unwrap_err()
        .message,
        "FTLP recipe input count exceeds the released limit"
    );

    let locked = vector("locked-ftlp-height");
    let lock = FtlpLockMode::BlockHeight { lock_height: 90, current_height: 100 };
    begin_signing(&ftlp_plan(&locked, LOCKED_FTLP_INPUT_LIMIT, lock)).unwrap();
    assert_eq!(
        begin_signing(&ftlp_plan(&locked, LOCKED_FTLP_INPUT_LIMIT + 1, lock))
            .unwrap_err()
            .message,
        "FTLP recipe input count exceeds the released limit"
    );
}

fn decode_hex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
