//! Mixed ECDSA/Schnorr through the same staged Engine; fixed public SDK vectors.
use tbc_engine_core::{protocols::coin_proof,signing::*};
use tbc_sdk::{Address,Transaction,hash};
use serde_json::Value;
fn fixture()->Value {serde_json::from_str(include_str!("../../../fixtures/coin-admin-proof.json")).unwrap()}
fn bytes(s:&str)->Vec<u8>{(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hex(v:&[u8])->String{v.iter().map(|b|format!("{b:02x}")).collect()}
fn tx(v:&Value)->Transaction{Transaction::from_hex(v.as_str().unwrap()).unwrap()}
fn context(key:&[u8])->PublicSigningContext {
    let h=hash::hash160(key);PublicSigningContext{address:Address::from_hash160(h).to_string(),public_key:hex(key),public_key_hash:hex(&h)}
}
fn fee_context()->PublicSigningContext {context(&bytes("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"))}
fn evidence(tx:&Transaction)->EvidenceEntry{EvidenceEntry{txid:tx.txid().to_string(),raw_transaction:tx.to_hex()}}
fn transaction(id:&str,stage:u32,current:&Transaction,inputs:Vec<PlannedInput>,deps:Vec<String>)->PlannedTransaction {
    PlannedTransaction{transaction_id:id.into(),role:format!("tbc20-stablecoin-{id}"),stage,depends_on:deps,version:current.version,
        lock_time:current.lock_time,inputs,outputs:current.outputs.iter().map(|o|PlannedOutput{satoshis:o.satoshis,locking_script:hex(o.script_pubkey.as_bytes())}).collect()}
}
fn planned_input(input:&tbc_sdk::TxIn,parent:&Transaction,parent_id:String,signer:PublicSigningContext,recipe:String)->PlannedInput{
    let output=&parent.outputs[input.previous_output.vout as usize];PlannedInput{previous_transaction_id:parent_id,
        previous_output_index:input.previous_output.vout,previous_output_script:hex(output.script_pubkey.as_bytes()),
        previous_output_satoshis:output.satoshis,sequence:input.sequence,unlocking_script:recipe,signer}
}
fn issuance()->(UnsignedPlan,Vec<Transaction>) {
    let f=fixture();let v=&f["issuance"];let source=tx(&v["parentRaw"]);let funding=tx(&v["grandparentRaw"]);let mint=tx(&v["signedRaw"]);
    let first=transaction("source",0,&source,vec![planned_input(&source.inputs[0],&funding,funding.txid().to_string(),fee_context(),String::new())],vec![]);
    let admin=context(&bytes(v["publicKeyHex"].as_str().unwrap()));
    let inputs=mint.inputs.iter().enumerate().map(|(vin,input)|planned_input(input,&source,"source".into(),
        if vin<2{admin.clone()}else{fee_context()},if vin==0{tbc721_unlocking_descriptor(Tbc721UnlockRecipe{
            parent:TransactionSource::Planned("source".into()),grandparent:TransactionSource::Evidence(0)}).unwrap()}else{String::new()})).collect();
    let second=transaction("mint",1,&mint,inputs,vec!["source".into()]);
    (UnsignedPlan{transactions:vec![first,second],evidence_table:vec![evidence(&funding)]},vec![source,mint])
}
fn maintenance()->(UnsignedPlan,Vec<Transaction>){
    let f=fixture();let freeze=&f["cases"][0];let unfreeze=&f["cases"][2];
    let mint=tx(&freeze["ancestorsRaw"][0]);let split=tx(&freeze["parentRaw"]);let frozen=tx(&freeze["signedRaw"]);let unfrozen=tx(&unfreeze["signedRaw"]);
    let admin=context(&bytes(freeze["publicKeyHex"].as_str().unwrap()));
    let transactions=[(&frozen,&split),( &unfrozen,&frozen)].into_iter().enumerate().map(|(stage,(current,parent))|{
        let id=if stage==0{"freeze"}else{"unfreeze"};
        let inputs=current.inputs.iter().enumerate().map(|(vin,input)|{
            let asset=vin<current.inputs.len()-1;
            let recipe=if asset {
                let p=coin_proof::inspect_parent(&parent.serialize(),&input.previous_output,None).unwrap();
                coin_unlocking_descriptor(CoinUnlockRecipe{parent:if stage==0{TransactionSource::Evidence(1)}else{TransactionSource::Planned("freeze".into())},
                    proof_references:p.dependencies().iter().map(|point|ProofReference{source:TransactionSource::Evidence(stage as u32),output_index:point.vout}).collect(),
                    output_groups:serde_json::from_value(if stage==0{freeze}else{unfreeze}["outputGroups"].clone()).unwrap(),contract_controller:None}).unwrap()
            }else{String::new()};
            planned_input(input,parent,if stage==0{parent.txid().to_string()}else{"freeze".into()},if asset{admin.clone()}else{fee_context()},recipe)
        }).collect();
        transaction(id,stage as u32,current,inputs,if stage==0{vec![]}else{vec!["freeze".into()]})
    }).collect();
    (UnsignedPlan{transactions,evidence_table:vec![evidence(&mint),evidence(&split)]},vec![frozen,unfrozen])
}
fn signatures(stage:&SigningStage,signed:&Transaction)->Vec<ExternalSignature>{
    stage.signing_requests.iter().map(|r|{
        let raw=signed.inputs[r.input_index as usize].script_sig.as_bytes();
        let sig=if r.script_class=="tbc20-stablecoin" {
            // SDK vector fields are a canonical proof; use the frozen signature.
            let f=fixture();let index=if stage.stage==0{r.input_index as usize}else{2};
            bytes(f["cases"][index]["signatureHex"].as_str().unwrap())
        }else {raw[1..1+raw[0] as usize].to_vec()};
        assert_eq!(sig.last(),Some(&0x41));
        assert_eq!(r.algorithm,if r.public_key.len()==64{"secp256k1-schnorr"}else{"secp256k1-ecdsa"});
        ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),
            input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&sig[..sig.len()-1])}
    }).collect()
}

