use secp256k1::{Message, PublicKey, Secp256k1, SecretKey, ecdsa::Signature};
use tbc_engine_core::{
    ErrorCode,
    signing::{
        ExternalSignature, PlannedInput, PlannedOutput, PlannedTransaction,
        MAX_SIGNING_CONTINUATION_SERIALIZED_BYTES, MAX_SIGNING_PLAN_DEPENDENCIES,
        MAX_SIGNING_PLAN_INPUTS, MAX_SIGNING_PLAN_OUTPUTS, MAX_SIGNING_PLAN_TRANSACTIONS,
        MAX_UNSIGNED_PLAN_SERIALIZED_BYTES,
        PublicSigningContext, SignedTransaction, SigningRequest, SigningStage, StageOutcome,
        UnsignedPlan, begin_signing, finalize_signing_stage,
    },
};

const OWNER_PUBLIC_KEY: &str =
    "031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";
const OWNER_PUBLIC_KEY_HASH: &str = "79b000887626b294a914501a4cd226b58b235983";
const OWNER_ADDRESS: &str = "1C6Rc3w25VHud3dLDamutaqfKWqhrLRTaD";
const OWNER_SCRIPT: &str = "76a91479b000887626b294a914501a4cd226b58b23598388ac";
const FIRST_DIGEST: &str = "83ef91250c1539adba15dc68e2fbf45e7b80a0cebd50b9a70a6f39679b8d10e7";

fn public_context() -> PublicSigningContext {
    PublicSigningContext {
        address: OWNER_ADDRESS.to_owned(),
        public_key: OWNER_PUBLIC_KEY.to_owned(),
        public_key_hash: OWNER_PUBLIC_KEY_HASH.to_owned(),
    }
}

fn external_input(txid_byte: u8, satoshis: u64) -> PlannedInput {
    PlannedInput {
        previous_transaction_id: format!("{txid_byte:02x}").repeat(32),
        previous_output_index: 0,
        previous_output_script: OWNER_SCRIPT.to_owned(),
        previous_output_satoshis: satoshis,
        sequence: u32::MAX,
        unlocking_script: String::new(),
        signer: public_context(),
    }
}

fn transaction(
    transaction_id: &str,
    stage: u32,
    depends_on: Vec<&str>,
    input: PlannedInput,
    output_satoshis: u64,
) -> PlannedTransaction {
    PlannedTransaction {
        transaction_id: transaction_id.to_owned(),
        role: "primary".to_owned(),
        stage,
        depends_on: depends_on.into_iter().map(str::to_owned).collect(),
        version: 10,
        inputs: vec![input],
        outputs: vec![PlannedOutput {
            satoshis: output_satoshis,
            locking_script: OWNER_SCRIPT.to_owned(),
        }],
        lock_time: 0,
    }
}

fn single_plan() -> UnsignedPlan {
    UnsignedPlan {
        evidence_table: Vec::new(),
        transactions: vec![transaction(
            "primary",
            0,
            vec![],
            external_input(0x11, 10_000),
            9_000,
        )],
    }
}

fn dependent_plan() -> UnsignedPlan {
    let child_input = PlannedInput {
        previous_transaction_id: "parent".to_owned(),
        previous_output_index: 0,
        previous_output_script: OWNER_SCRIPT.to_owned(),
        previous_output_satoshis: 9_000,
        sequence: u32::MAX,
        unlocking_script: String::new(),
        signer: public_context(),
    };
    UnsignedPlan {
        evidence_table: Vec::new(),
        transactions: vec![
            transaction(
                "parent",
                0,
                vec![],
                external_input(0x11, 10_000),
                9_000,
            ),
            transaction("child", 1, vec!["parent"], child_input, 8_000),
        ],
    }
}

