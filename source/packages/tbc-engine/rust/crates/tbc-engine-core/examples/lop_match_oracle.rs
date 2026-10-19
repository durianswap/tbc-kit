//! Offline SDK comparison adapter. Public synthetic signer only; no real keys,
//! network, persistence or broadcasting.
use std::io::{self,Read};
use tbc_sdk::{Transaction,PublicKey,PrivateKey,OutPoint,TxOut,UtxoInfo,script::Script};
use tbc_engine_core::{protocols::{lop_match::{self,MatchOptions,OrderInput,AssetInput,TokenInput,TokenProfile,ChainContext},tbc20,coin,tbc20_transfer::FeeInput},
    signing::{begin_signing,finalize_signing_stage,ExternalSignature,StageOutcome}};
use tbc_engine_core::protocols::{lop::Code,lop_proof::{build_match_unlock,build_match_unlock_pair},lop_settlement::{quote_match,validate_match_receivers}};
fn main(){
    let mut raw=String::new();io::stdin().take(8*1024*1024).read_to_string(&mut raw).unwrap();
    let request:serde_json::Value=serde_json::from_str(&raw).unwrap();
    let mut rows=vec![];
    for row in request.as_array().unwrap(){
        let current=Transaction::from_hex(row["current"].as_str().unwrap()).unwrap();
        let buy=Transaction::from_hex(row["buy"].as_str().unwrap()).unwrap();
        let sell=Transaction::from_hex(row["sell"].as_str().unwrap()).unwrap();
        if row["expectReject"].as_bool()==Some(true){rows.push(execute_match(row,&buy,&sell));continue;}
        let b=Code::decode(buy.outputs[current.inputs[0].previous_output.vout as usize].script_pubkey.as_bytes()).unwrap();
        let s=Code::decode(sell.outputs[current.inputs[2].previous_output.vout as usize].script_pubkey.as_bytes()).unwrap();
        let quote=quote_match(&b,&s,row["escrowA"].as_u64().unwrap(),row["escrowB"].as_u64().unwrap()).unwrap();
        quote.require_conserving_layout().unwrap();
        let native=matches!(b.market,tbc_engine_core::protocols::lop::Market::NativeToken{..});
        let address=|index:usize|-> [u8;20]{let script=current.outputs[index].script_pubkey.as_bytes();
            if script.len()==25{assert_eq!(&script[..3],&[0x76,0xa9,0x14]);assert_eq!(&script[23..],&[0x88,0xac]);script[3..23].try_into().unwrap()}
            else{let c=tbc_engine_core::protocols::tbc20::parse_code(script).map(|v|v.controller).unwrap_or_else(|_|tbc_engine_core::protocols::coin::parse_code(script).unwrap().controller);
                assert_eq!(c[20],0);c[..20].try_into().unwrap()}};
        validate_match_receivers(&b,&s,address(if native{6}else{8}),if quote.native_zero_tax_placeholder{b.tax_hash}else{address(if native{5}else{6})},address(2)).unwrap();
        let continuation=quote.continuation(&b,&s).unwrap().map(|c|c.encode().unwrap().iter().map(|b|format!("{b:02x}")).collect::<String>());
        let pair=build_match_unlock_pair(&current,&buy,&sell).unwrap();
        assert_eq!(pair[0],build_match_unlock(&current,&buy,0).unwrap());assert_eq!(pair[1],build_match_unlock(&current,&sell,2).unwrap());
        let mut wrong=buy.clone();wrong.lock_time^=1;assert!(build_match_unlock(&current,&wrong,0).is_err());
        assert!(build_match_unlock(&current,&buy,1).is_err());
        let mut wrong=current.clone();wrong.outputs[1].satoshis=1;assert!(build_match_unlock(&wrong,&buy,0).is_err());
        let mut wrong=current.clone();while wrong.outputs.len()<=12{wrong.outputs.push(current.outputs.last().unwrap().clone());}
        assert!(build_match_unlock(&wrong,&buy,0).is_err());
        let mut wrong=buy.clone();while wrong.inputs.len()<=10{wrong.inputs.push(buy.inputs[0].clone());}
        let mut spending=current.clone();spending.inputs[0].previous_output.txid=wrong.txid();assert!(build_match_unlock(&spending,&wrong,0).is_err());
        let proofs=pair.iter().map(|p|p.as_bytes().iter().map(|b|format!("{b:02x}")).collect::<String>()).collect::<Vec<_>>();
        let engine=if row.get("funding").is_some(){Some(execute_match(row,&buy,&sell))}else{None};
        rows.push(serde_json::json!({"proofs":proofs,"quote":quote,"continuation":continuation,"engine":engine}));
    }
    println!("{}",serde_json::to_string(&rows).unwrap());
}
fn bytes(hex:&str)->Vec<u8>{(0..hex.len()).step_by(2).map(|i|u8::from_str_radix(&hex[i..i+2],16).unwrap()).collect()}
fn hex(bytes:&[u8])->String{bytes.iter().map(|b|format!("{b:02x}")).collect()}
fn profile(code:&[u8])->(TokenProfile,Vec<u8>){if let Ok(id)=tbc20::code_identity(code){(TokenProfile::Tbc20,id)}else{(TokenProfile::Coin,coin::code_identity(code).unwrap())}}
fn execute_match(row:&serde_json::Value,buy:&Transaction,sell:&Transaction)->serde_json::Value{
    // Public synthetic scalar 4 only. This independent test signer is not part
    // of protocols/lop_match or any Engine API.
    let mut scalar=[0;32];scalar[31]=4;let key=PrivateKey::from_slice(&scalar).unwrap();let public:PublicKey=key.public_key();
    let parents=|field:&str|row[field].as_array().unwrap().iter().map(|raw|Transaction::from_hex(raw.as_str().unwrap()).unwrap()).collect::<Vec<_>>();
    let bp=parents("buyAncestors");let br:Vec<_>=bp.iter().collect();let sp=parents("sellAncestors");let sr:Vec<_>=sp.iter().collect();
    let bv=row["buyVout"].as_u64().unwrap_or(0)as usize;let sv=row["sellVout"].as_u64().unwrap_or(0)as usize;
    let native=matches!(Code::decode(sell.outputs[sv].script_pubkey.as_bytes()).unwrap().market,tbc_engine_core::protocols::lop::Market::NativeToken{..});
    let(bprofile,bid)=profile(buy.outputs[bv+1].script_pubkey.as_bytes());
    let aprofile=(!native).then(||profile(sell.outputs[sv+1].script_pubkey.as_bytes()));
    let f=&row["funding"];let output=TxOut{satoshis:f["satoshis"].as_u64().unwrap(),script_pubkey:Script::from_bytes(bytes(f["script"].as_str().unwrap()))};
    let funding=FeeInput{outpoint:OutPoint{txid:f["txId"].as_str().unwrap().parse().unwrap(),vout:f["outputIndex"].as_u64().unwrap()as u32},output:&output,public_key:&public};
    let options=||MatchOptions{buy:OrderInput{parent:buy,vout:bv as u32},sell:OrderInput{parent:sell,vout:sv as u32},
        quote:AssetInput{profile:bprofile,token:TokenInput{parent:buy,vout:bv as u32+1,ancestors:&br},expected_identity:&bid},
        base:aprofile.as_ref().map(|(p,id)|AssetInput{profile:*p,token:TokenInput{parent:sell,vout:sv as u32+1,ancestors:&sr},expected_identity:id}),
        funding:&funding,chain:ChainContext{height:Some(830000),median_time_past:Some(1774427100)},max_fee:10000};
    let built=lop_match::build_match_plan(options());
    if row["expectReject"].as_bool()==Some(true){let error=built.err().expect("unsupported settlement must fail before signing");
        let reason=row["rejectionReason"].as_str().unwrap();
        assert!(error.message.contains(if reason=="native-continuation-escrow"{"native buy continuation escrow"}else{"unallocated escrow"}));
        return serde_json::json!({"rejected":true,"reason":reason});}
    let plan=built.unwrap();let stage=begin_signing(&plan.unsigned_plan).unwrap();
    let indices:Vec<_>=stage.signing_requests.iter().map(|r|r.input_index).collect();
    assert_eq!(indices,if native{vec![1,3]}else{vec![1,3,4]});
    let signatures:Vec<_>=stage.signing_requests.iter().map(|r|ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),
        transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),
        signature:hex(&key.sign_ecdsa_digest(&bytes(&r.digest).try_into().unwrap()))}).collect();
    let mut wrong=plan.unsigned_plan.clone();wrong.transactions[0].inputs[0].previous_output_satoshis+=1;assert!(begin_signing(&wrong).is_err());
    let mut wrong=plan.unsigned_plan.clone();wrong.transactions[0].outputs[0].satoshis+=1;assert!(finalize_signing_stage(&wrong,begin_signing(&plan.unsigned_plan).unwrap(),&signatures).is_err());
    let mut extra=signatures.clone();let mut injected=extra[0].clone();injected.input_index=0;extra.push(injected);assert!(finalize_signing_stage(&plan.unsigned_plan,begin_signing(&plan.unsigned_plan).unwrap(),&extra).is_err());
    let mut bad=options();bad.max_fee=0;assert!(lop_match::build_match_plan(bad).is_err());
    let mut bad=options();bad.quote.token.ancestors=&[];assert!(lop_match::build_match_plan(bad).is_err());
    if plan.unsigned_plan.transactions[0].lock_time!=0{let mut bad=options();bad.chain=ChainContext{height:Some(0),median_time_past:None};
        assert!(lop_match::build_match_plan(bad).is_err(),"match must not bypass Coin maturity");}
    let StageOutcome::Complete(bundle)=finalize_signing_stage(&plan.unsigned_plan,stage,&signatures).unwrap()else{panic!("single stage")};
    let tx=Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap();assert!(tx.serialize().len()<=plan.maximum_signed_bytes);
    verify_staged_binding(&plan.unsigned_plan,&key,if native{6}else{8});
    let cancel=cancel_remainder(&tx,buy,sell,native,&funding);
    serde_json::json!({"raw":tx.to_hex(),"fee":plan.fee,"maximumSignedBytes":plan.maximum_signed_bytes,"signingInputs":indices,"cancel":cancel})
}
fn verify_staged_binding(plan:&tbc_engine_core::signing::UnsignedPlan,key:&PrivateKey,change:usize){
    use tbc_engine_core::signing::{SigningStage,PlannedTransaction};
    let mut staged=plan.clone();let parent=&staged.transactions[0];
    let mut input=parent.inputs.last().unwrap().clone();
    input.previous_transaction_id=parent.transaction_id.clone();input.previous_output_index=change as u32;
    input.previous_output_satoshis=parent.outputs[change].satoshis;input.previous_output_script=parent.outputs[change].locking_script.clone();
    let mut output=parent.outputs[change].clone();output.satoshis-=80;
    staged.transactions.push(PlannedTransaction{transaction_id:"matcher-change-spend".into(),role:"tbc-transfer".into(),stage:1,
        depends_on:vec![parent.transaction_id.clone()],version:10,lock_time:0,inputs:vec![input],outputs:vec![output]});
    let sign=|stage:&SigningStage|stage.signing_requests.iter().map(|r|ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,
        stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),
        public_key:r.public_key.clone(),signature:hex(&key.sign_ecdsa_digest(&bytes(&r.digest).try_into().unwrap()))}).collect::<Vec<_>>();
    let next=||{let stage=begin_signing(&staged).unwrap();let sig=sign(&stage);
        let StageOutcome::Pending(next)=finalize_signing_stage(&staged,stage,&sig).unwrap()else{panic!("dependent change stage")};next};
    let valid=next();let sig=sign(&valid);
    assert!(matches!(finalize_signing_stage(&staged,valid,&sig).unwrap(),StageOutcome::Complete(_)));
    for vin in [0,2]{
        let mut bad=next();let record=bad.continuation.finalized_transactions[0].as_mut().unwrap();
        let mut tx=Transaction::from_hex(&record.raw_transaction).unwrap();tx.inputs[vin].script_sig=Script::from_bytes(vec![0]);
        record.raw_transaction=tx.to_hex();record.txid=tx.txid().to_string();
        assert!(finalize_signing_stage(&staged,bad,&sig).is_err(),"unsigned LOP witness must be canonically rebuilt");
    }
}
fn cancel_remainder(tx:&Transaction,buy:&Transaction,sell:&Transaction,native:bool,prior_fee:&FeeInput<'_>)->Option<serde_json::Value>{
    use tbc_engine_core::protocols::{lop::Side,lop_token,lop_transaction};
    let vout=if native{7}else{9};let output=tx.outputs.get(vout)?;
    let code=Code::decode(output.script_pubkey.as_bytes()).unwrap();
    let mut scalar=[0;32];scalar[31]=if code.side==Side::Buy{2}else{1};
    let key=PrivateKey::from_slice(&scalar).unwrap();let public=key.public_key();
    assert_eq!(public.hash160(),code.terms.owner_hash);
    // Independent public-fixture funding, not the matcher's already spent input.
    let mut point=prior_fee.outpoint.clone();point.vout+=100;
    let fee_output=TxOut{satoshis:100000,script_pubkey:Script::p2pkh(&public.hash160())};
    let fee=FeeInput{outpoint:point.clone(),output:&fee_output,public_key:&public};
    let plan=if native&&code.side==Side::Sell{
        let order=UtxoInfo{outpoint:OutPoint{txid:tx.txid(),vout:vout as u32},satoshis:output.satoshis,script_pubkey:output.script_pubkey.clone()};
        let funding=UtxoInfo{outpoint:point,satoshis:fee_output.satoshis,script_pubkey:fee_output.script_pubkey.clone()};
        lop_transaction::build_native_cancel_plan(&order,&[funding],&public,10000).unwrap()
    }else{
        let(p,id)=profile(tx.outputs[vout+1].script_pubkey.as_bytes());
        let ancestors=[if code.side==Side::Buy{buy}else{sell}];
        lop_token::build_cancel_plan(lop_token::CancelOptions{profile:p,token:TokenInput{parent:tx,vout:vout as u32+1,ancestors:&ancestors},
            order_vout:vout as u32,funding:&fee,expected_identity:&id,chain:ChainContext{height:Some(830000),median_time_past:Some(1774427100)},max_fee:10000}).unwrap()
    };
    let stage=begin_signing(&plan.unsigned_plan).unwrap();
    let signatures=stage.signing_requests.iter().map(|r|ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),
        transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),
        signature:hex(&key.sign_ecdsa_digest(&bytes(&r.digest).try_into().unwrap()))}).collect::<Vec<_>>();
    let StageOutcome::Complete(bundle)=finalize_signing_stage(&plan.unsigned_plan,stage,&signatures).unwrap()else{panic!("single cancellation stage")};
    Some(serde_json::json!({"raw":bundle.transactions[0].raw_transaction,"fee":plan.fee,"maximumSignedBytes":plan.maximum_signed_bytes,
        "ownerPublicKey":hex(&public.to_bytes()),"inputs":plan.unsigned_plan.transactions[0].inputs.iter().map(|i|serde_json::json!({
            "txId":i.previous_transaction_id,"outputIndex":i.previous_output_index,"satoshis":i.previous_output_satoshis,"script":i.previous_output_script})).collect::<Vec<_>>()}))
}
