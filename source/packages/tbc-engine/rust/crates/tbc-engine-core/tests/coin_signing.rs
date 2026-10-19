//! Public synthetic SDK signatures through the common Engine signing machine.
//! No private keys, I/O, or claims of live-chain acceptance.
use tbc_engine_core::{protocols::coin_proof, signing::*};
use tbc_sdk::{PublicKey, Transaction};

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap()
}
fn bytes(value: &str) -> Vec<u8> {
    (0..value.len()).step_by(2).map(|i| u8::from_str_radix(&value[i..i+2], 16).unwrap()).collect()
}
fn hex(value: &[u8]) -> String { value.iter().map(|b| format!("{b:02x}")).collect() }
fn tx(value: &serde_json::Value) -> Transaction { Transaction::from_hex(value.as_str().unwrap()).unwrap() }
fn source(stage: usize) -> TransactionSource {
    if stage == 0 { TransactionSource::Evidence(1) } else { TransactionSource::Planned(format!("coin-{}", stage-1)) }
}
fn plan() -> UnsignedPlan {
    let f = fixture(); let vectors = &f["vectors"];
    let key = PublicKey::from_slice(&bytes(vectors[0]["publicKeyHex"].as_str().unwrap())).unwrap();
    let signer = PublicSigningContext { address: key.address().to_string(), public_key: hex(&key.to_bytes()), public_key_hash: hex(&key.hash160()) };
    let evidence_table = [&vectors[0]["ancestorsRaw"][0], &vectors[0]["parentRaw"]].into_iter().map(|raw| EvidenceEntry {
        txid: tx(raw).txid().to_string(), raw_transaction: raw.as_str().unwrap().into(),
    }).collect();
    let transactions = [0usize, 1, 3].into_iter().enumerate().map(|(stage, index)| {
        let vector = &vectors[index]; let current = tx(&vector["currentRaw"]); let parent = tx(&vector["parentRaw"]);
        let groups: Vec<Tbc20OutputGroup> = serde_json::from_value(vector["outputGroups"].clone()).unwrap();
        let inputs = current.inputs.iter().map(|input| {
            let previous = &parent.outputs[input.previous_output.vout as usize];
            let unlocking_script = if previous.satoshis == 500 {
                let material = coin_proof::inspect_parent(&parent.serialize(), &input.previous_output, None).unwrap();
                coin_unlocking_descriptor(CoinUnlockRecipe {
                    parent: source(stage),
                    proof_references: material.dependencies().iter().map(|point| ProofReference {
                        source: if stage < 2 { TransactionSource::Evidence(stage as u32) } else { TransactionSource::Planned("coin-0".into()) },
                        output_index: point.vout,
                    }).collect(),
                    output_groups: groups.clone(), contract_controller: None,
                }).unwrap()
            } else { String::new() };
            PlannedInput { previous_transaction_id: if stage == 0 { parent.txid().to_string() } else { format!("coin-{}",stage-1) },
                previous_output_index: input.previous_output.vout, previous_output_script: hex(previous.script_pubkey.as_bytes()),
                previous_output_satoshis: previous.satoshis, sequence: input.sequence, unlocking_script, signer: signer.clone() }
        }).collect();
        PlannedTransaction { transaction_id: format!("coin-{stage}"), role: "tbc20-stablecoin-transfer".into(), stage: stage as u32,
            depends_on: if stage == 0 { vec![] } else { vec![format!("coin-{}",stage-1)] },
            version: current.version, lock_time: current.lock_time, inputs,
            outputs: current.outputs.iter().map(|o| PlannedOutput { satoshis: o.satoshis, locking_script: hex(o.script_pubkey.as_bytes()) }).collect() }
    }).collect();
    UnsignedPlan { transactions, evidence_table }
}
fn recipe(input: &PlannedInput) -> CoinUnlockRecipe {
    serde_json::from_slice(&bytes(input.unlocking_script.strip_prefix("tbc20-stablecoin-unlock:").unwrap())).unwrap()
}
fn signatures(stage: &SigningStage) -> Vec<ExternalSignature> {
    let f = fixture(); let representative = &f["vectors"][[0usize, 1, 3][stage.stage as usize]];
    let signed = tx(&representative["signedRaw"]);
    stage.signing_requests.iter().map(|r| {
        let signature = if let Some(vector) = f["vectors"].as_array().unwrap().iter().find(|v|
            v["txid"] == representative["txid"] && v["inputIndex"].as_u64() == Some(r.input_index as u64)) {
            assert_eq!(r.digest, vector["digestHex"].as_str().unwrap());
            assert_eq!(r.script_class, "tbc20-stablecoin");
            let s = vector["signatureHex"].as_str().unwrap(); s[..s.len()-2].to_owned()
        } else {
            let script = signed.inputs[r.input_index as usize].script_sig.as_bytes(); let length = usize::from(script[0]);
            assert!((9..=72).contains(&length)); assert_eq!(r.script_class, "p2pkh"); hex(&script[1..length])
        };
        ExternalSignature { session_id:r.session_id.clone(), stage:r.stage, stage_commitment:r.stage_commitment.clone(),
            transaction_id:r.transaction_id.clone(), input_index:r.input_index, digest:r.digest.clone(), public_key:r.public_key.clone(), signature }
    }).collect()
}

