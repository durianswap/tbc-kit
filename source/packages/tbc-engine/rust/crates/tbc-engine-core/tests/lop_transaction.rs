use tbc_engine_core::{protocols::{lop::*,lop_transaction::*,tbc20,coin,tbc20_mint::fee_for_size},
    signing::{begin_signing,finalize_signing_stage,ExternalSignature,StageOutcome,SigningStage}};
use tbc_sdk::{OutPoint,PrivateKey,Txid,UtxoInfo,Transaction,script::Script};
fn key(n:u8)->PrivateKey{let mut b=[0;32];b[31]=n;PrivateKey::from_slice(&b).unwrap()}
fn hex(b:&[u8])->String{b.iter().map(|v|format!("{v:02x}")).collect()}
fn bytes(s:&str)->Vec<u8>{s.as_bytes().chunks_exact(2).map(|v|u8::from_str_radix(std::str::from_utf8(v).unwrap(),16).unwrap()).collect()}
fn setup(is_coin:bool,count:usize)->(Code,Vec<u8>,Vec<UtxoInfo>){
    let owner=key(1).public_key();
    let quote=if is_coin{coin::instantiate_code(&coin::CodeDescriptor{coin_nft_code_hash:[0x22;32],admin_pubkey_hash:owner.hash160(),
        tape_size:66,controller:[0;21]}).unwrap()}else{tbc20::instantiate_code(&tbc20::CodeDescriptor{original_outpoint:[0x22;36],tape_size:61,controller:[0;21]}).unwrap()};
    let identity=if is_coin{coin::code_identity(&quote).unwrap()}else{tbc20::code_identity(&quote).unwrap()};
    let code=Code{side:Side::Sell,market:Market::NativeToken{token_code_bytes:quote.len()as u16,marker:TapeMarker::Modern},tax_hash:key(2).public_key().hash160(),
        terms:Terms{owner_hash:owner.hash160(),sale_volume:3000,fee_rate:100,unit_price:1_100_000,
            asset_a:AssetTerms{partial_hash:identity[..32].try_into().unwrap(),contract_id:[0x44;32]},asset_b:None}};
    let funding=(0..count).map(|i|UtxoInfo{outpoint:OutPoint{txid:Txid::from_le_bytes([(i+1)as u8;32]),vout:0},satoshis:10000,
        script_pubkey:Script::p2pkh(&owner.hash160())}).collect();(code,quote,funding)
}
fn signatures(stage:&SigningStage,signer:u8)->Vec<ExternalSignature>{stage.signing_requests.iter().map(|r|ExternalSignature{
    session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),input_index:r.input_index,
    digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&key(signer).sign_ecdsa_digest(&bytes(&r.digest).try_into().unwrap()))}).collect()}
