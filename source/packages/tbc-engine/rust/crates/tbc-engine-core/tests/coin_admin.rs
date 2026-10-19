//! Fixed SDK synthetic freeze/unfreeze; public signature bytes, no wallet key.
use serde_json::Value;
use tbc_engine_core::{ErrorCode,protocols::{coin_admin::*,coin_proof,coin,tbc20_transfer::FeeInput},signing::*};
use tbc_sdk::{Transaction,OutPoint,PublicKey};
fn bytes(s:&str)->Vec<u8>{(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hex(b:&[u8])->String{b.iter().map(|v|format!("{v:02x}")).collect()}
fn fixture()->Value{serde_json::from_str(include_str!("../../../fixtures/coin-admin-proof.json")).unwrap()}
fn tx(v:&Value)->Transaction{Transaction::from_hex(v.as_str().unwrap()).unwrap()}
fn key()->PublicKey{PublicKey::from_slice(&bytes("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")).unwrap()}

// Test-only public scalars, never passed to a builder or production Engine.
fn sign_public(plan:&UnsignedPlan)->Transaction {
    let mut scalar=[0;32];scalar[31]=1;let fee=tbc_sdk::PrivateKey::from_slice(&scalar).unwrap();
    scalar[31]=2;let secp=secp256k1::Secp256k1::new();
    let admin=secp256k1::Keypair::from_secret_key(&secp,&secp256k1::SecretKey::from_byte_array(scalar).unwrap());
    let stage=begin_signing(plan).unwrap();
    let signatures=stage.signing_requests.iter().map(|r|{
        let digest:[u8;32]=bytes(&r.digest).try_into().unwrap();
        let signature=if r.algorithm=="secp256k1-schnorr"{secp.sign_schnorr_no_aux_rand(&digest,&admin).as_ref().to_vec()}
            else{fee.sign_ecdsa_digest(&digest)};
        ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),
            input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&signature)}
    }).collect::<Vec<_>>();
    let StageOutcome::Complete(bundle)=finalize_signing_stage(plan,stage,&signatures).unwrap()else{panic!("single stage")};
    Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap()
}