#[test]
fn coin_shared_external_signing_matches_transfer_merge_and_respend_raw() {
    let plan = plan(); let mut stage = begin_signing(&plan).unwrap();
    for index in 0..3 {
        assert_eq!(stage.signing_requests.len(), [2,3,2][index]);
        let sigs = signatures(&stage);
        match finalize_signing_stage(&plan, stage, &sigs).unwrap() {
            StageOutcome::Pending(next) => { assert!(index < 2); stage = next; }
            StageOutcome::Complete(bundle) => {
                assert_eq!(index, 2); assert_eq!(bundle.transactions.len(), 3);
                for (i, record) in bundle.transactions.iter().enumerate() {
                    let f = fixture(); let v = &f["vectors"][[0usize, 1, 3][i]];
                    assert_eq!(record.raw_transaction, v["signedRaw"].as_str().unwrap());
                    assert_eq!(record.txid, v["txid"].as_str().unwrap());
                }
                return;
            }
        }
    }
    panic!("expected completion");
}

#[test]
fn coin_shared_signing_rejects_bad_material_before_exposing_requests() {
    for case in 0..8 {
        let mut plan = plan(); let input = &mut plan.transactions[0].inputs[0]; let mut r = recipe(input);
        match case {
            0 => r.proof_references.clear(),
            1 => r.proof_references.push(r.proof_references[0].clone()),
            2 => r.proof_references[0].output_index = 1,
            3 => r.parent = TransactionSource::Planned("coin-1".into()),
            4 => input.previous_output_satoshis += 1,
            5 => input.sequence = u32::MAX,
            6 => r.output_groups.reverse(),
            _ => input.previous_output_script = "51".into(),
        }
        input.unlocking_script = coin_unlocking_descriptor(r).unwrap();
        assert!(begin_signing(&plan).is_err(), "mutation {case}");
    }
}

#[test]
fn coin_signature_and_continuation_remain_bound() {
    let plan = plan(); let stage = begin_signing(&plan).unwrap(); let mut sigs = signatures(&stage);
    sigs[0].signature.replace_range(10..12, "00"); assert!(finalize_signing_stage(&plan, stage, &sigs).is_err());
    let stage = begin_signing(&plan).unwrap(); let sigs = signatures(&stage);
    let StageOutcome::Pending(mut next) = finalize_signing_stage(&plan, stage, &sigs).unwrap() else { panic!("child") };
    let sigs = signatures(&next);
    next.continuation.finalized_transactions[0].as_mut().unwrap().raw_transaction.replace_range(0..2,"09");
    assert!(finalize_signing_stage(&plan, next, &sigs).is_err());
}
