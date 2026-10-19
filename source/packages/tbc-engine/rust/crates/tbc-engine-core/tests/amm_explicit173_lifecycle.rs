//! Rust builds/signature-finalizes independently of the npm oracle. Exact bytes
//! match fixtures already checked by tbc-lib-js's script VM; no real chain I/O.
use std::collections::{BTreeMap,BTreeSet};
use serde_json::Value;
use tbc_sdk::{Transaction,PublicKey,hash,script::Script};
use tbc_engine_core::{protocols::{amm_profile::{self,Profile},amm_state::PoolConfig,amm_code::Authorization,
    amm_mint::{self,MintOptions},amm_transaction::MinerFeePolicy,amm_business::{self,Action},amm_math::AddBudget,
    amm_material,amm_lp_proof,tbc20_material},signing::*};
fn bytes(s:&str)->Vec<u8>{(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hex(b:&[u8])->String{b.iter().map(|v|format!("{v:02x}")).collect()}
fn fixture()->Value{serde_json::from_str(include_str!("../../../fixtures/amm-explicit173-lifecycle.json")).unwrap()}
fn key(controlled:bool)->PublicKey{PublicKey::from_slice(&bytes(if controlled{"02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"}else{"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"})).unwrap()}
fn configuration(row:&Value,ft:&Transaction)->PoolConfig{
    let auth=if row["controlled"].as_bool().unwrap(){Authorization::Controller(vec![key(true).hash160()])}else{Authorization::Public};
    let profile=Profile::explicit(serde_json::from_value(row["rates"].clone()).unwrap(),row["feeAddress"].as_str().unwrap(),bytes(row["serviceProviderTag"].as_str().unwrap())).unwrap();
    PoolConfig::with_profile(ft,&ft.txid(),auth,row["locked"].as_bool().unwrap(),profile).unwrap()
}
fn pushes(script:&[u8])->Vec<Vec<u8>>{
    let mut result=vec![];let mut i=0;
    while i<script.len(){let op=script[i];i+=1;match op {
        0=>result.push(vec![]),0x4f=>result.push(vec![0x81]),0x51..=0x60=>result.push(vec![op-0x50]),
        _=>{let size=match op{1..=75=>op as usize,0x4c=>{let n=script[i] as usize;i+=1;n},0x4d=>{let n=u16::from_le_bytes(script[i..i+2].try_into().unwrap()) as usize;i+=2;n},0x4e=>{let n=u32::from_le_bytes(script[i..i+4].try_into().unwrap()) as usize;i+=4;n},_=>panic!("not push")};result.push(script[i..i+size].to_vec());i+=size;}
    }}result
}
fn signatures(stage:&SigningStage,expected:&Transaction)->Vec<ExternalSignature>{
    stage.signing_requests.iter().map(|r|{
        let fields=pushes(expected.inputs[r.input_index as usize].script_sig.as_bytes());
        let sig=&fields[if fields.len()==123{98}else{0}];assert_eq!(sig.last(),Some(&0x41));
        ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),
            transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&sig[..sig.len()-1])}
    }).collect()
}
#[test]
fn explicit_funded_genesis_and_32_business_plans_match_sdk_signed_bytes_and_fees(){
    let f=fixture();assert_eq!(f["vmInputs"],152);
    let history:BTreeMap<_,_>=f["raws"].as_object().unwrap().iter().map(|(id,raw)|(id.clone(),Transaction::from_hex(raw.as_str().unwrap()).unwrap())).collect();
    let owner=key(false);let controller=key(true);
    for row in f["cases"].as_array().unwrap(){
        let label=row["label"].as_str().unwrap();let ft=&history[row["ftGenesisId"].as_str().unwrap()];let config=configuration(row,ft);
        let source=&history[row["sourceId"].as_str().unwrap()];let genesis=&history[row["genesisId"].as_str().unwrap()];
        let mint=amm_mint::build_funded_mint_plan(MintOptions{config:&config,funding_parent:ft,funding_vout:row["fundingVout"].as_u64().unwrap() as u32,
            funding_public_key:&owner,change_hash:owner.hash160(),fee_policy:MinerFeePolicy::default(),max_fee:10000}).unwrap();
        assert_eq!(mint.fees,[row["sourceFee"].as_str().unwrap().parse::<u64>().unwrap(),row["genesisFee"].as_str().unwrap().parse::<u64>().unwrap()]);
        let stage=begin_signing(&mint.unsigned_plan).unwrap();let sigs=signatures(&stage,source);
        let StageOutcome::Pending(stage)=finalize_signing_stage(&mint.unsigned_plan,stage,&sigs).unwrap()else{panic!("deferred source")};
        let sigs=signatures(&stage,genesis);
        let StageOutcome::Complete(bundle)=finalize_signing_stage(&mint.unsigned_plan,stage,&sigs).unwrap()else{panic!("genesis complete")};
        assert_eq!(bundle.transactions[0].raw_transaction,source.to_hex(),"{label} source");
        assert_eq!(bundle.transactions[1].raw_transaction,genesis.to_hex(),"{label} genesis");
        let bound=amm_material::bind_genesis(genesis,ft,&owner).unwrap();assert_eq!(bound.config.profile(),config.profile());
        for action in row["actions"].as_array().unwrap(){
            let op=action["operation"].as_str().unwrap();let expected=&history[action["txid"].as_str().unwrap()];
            let parent=&history[&expected.inputs[0].previous_output.txid.to_string()];let ancestor=&history[&parent.inputs[0].previous_output.txid.to_string()];
            let snapshot=config.read_pool(parent,&bound.code_hash).unwrap();
            let dependencies=|vin:usize,is_lp:bool|{
                let point=&expected.inputs[vin].previous_output;let tx=&history[&point.txid.to_string()];
                let ids:BTreeSet<_>=if is_lp{amm_lp_proof::inspect_parent(&tx.serialize(),point,None).unwrap().dependencies().iter().map(|p|p.txid.to_string()).collect()}
                    else{tbc20_material::inspect_parent(&tx.serialize(),point,None).unwrap().dependencies().iter().map(|p|p.outpoint.txid.to_string()).collect()};
                ids.into_iter().map(|id|&history[&id]).collect::<Vec<_>>()
            };
            let pool_ancestors=dependencies(2,false);let pp=&expected.inputs[2].previous_output;
            let pool_ft=amm_business::AssetInput{parent:&history[&pp.txid.to_string()],vout:pp.vout,ancestors:&pool_ancestors,public_key:&owner};
            let user_ancestors=if op=="buy"{vec![]}else{dependencies(1,op=="remove")};let up=&expected.inputs[1].previous_output;
            let user=amm_business::AssetInput{parent:&history[&up.txid.to_string()],vout:up.vout,ancestors:&user_ancestors,public_key:&owner};
            let fp=&expected.inputs[if op=="buy"{1}else{3}].previous_output;
            let action_kind=match op {
                "add"=>Action::Add{budget:AddBudget::Tbc{amount:100000,first_ft:Some(200000)},min_lp:0,max_ft:None,max_tbc:None,lp_lock_time:config.timelocked().then_some(829999)},
                "buy"=>Action::Buy{input_tbc:10000,min_ft:1},"sell"=>Action::Sell{input_ft:1000,min_tbc:1},
                "remove"=>Action::Remove{burn:10000,min_ft:0,min_tbc:0,lock_time:None},_=>panic!(),
            };
            let built=amm_business::build_plan(amm_business::Options{config:&config,pool:&snapshot,pool_ancestor:ancestor,pool_ft:&pool_ft,
                user_asset:(op!="buy").then_some(&user),funding:amm_business::Funding{parent:&history[&fp.txid.to_string()],vout:fp.vout,public_key:&owner},
                controller_public_key:row["controlled"].as_bool().unwrap().then_some(&controller),expected_snapshot_hash:Some(*snapshot.snapshot_hash()),
                action:action_kind,receiver_hash:owner.hash160(),change_hash:owner.hash160(),fee_policy:MinerFeePolicy::default(),max_fee:10000}).unwrap_or_else(|e|panic!("{label}-{op}: {e:?}"));
            assert_eq!(built.funded.fee,action["fee"].as_str().unwrap().parse::<u64>().unwrap(),"{label}-{op}");
            let plan=&built.funded.unsigned_plan;assert_eq!(plan.evidence_table.len(),plan.evidence_table.iter().map(|e|&e.txid).collect::<BTreeSet<_>>().len());
            let stage=begin_signing(plan).unwrap();let sigs=signatures(&stage,expected);
            let StageOutcome::Complete(bundle)=finalize_signing_stage(plan,stage,&sigs).unwrap()else{panic!("single operation")};
            assert_eq!(bundle.transactions[0].raw_transaction,expected.to_hex(),"{label}-{op}");
            assert_eq!(bundle.transactions[0].txid,expected.txid().to_string());
            assert!(expected.serialize().len()<=built.funded.maximum_signed_bytes);
        }
    }
}
#[test]
fn bound_explicit_profiles_reject_replaced_rates_recipients_tags_and_cross_format(){
    let f=fixture();let row=&f["cases"][0];let ft=Transaction::from_hex(f["raws"][row["ftGenesisId"].as_str().unwrap()].as_str().unwrap()).unwrap();
    let genesis=Transaction::from_hex(f["raws"][row["genesisId"].as_str().unwrap()].as_str().unwrap()).unwrap();
    let config=configuration(row,&ft);let pool_hash=hash::sha256(genesis.outputs[0].script_pubkey.as_bytes());
    for index in [128,130,132,134,136,155,156,157,158]{
        let mut changed=genesis.clone();let mut tape=changed.outputs[1].script_pubkey.as_bytes().to_vec();tape[index]^=1;
        changed.outputs[1].script_pubkey=Script::from_bytes(tape);assert!(config.read_pool(&changed,&pool_hash).is_err(),"Tape {index}");
    }
    let mut changed=genesis.clone();let mut code=amm_profile::Code::decode(changed.outputs[0].script_pubkey.as_bytes()).unwrap();
    code.service_provider_tag=Some(b"different".to_vec());changed.outputs[0].script_pubkey=Script::from_bytes(code.encode().unwrap());
    assert!(config.read_pool(&changed,&hash::sha256(changed.outputs[0].script_pubkey.as_bytes())).is_err());
    code.service_provider_tag=None;changed.outputs[0].script_pubkey=Script::from_bytes(code.encode().unwrap());
    assert!(amm_material::inspect_pool(&changed).is_err(),"old Code cannot authenticate new Tape");
    let tape=amm_profile::Tape::decode(genesis.outputs[1].script_pubkey.as_bytes()).unwrap();
    assert!(Profile::from_parts(&code,&tape).is_err());
}
