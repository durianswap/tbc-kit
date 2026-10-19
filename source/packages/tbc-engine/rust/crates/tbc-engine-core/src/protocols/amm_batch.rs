//! Owner-only FT/LP maintenance before a fixed-snapshot AMM operation. No Pool
//! reserve consolidation: Pool3 requires its one exact state-matching FT input.
use std::collections::{BTreeMap,BTreeSet};
use tbc_sdk::{Transaction,TxIn,TxOut,OutPoint,script::Script};
use crate::{EngineError,ErrorCode,signing::{UnsignedPlan,bind_funding_recipe,remap_fungible_evidence}};
use super::{amm_business::{self,AssetInput,Options,Action,Quote,Funding},amm_lp_proof,amm_lp_transfer,amm_lp_batch,
    tbc20_material,tbc20_transfer,tbc20_batch};

pub struct BatchOptions<'a>{pub business:Options<'a>,pub user_inputs:&'a [AssetInput<'a>],pub max_transactions:usize}
pub struct BatchPlan{pub unsigned_plan:UnsignedPlan,pub fees:Vec<u64>,pub quote:Quote}
fn invalid(s:&str)->EngineError{EngineError{code:ErrorCode::InvalidPlan,message:s.into(),path:None}}
fn insufficient(s:&str)->EngineError{EngineError{code:ErrorCode::InsufficientFunds,message:s.into(),path:None}}
fn bytes(s:&str)->Result<Vec<u8>,EngineError>{
    if !s.is_ascii()||s.len()%2!=0{return Err(invalid("invalid maintenance hex"));}
    (0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).map_err(|_|invalid("invalid maintenance hex"))).collect()
}
/// Real local preview hashes, not zero placeholders. These never leave Engine
/// as signed artifacts and all references are rebound to typed Planned sources.
fn previews(plan:&UnsignedPlan)->Result<Vec<Transaction>,EngineError>{
    let mut ids=BTreeMap::new();let mut result=vec![];
    for p in &plan.transactions{
        let mut tx=Transaction::new();tx.version=p.version;tx.lock_time=p.lock_time;
        for i in &p.inputs{
            let txid=ids.get(&i.previous_transaction_id).cloned().unwrap_or_else(||i.previous_transaction_id.clone());
            let mut input=TxIn::new(OutPoint{txid:txid.parse().map_err(|_|invalid("missing earlier maintenance input"))?,vout:i.previous_output_index});input.sequence=i.sequence;tx.inputs.push(input);
        }
        for o in &p.outputs{tx.outputs.push(TxOut{satoshis:o.satoshis,script_pubkey:Script::from_bytes(bytes(&o.locking_script)?)});}
        ids.insert(p.transaction_id.clone(),tx.txid().to_string());result.push(tx);
    }Ok(result)
}
fn append_business(prior:&mut UnsignedPlan,mut business:UnsignedPlan,previews:&[Transaction])->Result<(),EngineError>{
    if business.transactions.len()!=1||prior.transactions.len()!=previews.len(){return Err(invalid("AMM maintenance shape invalid"));}
    let known:BTreeMap<_,_>=previews.iter().zip(&prior.transactions).map(|(tx,p)|(tx.txid().to_string(),(tx,p.transaction_id.clone(),p.stage))).collect();
    let mut indices:BTreeMap<_,_>=prior.evidence_table.iter().enumerate().map(|(i,e)|(e.txid.clone(),i as u32)).collect();let mut remap=BTreeMap::new();
    for(i,e)in business.evidence_table.iter().enumerate(){
        if let Some((tx,_,_))=known.get(&e.txid){if tx.to_hex()!=e.raw_transaction{return Err(invalid("maintenance preview evidence conflict"));}continue;}
        let index=if let Some(&i)=indices.get(&e.txid){if prior.evidence_table[i as usize]!=*e{return Err(invalid("AMM immutable evidence conflict"));}i}
            else{let i=prior.evidence_table.len()as u32;prior.evidence_table.push(e.clone());indices.insert(e.txid.clone(),i);i};remap.insert(i as u32,index);
    }
    let next=&mut business.transactions[0];next.depends_on.clear();next.stage=0;
    for input in &mut next.inputs{
        if let Some((_,id,stage))=known.get(&input.previous_transaction_id){input.previous_transaction_id=id.clone();if !next.depends_on.contains(id){next.depends_on.push(id.clone());}next.stage=next.stage.max(stage+1);}
        if input.unlocking_script.is_empty(){continue;}
        for(txid,(tx,id,_))in &known{
            let indices:Vec<_>=business.evidence_table.iter().enumerate().filter(|(_,e)|&e.txid==txid).map(|(i,_)|i as u32).collect();
            input.unlocking_script=bind_funding_recipe(&input.unlocking_script,&tx.to_hex(),&indices,id)?;
        }
        input.unlocking_script=remap_fungible_evidence(&input.unlocking_script,&remap)?;
    }
    next.role="primary".into();prior.transactions.push(business.transactions.remove(0));Ok(())
}
pub fn build_batch_plan(options:BatchOptions<'_>)->Result<BatchPlan,EngineError>{
    let mut o=options.business;let users=options.user_inputs;
    if options.max_transactions==0||users.len()>128||matches!(o.action,Action::Buy{..})!=users.is_empty(){return Err(invalid("AMM holder material or bundle bound invalid"));}
    if users.len()<=1{
        o.user_asset=users.first();let b=amm_business::build_plan(o)?;
        return Ok(BatchPlan{unsigned_plan:b.funded.unsigned_plan,fees:vec![b.funded.fee],quote:b.quote});
    }
    if options.max_transactions<2{return Err(invalid("AMM maintenance exceeds bundle limit"));}
    let lp=matches!(o.action,Action::Remove{..});let key=users[0].public_key;
    if users.iter().any(|u|u.public_key!=key)||key.hash160()!=o.change_hash||o.funding.public_key.hash160()!=o.change_hash{return Err(invalid("AMM owner maintenance must preserve controlled outputs"));}
    let mut seen=BTreeSet::new();
    for point in users.iter().map(|u|(u.parent.txid().to_string(),u.vout)).chain([
        (o.pool.transaction().txid().to_string(),0),(o.pool_ft.parent.txid().to_string(),o.pool_ft.vout),(o.funding.parent.txid().to_string(),o.funding.vout)]){
        if !seen.insert(point){return Err(invalid("AMM maintenance repeats external input"));}
    }
    // Validate every fragment against the same authenticated Pool/FT profile.
    for u in users{if lp{o.config.validate_lp(u.parent,u.vout as usize,key,o.pool)?;}else{o.config.validate_ft(u.parent,u.vout as usize,key,None)?;}}
    let point=OutPoint{txid:o.funding.parent.txid(),vout:o.funding.vout};
    let fee=tbc20_transfer::FeeInput{outpoint:point,output:o.funding.parent.outputs.get(o.funding.vout as usize).ok_or_else(||invalid("AMM funding output absent"))?,public_key:o.funding.public_key};
    let mut owner=[0;21];owner[..20].copy_from_slice(&key.hash160());
    let raw_ancestors:Vec<Vec<_>>=users.iter().map(|u|u.ancestors.iter().map(|t|t.serialize()).collect()).collect();
    let refs:Vec<Vec<_>>=raw_ancestors.iter().map(|r|r.iter().map(Vec::as_slice).collect()).collect();
    let(mut plan,mut fees)=if lp{
        let parents:Vec<_>=users.iter().map(|u|amm_lp_proof::inspect_parent(&u.parent.serialize(),&OutPoint{txid:u.parent.txid(),vout:u.vout},None)).collect::<Result<_,_>>()?;
        let inputs:Vec<_>=parents.iter().zip(&refs).map(|(parent,raws)|amm_lp_transfer::LpInput{parent,ancestor_raws:raws,public_key:key}).collect();
        let b=amm_lp_batch::build_batch_plan(amm_lp_batch::BatchOptions{transfer:amm_lp_transfer::TransferOptions{inputs:&inputs,fee_input:&fee,expected_identity:parents[0].identity(),receiver_controller:owner,amount:1,lp_change_controller:Some(owner),native_change_hash:o.change_hash,lock_time:None,output_lock_time:None,fee_policy:o.fee_policy,max_fee:o.max_fee},max_transactions:options.max_transactions-1,operation:amm_lp_batch::Operation::Merge})?;
        (b.unsigned_plan,b.fees)
    }else{
        if o.fee_policy.satoshis_per_kb!=80||o.fee_policy.minimum_fee!=80||o.fee_policy.change_dust!=10{return Err(invalid("TBC20 maintenance requires canonical 80/kB dust10 fee policy"));}
        let parents:Vec<_>=users.iter().map(|u|tbc20_material::inspect_parent(&u.parent.serialize(),&OutPoint{txid:u.parent.txid(),vout:u.vout},None)).collect::<Result<_,_>>()?;
        let linked:Vec<_>=parents.iter().zip(&refs).map(|(parent,raws)|tbc20_material::link_ancestors(parent,raws)).collect::<Result<_,_>>()?;
        let inputs:Vec<_>=parents.iter().zip(&linked).map(|(parent,ancestors)|tbc20_transfer::TokenInput{parent,ancestors,public_key:key}).collect();
        let b=tbc20_batch::build_batch_merge_plan(tbc20_batch::BatchOptions{transfer:tbc20_transfer::TransferOptions{inputs:&inputs,fee_inputs:&[fee],receivers:&[],expected_identity:parents[0].identity(),token_change_controller:owner,native_change_hash:o.change_hash,max_fee:o.max_fee},max_transactions:options.max_transactions-1})?;
        (b.unsigned_plan,b.fees)
    };
    for p in &mut plan.transactions{p.role="maintenance".into();}
    let previews=previews(&plan)?;let last=previews.last().ok_or_else(||invalid("AMM maintenance is empty"))?;
    let point=OutPoint{txid:last.txid(),vout:0};
    let dependencies:BTreeSet<_>=if lp{amm_lp_proof::inspect_parent(&last.serialize(),&point,None)?.dependencies().iter().map(|p|p.txid.to_string()).collect()}
        else{tbc20_material::inspect_parent(&last.serialize(),&point,None)?.dependencies().iter().map(|d|d.outpoint.txid.to_string()).collect()};
    let known:BTreeMap<_,_>=users.iter().map(|u|u.parent).chain(previews.iter()).map(|t|(t.txid().to_string(),t)).collect();
    let ancestors:Vec<_>=dependencies.iter().map(|id|known.get(id).copied().ok_or_else(||invalid("AMM maintained asset direct ancestor missing"))).collect::<Result<_,_>>()?;
    let user=AssetInput{parent:last,vout:0,ancestors:&ancestors,public_key:key};
    let native:Vec<_>=last.outputs.iter().enumerate().filter(|(_,v)|v.script_pubkey==Script::p2pkh(&o.change_hash)).collect();
    if native.len()!=1{return Err(insufficient("AMM maintenance must retain native fee change"));}
    let used=fees.iter().try_fold(0u64,|sum,n|sum.checked_add(*n).ok_or_else(||invalid("AMM maintenance fee overflow")))?;
    let remaining=o.max_fee.checked_sub(used).ok_or_else(||invalid("AMM maintenance exceeds total fee cap"))?;
    let b=amm_business::build_plan(Options{config:o.config,pool:o.pool,pool_ancestor:o.pool_ancestor,pool_ft:o.pool_ft,user_asset:Some(&user),
        funding:Funding{parent:last,vout:native[0].0 as u32,public_key:o.funding.public_key},controller_public_key:o.controller_public_key,expected_snapshot_hash:o.expected_snapshot_hash,
        action:o.action,receiver_hash:o.receiver_hash,change_hash:o.change_hash,fee_policy:o.fee_policy,max_fee:remaining})?;
    append_business(&mut plan,b.funded.unsigned_plan,&previews)?;fees.push(b.funded.fee);
    Ok(BatchPlan{unsigned_plan:plan,fees,quote:b.quote})
}