#[test]
fn mixed_algorithms_share_stage_binding_and_resolve_signed_parents(){
    for (plan,signed) in [issuance(),maintenance()] {
        let first=begin_signing(&plan).unwrap();let sigs=signatures(&first,&signed[0]);
        let StageOutcome::Pending(second)=finalize_signing_stage(&plan,first,&sigs).unwrap()else{panic!("child stage")};
        let sigs=signatures(&second,&signed[1]);
        let StageOutcome::Complete(bundle)=finalize_signing_stage(&plan,second,&sigs).unwrap()else{panic!("complete")};
        for (actual,expected) in bundle.transactions.iter().zip(signed){assert_eq!(actual.raw_transaction,expected.to_hex());assert_eq!(actual.txid,expected.txid().to_string());}
    }
}

#[test]
fn schnorr_rejects_mixed_keys_algorithms_continuations_and_signatures(){
    for case in 0..6 {
        let (mut plan,signed)=maintenance();
        if case==0 {plan.transactions[0].inputs[0].signer.public_key.insert_str(0,"02");assert!(begin_signing(&plan).is_err());continue;}
        let mut stage=begin_signing(&plan).unwrap();let mut sigs=signatures(&stage,&signed[0]);
        match case {1=>stage.signing_requests[0].algorithm="secp256k1-ecdsa".into(),
            2=>sigs[0].signature.push_str("41"),3=>sigs[0].signature="00".repeat(64),
            4=>sigs[0].digest="00".repeat(32),_=>stage.continuation.plan_commitment="00".repeat(32)}
        assert!(finalize_signing_stage(&plan,stage,&sigs).is_err(),"case {case}");
    }
    let (plan,signed)=issuance();let first=begin_signing(&plan).unwrap();let sigs=signatures(&first,&signed[0]);
    let StageOutcome::Pending(mut next)=finalize_signing_stage(&plan,first,&sigs).unwrap()else{panic!("pending")};
    let sigs=signatures(&next,&signed[1]);next.continuation.finalized_transactions[0].as_mut().unwrap().raw_transaction.replace_range(0..2,"09");
    assert!(finalize_signing_stage(&plan,next,&sigs).is_err());
}
