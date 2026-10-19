use serde_json::Value;
use std::collections::{BTreeMap,BTreeSet};
use tbc_engine_core::{EngineError,ErrorCode,protocols::{amm_business::*,amm_code,amm_math::AddBudget,amm_state::PoolConfig,amm_transaction::MinerFeePolicy,amm_lp_proof,tbc20_material},signing::*};
use tbc_sdk::{Transaction,PublicKey};
fn fixture()->Value{serde_json::from_str(include_str!("../../../fixtures/amm-pool-proof.json")).unwrap()}
fn bytes(s:&str)->Vec<u8>{(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hex(b:&[u8])->String{b.iter().map(|b|format!("{b:02x}")).collect()}
fn row<'a>(f:&'a Value,label:&str,action:&str)->&'a Value{let id=format!("{label}-{action}");f["vectors"].as_array().unwrap().iter().find(|v|v["id"]==id).unwrap()}
fn owner()->PublicKey{PublicKey::from_slice(&bytes("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")).unwrap()}
fn run(f:&Value,label:&str,action:&str,modify:impl FnOnce(&mut Options<'_>))->Result<BusinessPlan,EngineError>{
    run_with_funding(f,label,action,None,modify)
}
fn run_with_funding(f:&Value,label:&str,action:&str,funding_value:Option<u64>,modify:impl FnOnce(&mut Options<'_>))->Result<BusinessPlan,EngineError>{
    let raws:BTreeMap<_,_>=f["raws"].as_object().unwrap().iter().map(|(id,raw)|(id.clone(),Transaction::from_hex(raw.as_str().unwrap()).unwrap())).collect();
    let v=row(f,label,action);let current=Transaction::from_hex(v["currentRaw"].as_str().unwrap()).unwrap();
    let genesis_pool=&raws[row(f,label,"add")["parentTxid"].as_str().unwrap()];let ft_genesis=&raws[&genesis_pool.inputs[0].previous_output.txid.to_string()];
    let auth=amm_code::parse_code(genesis_pool.outputs[0].script_pubkey.as_bytes()).unwrap().authorization;let locked=label.ends_with("locked");
    let config=PoolConfig::new(ft_genesis,&ft_genesis.txid(),auth,locked,1,None).unwrap();
    let pool=&raws[v["parentTxid"].as_str().unwrap()];let ancestor=&raws[v["ancestorTxid"].as_str().unwrap()];
    let snapshot=config.read_pool(pool,&bytes(v["poolHash"].as_str().unwrap()).try_into().unwrap()).unwrap();
    let key=owner();let controller=v["publicKeyHex"].as_str().map(|h|PublicKey::from_slice(&bytes(h)).unwrap());
    let dependencies=|vin:usize,is_lp:bool|{
        let point=&current.inputs[vin].previous_output;let parent=&raws[&point.txid.to_string()];
        let ids:BTreeSet<_>=if is_lp{amm_lp_proof::inspect_parent(&parent.serialize(),point,None).unwrap().dependencies().iter().map(|p|p.txid.to_string()).collect()}
            else{tbc20_material::inspect_parent(&parent.serialize(),point,None).unwrap().dependencies().iter().map(|d|d.outpoint.txid.to_string()).collect()};
        ids.into_iter().map(|id|&raws[&id]).collect::<Vec<_>>()
    };
    let pp=&current.inputs[2].previous_output;let pool_ancestors=dependencies(2,false);
    let pool_ft=AssetInput{parent:&raws[&pp.txid.to_string()],vout:pp.vout,ancestors:&pool_ancestors,public_key:&key};
    let user_ancestors=if action=="buy"{vec![]}else{dependencies(1,action=="remove")};
    let up=&current.inputs[1].previous_output;
    let user=AssetInput{parent:&raws[&up.txid.to_string()],vout:up.vout,ancestors:&user_ancestors,public_key:&key};
    let fp=&current.inputs[if action=="buy"{1}else{3}].previous_output;
    let mut funding_parent=raws[&fp.txid.to_string()].clone();
    if let Some(value)=funding_value{funding_parent.outputs[fp.vout as usize].satoshis=value;}
    let action=match action{
        "add"=>Action::Add{budget:AddBudget::Tbc{amount:100000,first_ft:Some(200000)},min_lp:0,max_ft:None,max_tbc:None,lp_lock_time:locked.then_some(829999)},
        "buy"=>Action::Buy{input_tbc:10000,min_ft:0},"sell"=>Action::Sell{input_ft:1000,min_tbc:0},
        "remove"=>Action::Remove{burn:10000,min_ft:0,min_tbc:0,lock_time:None},_=>panic!(),
    };
    let mut options=Options{config:&config,pool:&snapshot,pool_ancestor:ancestor,pool_ft:&pool_ft,user_asset:(!matches!(action,Action::Buy{..})).then_some(&user),
        funding:Funding{parent:&funding_parent,vout:fp.vout,public_key:&key},controller_public_key:controller.as_ref(),expected_snapshot_hash:Some(*snapshot.snapshot_hash()),
        action,receiver_hash:key.hash160(),change_hash:key.hash160(),fee_policy:MinerFeePolicy::default(),max_fee:10000};
    modify(&mut options);build_plan(options)
}
fn pushes(script:&[u8])->Vec<Vec<u8>>{
    let mut fields=Vec::new();let mut i=0;
    while i<script.len(){let op=script[i];i+=1;match op{0=>fields.push(vec![]),0x4f=>fields.push(vec![0x81]),0x51..=0x60=>fields.push(vec![op-0x50]),_=>{
        let size=match op{1..=75=>op as usize,0x4c=>{let n=script[i] as usize;i+=1;n},0x4d=>{let n=u16::from_le_bytes(script[i..i+2].try_into().unwrap()) as usize;i+=2;n},0x4e=>{let n=u32::from_le_bytes(script[i..i+4].try_into().unwrap()) as usize;i+=4;n},_=>panic!("not push")};fields.push(script[i..i+size].to_vec());i+=size;
    }}}fields
}
#[test]
fn sixteen_business_builders_generate_sdk_outputs_fees_and_signed_raw_without_keys(){
    let f=fixture();
    for label in ["public-plain","public-locked","controller-plain","controller-locked"]{
        for action in ["add","buy","sell","remove"]{
            let built=run(&f,label,action,|_|{}).unwrap_or_else(|e|panic!("{label}-{action}: {e:?}"));let v=row(&f,label,action);
            let expected=Transaction::from_hex(f["raws"][v["signedTxid"].as_str().unwrap()].as_str().unwrap()).unwrap();
            let p=&built.funded.unsigned_plan;let planned=&p.transactions[0];
            assert_eq!(planned.outputs.len(),expected.outputs.len(),"{label}-{action}");assert_eq!(planned.lock_time,expected.lock_time);
            for(a,b)in planned.outputs.iter().zip(&expected.outputs){assert_eq!(a.satoshis,b.satoshis,"{label}-{action}");assert_eq!(a.locking_script,hex(b.script_pubkey.as_bytes()),"{label}-{action}");}
            let expected_fee=expected.inputs.iter().map(|i|{let parent=Transaction::from_hex(f["raws"][i.previous_output.txid.to_string()].as_str().unwrap()).unwrap();parent.outputs[i.previous_output.vout as usize].satoshis}).sum::<u64>()-expected.outputs.iter().map(|o|o.satoshis).sum::<u64>();
            assert_eq!(built.funded.fee,expected_fee);assert!(expected.serialize().len()<=built.funded.maximum_signed_bytes);
            assert_eq!(p.evidence_table.iter().map(|e|&e.txid).collect::<BTreeSet<_>>().len(),p.evidence_table.len(),"raw evidence deduplicated");
            let stage=begin_signing(p).unwrap();let sigs:Vec<_>=stage.signing_requests.iter().map(|r|{
                let fields=pushes(expected.inputs[r.input_index as usize].script_sig.as_bytes());let signature=&fields[if fields.len()==123{98}else{0}];assert_eq!(signature.last(),Some(&0x41));
                ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),input_index:r.input_index,
                    digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&signature[..signature.len()-1])}
            }).collect();
            let StageOutcome::Complete(bundle)=finalize_signing_stage(p,stage,&sigs).unwrap()else{panic!("single local operation")};
            assert_eq!(bundle.transactions[0].raw_transaction,expected.to_hex(),"{label}-{action}");assert_eq!(bundle.transactions[0].txid,expected.txid().to_string());
        }
    }
}
#[test]
fn business_limits_snapshot_controller_and_fee_caps_fail_before_any_external_signing(){
    let f=fixture();
    for label in ["public-plain","controller-locked"]{
        for action in ["add","buy","sell","remove"]{
            assert!(run(&f,label,action,|o|o.expected_snapshot_hash=Some([0;32])).is_err());
            assert_eq!(run(&f,label,action,|o|o.max_fee=1).unwrap_err().code,ErrorCode::FeeCapExceeded);
            assert!(run(&f,label,action,|o|o.controller_public_key=if label.starts_with("public"){Some(o.funding.public_key)}else{None}).is_err());
            assert!(run(&f,label,action,|o|o.funding.vout=u32::MAX).is_err());
        }
        assert!(run(&f,label,"add",|o|if let Action::Add{ref mut min_lp,..}=o.action{*min_lp=100001}).is_err());
        assert!(run(&f,label,"add",|o|if let Action::Add{ref mut max_ft,..}=o.action{*max_ft=Some(199999)}).is_err());
        assert!(run(&f,label,"add",|o|if let Action::Add{ref mut max_tbc,..}=o.action{*max_tbc=Some(99999)}).is_err());
        assert!(run(&f,label,"buy",|o|o.action=Action::Buy{input_tbc:10000,min_ft:200000}).is_err());
        assert!(run(&f,label,"sell",|o|o.action=Action::Sell{input_ft:1000,min_tbc:100000}).is_err());
        assert!(run(&f,label,"remove",|o|o.action=Action::Remove{burn:10000,min_ft:200000,min_tbc:0,lock_time:None}).is_err());
    }
    assert!(run(&f,"public-locked","remove",|o|if let Action::Remove{ref mut lock_time,..}=o.action{*lock_time=Some(829998)}).is_err());
    assert!(run(&f,"public-locked","add",|o|if let Action::Add{ref mut lp_lock_time,..}=o.action{*lp_lock_time=None}).is_err());
    assert!(run(&f,"public-plain","add",|o|if let Action::Add{ref mut lp_lock_time,..}=o.action{*lp_lock_time=Some(1)}).is_err());
}
#[test]
fn optional_asset_and_native_change_keep_correct_groups_and_fee_reservation(){
    let f=fixture();
    for label in ["public-plain","controller-locked"]{
        for action in ["add","buy","sell","remove"]{
            let normal=run(&f,label,action,|_|{}).unwrap();let p=&normal.funded.unsigned_plan.transactions[0];
            let fee_input=if action=="buy"{1}else{3};let old_change=p.outputs.last().unwrap().satoshis;
            let exact_funding=p.inputs[fee_input].previous_output_satoshis-old_change+10;
            let dust=run_with_funding(&f,label,action,Some(exact_funding),|_|{}).unwrap();
            assert_eq!(dust.funded.unsigned_plan.transactions[0].outputs.last().unwrap().satoshis,10);
            assert_eq!(dust.funded.fee,normal.funded.fee);
            let no_change=run_with_funding(&f,label,action,Some(exact_funding-1),|_|{}).unwrap();
            assert_eq!(no_change.funded.change_output_index,None);assert_eq!(no_change.funded.fee,normal.funded.fee+9);
            assert_eq!(no_change.funded.unsigned_plan.transactions[0].outputs.len()+1,p.outputs.len());
            assert!(begin_signing(&no_change.funded.unsigned_plan).is_ok());
        }
        let add=run(&f,label,"add",|o|{
            let u=o.user_asset.unwrap();let balance=o.config.validate_ft(u.parent,u.vout as usize,u.public_key,None).unwrap().balance as u64;
            if let Action::Add{ref mut budget,..}=o.action{*budget=AddBudget::Tbc{amount:100000,first_ft:Some(balance)};}
        }).unwrap();
        assert_eq!(add.funded.unsigned_plan.transactions[0].outputs.len(),7,"No FT change pair when all selected FT enters Pool");
        assert!(begin_signing(&add.funded.unsigned_plan).is_ok());
        let remove=run(&f,label,"remove",|o|o.action=Action::Remove{burn:o.pool.math().ft_lp_amount,min_ft:0,min_tbc:0,lock_time:None}).unwrap();
        assert_eq!(remove.funded.unsigned_plan.transactions[0].outputs.len(),10,"No LP change pair on full burn");
        assert_eq!(remove.quote.next_state().ft_lp_amount,0);assert_eq!(remove.quote.next_state().pool_value,1500);
        assert!(begin_signing(&remove.funded.unsigned_plan).is_ok());
    }
}
