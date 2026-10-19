//! Real shared signing state machine over fixed upstream synthetic witnesses.
use tbc_engine_core::signing::*;
use tbc_sdk::{PublicKey, Transaction};

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../fixtures/tbc721-standard-proof.json")).unwrap()
}
fn bytes(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i+2],16).unwrap()).collect()
}
fn hex(data: &[u8]) -> String { data.iter().map(|b|format!("{b:02x}")).collect() }
fn tx(value: &serde_json::Value) -> Transaction { Transaction::from_hex(value.as_str().unwrap()).unwrap() }

fn plan() -> UnsignedPlan {
    let f=fixture();let vectors=f["vectors"].as_array().unwrap();
    let key=PublicKey::from_slice(&bytes(vectors[0]["publicKeyHex"].as_str().unwrap())).unwrap();
    let signer=PublicSigningContext {address:key.address().to_string(),public_key:hex(&key.to_bytes()),public_key_hash:hex(&key.hash160())};
    let evidence_table=[&vectors[0]["grandparentRaw"],&vectors[0]["parentRaw"]].into_iter().map(|raw|EvidenceEntry {
        txid:tx(raw).txid().to_string(),raw_transaction:raw.as_str().unwrap().into(),
    }).collect();
    let transactions=vectors.iter().enumerate().map(|(stage,v)|{
        let current=tx(&v["currentRaw"]);let parent=tx(&v["parentRaw"]);
        let inputs=current.inputs.iter().enumerate().map(|(vin,input)|{
            let previous=&parent.outputs[input.previous_output.vout as usize];
            PlannedInput {previous_transaction_id:if stage==0 {parent.txid().to_string()} else {"transfer-0".into()},
                previous_output_index:input.previous_output.vout,previous_output_script:hex(previous.script_pubkey.as_bytes()),
                previous_output_satoshis:previous.satoshis,sequence:input.sequence,signer:signer.clone(),
                unlocking_script:if vin==0 {tbc721_unlocking_descriptor(Tbc721UnlockRecipe {
                    parent:if stage==0 {TransactionSource::Evidence(1)} else {TransactionSource::Planned("transfer-0".into())},
                    grandparent:TransactionSource::Evidence(stage as u32),
                }).unwrap()} else {String::new()},
            }
        }).collect();
        PlannedTransaction {transaction_id:format!("transfer-{stage}"),role:"tbc721-standard-transfer".into(),stage:stage as u32,
            depends_on:if stage==0 {vec![]} else {vec!["transfer-0".into()]},version:current.version,lock_time:current.lock_time,inputs,
            outputs:current.outputs.iter().map(|o|PlannedOutput {satoshis:o.satoshis,locking_script:hex(o.script_pubkey.as_bytes())}).collect()}
    }).collect();
    UnsignedPlan {transactions,evidence_table}
}

fn signatures(stage: &SigningStage) -> Vec<ExternalSignature> {
    let f=fixture();let vector=&f["vectors"][stage.stage as usize];
    let signed=tx(&vector["signedRaw"]);
    stage.signing_requests.iter().map(|r|{
        let script=signed.inputs[r.input_index as usize].script_sig.as_bytes();
        let length=usize::from(script[0]);assert!((9..=72).contains(&length));
        if r.input_index==0 {assert_eq!(r.digest,vector["digestBytesHex"].as_str().unwrap());assert_eq!(r.script_class,"tbc721-standard");}
        ExternalSignature {session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),
            transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),
            signature:hex(&script[1..length])}
    }).collect()
}

#[test]
fn new_nft_shared_signing_matches_complete_upstream_raw_and_resolves_signed_parent() {
    let plan=plan();let first=begin_signing(&plan).unwrap();assert_eq!(first.signing_requests.len(),3);
    let sigs=signatures(&first);
    let StageOutcome::Pending(second)=finalize_signing_stage(&plan,first,&sigs).unwrap() else {panic!("expected child")};
    let sigs=signatures(&second);
    let StageOutcome::Complete(bundle)=finalize_signing_stage(&plan,second,&sigs).unwrap() else {panic!("expected complete")};
    for (index,record) in bundle.transactions.iter().enumerate(){
        assert_eq!(record.raw_transaction,fixture()["vectors"][index]["signedRaw"].as_str().unwrap());
        assert_eq!(record.txid,fixture()["vectors"][index]["txid"].as_str().unwrap());
    }
}

#[test]
fn new_nft_rejects_wrong_material_and_forward_proof_before_signing() {
    for case in 0..5 {
        let mut plan=plan();let input=&mut plan.transactions[0].inputs[0];
        match case {
            0=>input.previous_output_satoshis+=1,
            1=>input.previous_output_index=1,
            2=>input.unlocking_script=tbc721_unlocking_descriptor(Tbc721UnlockRecipe {parent:TransactionSource::Evidence(1),grandparent:TransactionSource::Evidence(1)}).unwrap(),
            3=>input.unlocking_script=tbc721_unlocking_descriptor(Tbc721UnlockRecipe {parent:TransactionSource::Planned("transfer-1".into()),grandparent:TransactionSource::Evidence(0)}).unwrap(),
            _=>input.previous_output_script="51".into(),
        }
        assert!(begin_signing(&plan).is_err(),"case {case}");
    }
}

#[test]
fn new_nft_rejects_changed_signature_and_finalized_continuation() {
    let plan=plan();let first=begin_signing(&plan).unwrap();let mut sigs=signatures(&first);
    sigs[0].signature.replace_range(10..12,"00");
    assert!(finalize_signing_stage(&plan,first,&sigs).is_err());
    let first=begin_signing(&plan).unwrap();let sigs=signatures(&first);
    let StageOutcome::Pending(mut second)=finalize_signing_stage(&plan,first,&sigs).unwrap() else {panic!("child")};
    let sigs=signatures(&second);
    second.continuation.finalized_transactions[0].as_mut().unwrap().raw_transaction.replace_range(0..2,"09");
    assert!(finalize_signing_stage(&plan,second,&sigs).is_err());
}