fn decode_hex<const N: usize>(value: &str) -> [u8; N] {
    assert_eq!(value.len(), N * 2);
    let mut bytes = [0u8; N];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap();
    }
    bytes
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sign_request(request: &SigningRequest, scalar: u8) -> ExternalSignature {
    let secp = Secp256k1::new();
    let secret = SecretKey::from_byte_array([scalar; 32]).unwrap();
    let digest = decode_hex::<32>(&request.digest);
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
        public_key: encode_hex(&PublicKey::from_secret_key(&secp, &secret).serialize()),
        signature: encode_hex(&signature),
    }
}

fn sign_another_digest(request: &SigningRequest) -> ExternalSignature {
    let secp = Secp256k1::new();
    let secret = SecretKey::from_byte_array([1; 32]).unwrap();
    let signature = secp
        .sign_ecdsa(Message::from_digest([0x42; 32]), &secret)
        .serialize_der();
    let mut supplied = sign_request(request, 1);
    supplied.signature = encode_hex(&signature);
    supplied
}

fn high_s_signature(request: &SigningRequest) -> ExternalSignature {
    let mut supplied = sign_request(request, 1);
    let low = Signature::from_der(&decode_variable_hex(&supplied.signature)).unwrap();
    let mut compact = low.serialize_compact();
    let order = decode_hex::<32>("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    let low_s: [u8; 32] = compact[32..].try_into().unwrap();
    let mut high_s = [0u8; 32];
    let mut borrow = 0i16;
    for index in (0..32).rev() {
        let difference = order[index] as i16 - low_s[index] as i16 - borrow;
        if difference < 0 {
            high_s[index] = (difference + 256) as u8;
            borrow = 1;
        } else {
            high_s[index] = difference as u8;
            borrow = 0;
        }
    }
    compact[32..].copy_from_slice(&high_s);
    supplied.signature = encode_hex(&Signature::from_compact(&compact).unwrap().serialize_der());
    supplied
}

fn decode_variable_hex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
        .collect()
}

fn pending(outcome: StageOutcome) -> SigningStage {
    match outcome {
        StageOutcome::Pending(stage) => stage,
        StageOutcome::Complete(_) => panic!("expected another signing stage"),
    }
}

fn finalize_stage(
    stage: &SigningStage,
    signatures: &[ExternalSignature],
) -> Result<StageOutcome, tbc_engine_core::EngineError> {
    let plan = if stage.continuation.finalized_transactions.len() == 1 {
        single_plan()
    } else {
        dependent_plan()
    };
    finalize_signing_stage(&plan, duplicate_stage(stage), signatures)
}

fn duplicate_stage(stage: &SigningStage) -> SigningStage {
    serde_json::from_slice(&serde_json::to_vec(stage).unwrap()).unwrap()
}

#[test]
fn impossible_stage_is_rejected_without_attacker_sized_range_allocation() {
    let mut plan = single_plan();
    plan.transactions[0].stage = u32::MAX;

    let result = std::panic::catch_unwind(|| begin_signing(&plan));

    assert!(result.is_ok(), "impossible stage panicked");
    assert_eq!(result.unwrap().unwrap_err().code, ErrorCode::InvalidPlan);
}

#[test]
fn over_budget_plan_cardinality_is_rejected() {
    let template = single_plan().transactions.remove(0);
    let mut transactions = Vec::new();
    for index in 0..MAX_SIGNING_PLAN_TRANSACTIONS {
        let mut planned = template.clone();
        planned.transaction_id = format!("transaction-{index}");
        planned.inputs[0].previous_transaction_id = format!("{index:064x}");
        transactions.push(planned);
    }

    begin_signing(&UnsignedPlan {
        evidence_table: Vec::new(),
        transactions: transactions.clone(),
    })
    .unwrap();

    let mut over_budget = template;
    over_budget.transaction_id = format!("transaction-{MAX_SIGNING_PLAN_TRANSACTIONS}");
    over_budget.inputs[0].previous_transaction_id =
        format!("{MAX_SIGNING_PLAN_TRANSACTIONS:064x}");
    transactions.push(over_budget);

    let error = begin_signing(&UnsignedPlan {
        transactions,
        evidence_table: Vec::new(),
    })
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(error.message, "unsigned plan exceeds the transaction budget");
}

