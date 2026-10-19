//! Fixed SDK external signatures, not Engine-held keys or live-chain proof.
use serde_json::Value;
use tbc_engine_core::{protocols::amm_lp_proof, signing::*};
use tbc_sdk::{PublicKey, Transaction};

fn fixture() -> Value { serde_json::from_str(include_str!("../../../fixtures/amm-lp-proof.json")).unwrap() }
fn bytes(s: &str) -> Vec<u8> { (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i+2],16).unwrap()).collect() }
fn hex(b: &[u8]) -> String { b.iter().map(|b| format!("{b:02x}")).collect() }
fn row<'a>(f: &'a Value, id: &str) -> &'a Value { f["vectors"].as_array().unwrap().iter().find(|v| v["id"] == id).unwrap() }
fn raw_tx(f: &Value, id: &str) -> Transaction { Transaction::from_hex(f["raws"][id].as_str().unwrap()).unwrap() }

// Maps already signed parents to Planned sources rather than smuggling their
// SDK raw into evidence. The child can only resolve them after finalization.
fn plan(f: &Value, ids: &[&str]) -> UnsignedPlan {
    let mut evidence = Vec::<EvidenceEntry>::new();
    let mut completed = std::collections::BTreeMap::<String, String>::new();
    let mut transactions = Vec::new();
    for (stage, id) in ids.iter().enumerate() {
        let v = row(f,id);
        let current = Transaction::from_hex(v["currentRaw"].as_str().unwrap()).unwrap();
        let parent = raw_tx(f,v["parentTxid"].as_str().unwrap());
        let key = PublicKey::from_slice(&bytes(v["publicKeyHex"].as_str().unwrap())).unwrap();
        let signer = PublicSigningContext { address:key.address().to_string(),public_key:hex(&key.to_bytes()),public_key_hash:hex(&key.hash160()) };
        let mut source = |txid: &str| {
            if let Some(id) = completed.get(txid) { return TransactionSource::Planned(id.clone()); }
            let index = evidence.iter().position(|e| e.txid == txid).unwrap_or_else(|| {
                evidence.push(EvidenceEntry {txid:txid.into(),raw_transaction:f["raws"][txid].as_str().unwrap().into()}); evidence.len()-1
            });
            TransactionSource::Evidence(index as u32)
        };
        let inputs = current.inputs.iter().map(|input| {
            let previous = &parent.outputs[input.previous_output.vout as usize];
            let unlocking_script = if previous.satoshis == 500 {
                let p = amm_lp_proof::inspect_parent(&parent.serialize(),&input.previous_output,None).unwrap();
                amm_lp_unlocking_descriptor(AmmLpUnlockRecipe {
                    parent:source(&parent.txid().to_string()),
                    proof_references:p.dependencies().iter().map(|point| ProofReference {source:source(&point.txid.to_string()),output_index:point.vout}).collect(),
                    output_groups:serde_json::from_value(v["outputGroups"].clone()).unwrap(),
                    contract_controller:v.get("contractController").map(|c| Tbc20ContractControllerReference {
                        source:source(c["txid"].as_str().unwrap()),current_input_index:c["currentInputIndex"].as_u64().unwrap() as u32,
                    }),
                }).unwrap()
            } else { String::new() };
            PlannedInput {
                previous_transaction_id:completed.get(&parent.txid().to_string()).cloned().unwrap_or_else(|| parent.txid().to_string()),
                previous_output_index:input.previous_output.vout,previous_output_script:hex(previous.script_pubkey.as_bytes()),
                previous_output_satoshis:previous.satoshis,sequence:input.sequence,unlocking_script,signer:signer.clone(),
            }
        }).collect();
        let id = format!("lp-{stage}");
        transactions.push(PlannedTransaction {
            transaction_id:id.clone(),role:"tbc20-lp-transfer".into(),stage:stage as u32,
            depends_on:if stage == 0 {vec![]} else {vec![format!("lp-{}",stage-1)]},
            version:current.version,lock_time:current.lock_time,inputs,
            outputs:current.outputs.iter().map(|o| PlannedOutput {satoshis:o.satoshis,locking_script:hex(o.script_pubkey.as_bytes())}).collect(),
        });
        completed.insert(v["signedTxid"].as_str().unwrap().into(),id);
    }
    UnsignedPlan {transactions,evidence_table:evidence}
}
fn signatures(f: &Value, v: &Value, stage: &SigningStage) -> Vec<ExternalSignature> {
    let signed = raw_tx(f,v["signedTxid"].as_str().unwrap());
    stage.signing_requests.iter().map(|r| {
        let signature = if let Some(vector) = f["vectors"].as_array().unwrap().iter().find(|v2|
            v2["signedTxid"] == v["signedTxid"] && v2["inputIndex"].as_u64() == Some(r.input_index as u64)) {
            assert_eq!(r.script_class,"tbc20-lp"); assert_eq!(r.digest,vector["digestHex"].as_str().unwrap());
            let s=vector["signatureHex"].as_str().unwrap();s[..s.len()-2].into()
        } else {
            assert_eq!(r.script_class,"p2pkh");let s=signed.inputs[r.input_index as usize].script_sig.as_bytes();hex(&s[1..s[0] as usize])
        };
        ExternalSignature {session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),
            transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature}
    }).collect()
}
fn recipe(input: &PlannedInput) -> AmmLpUnlockRecipe {
    serde_json::from_slice(&bytes(input.unlocking_script.strip_prefix("tbc20-lp-unlock:").unwrap())).unwrap()
}

