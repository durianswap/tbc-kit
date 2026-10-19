//! Offline synthetic keys and preimages only. Never run against wallet secrets.
use sha2::{Digest, Sha256};
use tbc_engine_core::{protocols::{coin, coin_proof, htlc::Code,
    htlc_token::{build_lock_plan, build_spend_plan, ChainContext, LockOptions, SpendOptions, TokenInput, TokenProfile},
    htlc_transaction::{HtlcPlan, SpendBranch}, tbc20_material, tbc20_mint::fee_for_size,
    tbc20_transfer::FeeInput}, signing::{begin_signing, finalize_signing_stage, ExternalSignature, StageOutcome}};
use tbc_sdk::{OutPoint, PrivateKey, Transaction, Txid, TxOut, script::Script};

fn key(n:u8)->PrivateKey {let mut bytes=[0;32];bytes[31]=n;PrivateKey::from_slice(&bytes).unwrap()}
fn hex(b:&[u8])->String {b.iter().map(|x|format!("{x:02x}")).collect()}
fn bytes(s:&str)->Vec<u8> {(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
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
fn finish(plan:&HtlcPlan,signer:u8,profile:TokenProfile,operation:&str,parent:&Transaction,ancestors:&[Transaction])->Transaction {
    let stage=begin_signing(&plan.unsigned_plan).unwrap();
    // The independent signer receives digests, never the HTLC preimage.
    let signer_wire=serde_json::to_string(&stage.signing_requests).unwrap();
    assert!(!signer_wire.contains(&"33".repeat(32)));
    let sigs:Vec<_>=stage.signing_requests.iter().map(|r|ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,
        stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),input_index:r.input_index,
        digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&key(signer).sign_ecdsa_digest(&bytes(&r.digest).try_into().unwrap()))}).collect();
    let StageOutcome::Complete(bundle)=finalize_signing_stage(&plan.unsigned_plan,stage,&sigs).unwrap()else{panic!("single stage")};
    let tx=Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap();
    assert!(tx.serialize().len()<=plan.maximum_signed_bytes);
    assert!(plan.fee>=fee_for_size(tx.serialize().len()).unwrap());
    assert_eq!(plan.unsigned_plan.transactions[0].inputs.iter().map(|i|i.previous_output_satoshis).sum::<u64>()
        -tx.outputs.iter().map(|o|o.satoshis).sum::<u64>(),plan.fee);
    if std::env::var("HTLC_TOKEN_DUMP_WIRE").as_deref()==Ok("1") {
        // Opt-in fixture IPC to the independent offline oracle, public scalar 1/2
        // and constant 0x33 preimage ONLY; never used by product logging.
        println!("HTLC_TOKEN_WIRE:{}",serde_json::json!({"profile":format!("{profile:?}"),"operation":operation,
            "raw":tx.to_hex(),"parentRaw":parent.to_hex(),"ancestorsRaw":ancestors.iter().map(Transaction::to_hex).collect::<Vec<_>>(),
            "fee":plan.fee,"maximumSignedBytes":plan.maximum_signed_bytes,
            "inputs":plan.unsigned_plan.transactions[0].inputs.iter().map(|i|serde_json::json!({
                "txId":i.previous_transaction_id,"outputIndex":i.previous_output_index,"satoshis":i.previous_output_satoshis,"script":i.previous_output_script})).collect::<Vec<_>>()}));
    }tx
}

#[test]
fn token_and_coin_lock_claim_refund_use_shared_external_signing() {
    let sender=key(1).public_key();let receiver=key(2).public_key();
    for (profile,coin_lock,htlc_lock) in [(TokenProfile::Tbc20,0,830010),(TokenProfile::Tbc20,0,1774427165),
        (TokenProfile::Coin,0,830010),(TokenProfile::Coin,829000,830010),(TokenProfile::Coin,1774427000,1774427165)] {
        let (parent,ancestors,vout,fee_vout,identity)=fixture(profile,coin_lock);
        let refs:Vec<_>=ancestors.iter().collect();let inputs=[TokenInput{parent:&parent,vout,ancestors:&refs}];
        let funding=FeeInput{outpoint:OutPoint{txid:parent.txid(),vout:fee_vout},output:&parent.outputs[fee_vout as usize],public_key:&sender};
        let code=Code{sender_hash:sender.hash160(),receiver_hash:receiver.hash160(),hashlock:Sha256::digest([0x33;32]).into(),raw_lock_time:htlc_lock};
        let lock=build_lock_plan(LockOptions{profile,inputs:&inputs,funding:&funding,expected_identity:&identity,code:&code,amount:250,
            chain:ChainContext{height:Some(830000),median_time_past:Some(1774427100)},max_fee:10000}).unwrap();
        let deploy=finish(&lock,1,profile,"lock",&parent,&ancestors);
        assert_eq!(deploy.outputs[0].script_pubkey.as_bytes(),code.encode());
        assert_eq!(deploy.lock_time,coin_lock);
        for branch in [SpendBranch::Claim(vec![0x33;32]),SpendBranch::Refund] {
            let refund=matches!(branch,SpendBranch::Refund);let signer=if refund{1}else{2};let public=key(signer).public_key();
            let fee_output=TxOut{satoshis:100000,script_pubkey:Script::p2pkh(&public.hash160())};
            let funding=FeeInput{outpoint:OutPoint{txid:Txid::from_le_bytes([0xaa+signer;32]),vout:0},output:&fee_output,public_key:&public};
            let source=[&parent];let spend=build_spend_plan(SpendOptions{profile,token:TokenInput{parent:&deploy,vout:1,ancestors:&source},
                funding:&funding,expected_identity:&identity,branch:&branch,chain:ChainContext{height:Some(830010),median_time_past:Some(1774427166)},max_fee:10000}).unwrap();
            let tx=finish(&spend,signer,profile,if refund{"refund"}else{"claim"},&deploy,&[parent.clone()]);
            assert_eq!(tx.lock_time,if refund{htlc_lock.max(coin_lock)}else{coin_lock});
            if profile==TokenProfile::Coin {assert_eq!(coin::parse_tape(tx.outputs[1].script_pubkey.as_bytes(),None).unwrap().lock_time,coin_lock);}
        }
    }
}

