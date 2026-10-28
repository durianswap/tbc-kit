//! New NFT business builders, real external signer, public synthetic funds only.
use tbc_engine_core::{EngineError,ErrorCode,protocols::{tbc721_transaction::*,tbc721::{parse_code},tbc20_mint::fee_for_size},signing::*};
use tbc_sdk::{Address,OutPoint,PrivateKey,Transaction,TxIn,TxOut,Txid,script::Script,contracts::nft::{CollectionData,NftData}};
use serde_json::json;

fn key()->PrivateKey {let mut bytes=[0;32];bytes[31]=1;PrivateKey::from_slice(&bytes).unwrap()}
fn hex(bytes:&[u8])->String {bytes.iter().map(|b|format!("{b:02x}")).collect()}
fn unhex(text:&str)->Vec<u8> {(0..text.len()).step_by(2).map(|i|u8::from_str_radix(&text[i..i+2],16).unwrap()).collect()}
fn funding()->Transaction {Transaction {version:10,inputs:vec![TxIn::new(OutPoint {txid:Txid::from_le_bytes([0x11;32]),vout:0})],
    outputs:vec![TxOut {satoshis:100000,script_pubkey:Script::p2pkh(&key().public_key().hash160())}],lock_time:0}}
fn collection_data()->CollectionData {CollectionData {collection_name:"TBC721 Collection".into(),description:"public synthetic only".into(),supply:3,file:"{}".into()}}
fn nft_data()->NftData {NftData {nft_name:"NFT".into(),symbol:"N".into(),description:"synthetic".into(),attributes:"{}".into(),file:None}}
fn sign(built:&NftPlan)->Vec<Transaction> {
    let plan=&built.unsigned_plan;let mut stage=begin_signing(plan).unwrap();
    loop {
        let sigs=stage.signing_requests.iter().map(|r|ExternalSignature {session_id:r.session_id.clone(),stage:r.stage,
            stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),input_index:r.input_index,
            digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&key().sign_ecdsa_digest(&unhex(&r.digest).try_into().unwrap()))}).collect::<Vec<_>>();
        match finalize_signing_stage(plan,stage,&sigs).unwrap() {
            StageOutcome::Pending(next)=>stage=next,
            StageOutcome::Complete(bundle)=>return bundle.transactions.iter().enumerate().map(|(index,record)|{
                let tx=Transaction::from_hex(&record.raw_transaction).unwrap();
                let paid=plan.transactions[index].inputs.iter().map(|i|i.previous_output_satoshis).sum::<u64>()-tx.outputs.iter().map(|o|o.satoshis).sum::<u64>();
                assert_eq!(paid,built.fees[index]);assert!(tx.serialize().len()<=built.maximum_signed_bytes[index]);
                assert!(paid>=fee_for_size(tx.serialize().len()).unwrap());tx
            }).collect(),
        }
    }
}
fn create()->(Transaction,NftPlan,Transaction) {
    let funding=funding();let public=key().public_key();
    let plan=build_collection_plan(&collection_data(),&public.address(),&public,&[FundingInput {
        outpoint:OutPoint {txid:funding.txid(),vout:0},output:&funding.outputs[0]}],10000).unwrap();
    let tx=sign(&plan).remove(0);(funding,plan,tx)
}

#[test]
fn collection_template_does_not_encode_historical_or_current_generation() {
    use tbc_sdk::contracts::nft::scripts;
    let (_,_,current_collection)=create();
    let public=key().public_key();let owner=public.address();
    // The current builder and the historical SDK encode the same metadata
    // and mint-slot bytes. A label or intent name cannot prove provenance.
    assert_eq!(current_collection.outputs[0].script_pubkey,
        scripts::tape_script(&collection_data()).unwrap());
    for slot in &current_collection.outputs[1..=3] {
        assert_eq!(slot.satoshis,100);
        assert_eq!(slot.script_pubkey,scripts::mint_script(&owner));
    }
    let mut historical_collection=current_collection.clone();
    historical_collection.outputs[0].script_pubkey=scripts::tape_script(&collection_data()).unwrap();
    for slot in &mut historical_collection.outputs[1..=3] {
        slot.script_pubkey=scripts::mint_script(&owner);
    }
    assert_eq!(historical_collection.to_hex(),current_collection.to_hex());
    let data=nft_data();
    let built=build_mint_plan(&historical_collection,MintItem {slot:1,recipient:&owner,data:&data},
        &public,&[FundingInput {outpoint:OutPoint {txid:historical_collection.txid(),vout:4},
            output:&historical_collection.outputs[4]}],10000).unwrap();
    let minted=sign(&built).remove(0);
    assert_eq!(parse_code(minted.outputs[0].script_pubkey.as_bytes()).unwrap().original_outpoint,
        OutPoint {txid:historical_collection.txid(),vout:1});
}

