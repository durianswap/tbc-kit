//! Public SDK fixtures; receipt inspection is not a spend or chain-validity proof.
use serde_json::{Value,json};
use tbc_sdk::{Transaction,TxIn,TxOut,Address,hash,script::Script};
use tbc_engine_core::protocols::amm_lp;

fn wire(tx:&Transaction)->Value{json!({"txid":tx.txid().to_string(),"rawTransaction":tx.to_hex()})}
fn request(pool:&Transaction,tx:&Transaction)->Value{json!({"phase":"inspectLpReceipt","poolOrigin":wire(pool),"transaction":wire(tx)})}
fn call(request:&Value)->Result<Value,String>{
    let result=tbc_keyless_core::call("inspectAmmMaterial",&request.to_string()).map(|r|serde_json::from_str(&r).unwrap());
    if std::env::var("LP_RECEIPT_DUMP_WIRE").as_deref()==Ok("1"){
        println!("LP_RECEIPT_WIRE:{}",json!({"input":request,"result":result.as_ref().ok(),"error":result.is_err()}));
    }
    result
}
fn current(label:&str)->(Transaction,Transaction){
    let f:Value=serde_json::from_str(include_str!("../../../fixtures/amm-pool-proof.json")).unwrap();
    let row=f["vectors"].as_array().unwrap().iter().find(|r|r["id"]==format!("{label}-add")).unwrap();
    (Transaction::from_hex(f["raws"][row["parentTxid"].as_str().unwrap()].as_str().unwrap()).unwrap(),
        Transaction::from_hex(row["currentRaw"].as_str().unwrap()).unwrap())
}

#[test]
fn current_lp_receipts_reuse_four_sdk_profiles_without_recipient_public_key(){
    for label in ["public-plain","public-locked","controller-plain","controller-locked"]{
        let(pool,tx)=current(label);let r=call(&request(&pool,&tx)).unwrap();
        assert_eq!(r["generation"],"current");assert_eq!(r["poolContractId"],pool.txid().to_string());
        let outputs=r["outputs"].as_array().unwrap();assert!(!outputs.is_empty());
        for out in outputs{
            assert_eq!(out["contractCodeMatches"],true);
            let vout=out["codeVout"].as_u64().unwrap() as usize;
            let code=amm_lp::parse_code(tx.outputs[vout].script_pubkey.as_bytes()).unwrap();
            let tape=amm_lp::Tape::decode(tx.outputs[vout+1].script_pubkey.as_bytes(),code.timelocked,Some(code.tape_size)).unwrap();
            assert_eq!(out["balanceRaw"],tape.balance().unwrap().to_string());
            assert_eq!(out["controller"],hex::encode(code.controller));
            assert_eq!(out["lockTime"],tape.lock_time);
        }
        let(other,_)=current(if label=="public-plain"{"controller-locked"}else{"public-plain"});
        let wrong=call(&request(&other,&tx)).unwrap();
        assert!(wrong["outputs"].as_array().unwrap().iter().all(|o|o["contractCodeMatches"]==false));
    }
}

#[test]
fn receipt_rejects_hash_origin_and_pair_tampering(){
    let(pool,tx)=current("public-locked");
    let mut bad=request(&pool,&tx);bad["transaction"]["txid"]=json!("00".repeat(32));assert!(call(&bad).is_err());
    let mut wrong=pool.clone();wrong.inputs[0].previous_output.vout+=1;assert!(call(&request(&wrong,&tx)).is_err());
    let vout=tx.outputs.iter().position(|o|amm_lp::parse_code(o.script_pubkey.as_bytes()).is_ok()).unwrap();
    for field in 0..3{
        let mut wrong=tx.clone();
        match field{
            0=>wrong.outputs[vout].satoshis=499,
            1=>wrong.outputs[vout+1].satoshis=1,
            _=>{let mut bytes=wrong.outputs[vout+1].script_pubkey.as_bytes().to_vec();bytes[0]^=1;wrong.outputs[vout+1].script_pubkey=Script::from_bytes(bytes);},
        }
        assert!(call(&request(&pool,&wrong)).is_err());
    }
}