#[test]
fn lp_planned_parents_and_contract_controller_use_shared_staged_signer() {
    let f=fixture();
    for ids in [vec!["public-plain-transfer-0","public-plain-merge-0","public-plain-again-0","public-plain-to-contract-0","public-plain-contract-release-0"],
        vec!["controller-locked-transfer-0","controller-locked-merge-0","controller-locked-unlock-0"]] {
        let p=plan(&f,&ids);assert_eq!(p.evidence_table.len(),2,"parents share evidence; children are Planned");
        let mut stage=begin_signing(&p).unwrap();let mut complete=false;
        for (i,id) in ids.iter().enumerate() {
            let sigs=signatures(&f,row(&f,id),&stage);
            match finalize_signing_stage(&p,stage,&sigs).unwrap() {
                StageOutcome::Pending(next)=>{assert!(i+1<ids.len());stage=next;},
                StageOutcome::Complete(bundle)=>{
                    assert_eq!(i+1,ids.len());assert_eq!(bundle.transactions.len(),ids.len());
                    for (record,id) in bundle.transactions.iter().zip(&ids) {
                        let v=row(&f,id);assert_eq!(record.txid,v["signedTxid"].as_str().unwrap());
                        assert_eq!(record.raw_transaction,f["raws"][record.txid.as_str()].as_str().unwrap());
                    }
                    complete=true;break;
                }
            }
        }
        assert!(complete);
    }
}

#[test]
fn lp_material_tampering_is_rejected_before_signing_requests() {
    let f=fixture();
    for case in 0..10 {
        let mut p=plan(&f,&["controller-locked-transfer-0","controller-locked-merge-0"]);
        let input=&mut p.transactions[0].inputs[0];let mut r=recipe(input);
        match case {
            0=>r.proof_references.clear(),
            1=>r.proof_references.push(r.proof_references[0].clone()),
            2=>r.proof_references[0].output_index=1,
            3=>r.parent=TransactionSource::Planned("lp-1".into()),
            4=>input.previous_output_satoshis+=1,
            5=>input.sequence=u32::MAX,
            6=>r.output_groups.reverse(),
            7=>input.previous_output_script="51".into(),
            8=>r.proof_references[0].source=r.parent.clone(),
            _=>{},
        }
        input.unlocking_script=if case==9 {tbc20_unlocking_descriptor(r)} else {amm_lp_unlocking_descriptor(r)}.unwrap();
        assert!(begin_signing(&p).is_err(),"mutation {case}");
    }
    for case in 0..3 {
        let mut p=plan(&f,&["public-plain-contract-release-0"]);let input=&mut p.transactions[0].inputs[0];let mut r=recipe(input);
        match case {0=>r.contract_controller=None,1=>r.contract_controller.as_mut().unwrap().current_input_index=0,
            _=>r.contract_controller.as_mut().unwrap().source=r.proof_references[0].source.clone()}
        input.unlocking_script=amm_lp_unlocking_descriptor(r).unwrap();assert!(begin_signing(&p).is_err(),"controller {case}");
    }
}

#[test]
fn lp_signatures_and_parent_continuation_are_bound() {
    let f=fixture();let ids=["public-plain-transfer-0","public-plain-merge-0"];
    let p=plan(&f,&ids);let stage=begin_signing(&p).unwrap();let mut sigs=signatures(&f,row(&f,ids[0]),&stage);
    let original=&sigs[0].signature[10..12];let replacement=if original=="00" {"01"} else {"00"};
    sigs[0].signature.replace_range(10..12,replacement);assert!(finalize_signing_stage(&p,stage,&sigs).is_err());
    let stage=begin_signing(&p).unwrap();let sigs=signatures(&f,row(&f,ids[0]),&stage);
    let StageOutcome::Pending(mut next)=finalize_signing_stage(&p,stage,&sigs).unwrap() else {panic!("child")};
    let sigs=signatures(&f,row(&f,ids[1]),&next);
    next.continuation.finalized_transactions[0].as_mut().unwrap().raw_transaction.replace_range(0..2,"09");
    assert!(finalize_signing_stage(&p,next,&sigs).is_err());
}
