//! Public scalar 1/2 and synthetic supplied material only; no network or custody.
use tbc_engine_core::{protocols::{coin,coin_proof,tbc20,tbc20_material,
    lop::{Code,Terms,AssetTerms,Market,Side,TapeMarker},
    lop_token::{build_make_plan,build_cancel_plan,MakeOptions,CancelOptions,TokenProfile,TokenInput,ChainContext},
    lop_transaction::LopPlan,tbc20_transfer::FeeInput,tbc20_mint::fee_for_size},
    signing::{begin_signing,finalize_signing_stage,ExternalSignature,StageOutcome}};
use tbc_sdk::{PrivateKey,Transaction,OutPoint,TxOut,Txid,script::Script};
fn key(n:u8)->PrivateKey{let mut b=[0;32];b[31]=n;PrivateKey::from_slice(&b).unwrap()}
fn hex(b:&[u8])->String{b.iter().map(|x|format!("{x:02x}")).collect()}
fn bytes(s:&str)->Vec<u8>{(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn fixture(profile:TokenProfile, coin_lock:u32)->(Transaction,Vec<Transaction>,u32,u32,Vec<u8>) {
    let (mut parent,ancestors,vout,fee)=match profile {
        TokenProfile::Tbc20=>{let f:serde_json::Value=serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
            (Transaction::from_hex(f["stages"][1]["signedRaw"].as_str().unwrap()).unwrap(),
             vec![Transaction::from_hex(f["stages"][0]["signedRaw"].as_str().unwrap()).unwrap()],0,2)},
        TokenProfile::Coin=>{let f:serde_json::Value=serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap();let v=&f["vectors"][0];
            (Transaction::from_hex(v["parentRaw"].as_str().unwrap()).unwrap(),v["ancestorsRaw"].as_array().unwrap().iter()
                .map(|v|Transaction::from_hex(v.as_str().unwrap()).unwrap()).collect(),3,5)},
    };
    if profile==TokenProfile::Coin {parent.outputs[vout as usize+1].script_pubkey=Script::from_bytes(
        coin::set_lock_time(parent.outputs[vout as usize+1].script_pubkey.as_bytes(),coin_lock).unwrap());}
    let point=OutPoint{txid:parent.txid(),vout};
    let identity=match profile {
        TokenProfile::Tbc20=>tbc20_material::inspect_parent(&parent.serialize(),&point,None).unwrap().identity().to_vec(),
        TokenProfile::Coin=>coin_proof::inspect_parent(&parent.serialize(),&point,None).unwrap().identity().to_vec(),
    };(parent,ancestors,vout,fee,identity)
}

fn order(profile:TokenProfile,pair:bool,side:Side,asset:&[u8])->(Code,Vec<u8>,Option<Vec<u8>>){
    let other=fixture(if profile==TokenProfile::Tbc20{TokenProfile::Coin}else{TokenProfile::Tbc20},0);
    let other_code=other.0.outputs[other.2 as usize].script_pubkey.as_bytes().to_vec();
    let (a,b)=if !pair{(asset.to_vec(),None)}else if side==Side::Sell{(asset.to_vec(),Some(other_code))}else{(other_code,Some(asset.to_vec()))};
    let terms=|c:&[u8],tag:u8|AssetTerms{partial_hash:tbc20::code_identity(c).or_else(|_|coin::code_identity(c).map_err(|_|tbc20::CodecError::CodeTemplate)).unwrap()[..32].try_into().unwrap(),contract_id:[tag;32]};
    let code=Code{side,market:if pair{Market::TokenToken{a:TapeMarker::Modern,b:TapeMarker::Modern}}else{Market::NativeToken{token_code_bytes:a.len()as u16,marker:TapeMarker::Modern}},
        tax_hash:key(2).public_key().hash160(),terms:Terms{owner_hash:key(1).public_key().hash160(),sale_volume:100,unit_price:1_100_000,fee_rate:100,
            asset_a:terms(&a,0x44),asset_b:b.as_ref().map(|b|terms(b,0x55))}};
    (code,a,b)
}
fn finish(plan:&LopPlan,profile:TokenProfile,operation:&str,code:&Code,a:&[u8],b:Option<&[u8]>,parent:&Transaction,ancestors:&[Transaction])->Transaction{
    let stage=begin_signing(&plan.unsigned_plan).unwrap();
    let sigs:Vec<_>=stage.signing_requests.iter().map(|r|ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,
        stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),input_index:r.input_index,
        digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&key(1).sign_ecdsa_digest(&bytes(&r.digest).try_into().unwrap()))}).collect();
    let StageOutcome::Complete(result)=finalize_signing_stage(&plan.unsigned_plan,stage,&sigs).unwrap()else{panic!("single")};
    let tx=Transaction::from_hex(&result.transactions[0].raw_transaction).unwrap();
    assert!(tx.serialize().len()<=plan.maximum_signed_bytes);assert!(plan.fee>=fee_for_size(tx.serialize().len()).unwrap());
    assert_eq!(plan.unsigned_plan.transactions[0].inputs.iter().map(|i|i.previous_output_satoshis).sum::<u64>()-tx.outputs.iter().map(|o|o.satoshis).sum::<u64>(),plan.fee);
    if std::env::var("LOP_TOKEN_DUMP_WIRE").as_deref()==Ok("1"){
        println!("LOP_TOKEN_WIRE:{}",serde_json::json!({"profile":format!("{profile:?}"),"operation":operation,
            "market":if matches!(code.market,Market::NativeToken{..}){"native"}else{"token"},"side":if code.side==Side::Sell{"sell"}else{"buy"},
            "assetA":hex(a),"assetB":b.map(hex),"raw":tx.to_hex(),"parentRaw":parent.to_hex(),
            "ancestorsRaw":ancestors.iter().map(Transaction::to_hex).collect::<Vec<_>>(),
            "fee":plan.fee,"maximumSignedBytes":plan.maximum_signed_bytes,
            "inputs":plan.unsigned_plan.transactions[0].inputs.iter().map(|i|serde_json::json!({"txId":i.previous_transaction_id,
                "outputIndex":i.previous_output_index,"satoshis":i.previous_output_satoshis,"script":i.previous_output_script})).collect::<Vec<_>>()}));
    }tx
}
#[test]
fn token_lop_make_cancel_roundtrip_and_locks(){
    let owner=key(1).public_key();
    for(profile,lock,multi)in[(TokenProfile::Tbc20,0,false),(TokenProfile::Coin,0,false),(TokenProfile::Coin,829999,false),(TokenProfile::Coin,1774427000,false),
        (TokenProfile::Tbc20,0,true),(TokenProfile::Coin,0,true)]{
        for(pair,side)in[(false,Side::Buy),(true,Side::Sell),(true,Side::Buy)]{
            let(parent,ancestors,vout,fee_vout,identity)=if multi{
                let(parent,ancestor)=match profile{
                    TokenProfile::Tbc20=>{let f:serde_json::Value=serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
                        (Transaction::from_hex(f["stages"][2]["signedRaw"].as_str().unwrap()).unwrap(),Transaction::from_hex(f["stages"][1]["signedRaw"].as_str().unwrap()).unwrap())},
                    TokenProfile::Coin=>{let f:serde_json::Value=serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap();
                        (Transaction::from_hex(f["vectors"][0]["signedRaw"].as_str().unwrap()).unwrap(),Transaction::from_hex(f["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap())},
                };
                let id=match profile{TokenProfile::Tbc20=>tbc20::code_identity(parent.outputs[0].script_pubkey.as_bytes()).unwrap(),
                    TokenProfile::Coin=>coin::code_identity(parent.outputs[0].script_pubkey.as_bytes()).unwrap()};
                (parent,vec![ancestor],0,4,id.to_vec())
            }else{fixture(profile,lock)};
            let refs:Vec<_>=ancestors.iter().collect();
            let mut inputs=vec![TokenInput{parent:&parent,vout,ancestors:&refs}];
            if multi{inputs.push(TokenInput{parent:&parent,vout:2,ancestors:&refs});}
            let funding=FeeInput{outpoint:OutPoint{txid:parent.txid(),vout:fee_vout},output:&parent.outputs[fee_vout as usize],public_key:&owner};
            let(code,a,b)=order(profile,pair,side,parent.outputs[vout as usize].script_pubkey.as_bytes());
            let chain=ChainContext{height:Some(830000),median_time_past:Some(1774427100)};
            let plan=build_make_plan(MakeOptions{profile,inputs:&inputs,funding:&funding,expected_identity:&identity,
                code:&code,asset_a_code:&a,asset_b_code:b.as_deref(),chain,max_fee:10000}).unwrap();
            if multi{assert_eq!(plan.unsigned_plan.evidence_table.len(),2,"shared parent and ancestor interned only once");}
            let deploy=finish(&plan,profile,"make",&code,&a,b.as_deref(),&parent,&ancestors);
            assert_eq!(deploy.outputs[0].satoshis,300);assert_eq!(deploy.outputs[0].script_pubkey.as_bytes(),code.encode().unwrap());
            let source=[&parent];
            let funding=FeeInput{outpoint:OutPoint{txid:deploy.txid(),vout:deploy.outputs.len()as u32-1},output:deploy.outputs.last().unwrap(),public_key:&owner};
            let cancel=build_cancel_plan(CancelOptions{profile,token:TokenInput{parent:&deploy,vout:1,ancestors:&source},
                order_vout:0,funding:&funding,expected_identity:&identity,chain,max_fee:10000}).unwrap();
            let tx=finish(&cancel,profile,"cancel",&code,&a,b.as_deref(),&deploy,&[parent.clone()]);
            assert_eq!(tx.lock_time,lock);
            let amount=if side==Side::Sell{100}else{110};
            let slots=if profile==TokenProfile::Tbc20{tbc20::parse_tape(tx.outputs[1].script_pubkey.as_bytes()).unwrap().amounts}else{
                let tape=coin::parse_tape(tx.outputs[1].script_pubkey.as_bytes(),None).unwrap();assert_eq!(tape.lock_time,lock);tape.amounts};
            assert_eq!(slots,[0,amount,0,0,0,0]);
        }
    }
}
#[test]
fn token_lop_rejects_bad_identity_roles_material_and_fee(){
    for profile in[TokenProfile::Tbc20,TokenProfile::Coin]{
        let(parent,ancestors,vout,fee_vout,identity)=fixture(profile,0);let owner=key(1).public_key();
        let refs:Vec<_>=ancestors.iter().collect();let inputs=[TokenInput{parent:&parent,vout,ancestors:&refs}];
        let funding=FeeInput{outpoint:OutPoint{txid:parent.txid(),vout:fee_vout},output:&parent.outputs[fee_vout as usize],public_key:&owner};
        let(code,a,b)=order(profile,true,Side::Buy,parent.outputs[vout as usize].script_pubkey.as_bytes());
        let options=||MakeOptions{profile,inputs:&inputs,funding:&funding,expected_identity:&identity,code:&code,
            asset_a_code:&a,asset_b_code:b.as_deref(),chain:ChainContext{height:Some(830000),median_time_past:None},max_fee:10000};
        let mut bad=options();bad.expected_identity=&[0;34];assert!(build_make_plan(bad).is_err());
        let mut bad=options();bad.max_fee=1;assert!(build_make_plan(bad).is_err());
        let missing=[TokenInput{parent:&parent,vout,ancestors:&[]}];let mut bad=options();bad.inputs=&missing;assert!(build_make_plan(bad).is_err());
        let duplicate=[TokenInput{parent:&parent,vout,ancestors:&refs},TokenInput{parent:&parent,vout,ancestors:&refs}];
        let mut bad=options();bad.inputs=&duplicate;assert!(build_make_plan(bad).is_err());
        let mut wrong=code.clone();wrong.terms.owner_hash=key(2).public_key().hash160();let mut bad=options();bad.code=&wrong;assert!(build_make_plan(bad).is_err());
        let mut wrong=code.clone();wrong.terms.unit_price=1;let mut bad=options();bad.code=&wrong;assert!(build_make_plan(bad).is_err());
        let mut wrong=code.clone();wrong.terms.sale_volume=i64::MAX as u64;let mut bad=options();bad.code=&wrong;assert!(build_make_plan(bad).is_err());
        let plan=build_make_plan(options()).unwrap();
        // No diagnostic fixture output for these negative checks.
        let stage=begin_signing(&plan.unsigned_plan).unwrap();let sigs:Vec<_>=stage.signing_requests.iter().map(|r|ExternalSignature{
            session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),
            input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),
            signature:hex(&key(1).sign_ecdsa_digest(&bytes(&r.digest).try_into().unwrap()))}).collect();
        let StageOutcome::Complete(result)=finalize_signing_stage(&plan.unsigned_plan,stage,&sigs).unwrap()else{panic!("single")};
        let deploy=Transaction::from_hex(&result.transactions[0].raw_transaction).unwrap();let source=[&parent];
        let opts=||CancelOptions{profile,token:TokenInput{parent:&deploy,vout:1,ancestors:&source},order_vout:0,
            funding:&funding,expected_identity:&identity,chain:ChainContext{height:Some(830000),median_time_past:None},max_fee:10000};
        let mut bad=opts();bad.order_vout=2;assert!(build_cancel_plan(bad).is_err());
        let mut bad=opts();bad.token.ancestors=&[];assert!(build_cancel_plan(bad).is_err());
        let mut bad=opts();bad.max_fee=0;assert!(build_cancel_plan(bad).is_err());
        let stranger=key(2).public_key();let output=TxOut{satoshis:100000,script_pubkey:Script::p2pkh(&stranger.hash160())};
        let stranger_fee=FeeInput{outpoint:OutPoint{txid:Txid::from_le_bytes([0xaa;32]),vout:0},output:&output,public_key:&stranger};
        let mut bad=opts();bad.funding=&stranger_fee;assert!(build_cancel_plan(bad).is_err());
        let mut forged=deploy.clone();forged.outputs[0].satoshis=301;let mut bad=opts();bad.token.parent=&forged;assert!(build_cancel_plan(bad).is_err());
    }
}

#[test]
fn coin_lop_requires_maturity_and_exact_quote_metadata(){
    let owner=key(1).public_key();
    for lock in[830001,1774427000]{
        let(parent,ancestors,vout,fee_vout,identity)=fixture(TokenProfile::Coin,lock);
        let refs:Vec<_>=ancestors.iter().collect();let inputs=[TokenInput{parent:&parent,vout,ancestors:&refs}];
        let funding=FeeInput{outpoint:OutPoint{txid:parent.txid(),vout:fee_vout},output:&parent.outputs[fee_vout as usize],public_key:&owner};
        let(code,a,b)=order(TokenProfile::Coin,false,Side::Buy,parent.outputs[vout as usize].script_pubkey.as_bytes());
        let options=||MakeOptions{profile:TokenProfile::Coin,inputs:&inputs,funding:&funding,expected_identity:&identity,code:&code,
            asset_a_code:&a,asset_b_code:b.as_deref(),chain:ChainContext{height:Some(830000),median_time_past:Some(1774427000)},max_fee:10000};
        // Height future or timestamp equal to MTP cannot be spent.
        assert!(build_make_plan(options()).is_err());
        let mature=||{let mut o=options();o.chain=ChainContext{height:Some(830001),median_time_past:Some(1774427001)};o};
        assert!(build_make_plan(mature()).is_ok());
        let mut bad=mature();bad.profile=TokenProfile::Tbc20;assert!(build_make_plan(bad).is_err());
        let mut wrong=code.clone();wrong.market=Market::NativeToken{token_code_bytes:a.len()as u16,marker:TapeMarker::Legacy};
        let mut bad=mature();bad.code=&wrong;assert!(build_make_plan(bad).is_err());
        let mut wrong=code.clone();wrong.terms.asset_a.partial_hash[0]^=1;
        let mut bad=mature();bad.code=&wrong;assert!(build_make_plan(bad).is_err());
        let extra=[TokenInput{parent:&parent,vout,ancestors:&refs},TokenInput{parent:&parent,vout,ancestors:&refs},
            TokenInput{parent:&parent,vout,ancestors:&refs},TokenInput{parent:&parent,vout,ancestors:&refs},
            TokenInput{parent:&parent,vout,ancestors:&refs},TokenInput{parent:&parent,vout,ancestors:&refs}];
        let mut bad=mature();bad.inputs=&extra;assert!(build_make_plan(bad).is_err());
    }
}