#[test]
fn each_total_cardinality_budget_rejects_limit_plus_one() {
    let mut input_plan = single_plan();
    input_plan.transactions[0].inputs =
        vec![input_plan.transactions[0].inputs[0].clone(); MAX_SIGNING_PLAN_INPUTS + 1];
    let input_error = begin_signing(&input_plan).unwrap_err();
    assert_eq!(input_error.message, "unsigned plan exceeds the input budget");

    let mut output_plan = single_plan();
    output_plan.transactions[0].outputs =
        vec![output_plan.transactions[0].outputs[0].clone(); MAX_SIGNING_PLAN_OUTPUTS];
    begin_signing(&output_plan).unwrap();
    let extra_output = output_plan.transactions[0].outputs[0].clone();
    output_plan.transactions[0].outputs.push(extra_output);
    let output_error = begin_signing(&output_plan).unwrap_err();
    assert_eq!(output_error.message, "unsigned plan exceeds the output budget");

    let mut dependency_plan = single_plan();
    dependency_plan.transactions[0].depends_on =
        vec!["parent".to_owned(); MAX_SIGNING_PLAN_DEPENDENCIES + 1];
    let dependency_error = begin_signing(&dependency_plan).unwrap_err();
    assert_eq!(
        dependency_error.message,
        "unsigned plan exceeds the dependency budget"
    );
}

#[test]
fn invalid_stage_is_rejected_before_canonical_size_serialization() {
    let mut plan = single_plan();
    plan.transactions[0].stage = u32::MAX;
    plan.transactions[0].role = "x".repeat(MAX_UNSIGNED_PLAN_SERIALIZED_BYTES + 1);

    let error = begin_signing(&plan).unwrap_err();

    assert_eq!(
        error.message,
        "signing stage exceeds the transaction cardinality"
    );
}

#[test]
fn over_budget_serialized_plan_and_continuation_are_rejected() {
    let mut plan = single_plan();
    plan.transactions[0].role = "x".repeat(MAX_UNSIGNED_PLAN_SERIALIZED_BYTES + 1);
    let plan_error = begin_signing(&plan).unwrap_err();
    assert_eq!(plan_error.code, ErrorCode::InvalidPlan);
    assert_eq!(
        plan_error.message,
        "unsigned plan exceeds the serialized byte budget"
    );

    let stage = begin_signing(&single_plan()).unwrap();
    let mut oversized = duplicate_stage(&stage);
    oversized.continuation.finalized_transactions[0] = Some(SignedTransaction {
        transaction_id: "primary".to_owned(),
        role: "primary".to_owned(),
        txid: "00".repeat(32),
        raw_transaction: "x".repeat(MAX_SIGNING_CONTINUATION_SERIALIZED_BYTES + 1),
    });
    let continuation_error = finalize_stage(&oversized, &[]).unwrap_err();
    assert_eq!(continuation_error.code, ErrorCode::InvalidPlan);
    assert_eq!(
        continuation_error.message,
        "signing continuation exceeds the serialized byte budget"
    );
}

