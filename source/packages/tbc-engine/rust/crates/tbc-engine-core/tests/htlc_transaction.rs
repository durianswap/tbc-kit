use sha2::{Digest,Sha256};
use tbc_engine_core::{protocols::{htlc::Code,htlc_transaction::{build_lock_plan,build_spend_plan,HtlcPlan,SpendBranch,MAX_PREIMAGE_BYTES},tbc20_mint::fee_for_size},
    signing::{begin_signing,finalize_signing_stage,ExternalSignature,StageOutcome}};
use tbc_sdk::{OutPoint,PrivateKey,Txid,UtxoInfo,Transaction,script::Script};
fn key(value:u8)->PrivateKey{let mut scalar=[0;32];scalar[31]=value;PrivateKey::from_slice(&scalar).unwrap()}
fn hex(bytes:&[u8])->String{bytes.iter().map(|b|format!("{b:02x}")).collect()}
fn decode(value:&str)->Vec<u8>{value.as_bytes().chunks_exact(2).map(|s|u8::from_str_radix(std::str::from_utf8(s).unwrap(),16).unwrap()).collect()}
fn code(secret:&[u8],lock:u32)->Code{Code{sender_hash:key(1).public_key().hash160(),receiver_hash:key(2).public_key().hash160(),hashlock:Sha256::digest(secret).into(),raw_lock_time:lock}}
fn inputs(count:usize,code:Option<&Code>)->Vec<UtxoInfo>{(0..count).map(|i|UtxoInfo{outpoint:OutPoint{txid:Txid::from_le_bytes([(i+1)as u8;32]),vout:0},satoshis:10000,
    script_pubkey:code.map_or_else(||Script::p2pkh(&key(1).public_key().hash160()),|c|Script::from_bytes(c.encode()))}).collect()}
