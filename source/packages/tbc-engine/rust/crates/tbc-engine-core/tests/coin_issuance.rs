//! Synthetic SDK source/mint vectors only; Engine never receives a private key.
use serde_json::Value;
use tbc_engine_core::{protocols::{coin_issuance::*,coin_identity,tbc20_transfer::FeeInput},signing::*,ErrorCode};
use tbc_sdk::{Transaction,OutPoint,PublicKey};
fn bytes(s:&str)->Vec<u8>{(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hex(b:&[u8])->String{b.iter().map(|v|format!("{v:02x}")).collect()}
fn fixture()->Value{serde_json::from_str(include_str!("../../../fixtures/coin-admin-proof.json")).unwrap()}
fn material()->(Transaction,PublicKey,[u8;32]) {
    let f=fixture();(Transaction::from_hex(f["issuance"]["grandparentRaw"].as_str().unwrap()).unwrap(),
        PublicKey::from_slice(&bytes("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")).unwrap(),
        bytes(f["issuance"]["publicKeyHex"].as_str().unwrap()).try_into().unwrap())
}
fn options<'a>(funding:&'a Transaction,key:&'a PublicKey,admin:&'a [u8;32])->CreateOptions<'a>{
    let mut recipient=[0;21];recipient[..20].copy_from_slice(&key.hash160());
    CreateOptions {definition:CoinDefinition{name:"Offline Coin",symbol:"OFF",decimals:0,initial_amount:1000},
        administrator:admin,fee_public_key:key,funding,funding_outpoint:OutPoint{txid:funding.txid(),vout:0},
        recipient,additional_info:None,max_fee:10000}
}
fn signatures(stage:&SigningStage,signed:&Transaction)->Vec<ExternalSignature> {
    let f=fixture();stage.signing_requests.iter().map(|r|{
        let sig=if stage.stage==1 && r.input_index==0 {bytes(f["issuance"]["signatureHex"].as_str().unwrap())}
            else{let script=signed.inputs[r.input_index as usize].script_sig.as_bytes();script[1..1+script[0]as usize].to_vec()};
        assert_eq!(sig.last(),Some(&65));
        ExternalSignature {session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),
            transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),
            signature:hex(&sig[..sig.len()-1])}
    }).collect()
}

fn sign_with_public_test_scalars(plan:&IssuancePlan)->Vec<Transaction> {
    let mut scalar=[0;32];scalar[31]=1;let fee=tbc_sdk::PrivateKey::from_slice(&scalar).unwrap();
    scalar[31]=2;let secp=secp256k1::Secp256k1::new();
    let admin=secp256k1::Keypair::from_secret_key(&secp,&secp256k1::SecretKey::from_byte_array(scalar).unwrap());
    let mut stage=begin_signing(&plan.unsigned_plan).unwrap();
    loop {
        let sigs=stage.signing_requests.iter().map(|r| {
            let digest:[u8;32]=bytes(&r.digest).try_into().unwrap();
            let sig=if r.algorithm=="secp256k1-schnorr" {secp.sign_schnorr_no_aux_rand(&digest,&admin).as_ref().to_vec()}
                else{fee.sign_ecdsa_digest(&digest)};
            ExternalSignature {session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),
                input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&sig)}
        }).collect::<Vec<_>>();
        match finalize_signing_stage(&plan.unsigned_plan,stage,&sigs).unwrap() {
            StageOutcome::Pending(next)=>stage=next,
            StageOutcome::Complete(bundle)=>return bundle.transactions.iter().enumerate().map(|(i,signed)|{
                let tx=Transaction::from_hex(&signed.raw_transaction).unwrap();
                assert!(tx.serialize().len()<=plan.maximum_signed_bytes[i]);tx
            }).collect(),
        }
    }
}