#[test]
fn admin_groups_mixed_controllers_with_absolute_slots_and_external_signer() {
    use tbc_engine_core::protocols::coin_transfer::{CoinInput,Receiver,TransferOptions,build_transfer_plan};
    let f=fixture();let issuer=tx(&f["issuance"]["parentRaw"]);let mint=tx(&f["issuance"]["signedRaw"]);let key=key();
    let admin:[u8;32]=bytes(f["issuance"]["publicKeyHex"].as_str().unwrap()).try_into().unwrap();
    let mut owner=[0;21];owner[..20].copy_from_slice(&key.hash160());let mut contract=[0x22;21];contract[20]=1;
    let material=coin_proof::inspect_parent(&mint.serialize(),&OutPoint{txid:mint.txid(),vout:3},None).unwrap();
    let issuer_raw=issuer.serialize();let ancestors=[issuer_raw.as_slice()];
    let inputs=[CoinInput{parent:&material,ancestor_raws:&ancestors,public_key:&key}];
    let fee=FeeInput{outpoint:OutPoint{txid:mint.txid(),vout:5},output:&mint.outputs[5],public_key:&key};
    let receivers=[Receiver{controller:owner,amount:250},Receiver{controller:contract,amount:300}];
    let split=build_transfer_plan(TransferOptions{inputs:&inputs,fee_input:&fee,receivers:&receivers,expected_identity:material.identity(),
        token_change_controller:owner,additional_payment:None,additional_info:None,max_fee:10000}).unwrap();
    let split_tx=sign_public(&split.unsigned_plan);let mut parent=split_tx.clone();let mut ancestor=mint.clone();let mut report=Vec::new();
    for (lock,vouts) in [(u32::MAX,vec![2,0,4]),(0,vec![2,0])] {
        let materials:Vec<_>=vouts.iter().map(|&vout|coin_proof::inspect_parent(&parent.serialize(),&OutPoint{txid:parent.txid(),vout},None).unwrap()).collect();
        let ancestor_raw=ancestor.serialize();let refs=[ancestor_raw.as_slice()];
        let inputs:Vec<_>=materials.iter().map(|parent|AdminInput{parent,ancestor_raws:&refs}).collect();
        let fee=FeeInput{outpoint:OutPoint{txid:parent.txid(),vout:parent.outputs.len()as u32-1},output:parent.outputs.last().unwrap(),public_key:&key};
        let plan=build_change_locks_plan(ChangeLocksOptions{inputs:&inputs,expected_identity:material.identity(),administrator:&admin,fee_input:&fee,lock_time:lock,max_fee:10000}).unwrap();
        assert_eq!(plan.unsigned_plan.evidence_table.len(),2);
        let signed=sign_public(&plan.unsigned_plan);assert_eq!(signed.outputs.len(),5);
        assert!(signed.serialize().len()<=plan.maximum_signed_bytes[0]);
        for group in 0..2 {
            let p=coin_proof::inspect_parent(&signed.serialize(),&OutPoint{txid:signed.txid(),vout:group*2},None).unwrap();
            let expected=if (lock!=0)==(group==0){contract}else{owner};
            assert_eq!(p.code().controller,expected);assert_eq!(p.tape().lock_time,lock);
            assert_eq!(p.tape().balance,if expected==contract{300}else{700});
        }
        report.push(serde_json::json!({"lock":lock,"vouts":vouts,"raw":signed.to_hex(),"fee":plan.fees[0],"maximumSignedBytes":plan.maximum_signed_bytes[0]}));
        ancestor=parent;parent=signed;
    }
    if let Ok(path)=std::env::var("COIN_ADMIN_REPORT") {
        std::fs::write(path,serde_json::to_vec(&serde_json::json!({"network":false,"publicScalars":[1,2],"splitRaw":split_tx.to_hex(),"cases":report})).unwrap()).unwrap();
    }
}

#[test]
fn admin_builder_matches_sdk_freeze_unfreeze_raws_without_private_keys() {
    let f=fixture();let fee_key=key();
    for (indexes,lock) in [(vec![0usize,1],u32::MAX),(vec![2usize],0)] {
        let vectors:Vec<_>=indexes.iter().map(|&i|&f["cases"][i]).collect();
        let parent=tx(&vectors[0]["parentRaw"]);let expected=tx(&vectors[0]["signedRaw"]);
        let admin:[u8;32]=bytes(vectors[0]["publicKeyHex"].as_str().unwrap()).try_into().unwrap();
        let materials:Vec<_>=vectors.iter().map(|v|coin_proof::inspect_parent(&parent.serialize(),&OutPoint {
            txid:parent.txid(),vout:v["parentCodeVout"].as_u64().unwrap()as u32},None).unwrap()).collect();
        let ancestors:Vec<_>=vectors[0]["ancestorsRaw"].as_array().unwrap().iter().map(|v|bytes(v.as_str().unwrap())).collect();
        let refs:Vec<_>=ancestors.iter().map(Vec::as_slice).collect();
        let inputs:Vec<_>=materials.iter().map(|parent|AdminInput{parent,ancestor_raws:&refs}).collect();
        let fee_index=parent.outputs.len()as u32-1;
        let fee=FeeInput{outpoint:OutPoint{txid:parent.txid(),vout:fee_index},output:&parent.outputs[fee_index as usize],public_key:&fee_key};
        let plan=build_change_locks_plan(ChangeLocksOptions{inputs:&inputs,expected_identity:materials[0].identity(),administrator:&admin,
            fee_input:&fee,lock_time:lock,max_fee:10000}).unwrap();
        assert_eq!(plan.unsigned_plan.evidence_table.len(),2,"shared parent/ancestor must be interned");
        assert_eq!(plan.unsigned_plan.transactions[0].lock_time,0,"administrator bypasses input maturity, not output conservation");
        for (actual,expected) in plan.unsigned_plan.transactions[0].outputs.iter().zip(&expected.outputs){
            assert_eq!(actual.satoshis,expected.satoshis);assert_eq!(actual.locking_script,hex(expected.script_pubkey.as_bytes()));
        }
        let stage=begin_signing(&plan.unsigned_plan).unwrap();
        let signatures=stage.signing_requests.iter().map(|r|{
            let sig=if let Some(v)=vectors.get(r.input_index as usize){bytes(v["signatureHex"].as_str().unwrap())}
                else{let script=expected.inputs[r.input_index as usize].script_sig.as_bytes();script[1..1+script[0]as usize].to_vec()};
            ExternalSignature {session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),
                input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&sig[..sig.len()-1])}
        }).collect::<Vec<_>>();
        let StageOutcome::Complete(bundle)=finalize_signing_stage(&plan.unsigned_plan,stage,&signatures).unwrap()else{panic!("single stage")};
        assert_eq!(bundle.transactions[0].raw_transaction,expected.to_hex());
        assert_eq!(bundle.transactions[0].txid,expected.txid().to_string());
        assert!(plan.maximum_signed_bytes[0]>=expected.serialize().len());
        let total=plan.unsigned_plan.transactions[0].inputs.iter().map(|i|i.previous_output_satoshis).sum::<u64>();
        assert_eq!(plan.fees[0],total-expected.outputs.iter().map(|o|o.satoshis).sum::<u64>());
        assert_eq!(coin::parse_tape(expected.outputs[1].script_pubkey.as_bytes(),None).unwrap().lock_time,lock);
    }
}

