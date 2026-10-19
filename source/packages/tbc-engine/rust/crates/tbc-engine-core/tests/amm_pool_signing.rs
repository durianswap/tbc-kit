//! Full Pool/FT/LP/funding signing via shared recipes; SDK fixes outputs and
//! external signatures here. This is not yet the Rust business-output builder.
use serde_json::Value;
use std::collections::{BTreeMap,BTreeSet};
use tbc_engine_core::{protocols::{amm_lp_proof,amm_pool_proof::{Operation,output_layout},tbc20,tbc20_material},signing::*};
use tbc_sdk::{PublicKey,Transaction};
fn fixture()->Value{serde_json::from_str(include_str!("../../../fixtures/amm-pool-proof.json")).unwrap()}
fn bytes(s:&str)->Vec<u8>{(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hex(b:&[u8])->String{b.iter().map(|b|format!("{b:02x}")).collect()}
fn tx(f:&Value,id:&str)->Transaction{Transaction::from_hex(f["raws"][id].as_str().unwrap()).unwrap()}
fn row<'a>(f:&'a Value,id:&str)->&'a Value{f["vectors"].as_array().unwrap().iter().find(|v|v["id"]==id).unwrap()}
fn op(v:&Value)->Operation{match v["operation"].as_u64().unwrap(){1=>Operation::AddLp,2=>Operation::RemoveLp,3=>Operation::BuyFt,4=>Operation::SellFt,_=>panic!()}}
fn context(key:&PublicKey)->PublicSigningContext{PublicSigningContext{address:key.address().to_string(),public_key:hex(&key.to_bytes()),public_key_hash:hex(&key.hash160())}}
fn owner()->PublicKey{PublicKey::from_slice(&bytes("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")).unwrap()}
fn source(f:&Value,id:&str,done:&BTreeMap<String,String>,evidence:&mut Vec<EvidenceEntry>)->TransactionSource{
    if let Some(planned)=done.get(id){return TransactionSource::Planned(planned.clone());}
    let i=evidence.iter().position(|e|e.txid==id).unwrap_or_else(||{evidence.push(EvidenceEntry{txid:id.into(),raw_transaction:f["raws"][id].as_str().unwrap().into()});evidence.len()-1});
    TransactionSource::Evidence(i as u32)
}
fn plan(f:&Value,label:&str)->UnsignedPlan{
    let mut done=BTreeMap::<String,String>::new();let mut evidence=Vec::new();let mut transactions=Vec::new();let key=owner();
    for (stage,action) in ["add","buy","sell","remove"].iter().enumerate(){
        let v=row(f,&format!("{label}-{action}"));let current=Transaction::from_hex(v["currentRaw"].as_str().unwrap()).unwrap();
        let layout=output_layout(op(v),current.outputs.len()).unwrap();
        let pairs:BTreeSet<_>=[Some(0),Some(layout.pool_ft),layout.user_ft,layout.lp,layout.lp_burn,layout.ft_change,layout.lp_change].into_iter().flatten().collect();
        let mut groups=Vec::new();let mut index=0;
        while index<current.outputs.len(){let pair=pairs.contains(&index);groups.push(Tbc20OutputGroup{code_vout:index as u32,tape_vout:pair.then_some(index as u32+1)});index+=if pair{2}else{1};}
        let mut depends=Vec::new();
        let inputs=current.inputs.iter().enumerate().map(|(vin,input)|{
            let parent_id=input.previous_output.txid.to_string();let parent=tx(f,&parent_id);let previous=&parent.outputs[input.previous_output.vout as usize];
            if let Some(id)=done.get(&parent_id){if !depends.contains(id){depends.push(id.clone());}}
            let signer=if vin==0 {v["publicKeyHex"].as_str().map(|h|PublicKey::from_slice(&bytes(h)).unwrap()).unwrap_or_else(owner)}else{key.clone()};
            let unlocking_script=if vin==0{
                amm_pool_unlocking_descriptor(AmmPoolUnlockRecipe{
                    parent:source(f,&parent_id,&done,&mut evidence),ancestor:source(f,v["ancestorTxid"].as_str().unwrap(),&done,&mut evidence),
                    auxiliary_parents:v["auxiliaryTxids"].as_array().unwrap().iter().map(|id|source(f,id.as_str().unwrap(),&done,&mut evidence)).collect(),
                    operation:v["operation"].as_u64().unwrap() as u8,pool_code_hash:v["poolHash"].as_str().unwrap().into(),
                }).unwrap()
            }else if previous.satoshis==500{
                let is_ft=tbc20::parse_code(previous.script_pubkey.as_bytes()).is_ok();
                let (points,controlled)=if is_ft{
                    let material=tbc20_material::inspect_parent(&parent.serialize(),&input.previous_output,None).unwrap();
                    (material.dependencies().iter().map(|d|d.outpoint.clone()).collect::<Vec<_>>(),material.code().controller[20]==1)
                }else{let material=amm_lp_proof::inspect_parent(&parent.serialize(),&input.previous_output,None).unwrap();(material.dependencies().to_vec(),material.code().controller[20]==1)};
                let recipe=Tbc20UnlockRecipe{parent:source(f,&parent_id,&done,&mut evidence),
                    proof_references:points.iter().map(|p|ProofReference{source:source(f,&p.txid.to_string(),&done,&mut evidence),output_index:p.vout}).collect(),
                    output_groups:groups.clone(),contract_controller:controlled.then(||Tbc20ContractControllerReference{
                        source:source(f,v["parentTxid"].as_str().unwrap(),&done,&mut evidence),current_input_index:0})};
                if is_ft{tbc20_unlocking_descriptor(recipe)}else{amm_lp_unlocking_descriptor(recipe)}.unwrap()
            }else{String::new()};
            PlannedInput{previous_transaction_id:done.get(&parent_id).cloned().unwrap_or(parent_id),previous_output_index:input.previous_output.vout,
                previous_output_script:hex(previous.script_pubkey.as_bytes()),previous_output_satoshis:previous.satoshis,sequence:input.sequence,
                unlocking_script,signer:context(&signer)}
        }).collect();
        let id=format!("amm-{stage}");transactions.push(PlannedTransaction{transaction_id:id.clone(),stage:stage as u32,role:format!("tbc-amm-{action}"),
            depends_on:depends,version:current.version,lock_time:current.lock_time,inputs,
            outputs:current.outputs.iter().map(|o|PlannedOutput{satoshis:o.satoshis,locking_script:hex(o.script_pubkey.as_bytes())}).collect()});
        done.insert(v["signedTxid"].as_str().unwrap().into(),id);
    }
    UnsignedPlan{transactions,evidence_table:evidence}
}
fn pushes(script:&[u8])->Vec<Vec<u8>>{
    let mut fields=Vec::new();let mut i=0;
    while i<script.len(){let op=script[i];i+=1;
        match op{0=>fields.push(vec![]),0x4f=>fields.push(vec![0x81]),0x51..=0x60=>fields.push(vec![op-0x50]),_=>{
            let size=match op{1..=75=>op as usize,0x4c=>{let n=script[i] as usize;i+=1;n},0x4d=>{let n=u16::from_le_bytes(script[i..i+2].try_into().unwrap()) as usize;i+=2;n},0x4e=>{let n=u32::from_le_bytes(script[i..i+4].try_into().unwrap()) as usize;i+=4;n},_=>panic!("not a push")};
            fields.push(script[i..i+size].to_vec());i+=size;
        }}
    }fields
}
fn signatures(f:&Value,label:&str,stage:&SigningStage)->Vec<ExternalSignature>{
    let action=["add","buy","sell","remove"][stage.stage as usize];let v=row(f,&format!("{label}-{action}"));let signed=tx(f,v["signedTxid"].as_str().unwrap());
    stage.signing_requests.iter().map(|r|{
        let fields=pushes(signed.inputs[r.input_index as usize].script_sig.as_bytes());
        let signature=if r.input_index==0{assert_eq!(r.script_class,"tbc-amm");assert_eq!(r.digest,v["digestHex"].as_str().unwrap());&fields[0]}
            else if fields.len()==123{assert!(matches!(r.script_class.as_str(),"tbc20-standard"|"tbc20-lp"));&fields[98]}else{assert_eq!(r.script_class,"p2pkh");&fields[0]};
        assert_eq!(signature.last(),Some(&0x41));
        ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),
            input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&signature[..signature.len()-1])}
    }).collect()
}
fn recipe(input:&PlannedInput)->AmmPoolUnlockRecipe{serde_json::from_slice(&bytes(input.unlocking_script.strip_prefix("tbc-amm-unlock:").unwrap())).unwrap()}