#[test]
fn issuance_precision_message_and_contract_receiver_use_same_external_signer() {
    let (funding,key,admin)=material();let mut reports=Vec::new();
    for (id,decimals,amount,contract,message) in [
        ("precision-message",6,2500000,false,Some("Coin UTF-8 message")),
        ("contract-recipient",0,1000,true,None),
    ] {
        let mut o=options(&funding,&key,&admin);o.definition.decimals=decimals;o.definition.initial_amount=amount;
        if contract{o.recipient=[0x22;21];o.recipient[20]=1;}
        o.additional_info=message.map(str::as_bytes);
        let plan=build_create_plan(o).unwrap();let txs=sign_with_public_test_scalars(&plan);
        assert_eq!(txs[1].inputs[0].previous_output.txid,txs[0].txid());
        let identity=coin_identity::inspect_genesis(&txs[1].txid(),&txs[1].serialize(),&txs[0].serialize()).unwrap();
        assert_eq!(identity.initial_supply,amount);assert_eq!(identity.decimals,decimals);
        let parent=&txs[1];let vout=parent.outputs.len() as u32-1;
        let fee=FeeInput {outpoint:OutPoint {txid:parent.txid(),vout},output:&parent.outputs[vout as usize],public_key:&key};
        let mut recipient=[0;21];recipient[..20].copy_from_slice(&key.hash160());
        let mint=build_mint_plan(MintOptions {issuer_id:&txs[0].txid(),issuer:&txs[0],certificate:parent,grandparent:&txs[0],
            coin_code:parent.outputs[3].script_pubkey.as_bytes(),coin_tape:parent.outputs[4].script_pubkey.as_bytes(),administrator:&admin,
            fee_input:&fee,amount:777,recipient,additional_info:Some(b"additional mint"),max_fee:10000}).unwrap();
        let minted=sign_with_public_test_scalars(&mint);
        assert_eq!(minted[0].inputs[0].previous_output.txid,parent.txid());
        assert_eq!(minted[0].outputs[0],parent.outputs[0]);assert_eq!(minted[0].outputs[1],parent.outputs[1]);
        reports.push(serde_json::json!({"id":id,"name":"Offline Coin","symbol":"OFF","decimals":decimals,"amountAtomic":amount.to_string(),
            "contractRecipient":contract,"message":message,"fees":plan.fees,"maximumSignedBytes":plan.maximum_signed_bytes,
            "raws":txs.iter().map(Transaction::to_hex).collect::<Vec<_>>(),"mintAmountAtomic":"777","mintMessage":"additional mint",
            "mintRaw":minted[0].to_hex(),"mintFee":mint.fees[0],"mintMaximumSignedBytes":mint.maximum_signed_bytes[0] }));
    }
    if let Ok(path)=std::env::var("COIN_ISSUANCE_REPORT") {
        std::fs::write(path,serde_json::to_vec(&serde_json::json!({"publicScalars":[1,2],"network":false,
            "fundingRaw":funding.to_hex(),"cases":reports})).unwrap()).unwrap();
    }
}

#[test]
fn reissuance_rejects_wrong_anchor_admin_metadata_parent_and_fee_material() {
    let (_,key,admin)=material();let f=fixture();
    let issuer=Transaction::from_hex(f["issuance"]["parentRaw"].as_str().unwrap()).unwrap();
    let parent=Transaction::from_hex(f["issuance"]["signedRaw"].as_str().unwrap()).unwrap();
    let code=parent.outputs[3].script_pubkey.as_bytes();let tape=parent.outputs[4].script_pubkey.as_bytes();
    let mut recipient=[0;21];recipient[..20].copy_from_slice(&key.hash160());
    let mut wrong_admin=admin;wrong_admin[0]^=1;
    let wrong_id="55".repeat(32).parse().unwrap();
    let issuer_id=issuer.txid();
    for case in 0..7 {
        let mut current=parent.clone();let mut coin_code=code.to_vec();let mut coin_tape=tape.to_vec();
        if case==2 {coin_code[100]^=1;}
        if case==3 {coin_tape[54]^=1;}
        if case==4 {current.outputs[1].satoshis=101;}
        let vout=if case==5 {1}else{parent.outputs.len() as u32-1};
        let mut value=parent.outputs[vout as usize].clone();if case==6 {value.satoshis+=1;}
        let fee=FeeInput {outpoint:OutPoint{txid:parent.txid(),vout},output:&value,public_key:&key};
        let result=build_mint_plan(MintOptions {issuer_id:if case==0{&wrong_id}else{&issuer_id},issuer:&issuer,
            certificate:&current,grandparent:&issuer,coin_code:&coin_code,coin_tape:&coin_tape,
            administrator:if case==1{&wrong_admin}else{&admin},fee_input:&fee,amount:1,recipient,additional_info:None,max_fee:10000});
        assert!(result.is_err(),"case {case}");
    }
}