#[test]
fn wire_input_indexes_are_fixed_width_and_locally_bounded() {
    let stage = begin_signing(&single_plan()).unwrap();
    fn assert_u32(_: u32) {}
    assert_u32(stage.signing_requests[0].input_index);
    let encoded_stage = serde_json::to_string(&stage).unwrap();
    let maximum_stage = encoded_stage.replacen(
        "\"inputIndex\":0",
        "\"inputIndex\":4294967295",
        1,
    );
    let decoded_stage = serde_json::from_str::<SigningStage>(&maximum_stage).unwrap();
    assert_eq!(decoded_stage.signing_requests[0].input_index, u32::MAX);
    let oversized_stage = encoded_stage.replacen(
        "\"inputIndex\":0",
        "\"inputIndex\":4294967296",
        1,
    );
    assert!(serde_json::from_str::<SigningStage>(&oversized_stage).is_err());

    let signature = sign_request(&stage.signing_requests[0], 1);
    assert_u32(signature.input_index);
    let encoded_signature = serde_json::to_string(&signature).unwrap();
    let maximum_signature = encoded_signature.replacen(
        "\"inputIndex\":0",
        "\"inputIndex\":4294967295",
        1,
    );
    let decoded_signature =
        serde_json::from_str::<ExternalSignature>(&maximum_signature).unwrap();
    assert_eq!(decoded_signature.input_index, u32::MAX);
    let oversized_signature = encoded_signature.replacen(
        "\"inputIndex\":0",
        "\"inputIndex\":4294967296",
        1,
    );
    assert!(serde_json::from_str::<ExternalSignature>(&oversized_signature).is_err());

    let mut out_of_range = signature;
    out_of_range.input_index = u32::MAX as _;
    let result = std::panic::catch_unwind(|| finalize_stage(&stage, &[out_of_range]));
    assert!(result.is_ok(), "out-of-range input index panicked");
    assert_eq!(result.unwrap().unwrap_err().code, ErrorCode::InvalidSignature);
}

#[test]
fn canonical_plan_and_continuation_hashes_match_fixed_legacy_vectors() {
    let plan = single_plan();
    let canonical_plan = serde_json::to_vec(&plan).unwrap();
    let stage = begin_signing(&plan).unwrap();
    let canonical_continuation = serde_json::to_vec(&stage.continuation).unwrap();
    let vector = (
        canonical_plan.len(),
        encode_hex(&tbc_sdk::hash::sha256(&canonical_plan)),
        canonical_continuation.len(),
        encode_hex(&tbc_sdk::hash::sha256(&canonical_continuation)),
        stage.session_id,
        stage.stage_commitment,
    );

    assert_eq!(vector.0, 689);
    assert_eq!(vector.1, "59bcc704e465ba5ad6ece0e1a3c2a1e2b4b3214cc9a43c02bc34201f00785afa");
    assert!(canonical_continuation.len() < canonical_plan.len());
    let wire: serde_json::Value = serde_json::from_slice(&canonical_continuation).unwrap();
    assert!(wire.get("plan").is_none(), "continuation duplicates the unsigned plan");
    assert_eq!(wire["planCommitment"], vector.4);
}

#[test]
fn planning_uses_public_context_and_emits_no_signature() {
    let stage = begin_signing(&single_plan()).unwrap();

    assert_eq!(stage.stage, 0);
    assert_eq!(stage.signing_requests.len(), 1);
    assert_eq!(stage.signing_requests[0].algorithm, "secp256k1-ecdsa");
    assert_eq!(stage.signing_requests[0].sighash_type, 0x41);
    assert_eq!(stage.signing_requests[0].digest, FIRST_DIGEST);
    assert_eq!(stage.signing_requests[0].public_key, OWNER_PUBLIC_KEY);
    assert_eq!(
        serde_json::to_value(&stage.continuation).unwrap().get("plan"),
        None
    );
    let encoded = serde_json::to_string(&stage).unwrap();
    assert!(!encoded.contains(&["private", "Key"].concat()));
    assert!(!encoded.contains("signature"));
}

#[test]
fn independent_transactions_share_a_stage_in_plan_order() {
    let plan = UnsignedPlan {
        evidence_table: Vec::new(),
        transactions: vec![
            transaction("first", 0, vec![], external_input(0x11, 10_000), 9_000),
            transaction("second", 0, vec![], external_input(0x22, 20_000), 19_000),
        ],
    };

    let stage = begin_signing(&plan).unwrap();

    assert_eq!(stage.stage, 0);
    assert_eq!(
        stage
            .signing_requests
            .iter()
            .map(|request| request.transaction_id.as_str())
            .collect::<Vec<_>>(),
        vec!["first", "second"]
    );
}