fn finish(built:&HtlcPlan,inputs:&[UtxoInfo],signer:u8,operation:&str,secret:&[u8])->Transaction{
    let stage=begin_signing(&built.unsigned_plan).unwrap();assert_eq!(stage.signing_requests.len(),inputs.len());
    assert!(stage.signing_requests.iter().all(|r|r.script_class==if operation=="lock"{"p2pkh"}else{"tbc-htlc"}));
    let signatures=stage.signing_requests.iter().map(|r|ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),
        transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),
        signature:hex(&key(signer).sign_ecdsa_digest(&decode(&r.digest).try_into().unwrap()))}).collect::<Vec<_>>();
    let StageOutcome::Complete(bundle)=finalize_signing_stage(&built.unsigned_plan,stage,&signatures).unwrap()else{panic!("Single stage expected")};
    let tx=Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap();
    assert!(tx.serialize().len()<=built.maximum_signed_bytes);assert!(built.fee>=fee_for_size(tx.serialize().len()).unwrap());
    assert_eq!(inputs.iter().map(|u|u.satoshis).sum::<u64>()-tx.outputs.iter().map(|o|o.satoshis).sum::<u64>(),built.fee);
    if std::env::var("HTLC_TX_DUMP_WIRE").as_deref()==Ok("1"){
        // Every key and preimage in this test is a public synthetic fixture.
        println!("HTLC_TX_WIRE:{}",serde_json::json!({"operation":operation,"raw":hex(&tx.serialize()),"fee":built.fee,"maximumSignedBytes":built.maximum_signed_bytes,
            "secret":hex(secret),"inputs":inputs.iter().map(|u|serde_json::json!({"txId":u.outpoint.txid.to_string(),"outputIndex":u.outpoint.vout,
            "satoshis":u.satoshis,"script":hex(u.script_pubkey.as_bytes())})).collect::<Vec<_>>()}));
    }tx
}
#[test]
fn keyless_native_htlc_uses_shared_external_signatures_and_sized_fees(){
    let secret=vec![0x33;32];let contract=code(&secret,834801);
    for count in [1,7]{
        let funding=inputs(count,None);let locked=inputs(count,Some(&contract));
        let built=build_lock_plan(&funding,&key(1).public_key(),&contract,3000,1000).unwrap();
        assert_eq!(finish(&built,&funding,1,"lock",&secret).outputs[0].script_pubkey.as_bytes(),contract.encode());
        let built=build_spend_plan(&locked,&key(2).public_key(),&SpendBranch::Claim(secret.clone()),None,None,1000).unwrap();
        assert_eq!(finish(&built,&locked,2,"claim",&secret).lock_time,0);
        let built=build_spend_plan(&locked,&key(1).public_key(),&SpendBranch::Refund,Some(834801),None,1000).unwrap();
        assert_eq!(finish(&built,&locked,1,"refund",&secret).lock_time,834801);
    }
    let contract=code(&secret,1774427165);let locked=inputs(1,Some(&contract));
    let built=build_spend_plan(&locked,&key(1).public_key(),&SpendBranch::Refund,Some(834801),Some(1774427166),1000).unwrap();
    finish(&built,&locked,1,"refund",&secret);
}
#[test]
fn claim_push_boundaries_are_bounded_and_minimal(){
    for secret in [vec![],vec![0],vec![1],vec![16],vec![0x81],vec![0x33;75],vec![0x33;76],vec![0x33;255],vec![0x33;256],vec![0x33;521],vec![0x33;MAX_PREIMAGE_BYTES]]{
        let locked=inputs(1,Some(&code(&secret,834801)));
        let built=build_spend_plan(&locked,&key(2).public_key(),&SpendBranch::Claim(secret.clone()),None,None,10000).unwrap();
        finish(&built,&locked,2,"claim",&secret);
    }
    assert!(SpendBranch::Claim(vec![0;MAX_PREIMAGE_BYTES+1]).descriptor().is_err());
}
#[test]
fn htlc_rejects_wrong_role_proof_domain_maturity_fee_and_tampering(){
    let secret=vec![0x33;32];let contract=code(&secret,834801);let funding=inputs(1,None);let locked=inputs(1,Some(&contract));
    assert!(build_lock_plan(&[],&key(1).public_key(),&contract,3000,1000).is_err());
    assert!(build_lock_plan(&[funding[0].clone(),funding[0].clone()],&key(1).public_key(),&contract,3000,1000).is_err());
    assert!(build_lock_plan(&funding,&key(2).public_key(),&contract,3000,1000).is_err());
    assert!(build_lock_plan(&funding,&key(1).public_key(),&contract,0,1000).is_err());
    assert!(build_lock_plan(&funding,&key(1).public_key(),&code(&secret,u32::MAX),3000,1000).is_err());
    assert!(build_lock_plan(&funding,&key(1).public_key(),&contract,10000,1000).is_err());
    assert!(build_lock_plan(&funding,&key(1).public_key(),&contract,3000,79).is_err());
    assert!(build_spend_plan(&locked,&key(1).public_key(),&SpendBranch::Claim(secret.clone()),None,None,1000).is_err());
    assert!(build_spend_plan(&locked,&key(2).public_key(),&SpendBranch::Claim(vec![0x34;32]),None,None,1000).is_err());
    assert!(build_spend_plan(&locked,&key(2).public_key(),&SpendBranch::Refund,Some(834801),None,1000).is_err());
    assert!(build_spend_plan(&locked,&key(1).public_key(),&SpendBranch::Refund,Some(834800),None,1000).is_err());
    let time=inputs(1,Some(&code(&secret,1774427165)));
    for mtp in [None,Some(1774427165)]{assert!(build_spend_plan(&time,&key(1).public_key(),&SpendBranch::Refund,Some(834801),mtp,1000).is_err());}
    let mut mixed=locked.clone();let mut other=time[0].clone();other.outpoint.vout=1;mixed.push(other);
    assert!(build_spend_plan(&mixed,&key(1).public_key(),&SpendBranch::Refund,Some(834801),Some(1774427166),1000).is_err());
    let built=build_spend_plan(&locked,&key(1).public_key(),&SpendBranch::Refund,Some(834801),None,1000).unwrap();
    for kind in 0..4{
        let mut plan=built.unsigned_plan.clone();let tx=&mut plan.transactions[0];
        match kind{0=>tx.lock_time=834800,1=>tx.inputs[0].sequence=u32::MAX,2=>tx.lock_time=1774427165,_=>tx.inputs[0].unlocking_script.push_str(":unknown")}
        assert!(begin_signing(&plan).is_err());
    }
    let built=build_spend_plan(&locked,&key(2).public_key(),&SpendBranch::Claim(secret),None,None,1000).unwrap();
    let mut bad=built.unsigned_plan.clone();bad.transactions[0].inputs[0].unlocking_script="tbc-htlc-claim:aa".into();assert!(begin_signing(&bad).is_err());
    let stage=begin_signing(&built.unsigned_plan).unwrap();
    let wrong=stage.signing_requests.iter().map(|r|ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),
        transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),
        signature:hex(&key(1).sign_ecdsa_digest(&decode(&r.digest).try_into().unwrap()))}).collect::<Vec<_>>();
    assert!(finalize_signing_stage(&built.unsigned_plan,stage,&wrong).is_err());
}

