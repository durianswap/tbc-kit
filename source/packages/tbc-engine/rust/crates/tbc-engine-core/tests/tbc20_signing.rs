use tbc_engine_core::signing::*;
use tbc_sdk::{PublicKey, Transaction};

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap()
}
fn bytes(value: &str) -> Vec<u8> {
    (0..value.len()).step_by(2).map(|i| u8::from_str_radix(&value[i..i+2], 16).unwrap()).collect()
}
fn hex(value: &[u8]) -> String { value.iter().map(|b| format!("{b:02x}")).collect() }

// Only public, fabricated oracle transactions and their existing signatures are
// consumed here. No private key, network, or chain-acceptance claim is involved.
fn plan() -> UnsignedPlan {
    let f = fixture();
    let public = PublicKey::from_slice(&bytes(f["request"]["publicKeyHex"].as_str().unwrap())).unwrap();
    let signer = PublicSigningContext { address: public.address().to_string(),
        public_key: hex(&public.to_bytes()), public_key_hash: hex(&public.hash160()) };
    let evidence_table = (0..2).map(|index| EvidenceEntry {
        txid: f["stages"][index]["txid"].as_str().unwrap().into(),
        raw_transaction: f["stages"][index]["signedRaw"].as_str().unwrap().into(),
    }).collect();
    let transactions = (2..4).map(|index| {
        let oracle = &f["stages"][index];
        let raw = Transaction::from_hex(oracle["unsignedRaw"].as_str().unwrap()).unwrap();
        let output_groups: Vec<Tbc20OutputGroup> = serde_json::from_value(oracle["outputGroups"].clone()).unwrap();
        let inputs = raw.inputs.iter().enumerate().map(|(vin, input)| {
            let source = &oracle["inputs"][vin];
            let is_token = vin < index - 1;
            let unlocking_script = if is_token {
                tbc20_unlocking_descriptor(Tbc20UnlockRecipe {
                    parent: if index == 2 { TransactionSource::Evidence(1) } else { TransactionSource::Planned("transfer".into()) },
                    proof_references: vec![ProofReference { source: TransactionSource::Evidence((index-2) as u32), output_index: 0 }],
                    output_groups: output_groups.clone(), contract_controller: None,
                }).unwrap()
            } else { String::new() };
            PlannedInput {
                previous_transaction_id: if index == 2 { input.previous_output.txid.to_string() } else { "transfer".into() },
                previous_output_index: input.previous_output.vout,
                previous_output_script: source["previousScriptHex"].as_str().unwrap().into(),
                previous_output_satoshis: source["previousValue"].as_str().unwrap().parse().unwrap(),
                sequence: input.sequence, unlocking_script, signer: signer.clone(),
            }
        }).collect();
        PlannedTransaction { transaction_id: if index==2 {"transfer"} else {"merge"}.into(),
            role:"tbc20-standard-transfer".into(), stage:(index-2) as u32,
            depends_on: if index==2 {vec![]} else {vec!["transfer".into()]},
            version:raw.version, lock_time:raw.lock_time, inputs,
            outputs:raw.outputs.iter().map(|output| PlannedOutput { satoshis:output.satoshis,
                locking_script:hex(output.script_pubkey.as_bytes()) }).collect(),
        }
    }).collect();
    UnsignedPlan { transactions, evidence_table }
}
fn signatures(stage: &SigningStage) -> Vec<ExternalSignature> {
    let f = fixture();
    stage.signing_requests.iter().map(|request| {
        let oracle = &f["stages"][request.stage as usize + 2]["inputs"][request.input_index as usize];
        assert_eq!(request.digest, oracle["digestBytesHex"].as_str().unwrap());
        let signature = oracle["signatureHex"].as_str().unwrap();
        ExternalSignature { session_id:request.session_id.clone(), stage:request.stage,
            stage_commitment:request.stage_commitment.clone(), transaction_id:request.transaction_id.clone(),
            input_index:request.input_index, digest:request.digest.clone(), public_key:request.public_key.clone(),
            signature:signature[..signature.len()-2].into() }
    }).collect()
}
fn recipe(input: &PlannedInput) -> Tbc20UnlockRecipe {
    serde_json::from_slice(&bytes(input.unlocking_script.strip_prefix("tbc20-standard-unlock:").unwrap())).unwrap()
}

#[test]
fn planned_parent_external_signatures_match_upstream_and_continuation_is_bound() {
    let plan = plan();
    let stage = begin_signing(&plan).unwrap();
    assert_eq!(stage.signing_requests[0].script_class, "tbc20-standard");
    let sigs = signatures(&stage);
    let StageOutcome::Pending(stage) = finalize_signing_stage(&plan,stage,&sigs).unwrap() else {panic!("merge stage expected")};
    let mut tampered: SigningStage = serde_json::from_value(serde_json::to_value(&stage).unwrap()).unwrap();
    tampered.continuation.finalized_transactions[0].as_mut().unwrap().raw_transaction.replace_range(0..2,"09");
    let sigs = signatures(&stage);
    assert!(finalize_signing_stage(&plan,tampered,&sigs).is_err());
    let StageOutcome::Complete(bundle) = finalize_signing_stage(&plan,stage,&sigs).unwrap() else {panic!("complete expected")};
    for (index, transaction) in bundle.transactions.iter().enumerate() {
        assert_eq!(transaction.raw_transaction,fixture()["stages"][index+2]["signedRaw"].as_str().unwrap());
    }
}

#[test]
fn rejects_missing_extra_wrong_proofs_previous_output_and_signature() {
    let original = plan();
    for change in 0..5 {
        let mut plan = original.clone();
        let input = &mut plan.transactions[0].inputs[0];
        let mut descriptor = recipe(input);
        match change {
            0 => descriptor.proof_references.clear(),
            1 => descriptor.proof_references.push(descriptor.proof_references[0].clone()),
            2 => descriptor.proof_references[0].output_index = 1,
            3 => input.previous_output_satoshis += 1,
            _ => descriptor.parent = TransactionSource::Planned("merge".into()),
        }
        input.unlocking_script = tbc20_unlocking_descriptor(descriptor).unwrap();
        assert!(begin_signing(&plan).is_err(),"mutation {change} must fail before signing");
    }
    let stage = begin_signing(&original).unwrap();
    let mut sigs = signatures(&stage);
    let end = sigs[0].signature.len();
    sigs[0].signature.replace_range(end-2..end,"00");
    assert!(finalize_signing_stage(&original,stage,&sigs).is_err());
}