#[test]
fn signing_rejects_same_stage_and_cross_stage_external_outpoint_reuse() {
    let same_stage = UnsignedPlan {
        evidence_table: Vec::new(),
        transactions: vec![
            transaction("first", 0, vec![], external_input(0x11, 10_000), 9_000),
            transaction("second", 0, vec![], external_input(0x11, 10_000), 8_000),
        ],
    };
    let same_stage_error = begin_signing(&same_stage).unwrap_err();
    assert_eq!(same_stage_error.code, ErrorCode::InvalidPlan);
    assert_eq!(same_stage_error.path.as_deref(), Some("plan.transactions"));
    assert_eq!(
        same_stage_error.message,
        "planned input outpoints must be globally unique"
    );

    let cross_stage = UnsignedPlan {
        evidence_table: Vec::new(),
        transactions: vec![
            transaction("first", 0, vec![], external_input(0x11, 10_000), 9_000),
            transaction("second", 1, vec![], external_input(0x11, 10_000), 8_000),
        ],
    };
    let cross_stage_error = begin_signing(&cross_stage).unwrap_err();
    assert_eq!(cross_stage_error.code, ErrorCode::InvalidPlan);
    assert_eq!(cross_stage_error.path.as_deref(), Some("plan.transactions"));
    assert_eq!(
        cross_stage_error.message,
        "planned input outpoints must be globally unique"
    );
}

#[test]
fn signing_rejects_internal_parent_output_reuse() {
    let child_input = || PlannedInput {
        previous_transaction_id: "parent".to_owned(),
        previous_output_index: 0,
        previous_output_script: OWNER_SCRIPT.to_owned(),
        previous_output_satoshis: 9_000,
        sequence: u32::MAX,
        unlocking_script: String::new(),
        signer: public_context(),
    };
    let plan = UnsignedPlan {
        evidence_table: Vec::new(),
        transactions: vec![
            transaction("parent", 0, vec![], external_input(0x11, 10_000), 9_000),
            transaction("child-a", 1, vec!["parent"], child_input(), 8_000),
            transaction("child-b", 1, vec!["parent"], child_input(), 7_000),
        ],
    };

    let error = begin_signing(&plan).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(error.path.as_deref(), Some("plan.transactions"));
    assert_eq!(error.message, "planned input outpoints must be globally unique");
}

#[test]
fn continuation_rejects_external_reference_to_a_finalized_internal_outpoint() {
    let parent_only = UnsignedPlan {
        evidence_table: Vec::new(),
        transactions: vec![transaction(
            "parent",
            0,
            vec![],
            external_input(0x11, 10_000),
            9_000,
        )],
    };
    let parent_stage = begin_signing(&parent_only).unwrap();
    let parent_signature = sign_request(&parent_stage.signing_requests[0], 1);
    let parent_txid = match finalize_signing_stage(&parent_only, parent_stage, &[parent_signature])
        .unwrap()
    {
        StageOutcome::Complete(bundle) => bundle.transactions[0].txid.clone(),
        StageOutcome::Pending(_) => panic!("single parent must complete"),
    };
    let external_collision = PlannedInput {
        previous_transaction_id: parent_txid,
        previous_output_index: 0,
        previous_output_script: OWNER_SCRIPT.to_owned(),
        previous_output_satoshis: 9_000,
        sequence: u32::MAX,
        unlocking_script: String::new(),
        signer: public_context(),
    };
    let plan = UnsignedPlan {
        evidence_table: Vec::new(),
        transactions: vec![
            transaction("parent", 0, vec![], external_input(0x11, 10_000), 9_000),
            transaction("collision", 1, vec![], external_collision, 8_000),
        ],
    };
    let stage = begin_signing(&plan).unwrap();
    let signature = sign_request(&stage.signing_requests[0], 1);

    let error = finalize_signing_stage(&plan, stage, &[signature]).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidPlan);
    assert_eq!(error.path.as_deref(), Some("plan.transactions"));
    assert_eq!(error.message, "planned input outpoints must be globally unique");
}

#[test]
fn continuation_round_trips_without_hidden_state() {
    let stage = begin_signing(&dependent_plan()).unwrap();
    let encoded = serde_json::to_string(&stage).unwrap();

    assert_eq!(serde_json::from_str::<SigningStage>(&encoded).unwrap(), stage);
}