#[test]
fn htlc_claim_parent_continuation_rechecks_canonical_branch_and_signature(){
    let secret=vec![0x33;32];let locked=inputs(1,Some(&code(&secret,834801)));
    let mut plan=build_spend_plan(&locked,&key(2).public_key(),&SpendBranch::Claim(secret),None,None,1000).unwrap().unsigned_plan;
    let mut child=plan.transactions[0].clone();child.transaction_id="after-claim".into();child.role="p2pkh".into();child.stage=1;
    child.depends_on=vec![plan.transactions[0].transaction_id.clone()];
    child.inputs[0].previous_transaction_id=plan.transactions[0].transaction_id.clone();
    child.inputs[0].previous_output_satoshis=plan.transactions[0].outputs[0].satoshis;
    child.inputs[0].previous_output_script=plan.transactions[0].outputs[0].locking_script.clone();
    child.inputs[0].unlocking_script.clear();child.outputs[0].satoshis-=80;plan.transactions.push(child);
    let sign=|stage:&tbc_engine_core::signing::SigningStage|stage.signing_requests.iter().map(|r|ExternalSignature{
        session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),
        input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),
        signature:hex(&key(2).sign_ecdsa_digest(&decode(&r.digest).try_into().unwrap()))}).collect::<Vec<_>>();
    let first=begin_signing(&plan).unwrap();let signatures=sign(&first);
    let StageOutcome::Pending(second)=finalize_signing_stage(&plan,first,&signatures).unwrap()else{panic!("Dependent stage expected")};
    let signatures=sign(&second);
    for kind in 0..3{
        let mut tampered:tbc_engine_core::signing::SigningStage=serde_json::from_value(serde_json::to_value(&second).unwrap()).unwrap();
        let parent=tampered.continuation.finalized_transactions[0].as_mut().unwrap();
        let mut tx=Transaction::from_hex(&parent.raw_transaction).unwrap();let mut script=tx.inputs[0].script_sig.as_bytes().to_vec();
        match kind{
            0=>{*script.last_mut().unwrap()=0;},
            1=>{let last=script.len()-2;script[last]^=1;},
            _=>{script.pop();script.extend_from_slice(&[1,1]);},
        }
        tx.inputs[0].script_sig=Script::from_bytes(script);parent.raw_transaction=tx.to_hex();parent.txid=tx.txid().to_string();
        assert!(finalize_signing_stage(&plan,tampered,&signatures).is_err());
    }
    assert!(matches!(finalize_signing_stage(&plan,second,&signatures).unwrap(),StageOutcome::Complete(_)));
}