#[test]
fn token_htlc_rejects_wrong_roles_ancestry_identity_maturity_and_fee_cap() {
    for profile in [TokenProfile::Tbc20,TokenProfile::Coin] {
        let (parent,ancestors,vout,fee_vout,identity)=fixture(profile,0);let sender=key(1).public_key();
        let refs:Vec<_>=ancestors.iter().collect();let inputs=[TokenInput{parent:&parent,vout,ancestors:&refs}];
        let funding=FeeInput{outpoint:OutPoint{txid:parent.txid(),vout:fee_vout},output:&parent.outputs[fee_vout as usize],public_key:&sender};
        let code=Code{sender_hash:sender.hash160(),receiver_hash:key(2).public_key().hash160(),hashlock:Sha256::digest([0x33;32]).into(),raw_lock_time:830010};
        let options=||LockOptions{profile,inputs:&inputs,funding:&funding,expected_identity:&identity,code:&code,amount:250,
            chain:ChainContext{height:Some(830000),median_time_past:None},max_fee:10000};
        let mut bad=options();bad.expected_identity=&[0;34];assert!(build_lock_plan(bad).is_err());
        let mut bad=options();bad.max_fee=1;assert!(build_lock_plan(bad).is_err());
        let mut bad=options();bad.amount=i64::MAX as u128+1;assert!(build_lock_plan(bad).err().unwrap().message.contains("spend allocation slot"));
        let mut bad=options();bad.chain.height=Some(830010);assert!(build_lock_plan(bad).is_err());
        let missing=[TokenInput{parent:&parent,vout,ancestors:&[]}];let mut bad=options();bad.inputs=&missing;assert!(build_lock_plan(bad).is_err());
        let duplicates=[TokenInput{parent:&parent,vout,ancestors:&refs},TokenInput{parent:&parent,vout,ancestors:&refs}];
        let mut bad=options();bad.inputs=&duplicates;assert!(build_lock_plan(bad).is_err());
        let lock=build_lock_plan(options()).unwrap();
        // Sign here without emitting an extra oracle row.
        let stage=begin_signing(&lock.unsigned_plan).unwrap();let sigs:Vec<_>=stage.signing_requests.iter().map(|r|ExternalSignature{
            session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),
            input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&key(1).sign_ecdsa_digest(&bytes(&r.digest).try_into().unwrap()))}).collect();
        let StageOutcome::Complete(b)=finalize_signing_stage(&lock.unsigned_plan,stage,&sigs).unwrap()else{panic!("single")};
        let deploy=Transaction::from_hex(&b.transactions[0].raw_transaction).unwrap();let source=[&parent];
        let good_claim=SpendBranch::Claim(vec![0x33;32]);let wrong_claim=SpendBranch::Claim(vec![0x34;32]);
        let receiver=key(2).public_key();let output=TxOut{satoshis:100000,script_pubkey:Script::p2pkh(&receiver.hash160())};
        let fee=FeeInput{outpoint:OutPoint{txid:Txid::from_le_bytes([0xcc;32]),vout:0},output:&output,public_key:&receiver};
        let spend=||SpendOptions{profile,token:TokenInput{parent:&deploy,vout:1,ancestors:&source},funding:&fee,
            expected_identity:&identity,branch:&good_claim,chain:ChainContext{height:Some(830010),median_time_past:None},max_fee:10000};
        let mut bad=spend();bad.branch=&wrong_claim;assert!(build_spend_plan(bad).is_err());
        let mut bad=spend();bad.branch=&SpendBranch::Refund;assert!(build_spend_plan(bad).is_err());
        let mut bad=spend();bad.token.vout=0;assert!(build_spend_plan(bad).is_err());
        let mut bad=spend();bad.token.ancestors=&[];assert!(build_spend_plan(bad).is_err());
        let good=build_spend_plan(spend()).unwrap();let mut tampered=good.unsigned_plan.clone();
        tampered.transactions[0].inputs[0].unlocking_script="tbc-htlc-claim:aa".into();assert!(begin_signing(&tampered).is_err());
    }
}