fn historical(locked:bool)->(Transaction,Transaction){
    use tbc_sdk::contracts::{ft::partial_sha256::calculate_partial_hash,pool_nft_v2::*};
    let f:Value=serde_json::from_str(include_str!("../../../vendor/tbc-sdk/tests/fixtures/pool-v2-js-165.json")).unwrap();
    let source=tbc_sdk::OutPoint{txid:f["sourceTxid"].as_str().unwrap().parse().unwrap(),vout:f["sourceVout"].as_u64().unwrap() as u32};
    let mut state=PoolState::from_v2_tape(&Script::from_bytes(hex::decode(f["scripts"]["poolTape"]["hex"].as_str().unwrap()).unwrap()),String::new()).unwrap();
    state.public_key_locked=false;state.ftlp_lock_time_enabled=locked;
    let code=pool_code(source.clone(),b"receipt",&PoolCodeParams{lp_plan:state.lp_plan,ft_version:FtScriptVersion::V3,is_coin:false}).unwrap();
    let tape=ftlp_tape(&FtlpTapeParams{amount_raw:123,layout:if locked{FtlpTapeLayout::LockTime{lock_time:829999,source_ft_tape_size:91}}
        else{FtlpTapeLayout::Standard{decimal:6,name:"LP",symbol:"LP",is_coin:false}}}).unwrap();
    let params=FtlpCodeParams::for_tape(&tape,FtScriptVersion::V3,false).unwrap();
    let owner=Address::from_hash160([1;20]);
    let lp=(if locked{ftlp_lock_time_code(hash::sha256(code.as_bytes()),&owner,&params)}else{ftlp_code(hash::sha256(code.as_bytes()),&owner,&params)}).unwrap();
    state.ft_lp_partial_hash=calculate_partial_hash(&lp.as_bytes()[..lp.as_bytes().len()-28]).to_vec();
    let pool=Transaction{version:10,inputs:vec![TxIn::new(source)],outputs:vec![TxOut{satoshis:1000,script_pubkey:code},TxOut{satoshis:0,script_pubkey:pool_tape(&state).unwrap()}],lock_time:0};
    let tx=Transaction{version:10,inputs:vec![TxIn::new(tbc_sdk::OutPoint{txid:pool.txid(),vout:0})],
        outputs:vec![TxOut{satoshis:500,script_pubkey:lp},TxOut{satoshis:0,script_pubkey:tape}],lock_time:0};
    (pool,tx)
}

#[test]
fn historical_lp_receipts_bind_pool_identity_and_preserve_locks(){
    for locked in [false,true]{
        let(pool,tx)=historical(locked);let result=call(&request(&pool,&tx)).unwrap();
        assert_eq!(result["generation"],"historical");assert_eq!(result["outputs"].as_array().unwrap().len(),1);
        let out=&result["outputs"][0];assert_eq!(out["balanceRaw"],"123");assert_eq!(out["contractCodeMatches"],true);
        assert_eq!(out["controller"],format!("{}00","01".repeat(20)));
        assert_eq!(out["lockTime"],if locked{json!(829999)}else{json!(0)});
        let(other,_)=historical(!locked);assert_eq!(call(&request(&other,&tx)).unwrap()["outputs"][0]["contractCodeMatches"],false);
    }
}

#[test]
fn receipt_cross_generation_and_unknown_fields_cannot_grant_a_match(){
    let(new_pool,new_tx)=current("public-plain");let(old_pool,old_tx)=historical(false);
    for(pool,tx)in [(&old_pool,&new_tx),(&new_pool,&old_tx)]{
        let result=call(&request(pool,tx)).unwrap();
        assert!(result["outputs"].as_array().unwrap().iter().all(|o|o["contractCodeMatches"]==false));
    }
    let mut bad=request(&new_pool,&new_tx);bad["privateKey"]=json!("not-a-secret");assert!(call(&bad).is_err());
    let mut bad=request(&new_pool,&new_tx);bad["transaction"]["rawTransaction"]=json!(new_tx.to_hex().to_uppercase());assert!(call(&bad).is_err());
}