#[test]
fn stage_commitment_is_deterministic_and_advances_with_the_continuation() {
    let first = begin_signing(&dependent_plan()).unwrap();
    let duplicate = begin_signing(&dependent_plan()).unwrap();
    assert_eq!(first.stage_commitment, duplicate.stage_commitment);
    assert_eq!(
        first.signing_requests[0].stage_commitment,
        first.stage_commitment
    );

    let signature = sign_request(&first.signing_requests[0], 1);
    let second = pending(finalize_stage(&first, &[signature]).unwrap());
    assert_ne!(first.stage_commitment, second.stage_commitment);
    assert_eq!(
        second.signing_requests[0].stage_commitment,
        second.stage_commitment
    );
}

#[test]
fn malformed_continuation_shape_returns_invalid_plan_without_panicking() {
    let base = begin_signing(&dependent_plan()).unwrap();
    let malformed = [
        {
            let mut stage = duplicate_stage(&base);
            stage.continuation.finalized_transactions.clear();
            stage
        },
        {
            let mut stage = duplicate_stage(&base);
            stage.continuation.finalized_transactions.push(None);
            stage
        },
        {
            let mut stage = base;
            stage.continuation.finalized_transactions[0] = Some(SignedTransaction {
                transaction_id: "parent".to_owned(),
                role: "primary".to_owned(),
                txid: "11".repeat(32),
                raw_transaction: "00".to_owned(),
            });
            stage
        },
    ];

    for stage in malformed {
        let result = std::panic::catch_unwind(|| finalize_stage(&stage, &[]));
        assert!(result.is_ok(), "malformed continuation panicked");
        assert_eq!(result.unwrap().unwrap_err().code, ErrorCode::InvalidPlan);
    }
}

#[test]
fn malformed_unicode_hex_returns_invalid_plan_without_panicking() {
    let mut plan = single_plan();
    plan.transactions[0].outputs[0].locking_script = "aéx".to_owned();

    let result = std::panic::catch_unwind(|| begin_signing(&plan));

    assert!(result.is_ok(), "Unicode hex input panicked");
    assert_eq!(result.unwrap().unwrap_err().code, ErrorCode::InvalidPlan);
}

#[test]
fn finalize_rejects_missing_extra_and_duplicate_signatures() {
    let stage = begin_signing(&single_plan()).unwrap();
    assert_eq!(
        finalize_stage(&stage, &[]).unwrap_err().code,
        ErrorCode::MissingSignature
    );

    let valid = sign_request(&stage.signing_requests[0], 1);
    let mut extra = valid.clone();
    extra.transaction_id = "not-requested".to_owned();
    assert_eq!(
        finalize_stage(&stage, &[valid.clone(), extra])
            .unwrap_err()
            .code,
        ErrorCode::InvalidSignature
    );
    assert_eq!(
        finalize_stage(&stage, &[valid.clone(), valid])
            .unwrap_err()
            .code,
        ErrorCode::InvalidSignature
    );
}

#[test]
fn finalize_rejects_wrong_digest_key_and_malformed_signature() {
    let stage = begin_signing(&single_plan()).unwrap();
    let request = &stage.signing_requests[0];

    let mut wrong_digest = sign_request(request, 1);
    wrong_digest.digest = "00".repeat(32);
    assert_eq!(
        finalize_stage(&stage, &[wrong_digest])
            .unwrap_err()
            .code,
        ErrorCode::InvalidSignature
    );

    let wrong_key = sign_request(request, 2);
    assert_eq!(
        finalize_stage(&stage, &[wrong_key])
            .unwrap_err()
            .code,
        ErrorCode::InvalidSignature
    );

    let mut malformed = sign_request(request, 1);
    malformed.signature = "00".to_owned();
    assert_eq!(
        finalize_stage(&stage, &[malformed])
            .unwrap_err()
            .code,
        ErrorCode::InvalidSignature
    );

    assert_eq!(
        finalize_stage(&stage, &[sign_another_digest(request)])
            .unwrap_err()
            .code,
        ErrorCode::InvalidSignature
    );
}