#[test]
fn multi_input_lock_preserves_allocations_and_reuses_exact_ancestors() {
    for profile in [TokenProfile::Tbc20,TokenProfile::Coin] {
        let (parent,ancestor)=match profile {
            TokenProfile::Tbc20=>{let f:serde_json::Value=serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
                (Transaction::from_hex(f["stages"][2]["signedRaw"].as_str().unwrap()).unwrap(),Transaction::from_hex(f["stages"][1]["signedRaw"].as_str().unwrap()).unwrap())},
            TokenProfile::Coin=>{let f:serde_json::Value=serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap();
                (Transaction::from_hex(f["vectors"][0]["signedRaw"].as_str().unwrap()).unwrap(),Transaction::from_hex(f["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap())},
        };
        let point=OutPoint{txid:parent.txid(),vout:0};
        let identity=match profile{TokenProfile::Tbc20=>tbc20_material::inspect_parent(&parent.serialize(),&point,None).unwrap().identity().to_vec(),
            TokenProfile::Coin=>coin_proof::inspect_parent(&parent.serialize(),&point,None).unwrap().identity().to_vec()};
        let sender=key(1).public_key();let receiver=key(2).public_key();let refs=[&ancestor];
        let inputs=[TokenInput{parent:&parent,vout:0,ancestors:&refs},TokenInput{parent:&parent,vout:2,ancestors:&refs}];
        let fee=FeeInput{outpoint:OutPoint{txid:parent.txid(),vout:4},output:&parent.outputs[4],public_key:&sender};
        let code=Code{sender_hash:sender.hash160(),receiver_hash:receiver.hash160(),hashlock:Sha256::digest([0x33;32]).into(),raw_lock_time:830010};
        let amount=if profile==TokenProfile::Tbc20{50000}else{400};
        let plan=build_lock_plan(LockOptions{profile,inputs:&inputs,funding:&fee,expected_identity:&identity,code:&code,amount,
            chain:ChainContext{height:Some(830000),median_time_past:None},max_fee:10000}).unwrap();
        assert_eq!(plan.unsigned_plan.evidence_table.len(),2,"shared ancestor interned once");
        let deploy=finish(&plan,1,profile,"lock",&parent,&[ancestor]);
        for branch in [SpendBranch::Claim(vec![0x33;32]),SpendBranch::Refund] {
            let refund=matches!(branch,SpendBranch::Refund);let signer=if refund{1}else{2};let public=key(signer).public_key();
            let output=TxOut{satoshis:100000,script_pubkey:Script::p2pkh(&public.hash160())};
            let fee=FeeInput{outpoint:OutPoint{txid:Txid::from_le_bytes([0xda+signer;32]),vout:0},output:&output,public_key:&public};
            let ancestors=[&parent];let plan=build_spend_plan(SpendOptions{profile,token:TokenInput{parent:&deploy,vout:1,ancestors:&ancestors},
                funding:&fee,expected_identity:&identity,branch:&branch,chain:ChainContext{height:Some(830010),median_time_past:None},max_fee:10000}).unwrap();
            assert_eq!(plan.unsigned_plan.evidence_table.len(),2,"two token dependencies share one parent raw");
            finish(&plan,signer,profile,if refund{"refund"}else{"claim"},&deploy,&[parent.clone()]);
        }
    }
}

#[test]
fn coin_htlc_never_bypasses_coin_lock_or_mixes_refund_domains() {
    let sender=key(1).public_key();let receiver=key(2).public_key();
    let (parent,ancestors,vout,fee_vout,identity)=fixture(TokenProfile::Coin,829999);let refs:Vec<_>=ancestors.iter().collect();
    let inputs=[TokenInput{parent:&parent,vout,ancestors:&refs}];
    let fee=FeeInput{outpoint:OutPoint{txid:parent.txid(),vout:fee_vout},output:&parent.outputs[fee_vout as usize],public_key:&sender};
    let code=Code{sender_hash:sender.hash160(),receiver_hash:receiver.hash160(),hashlock:Sha256::digest([0x33;32]).into(),raw_lock_time:1774427165};
    let options=||LockOptions{profile:TokenProfile::Coin,inputs:&inputs,funding:&fee,expected_identity:&identity,code:&code,amount:250,
        chain:ChainContext{height:Some(829998),median_time_past:Some(1774427100)},max_fee:10000};
    assert!(build_lock_plan(options()).is_err());
    // A height-locked Coin cannot be combined with a timestamp HTLC refund:
    // the eventual refund transaction has only one nLockTime domain.
    let mut mature=options();mature.chain.height=Some(830000);
    assert!(build_lock_plan(mature).is_err());
}
