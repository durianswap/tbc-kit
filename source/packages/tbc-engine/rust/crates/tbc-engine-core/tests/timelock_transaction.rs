use tbc_engine_core::{ErrorCode,protocols::{timelock::height_code,timelock_transaction::{build_lock_plan,build_unlock_plan,TimelockPlan},tbc20_mint::fee_for_size},
    signing::{begin_signing,finalize_signing_stage,ExternalSignature,StageOutcome,SigningStage}};
use tbc_sdk::{OutPoint,PrivateKey,Txid,UtxoInfo,Transaction,script::Script};
fn key(value:u8)->PrivateKey{let mut scalar=[0;32];scalar[31]=value;PrivateKey::from_slice(&scalar).unwrap()}
fn hex(bytes:&[u8])->String{bytes.iter().map(|b|format!("{b:02x}")).collect()}
fn decode(value:&str)->Vec<u8>{value.as_bytes().chunks_exact(2).map(|s|u8::from_str_radix(std::str::from_utf8(s).unwrap(),16).unwrap()).collect()}
fn inputs(count:usize,locked:bool)->Vec<UtxoInfo>{
    let owner=key(1).public_key();
    (0..count).map(|i|UtxoInfo{outpoint:OutPoint{txid:Txid::from_le_bytes([(i+1) as u8;32]),vout:0},satoshis:10000,
        script_pubkey:if locked{Script::from_bytes(height_code(owner.hash160(),830000-i as u32).unwrap())}else{Script::p2pkh(&owner.hash160())}}).collect()
}
fn sign(stage:&SigningStage,value:u8)->Vec<ExternalSignature>{
    stage.signing_requests.iter().map(|r|ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,
        stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),input_index:r.input_index,
        digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&key(value).sign_ecdsa_digest(&decode(&r.digest).try_into().unwrap()))}).collect()
}
fn finish(built:&TimelockPlan,utxos:&[UtxoInfo],unlock:bool)->Transaction{
    let stage=begin_signing(&built.unsigned_plan).unwrap();assert_eq!(stage.signing_requests.len(),utxos.len());
    assert!(stage.signing_requests.iter().all(|r|r.script_class==if unlock{"tbc-timelock"}else{"p2pkh"}));
    let signatures=sign(&stage,1);
    let StageOutcome::Complete(bundle)=finalize_signing_stage(&built.unsigned_plan,stage,&signatures).unwrap()else{panic!("Single stage expected")};
    assert_eq!(bundle.transactions.len(),1);let tx=Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap();
    assert!(tx.serialize().len()<=built.maximum_signed_bytes);assert!(built.fee>=fee_for_size(tx.serialize().len()).unwrap());
    assert_eq!(utxos.iter().map(|u|u.satoshis).sum::<u64>()-tx.outputs.iter().map(|o|o.satoshis).sum::<u64>(),built.fee);
    if std::env::var("TIMELOCK_TX_DUMP_WIRE").as_deref()==Ok("1"){
        println!("TIMELOCK_TX_WIRE:{}",serde_json::json!({"operation":if unlock{"unlock"}else{"lock"},"raw":hex(&tx.serialize()),
          "amount":if unlock{0}else{tx.outputs[0].satoshis},"height":830000,"fee":built.fee,"maximumSignedBytes":built.maximum_signed_bytes,
          "inputs":utxos.iter().map(|u|serde_json::json!({"txId":u.outpoint.txid.to_string(),"outputIndex":u.outpoint.vout,
            "satoshis":u.satoshis,"script":hex(u.script_pubkey.as_bytes())})).collect::<Vec<_>>()}));
    }tx
}
#[test]
fn timelock_builders_share_external_signatures_and_bound_real_signed_size(){
    for count in [1,7]{
        let native=inputs(count,false);let lock=build_lock_plan(&native,&key(1).public_key(),3000,830000,1000).unwrap();
        let tx=finish(&lock,&native,false);assert_eq!(tx.outputs[0].satoshis,3000);
        let locked=inputs(count,true);let unlock=build_unlock_plan(&locked,&key(1).public_key(),830000,1000).unwrap();
        let tx=finish(&unlock,&locked,true);assert_eq!(tx.lock_time,830000);assert!(tx.inputs.iter().all(|i|i.sequence==0xfffffffe));
    }
    let mut native=inputs(1,false);native[0].satoshis=3080;
    let lock=build_lock_plan(&native,&key(1).public_key(),3000,830000,80).unwrap();
    assert_eq!(finish(&lock,&native,false).outputs.len(),1);
}
#[test]
fn timelock_builders_reject_bad_funding_owner_height_and_caps(){
    let native=inputs(1,false);let owner=key(1).public_key();let locked=inputs(1,true);
    assert!(build_lock_plan(&[],&owner,3000,830000,1000).is_err());
    assert!(build_lock_plan(&[native[0].clone(),native[0].clone()],&owner,3000,830000,1000).is_err());
    assert!(build_lock_plan(&native,&key(2).public_key(),3000,830000,1000).is_err());
    assert!(build_lock_plan(&native,&owner,0,830000,1000).is_err());
    assert!(build_lock_plan(&native,&owner,3000,500000000,1000).is_err());
    assert_eq!(build_lock_plan(&native,&owner,10000,830000,1000).unwrap_err().code,ErrorCode::InsufficientFunds);
    assert_eq!(build_lock_plan(&native,&owner,3000,830000,79).unwrap_err().code,ErrorCode::FeeCapExceeded);
    assert!(build_unlock_plan(&locked,&key(2).public_key(),830000,1000).is_err());
    assert!(build_unlock_plan(&locked,&owner,829999,1000).is_err());
    assert!(build_unlock_plan(&native,&owner,830000,1000).is_err());
    assert_eq!(build_unlock_plan(&locked,&owner,830000,79).unwrap_err().code,ErrorCode::FeeCapExceeded);
    let mut large=native.clone();large[0].satoshis=u64::MAX;assert!(build_lock_plan(&large,&owner,3000,830000,1000).is_err());
}
#[test]
fn shared_signer_rejects_timelock_condition_or_owner_tampering_before_signing(){
    let built=build_unlock_plan(&inputs(1,true),&key(1).public_key(),830000,1000).unwrap();
    for kind in 0..5{
        let mut plan=built.unsigned_plan.clone();let tx=&mut plan.transactions[0];
        match kind{0=>tx.inputs[0].sequence=u32::MAX,1=>tx.lock_time=829999,2=>tx.lock_time=1700000000,
            3=>tx.inputs[0].unlocking_script.push_str(":unbound"),_=>{
                tx.inputs[0].previous_output_script=hex(&height_code(key(2).public_key().hash160(),830000).unwrap());
            }}assert!(begin_signing(&plan).is_err(),"case {kind}");
    }
    let stage=begin_signing(&built.unsigned_plan).unwrap();let signatures=sign(&stage,2);
    assert!(finalize_signing_stage(&built.unsigned_plan,stage,&signatures).is_err());
    let stage=begin_signing(&built.unsigned_plan).unwrap();let signatures=sign(&stage,1);let mut changed=built.unsigned_plan.clone();
    changed.transactions[0].outputs[0].satoshis-=1;assert!(finalize_signing_stage(&changed,stage,&signatures).is_err());
}
