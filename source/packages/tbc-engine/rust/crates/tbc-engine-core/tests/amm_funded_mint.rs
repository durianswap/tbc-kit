use serde_json::Value;
use std::collections::{BTreeMap,BTreeSet};
use tbc_engine_core::{ErrorCode,protocols::{amm_code,amm_mint::*,amm_state::PoolConfig,amm_transaction::MinerFeePolicy,amm_business,amm_math::AddBudget,tbc20_material},signing::*};
use tbc_sdk::{Transaction,PublicKey,hash};
fn bytes(s:&str)->Vec<u8>{(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hex(b:&[u8])->String{b.iter().map(|b|format!("{b:02x}")).collect()}
fn owner()->PublicKey{PublicKey::from_slice(&bytes("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")).unwrap()}
fn fixture()->Value{serde_json::from_str(include_str!("../../../fixtures/amm-mint.json")).unwrap()}
struct Case{ft:Transaction,config:PoolConfig,vout:u32,key:PublicKey}
impl Case{
    fn new(v:&Value)->Self{
        let previous:Value=serde_json::from_str(include_str!("../../../fixtures/amm-pool-proof.json")).unwrap();
        let label=v["label"].as_str().unwrap();let row=previous["vectors"].as_array().unwrap().iter().find(|r|r["id"]==format!("{label}-add")).unwrap();
        let pool=Transaction::from_hex(previous["raws"][row["parentTxid"].as_str().unwrap()].as_str().unwrap()).unwrap();
        let ft=Transaction::from_hex(previous["raws"][v["ftGenesisId"].as_str().unwrap()].as_str().unwrap()).unwrap();
        let auth=amm_code::parse_code(pool.outputs[0].script_pubkey.as_bytes()).unwrap().authorization;
        let config=PoolConfig::new(&ft,&ft.txid(),auth,label.ends_with("locked"),1,None).unwrap();
        Self{ft,config,vout:v["fundingVout"].as_u64().unwrap() as u32,key:owner()}
    }
    fn options(&self)->MintOptions<'_>{MintOptions{config:&self.config,funding_parent:&self.ft,funding_vout:self.vout,funding_public_key:&self.key,
        change_hash:self.key.hash160(),fee_policy:MinerFeePolicy::default(),max_fee:10000}}
}
fn signatures(stage:&SigningStage,encoded:&str)->Vec<ExternalSignature>{
    let bytes=bytes(encoded);assert_eq!(bytes.last(),Some(&0x41));assert_eq!(stage.signing_requests.len(),1);
    stage.signing_requests.iter().map(|r|{assert_eq!(r.script_class,"p2pkh");ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),
        transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&bytes[..bytes.len()-1])}}).collect()
}
fn source_signature(v:&Value)->String{let source=Transaction::from_hex(v["sourceRaw"].as_str().unwrap()).unwrap();let script=source.inputs[0].script_sig.as_bytes();hex(&script[1..1+script[0] as usize])}
fn first_add(c:&Case,source:&Transaction,genesis:&Transaction,v:&Value){
    let previous:Value=serde_json::from_str(include_str!("../../../fixtures/amm-pool-proof.json")).unwrap();
    let mut history:BTreeMap<_,_>=previous["raws"].as_object().unwrap().iter().map(|(id,raw)|(id.clone(),Transaction::from_hex(raw.as_str().unwrap()).unwrap())).collect();
    history.insert(source.txid().to_string(),source.clone());history.insert(genesis.txid().to_string(),genesis.clone());
    let ancestors=|tx:&Transaction,vout:u32|{
        let point=tbc_sdk::OutPoint{txid:tx.txid(),vout};let material=tbc20_material::inspect_parent(&tx.serialize(),&point,None).unwrap();
        material.dependencies().iter().map(|d|d.outpoint.txid.to_string()).collect::<BTreeSet<_>>().iter().map(|id|&history[id]).collect::<Vec<_>>()
    };
    let user_ancestors=ancestors(&c.ft,0);let pool_ancestors=ancestors(genesis,2);
    let user=amm_business::AssetInput{parent:&c.ft,vout:0,ancestors:&user_ancestors,public_key:&c.key};
    let pool_ft=amm_business::AssetInput{parent:genesis,vout:2,ancestors:&pool_ancestors,public_key:&c.key};
    let pool=c.config.read_pool(genesis,&hash::sha256(genesis.outputs[0].script_pubkey.as_bytes())).unwrap();
    let controller=PublicKey::from_slice(&bytes("02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5")).unwrap();
    let controlled=matches!(c.config.authorization(),amm_code::Authorization::Controller(_));
    let built=amm_business::build_plan(amm_business::Options{config:&c.config,pool:&pool,pool_ancestor:source,pool_ft:&pool_ft,user_asset:Some(&user),
        funding:amm_business::Funding{parent:genesis,vout:4,public_key:&c.key},controller_public_key:controlled.then_some(&controller),expected_snapshot_hash:Some(*pool.snapshot_hash()),
        action:amm_business::Action::Add{budget:AddBudget::Tbc{amount:100000,first_ft:Some(200000)},min_lp:100000,max_ft:Some(200000),max_tbc:Some(100000),lp_lock_time:c.config.timelocked().then_some(829999)},
        receiver_hash:c.key.hash160(),change_hash:c.key.hash160(),fee_policy:MinerFeePolicy::default(),max_fee:10000}).unwrap();
    let p=&built.funded.unsigned_plan;let stage=begin_signing(p).unwrap();
    let sigs=stage.signing_requests.iter().map(|r|{
        let raw=v["firstAddSignatures"].as_array().unwrap().iter().find(|s|s["vin"].as_u64()==Some(r.input_index as u64)).unwrap()["signature"].as_str().unwrap();let signature=bytes(raw);
        assert_eq!(signature.last(),Some(&0x41));ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),
            input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&signature[..signature.len()-1])}
    }).collect::<Vec<_>>();
    let StageOutcome::Complete(bundle)=finalize_signing_stage(p,stage,&sigs).unwrap()else{panic!("first add")};
    assert_eq!(hex(&hash::sha256(&bytes(&bundle.transactions[0].raw_transaction))),v["firstAddRawHash"].as_str().unwrap());
    assert_eq!(bundle.transactions[0].txid,v["firstAddTxid"].as_str().unwrap());
}
#[test]
fn four_complete_mints_resolve_real_source_id_and_match_sdk_fees_and_raw_hashes(){
    let f=fixture();
    for v in f["cases"].as_array().unwrap(){
        let c=Case::new(v);let built=build_funded_mint_plan(c.options()).unwrap();let p=&built.unsigned_plan;
        assert_eq!(built.fees,[v["sourceFee"].as_u64().unwrap(),v["genesisFee"].as_u64().unwrap()]);
        assert_eq!(p.transactions.len(),2);assert!(p.evidence_table.is_empty(),"new Source must not be fetched into evidence");
        assert_eq!(p.transactions[1].inputs[0].previous_transaction_id,"tbc-amm-source");
        assert!(p.transactions[1].outputs[..3].iter().all(|o|o.locking_script.starts_with("tbc-amm-genesis:")));
        let stage=begin_signing(p).unwrap();assert_eq!(stage.stage,0);let sigs=signatures(&stage,&source_signature(v));
        let StageOutcome::Pending(stage)=finalize_signing_stage(p,stage,&sigs).unwrap()else{panic!("Source then Genesis")};
        assert_eq!(stage.stage,1);let sigs=signatures(&stage,v["genesisSignature"].as_str().unwrap());
        let StageOutcome::Complete(bundle)=finalize_signing_stage(p,stage,&sigs).unwrap()else{panic!("two stages")};
        assert_eq!(bundle.transactions[0].raw_transaction,v["sourceRaw"].as_str().unwrap());
        let genesis=Transaction::from_hex(&bundle.transactions[1].raw_transaction).unwrap();
        assert_eq!(hex(&hash::sha256(&genesis.serialize())),v["genesisRawHash"].as_str().unwrap());assert_eq!(genesis.txid().to_string(),v["genesisTxid"].as_str().unwrap());
        assert_eq!(genesis.inputs[0].previous_output.txid.to_string(),bundle.transactions[0].txid);
        let code=amm_code::parse_code(genesis.outputs[0].script_pubkey.as_bytes()).unwrap();assert_eq!(&code.original_utxo[..32],genesis.inputs[0].previous_output.txid.as_le_bytes());
        let snapshot=c.config.read_pool(&genesis,&hash::sha256(genesis.outputs[0].script_pubkey.as_bytes())).unwrap();
        assert_eq!(c.config.validate_ft(&genesis,2,&c.key,Some(&snapshot)).unwrap().balance,0);
        for(i,result)in bundle.transactions.iter().enumerate(){assert!(result.raw_transaction.len()/2<=built.maximum_signed_bytes[i]);}
        first_add(&c,&Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap(),&genesis,v);
    }
}
#[test]
fn mint_descriptors_cannot_retarget_source_mismatch_siblings_or_issue_pool_ft(){
    let f=fixture();let v=&f["cases"][0];let c=Case::new(v);
    for mutation in 0..10{
        let mut p=build_funded_mint_plan(c.options()).unwrap().unsigned_plan;
        let child=&mut p.transactions[1];
        match mutation{
            0=>child.outputs[0].locking_script=child.outputs[0].locking_script.replace("tbc-amm-source","tbc-amm-create"),
            1=>child.outputs.swap(0,1),
            2=>child.outputs[1].locking_script=child.outputs[1].locking_script.replace("\"lpPlan\":1","\"lpPlan\":2"),
            3=>child.outputs[0].locking_script="51".into(),
            4=>child.outputs[3].satoshis=1,
            5=>{let mut raw=bytes(&child.outputs[3].locking_script);raw[4]=1;child.outputs[3].locking_script=hex(&raw);},
            6=>child.inputs[0].previous_output_index=1,
            7=>child.stage=0,
            8=>child.outputs[2].satoshis=501,
            _=>child.outputs[0].locking_script=child.outputs[0].locking_script.replace("\"part\":0","\"part\":0,\"unrecognized\":true"),
        }
        assert!(begin_signing(&p).is_err(),"mutation {mutation}");
    }
    let p=build_funded_mint_plan(c.options()).unwrap().unsigned_plan;let stage=begin_signing(&p).unwrap();let sigs=signatures(&stage,&source_signature(v));
    let StageOutcome::Pending(mut stage)=finalize_signing_stage(&p,stage,&sigs).unwrap()else{panic!()};
    let sigs=signatures(&stage,v["genesisSignature"].as_str().unwrap());
    let record=stage.continuation.finalized_transactions[0].as_mut().unwrap();let mut changed=Transaction::from_hex(&record.raw_transaction).unwrap();changed.lock_time+=1;
    record.raw_transaction=changed.to_hex();record.txid=changed.txid().to_string();
    assert!(finalize_signing_stage(&p,stage,&sigs).is_err());
}
#[test]
fn complete_mint_caps_sum_both_fees_and_keeps_change_boundary(){
    let f=fixture();let c=Case::new(&f["cases"][0]);let built=build_funded_mint_plan(c.options()).unwrap();
    let total=built.fees.iter().sum::<u64>();let mut o=c.options();o.max_fee=total-1;
    assert_eq!(build_funded_mint_plan(o).unwrap_err().code,ErrorCode::FeeCapExceeded);
    let mut o=c.options();o.max_fee=total;assert!(build_funded_mint_plan(o).is_ok());
    let mut funding=c.ft.clone();funding.outputs[c.vout as usize].satoshis=total+2000+10;
    let mut o=c.options();o.funding_parent=&funding;let exact=build_funded_mint_plan(o).unwrap();assert_eq!(exact.unsigned_plan.transactions[1].outputs.last().unwrap().satoshis,10);
    funding.outputs[c.vout as usize].satoshis-=1;let mut o=c.options();o.funding_parent=&funding;let no_change=build_funded_mint_plan(o).unwrap();assert_eq!(no_change.unsigned_plan.transactions[1].outputs.len(),4);
    funding.outputs[c.vout as usize].satoshis=80;let mut o=c.options();o.funding_parent=&funding;assert_eq!(build_funded_mint_plan(o).unwrap_err().code,ErrorCode::InsufficientFunds);
}