#[test]
fn keyless_create_matches_sdk_source_mint_and_external_finalization() {
    let (funding,key,admin)=material();let plan=build_create_plan(options(&funding,&key,&admin)).unwrap();
    let f=fixture();let expected=["parentRaw","signedRaw"].map(|name|Transaction::from_hex(f["issuance"][name].as_str().unwrap()).unwrap());
    assert_eq!(plan.unsigned_plan.transactions.len(),2);
    for (i,actual) in plan.unsigned_plan.transactions.iter().enumerate() {
        assert_eq!(actual.outputs.len(),expected[i].outputs.len());
        for (o,e) in actual.outputs.iter().zip(&expected[i].outputs){assert_eq!(o.satoshis,e.satoshis);assert_eq!(o.locking_script,hex(e.script_pubkey.as_bytes()));}
        let paid=actual.inputs.iter().map(|i|i.previous_output_satoshis).sum::<u64>()-actual.outputs.iter().map(|o|o.satoshis).sum::<u64>();
        assert_eq!(paid,plan.fees[i]);assert!(plan.maximum_signed_bytes[i]>=expected[i].serialize().len());
    }
    let first=begin_signing(&plan.unsigned_plan).unwrap();assert_eq!(first.signing_requests.len(),1);
    let sigs=signatures(&first,&expected[0]);
    let StageOutcome::Pending(second)=finalize_signing_stage(&plan.unsigned_plan,first,&sigs).unwrap()else{panic!("mint stage")};
    assert_eq!(second.signing_requests.iter().map(|r|r.algorithm.as_str()).collect::<Vec<_>>(),vec!["secp256k1-schnorr","secp256k1-schnorr","secp256k1-ecdsa"]);
    let sigs=signatures(&second,&expected[1]);
    let StageOutcome::Complete(bundle)=finalize_signing_stage(&plan.unsigned_plan,second,&sigs).unwrap()else{panic!("complete")};
    for (actual,expected) in bundle.transactions.iter().zip(&expected) {assert_eq!(actual.raw_transaction,expected.to_hex());assert_eq!(actual.txid,expected.txid().to_string());}
    let issuer=coin_identity::inspect_issuer(&expected[0].txid(),&expected[0].serialize()).unwrap();assert_eq!(issuer.name,"Offline Coin");
    let identity=coin_identity::inspect_genesis(&expected[1].txid(),&expected[1].serialize(),&expected[0].serialize()).unwrap();assert_eq!(identity.initial_supply,1000);
}

#[test]
fn issuance_bounds_supply_metadata_selected_funding_and_total_fee_before_signing() {
    let (funding,key,admin)=material();
    for case in 0..8 {
        let mut o=options(&funding,&key,&admin);
        match case {0=>o.definition.initial_amount=0,1=>o.definition.initial_amount=u64::MAX,
            2=>o.definition.decimals=19,3=>o.definition.name="This metadata is much too long for Coin's bounded sixty-one-byte metadata area",
            4=>o.funding_outpoint.vout=u32::MAX,5=>o.funding_outpoint.txid="22".repeat(32).parse().unwrap(),
            6=>o.recipient[20]=2,_=>o.max_fee=1}
        assert!(build_create_plan(o).is_err(),"case {case}");
    }
    let accepted=build_create_plan(options(&funding,&key,&admin)).unwrap();
    let mut o=options(&funding,&key,&admin);o.max_fee=accepted.fees.iter().sum::<u64>()-1;
    assert_eq!(build_create_plan(o).unwrap_err().code,ErrorCode::FeeCapExceeded);
    let mut poor=funding.clone();poor.outputs[0].satoshis=403;
    assert_eq!(build_create_plan(options(&poor,&key,&admin)).unwrap_err().code,ErrorCode::InsufficientFunds);
    let mut counterfeit=funding.clone();counterfeit.outputs[0].script_pubkey=tbc_sdk::script::Script::p2pkh(&[9;20]);
    assert!(build_create_plan(options(&counterfeit,&key,&admin)).is_err());
    assert!(build_create_plan(options(&funding,&key,&[255;32])).is_err());
}