#[test]
fn sixteen_complete_transactions_use_only_shared_new_pool_ft_lp_and_funding_recipes(){
    let f=fixture();
    for label in ["public-plain","public-locked","controller-plain","controller-locked"]{
        let p=plan(&f,label);assert_eq!(p.evidence_table.len(),3,"Only Pool genesis, FT genesis and FT source; children are Planned");
        let mut stage=begin_signing(&p).unwrap();let mut complete=false;
        for(i,action)in ["add","buy","sell","remove"].iter().enumerate(){
            assert_eq!(stage.signing_requests.len(),[3,2,3,3][i]+usize::from(label.starts_with("controller")));
            assert_eq!(stage.signing_requests.iter().any(|r|r.input_index==0),label.starts_with("controller"));
            let sigs=signatures(&f,label,&stage);
            match finalize_signing_stage(&p,stage,&sigs).unwrap(){
                StageOutcome::Pending(next)=>{assert_ne!(*action,"remove");stage=next;},
                StageOutcome::Complete(bundle)=>{assert_eq!(i,3);assert_eq!(bundle.transactions.len(),4);
                    for(j,record)in bundle.transactions.iter().enumerate(){let v=row(&f,&format!("{label}-{}",["add","buy","sell","remove"][j]));
                        assert_eq!(record.txid,v["signedTxid"].as_str().unwrap());assert_eq!(record.raw_transaction,f["raws"][record.txid.as_str()].as_str().unwrap());}
                    complete=true;break;}
            }
        }assert!(complete);
    }
}
#[test]
fn pool_recipe_rejects_bad_material_role_counts_and_forward_sources(){
    let f=fixture();
    for label in ["public-plain","controller-locked"]{
        for mutation in 0..8{
            let mut p=plan(&f,label);let input=&mut p.transactions[0].inputs[0];let mut r=recipe(input);
            match mutation{0=>r.pool_code_hash="00".repeat(32),1=>r.parent=TransactionSource::Planned("amm-1".into()),
                2=>r.ancestor=r.parent.clone(),3=>r.auxiliary_parents[0]=r.parent.clone(),4=>r.operation=3,
                5=>input.previous_output_satoshis+=1,6=>input.previous_output_script="51".into(),_=>r.auxiliary_parents.clear()}
            match amm_pool_unlocking_descriptor(r){Err(_)=>assert!(mutation==4||mutation==7),Ok(encoded)=>{input.unlocking_script=encoded;assert!(begin_signing(&p).is_err(),"{label} mutation {mutation}");}}
        }
    }
    let mut p=plan(&f,"controller-plain");p.transactions[0].inputs[0].signer=context(&owner());assert!(begin_signing(&p).is_err());
}
#[test]
fn public_and_controlled_continuations_cannot_replace_finalized_pool_script(){
    let f=fixture();
    for label in ["public-plain","controller-locked"]{
        let p=plan(&f,label);let stage=begin_signing(&p).unwrap();let sigs=signatures(&f,label,&stage);
        let StageOutcome::Pending(mut next)=finalize_signing_stage(&p,stage,&sigs).unwrap()else{panic!("child")};
        let sigs=signatures(&f,label,&next);let record=next.continuation.finalized_transactions[0].as_mut().unwrap();
        let mut transaction=Transaction::from_hex(&record.raw_transaction).unwrap();transaction.inputs[0].script_sig=tbc_sdk::script::Script::from_bytes(vec![0]);
        record.raw_transaction=transaction.to_hex();record.txid=transaction.txid().to_string();
        assert!(finalize_signing_stage(&p,next,&sigs).is_err());
    }
}