#[test]
fn admin_builder_rejects_bad_authority_identity_ancestry_fee_and_input_sets() {
    let f=fixture();let v=&f["cases"][0];let parent=tx(&v["parentRaw"]);let key=key();
    let admin:[u8;32]=bytes(v["publicKeyHex"].as_str().unwrap()).try_into().unwrap();
    let material=coin_proof::inspect_parent(&parent.serialize(),&OutPoint{txid:parent.txid(),vout:0},None).unwrap();
    let raw=bytes(v["ancestorsRaw"][0].as_str().unwrap());let refs=[raw.as_slice()];
    let inputs=[AdminInput{parent:&material,ancestor_raws:&refs}];
    let fee=FeeInput{outpoint:OutPoint{txid:parent.txid(),vout:parent.outputs.len()as u32-1},output:parent.outputs.last().unwrap(),public_key:&key};
    let options=||ChangeLocksOptions{inputs:&inputs,expected_identity:material.identity(),administrator:&admin,fee_input:&fee,lock_time:12345,max_fee:10000};
    let mut bad=options();bad.expected_identity=&[1];assert!(build_change_locks_plan(bad).is_err());
    let mut bad=options();bad.administrator=&[255;32];assert!(build_change_locks_plan(bad).is_err());
    let mut bad=options();bad.max_fee=1;assert_eq!(build_change_locks_plan(bad).unwrap_err().code,ErrorCode::FeeCapExceeded);
    let duplicate=[AdminInput{parent:&material,ancestor_raws:&refs},AdminInput{parent:&material,ancestor_raws:&refs}];
    let mut bad=options();bad.inputs=&duplicate;assert!(build_change_locks_plan(bad).is_err());
    let missing=[AdminInput{parent:&material,ancestor_raws:&[]}];let mut bad=options();bad.inputs=&missing;assert!(build_change_locks_plan(bad).is_err());
    let mut bad=options();bad.inputs=&[];assert!(build_change_locks_plan(bad).is_err());
    let mut tiny=fee.output.clone();tiny.satoshis=1;let small=FeeInput{output:&tiny,outpoint:fee.outpoint.clone(),public_key:&key};
    let mut bad=options();bad.fee_input=&small;assert_eq!(build_change_locks_plan(bad).unwrap_err().code,ErrorCode::InsufficientFunds);
}