fn finish(built:&LopPlan,inputs:&[UtxoInfo],quote:&[u8],operation:&str)->Transaction{
    let stage=begin_signing(&built.unsigned_plan).unwrap();assert_eq!(stage.signing_requests.len(),inputs.len());
    assert_eq!(stage.signing_requests[0].script_class,if operation=="cancel"{"tbc-lop"}else{"p2pkh"});
    let signed=signatures(&stage,1);
    let StageOutcome::Complete(bundle)=finalize_signing_stage(&built.unsigned_plan,stage,&signed).unwrap()else{panic!("one stage")};
    let tx=Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap();
    assert!(tx.serialize().len()<=built.maximum_signed_bytes);assert!(built.fee>=fee_for_size(tx.serialize().len()).unwrap());
    assert_eq!(inputs.iter().map(|u|u.satoshis).sum::<u64>()-tx.outputs.iter().map(|o|o.satoshis).sum::<u64>(),built.fee);
    if std::env::var("LOP_TX_DUMP_WIRE").as_deref()==Ok("1"){
        println!("LOP_TX_WIRE:{}",serde_json::json!({"operation":operation,"raw":tx.to_hex(),"quoteCode":hex(quote),"fee":built.fee,"maximumSignedBytes":built.maximum_signed_bytes,
            "inputs":inputs.iter().map(|u|serde_json::json!({"txId":u.outpoint.txid.to_string(),"outputIndex":u.outpoint.vout,"satoshis":u.satoshis,"script":hex(u.script_pubkey.as_bytes())})).collect::<Vec<_>>()}));
    }tx
}
#[test]
fn native_lop_make_cancel_share_external_signing_and_fee_envelope(){
    for is_coin in [false,true]{for count in [1,10]{
        let (code,quote,funding)=setup(is_coin,count);let owner=key(1).public_key();
        let make=build_native_sell_plan(&funding,&owner,&code,&quote,1000).unwrap();let tx=finish(&make,&funding,&quote,"make");
        assert_eq!(tx.outputs[0].satoshis,3000);assert_eq!(tx.outputs[0].script_pubkey.as_bytes(),code.encode().unwrap());
        let order=UtxoInfo{outpoint:OutPoint{txid:tx.txid(),vout:0},satoshis:3000,script_pubkey:tx.outputs[0].script_pubkey.clone()};
        let mut fees=funding.clone();for u in &mut fees{u.outpoint.vout=1;}
        let cancel=build_native_cancel_plan(&order,&fees,&owner,1000).unwrap();let mut inputs=vec![order];inputs.extend(fees);
        let tx=finish(&cancel,&inputs,&quote,"cancel");assert_eq!(tx.outputs[0].satoshis,3000);
        assert_eq!(tx.outputs[0].script_pubkey,Script::p2pkh(&owner.hash160()));assert_eq!(tx.inputs[0].script_sig.as_bytes().last(),Some(&0x52));
    }}
}
#[test]
fn native_lop_rejects_identity_role_fee_and_plan_tampering(){
    let (code,quote,funding)=setup(false,1);let owner=key(1).public_key();
    assert!(build_native_sell_plan(&[],&owner,&code,&quote,1000).is_err());
    assert!(build_native_sell_plan(&vec![funding[0].clone();2],&owner,&code,&quote,1000).is_err());
    assert!(build_native_sell_plan(&funding,&key(2).public_key(),&code,&quote,1000).is_err());
    assert!(build_native_sell_plan(&funding,&owner,&code,&quote,79).is_err());
    for choice in 0..6{
        let mut bad=code.clone();match choice{0=>bad.side=Side::Buy,1=>bad.terms.asset_a.partial_hash[0]^=1,2=>bad.terms.unit_price=0,
            3=>bad.terms.sale_volume=10000,4=>bad.market=Market::NativeToken{token_code_bytes:1,marker:TapeMarker::Modern},_=>bad.terms.owner_hash=[0;20]}
        assert!(build_native_sell_plan(&funding,&owner,&bad,&quote,1000).is_err());
    }
    let mut wrong_quote=quote.clone();wrong_quote[0]^=1;assert!(build_native_sell_plan(&funding,&owner,&code,&wrong_quote,1000).is_err());
    let order=UtxoInfo{outpoint:OutPoint{txid:Txid::from_le_bytes([8;32]),vout:0},satoshis:3000,script_pubkey:Script::from_bytes(code.encode().unwrap())};
    assert!(build_native_cancel_plan(&order,&[],&owner,1000).is_err());assert!(build_native_cancel_plan(&order,&funding,&key(2).public_key(),1000).is_err());
    let mut wrong=order.clone();wrong.satoshis=3001;assert!(build_native_cancel_plan(&wrong,&funding,&owner,1000).is_err());
    let built=build_native_cancel_plan(&order,&funding,&owner,1000).unwrap();let stage=begin_signing(&built.unsigned_plan).unwrap();
    let wrong=signatures(&stage,2);assert!(finalize_signing_stage(&built.unsigned_plan,stage,&wrong).is_err());
    let mut bad=built.unsigned_plan.clone();bad.transactions[0].inputs[0].unlocking_script.push_str(":unbound");assert!(begin_signing(&bad).is_err());
    let mut bad=built.unsigned_plan.clone();bad.transactions[0].inputs[0].previous_output_script=hex(Script::p2pkh(&owner.hash160()).as_bytes());assert!(begin_signing(&bad).is_err());
}
#[test]
fn lop_change_dust_and_fee_cap_do_not_reduce_order_or_refund_value(){
    let (code,quote,mut funding)=setup(false,1);let owner=key(1).public_key();
    let base=build_native_sell_plan(&funding,&owner,&code,&quote,1000).unwrap();
    for change in [0,41,42]{
        funding[0].satoshis=code.terms.sale_volume+base.fee+change;
        let built=build_native_sell_plan(&funding,&owner,&code,&quote,1000).unwrap();
        assert_eq!(built.unsigned_plan.transactions[0].outputs[0].satoshis,code.terms.sale_volume);
        assert_eq!(built.unsigned_plan.transactions[0].outputs.len(),if change==42{2}else{1});
        assert_eq!(built.fee,if change==42{base.fee}else{base.fee+change});
        if change==42{assert_eq!(built.unsigned_plan.transactions[0].outputs[1].satoshis,42);}
        assert!(build_native_sell_plan(&funding,&owner,&code,&quote,built.fee-1).is_err());
    }
    let order=UtxoInfo{outpoint:OutPoint{txid:Txid::from_le_bytes([8;32]),vout:0},satoshis:3000,script_pubkey:Script::from_bytes(code.encode().unwrap())};
    funding[0].satoshis=80;let exact=build_native_cancel_plan(&order,&funding,&owner,80).unwrap();
    assert_eq!(exact.unsigned_plan.transactions[0].outputs.len(),1);assert_eq!(exact.unsigned_plan.transactions[0].outputs[0].satoshis,3000);
    funding[0].satoshis=79;assert!(build_native_cancel_plan(&order,&funding,&owner,1000).is_err());
}
#[test]
fn lop_cancel_continuation_rejects_altered_branch_or_nonminimal_encoding(){
    let (code,_,funding)=setup(false,1);let owner=key(1).public_key();
    let order=UtxoInfo{outpoint:OutPoint{txid:Txid::from_le_bytes([8;32]),vout:0},satoshis:3000,script_pubkey:Script::from_bytes(code.encode().unwrap())};
    let mut plan=build_native_cancel_plan(&order,&funding,&owner,1000).unwrap().unsigned_plan;
    let mut child=plan.transactions[0].clone();child.transaction_id="after-cancel".into();child.role="p2pkh".into();child.stage=1;
    child.depends_on=vec![plan.transactions[0].transaction_id.clone()];child.inputs.truncate(1);
    child.inputs[0].previous_transaction_id=plan.transactions[0].transaction_id.clone();child.inputs[0].previous_output_satoshis=3000;
    child.inputs[0].previous_output_script=plan.transactions[0].outputs[0].locking_script.clone();child.inputs[0].unlocking_script.clear();
    child.outputs.truncate(1);child.outputs[0].satoshis=2920;plan.transactions.push(child);
    let stage=begin_signing(&plan).unwrap();let sigs=signatures(&stage,1);
    let StageOutcome::Pending(next)=finalize_signing_stage(&plan,stage,&sigs).unwrap()else{panic!("child expected")};
    let sigs=signatures(&next,1);
    for suffix in [vec![0x51],vec![1,2],vec![]]{
        let mut altered:SigningStage=serde_json::from_value(serde_json::to_value(&next).unwrap()).unwrap();
        let parent=altered.continuation.finalized_transactions[0].as_mut().unwrap();let mut tx=Transaction::from_hex(&parent.raw_transaction).unwrap();
        let mut script=tx.inputs[0].script_sig.as_bytes().to_vec();script.pop();script.extend_from_slice(&suffix);tx.inputs[0].script_sig=Script::from_bytes(script);
        parent.raw_transaction=tx.to_hex();parent.txid=tx.txid().to_string();assert!(finalize_signing_stage(&plan,altered,&sigs).is_err());
    }
    assert!(matches!(finalize_signing_stage(&plan,next,&sigs).unwrap(),StageOutcome::Complete(_)));
}