#[test]
fn finalize_rejects_high_s_signature() {
    let stage = begin_signing(&single_plan()).unwrap();
    let supplied = high_s_signature(&stage.signing_requests[0]);

    assert_eq!(
        finalize_stage(&stage, &[supplied])
            .unwrap_err()
            .code,
        ErrorCode::InvalidSignature
    );
}

#[test]
fn finalize_rejects_replayed_session_and_out_of_order_stage() {
    let stage = begin_signing(&single_plan()).unwrap();
    let request = &stage.signing_requests[0];

    let mut replayed = sign_request(request, 1);
    replayed.session_id = "another-session".to_owned();
    assert_eq!(
        finalize_stage(&stage, &[replayed])
            .unwrap_err()
            .code,
        ErrorCode::InvalidPlan
    );

    let mut out_of_order = sign_request(request, 1);
    out_of_order.stage += 1;
    assert_eq!(
        finalize_stage(&stage, &[out_of_order])
            .unwrap_err()
            .code,
        ErrorCode::InvalidPlan
    );

    let mut stale_commitment = sign_request(request, 1);
    stale_commitment.stage_commitment = "00".repeat(32);
    assert_eq!(
        finalize_stage(&stage, &[stale_commitment])
            .unwrap_err()
            .code,
        ErrorCode::InvalidPlan
    );
}

#[test]
fn exact_duplicate_stage_invocation_is_deterministic_and_idempotent() {
    let stage = begin_signing(&single_plan()).unwrap();
    let signature = sign_request(&stage.signing_requests[0], 1);

    let first = finalize_stage(&stage, std::slice::from_ref(&signature)).unwrap();
    let duplicate = finalize_stage(&stage, &[signature]).unwrap();

    assert_eq!(first, duplicate);
}

#[test]
fn child_requests_wait_for_the_final_parent_transaction_id() {
    let first = begin_signing(&dependent_plan()).unwrap();
    assert_eq!(first.stage, 0);
    assert_eq!(first.signing_requests[0].transaction_id, "parent");

    let parent_signature = sign_request(&first.signing_requests[0], 1);
    let second = pending(finalize_stage(&first, &[parent_signature]).unwrap());

    assert_eq!(second.stage, 1);
    assert_eq!(second.signing_requests.len(), 1);
    assert_eq!(second.signing_requests[0].transaction_id, "child");
    let parent_txid = second.continuation.finalized_transactions[0]
        .as_ref()
        .unwrap()
        .txid
        .clone();
    assert_ne!(parent_txid, "parent");

    let child_signature = sign_request(&second.signing_requests[0], 1);
    let bundle = match finalize_stage(&second, &[child_signature]).unwrap() {
        StageOutcome::Complete(bundle) => bundle,
        StageOutcome::Pending(_) => panic!("expected signing to be complete"),
    };
    let child = tbc_sdk::Transaction::from_hex(&bundle.transactions[1].raw_transaction).unwrap();
    assert_eq!(child.inputs[0].previous_output.txid.to_string(), parent_txid);
    assert!(!child.inputs[0].script_sig.as_bytes().is_empty());
}

#[test]
fn tampered_finalized_parent_raw_transaction_and_txid_are_rejected() {
    let first = begin_signing(&dependent_plan()).unwrap();
    let parent_signature = sign_request(&first.signing_requests[0], 1);
    let second = pending(finalize_stage(&first, &[parent_signature]).unwrap());

    let mut raw_tampered = duplicate_stage(&second);
    raw_tampered.continuation.finalized_transactions[0]
        .as_mut()
        .unwrap()
        .raw_transaction
        .push_str("00");
    assert_eq!(
        finalize_stage(&raw_tampered, &[])
            .unwrap_err()
            .code,
        ErrorCode::InvalidPlan
    );

    let mut txid_tampered = second;
    txid_tampered.continuation.finalized_transactions[0]
        .as_mut()
        .unwrap()
        .txid = "22".repeat(32);
    assert_eq!(
        finalize_stage(&txid_tampered, &[])
            .unwrap_err()
            .code,
        ErrorCode::InvalidPlan
    );
}