#[test]
fn collection_batch_mint_transfer_and_tbc_payment_share_keyless_signing() {
    let (funding,collection_plan,collection)=create();let public=key().public_key();let owner=public.address();
    let data=nft_data();let mint_items=[MintItem {slot:1,recipient:&owner,data:&data},MintItem {slot:3,recipient:&owner,data:&data}];
    let mint_plan=build_batch_mint_plan(&collection,&mint_items,&public,&[FundingInput {
        outpoint:OutPoint {txid:collection.txid(),vout:4},output:&collection.outputs[4]}],10000).unwrap();
    let minted=sign(&mint_plan);
    assert_eq!(minted[1].inputs[1].previous_output,OutPoint {txid:minted[0].txid(),vout:3});
    assert_eq!(minted[1].inputs[0].previous_output,OutPoint {txid:collection.txid(),vout:3});
    for (index,mint) in minted.iter().enumerate(){assert_eq!(parse_code(mint.outputs[0].script_pubkey.as_bytes()).unwrap().original_outpoint.vout,[1,3][index]);}
    let recipient=Address::from_hash160([0x22;20]);
    let origin=OutPoint {txid:collection.txid(),vout:3};
    let plan_transfer=|parent:&Transaction,grandparent:&Transaction,payment|build_transfer_plan(TransferOptions {
        parent,grandparent,expected_origin:&origin,public_key:&public,recipient:&owner,
        funding:&[FundingInput {outpoint:OutPoint {txid:parent.txid(),vout:3},output:&parent.outputs[3]}],payment,max_fee:10000,
    }).unwrap();
    let transfer_plan=plan_transfer(&minted[1],&collection,None);let transfer=sign(&transfer_plan).remove(0);
    let payment_plan=plan_transfer(&transfer,&minted[1],Some((&recipient,1234)));let payment=sign(&payment_plan).remove(0);
    assert_eq!(payment.outputs[3].satoshis,1234);assert_eq!(payment.outputs[3].script_pubkey,recipient.script_pubkey());
    assert_eq!(payment.outputs[2],minted[1].outputs[2]);
    let minted_ids:Vec<_>=minted.iter().map(|t|t.txid().to_string()).collect();
    assert_ne!(minted_ids[0],minted_ids[1]);
    if let Ok(path)=std::env::var("TBC721_SYNTHETIC_REPORT") {
        let record=|role:&str,plan:&NftPlan,txs:&[Transaction]|json!({"role":role,"fees":plan.fees,
            "maximumSignedBytes":plan.maximum_signed_bytes,"raws":txs.iter().map(|t|t.to_hex()).collect::<Vec<_>>()});
        let report=json!({"syntheticFunding":true,"publicScalar":"1","network":false,"fundingRaw":funding.to_hex(),
            "cases":[record("collection",&collection_plan,&[collection]),record("batch-mint",&mint_plan,&minted),
                record("transfer",&transfer_plan,&[transfer]),record("payment",&payment_plan,&[payment])]});
        std::fs::write(path,serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
}

#[test]
fn nft_funding_fee_and_slot_errors_fail_before_external_signing() {
    let (_,_,collection)=create();let public=key().public_key();let owner=public.address();let data=nft_data();
    let funding=[FundingInput {outpoint:OutPoint {txid:collection.txid(),vout:4},output:&collection.outputs[4]}];
    for slot in [0,4,u32::MAX] {assert!(build_mint_plan(&collection,MintItem {slot,recipient:&owner,data:&data},&public,&funding,10000).is_err());}
    let duplicate=[MintItem {slot:1,recipient:&owner,data:&data},MintItem {slot:1,recipient:&owner,data:&data}];
    assert!(build_batch_mint_plan(&collection,&duplicate,&public,&funding,10000).is_err());
    assert!(build_batch_mint_plan(&collection,&[],&public,&funding,10000).is_err());
    assert_eq!(build_mint_plan(&collection,MintItem {slot:1,recipient:&owner,data:&data},&public,&funding,1).unwrap_err().code,ErrorCode::FeeCapExceeded);
    let counterfeit=TxOut {satoshis:100000,script_pubkey:Script::p2pkh(&[0x44;20])};
    assert!(build_collection_plan(&collection_data(),&owner,&public,&[FundingInput {outpoint:OutPoint {txid:collection.txid(),vout:4},output:&counterfeit}],10000).is_err());
    let mut excessive=collection_data();excessive.supply=u32::MAX;
    assert!(build_collection_plan(&excessive,&owner,&public,&funding,10000).is_err());
    let mut wrong=collection.clone();wrong.outputs[1].satoshis=101;
    assert!(build_mint_plan(&wrong,MintItem {slot:1,recipient:&owner,data:&data},&public,&funding,10000).is_err());
}

#[test]
fn transfer_requires_bound_origin_and_normal_nft_role_and_preserves_tape_bytes() {
    let (_,_,collection)=create();let public=key().public_key();let owner=public.address();let data=nft_data();
    let built=build_mint_plan(&collection,MintItem {slot:2,recipient:&owner,data:&data},&public,&[FundingInput {
        outpoint:OutPoint {txid:collection.txid(),vout:4},output:&collection.outputs[4]}],10000).unwrap();
    let parent=sign(&built).remove(0);let origin=OutPoint {txid:collection.txid(),vout:2};
    let run=|p:&Transaction,origin:&OutPoint,payment|->Result<NftPlan,EngineError>{build_transfer_plan(TransferOptions {
        parent:p,grandparent:&collection,expected_origin:origin,public_key:&public,recipient:&owner,
        funding:&[FundingInput {outpoint:OutPoint {txid:p.txid(),vout:3},output:&p.outputs[3]}],payment,max_fee:10000})};
    assert!(run(&parent,&OutPoint {txid:collection.txid(),vout:1},None).is_err());
    assert!(run(&parent,&origin,Some((&owner,23))).is_err());
    let mut wrong=parent.clone();wrong.outputs[1].script_pubkey=Script::p2pkh(&public.hash160());
    assert!(run(&wrong,&origin,None).is_err());
    let mut augmented=parent.clone();
    let metadata=json!({"z":"retained","nftName":"NFT","symbol":"N","description":"synthetic","attributes":null});
    augmented.outputs[2].script_pubkey=tbc_sdk::contracts::nft::scripts::tape_script(&metadata).unwrap();
    let built=run(&augmented,&origin,None).unwrap();
    assert_eq!(built.unsigned_plan.transactions[0].outputs[2].locking_script,hex(augmented.outputs[2].script_pubkey.as_bytes()));
}

#[test]
fn nft_dust_and_batch_exhaustion_never_donate_unbounded_fees_or_reuse_slots() {
    let public=key().public_key();let owner=public.address();let source=funding();
    for value in [80+300+41,80+300+42] {
        let output=TxOut {satoshis:value,script_pubkey:owner.script_pubkey()};
        let plan=build_collection_plan(&collection_data(),&owner,&public,&[FundingInput {
            outpoint:OutPoint {txid:source.txid(),vout:0},output:&output}],1000).unwrap();
        assert_eq!(plan.unsigned_plan.transactions[0].outputs.len(),if value==421 {4} else {5});
        assert_eq!(plan.fees[0],if value==421 {121} else {80});
        sign(&plan);
        if value==421 {assert_eq!(build_collection_plan(&collection_data(),&owner,&public,&[FundingInput {
            outpoint:OutPoint {txid:source.txid(),vout:0},output:&output}],100).unwrap_err().code,ErrorCode::FeeCapExceeded);}
    }
    let (_,_,collection)=create();let data=nft_data();
    let low=TxOut {satoshis:280,script_pubkey:owner.script_pubkey()};
    let slots=[MintItem {slot:1,recipient:&owner,data:&data},MintItem {slot:2,recipient:&owner,data:&data}];
    let fee=[FundingInput {outpoint:OutPoint {txid:source.txid(),vout:0},output:&low}];
    assert!(build_mint_plan(&collection,MintItem {slot:1,recipient:&owner,data:&data},&public,&fee,1000).is_ok());
    assert_eq!(build_batch_mint_plan(&collection,&slots,&public,&fee,1000).unwrap_err().code,ErrorCode::InsufficientFunds);
    let repeated=[FundingInput {outpoint:OutPoint {txid:source.txid(),vout:0},output:&low},FundingInput {outpoint:OutPoint {txid:source.txid(),vout:0},output:&low}];
    assert!(build_collection_plan(&collection_data(),&owner,&public,&repeated,1000).is_err());
}

#[test]
fn large_nft_media_remains_readable_and_transferable_after_signing() {
    use tbc_engine_core::protocols::nft_origin::{inspect_collection_origin,inspect_nft_origin};
    let public=key().public_key();let owner=public.address();
    let mut reports=Vec::new();
    for (length,supply) in [(70_000,3),(500_000,3),(4,2000)] {
        let mut source=funding();source.outputs[0].satoshis=10_000_000;
        let mut collection_meta=collection_data();collection_meta.file="x".repeat(length);collection_meta.supply=supply;
        let cplan=build_collection_plan(&collection_meta,&owner,&public,&[FundingInput {
            outpoint:OutPoint {txid:source.txid(),vout:0},output:&source.outputs[0]}],1_000_000).unwrap();
        let collection=sign(&cplan).remove(0);
        assert_eq!(inspect_collection_origin(&collection.txid(),&collection.serialize()).unwrap().metadata.file.len(),length);
        let mut data=nft_data();data.file=Some("y".repeat(length));
        let mplan=build_mint_plan(&collection,MintItem {slot:1,recipient:&owner,data:&data},&public,&[FundingInput {
            outpoint:OutPoint {txid:collection.txid(),vout:supply+1},output:&collection.outputs[supply as usize+1]}],1_000_000).unwrap();
        let mint=sign(&mplan).remove(0);
        inspect_nft_origin(&mint.txid(),&mint.serialize()).unwrap();
        let mut transactions=vec![collection.to_hex(),mint.to_hex()];
        let origin=OutPoint {txid:collection.txid(),vout:1};
        let mut parent=mint.clone();let mut grandparent=collection.clone();
        for _ in 0..2 {
            let plan=build_transfer_plan(TransferOptions {parent:&parent,grandparent:&grandparent,expected_origin:&origin,
                public_key:&public,recipient:&owner,funding:&[FundingInput {outpoint:OutPoint {txid:parent.txid(),vout:3},output:&parent.outputs[3]}],
                payment:None,max_fee:1_000_000}).unwrap();
            let sent=sign(&plan).remove(0);
            assert_eq!(sent.outputs[2],mint.outputs[2]);
            assert!(sent.serialize().len()<=1_048_576);
            transactions.push(sent.to_hex());
            grandparent=parent;parent=sent;
        }
        data.file=Some("z".repeat(1_048_576));
        let oversized=build_mint_plan(&collection,MintItem {slot:1,recipient:&owner,data:&data},&public,&[FundingInput {
            outpoint:OutPoint {txid:collection.txid(),vout:supply+1},output:&collection.outputs[supply as usize+1]}],1_000_000).unwrap_err();
        assert!(oversized.message.contains("metadata exceeds material budget"));
        collection_meta.file="z".repeat(1_048_576);
        assert!(build_collection_plan(&collection_meta,&owner,&public,&[FundingInput {
            outpoint:OutPoint {txid:source.txid(),vout:0},output:&source.outputs[0]}],1_000_000).is_err());
        reports.push(json!({"mediaBytes":length,"supply":supply,"fundingRaw":source.to_hex(),"transactions":transactions}));
    }
    if let Ok(path)=std::env::var("TBC721_MEDIA_REPORT") {
        std::fs::write(path,serde_json::to_vec(&reports).unwrap()).unwrap();
    }
}