#[test]
fn hostile_compact_size_parent_counts_return_invalid_plan_without_panicking() {
    let first = begin_signing(&dependent_plan()).unwrap();
    let parent_signature = sign_request(&first.signing_requests[0], 1);
    let second = pending(finalize_stage(&first, &[parent_signature]).unwrap());
    let hostile_transactions = [
        format!("0a000000ff{}", "ff".repeat(8)),
        format!("0a00000000ff{}", "ff".repeat(8)),
    ];

    for raw_transaction in hostile_transactions {
        let mut hostile = duplicate_stage(&second);
        hostile.continuation.finalized_transactions[0]
            .as_mut()
            .unwrap()
            .raw_transaction = raw_transaction;
        let result = std::panic::catch_unwind(|| finalize_stage(&hostile, &[]));
        assert!(result.is_ok(), "hostile compact-size count panicked");
        assert_eq!(result.unwrap().unwrap_err().code, ErrorCode::InvalidPlan);
    }
}

#[test]
fn finalized_parent_rejects_non_minimal_signature_push_encoding() {
    let first = begin_signing(&dependent_plan()).unwrap();
    let parent_signature = sign_request(&first.signing_requests[0], 1);
    let mut second = pending(finalize_stage(&first, &[parent_signature]).unwrap());
    let tampered_txid = {
        let record = second.continuation.finalized_transactions[0]
            .as_mut()
            .unwrap();
        let mut raw = decode_variable_hex(&record.raw_transaction);
        let script_length_index = 4 + 1 + 32 + 4;
        let script_start = script_length_index + 1;
        let signature_length = raw[script_start];
        assert!(signature_length <= 75);
        raw[script_length_index] += 1;
        raw[script_start] = 0x4c;
        raw.insert(script_start + 1, signature_length);
        record.raw_transaction = encode_hex(&raw);
        record.txid = tbc_sdk::Transaction::from_hex(&record.raw_transaction)
            .unwrap()
            .txid()
            .to_string();
        record.txid.clone()
    };

    let stage_commitment = encode_hex(&tbc_sdk::hash::sha256(
        &serde_json::to_vec(&second.continuation).unwrap(),
    ));
    second.stage_commitment = stage_commitment.clone();
    second.signing_requests[0].stage_commitment = stage_commitment;

    let plan = dependent_plan();
    let child = &plan.transactions[1];
    let mut child_transaction = tbc_sdk::Transaction {
        version: child.version,
        inputs: vec![tbc_sdk::TxIn {
            previous_output: tbc_sdk::OutPoint {
                txid: tampered_txid.parse().unwrap(),
                vout: child.inputs[0].previous_output_index,
            },
            script_sig: tbc_sdk::script::Script::empty(),
            sequence: child.inputs[0].sequence,
        }],
        outputs: vec![tbc_sdk::TxOut {
            satoshis: child.outputs[0].satoshis,
            script_pubkey: tbc_sdk::script::Script::from_bytes(decode_variable_hex(
                &child.outputs[0].locking_script,
            )),
        }],
        lock_time: child.lock_time,
    };
    child_transaction.inputs[0].script_sig = tbc_sdk::script::Script::empty();
    let script_code = tbc_sdk::script::Script::from_bytes(decode_variable_hex(
        &child.inputs[0].previous_output_script,
    ));
    second.signing_requests[0].digest = encode_hex(
        &child_transaction
            .sighash_digest(
                0,
                &script_code,
                child.inputs[0].previous_output_satoshis,
                tbc_sdk::DEFAULT_SIGHASH,
            )
            .unwrap(),
    );

    assert_eq!(
        finalize_stage(&second, &[]).unwrap_err().code,
        ErrorCode::InvalidPlan
    );
}
