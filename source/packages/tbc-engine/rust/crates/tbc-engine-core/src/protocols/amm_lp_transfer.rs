//! Keyless selected-input LP transfer/merge/lock/unlock. SDK reference:
//! af776161 poolNFT3.0.ts prepareLPTransfer and poolnft3/transaction.ts.
//! Shared evidence table, staged signer, exact proof-based size reservation.
//! No coin selection policy, fetching, persistence, UI, private keys or signing.
use std::collections::{BTreeMap,BTreeSet};
use tbc_sdk::{PublicKey,Transaction,script::Script};
use crate::{EngineError,ErrorCode,signing::{UnsignedPlan,PlannedInput,PlannedOutput,PlannedTransaction,
    ProofReference,Tbc20OutputGroup,AmmLpUnlockRecipe,amm_lp_unlocking_descriptor}};
use super::{amm::MAX_AMOUNT,amm_lp as lp,amm_lp_proof::ParentMaterial,
    tbc20_material::MAX_MATERIAL_TRANSACTION_BYTES,tbc20_transfer::{intern,public_context,TokenOutput}};
pub use super::tbc20_transfer::{FeeInput,TransferPlan};
const MAX_SAFE:u64=9_007_199_254_740_991;
pub use super::amm_transaction::MinerFeePolicy;
pub struct LpInput<'a>{pub parent:&'a ParentMaterial,pub ancestor_raws:&'a [&'a [u8]],pub public_key:&'a PublicKey}
pub struct TransferOptions<'a>{
    pub inputs:&'a [LpInput<'a>],pub fee_input:&'a FeeInput<'a>,pub expected_identity:&'a [u8],
    pub receiver_controller:[u8;21],pub amount:u64,pub lp_change_controller:Option<[u8;21]>,
    pub native_change_hash:[u8;20],pub lock_time:Option<u32>,pub output_lock_time:Option<u32>,
    pub fee_policy:MinerFeePolicy,pub max_fee:u64,
}
fn invalid(message:&str)->EngineError{EngineError{code:ErrorCode::InvalidPlan,message:message.into(),path:None}}
fn insufficient(message:&str)->EngineError{EngineError{code:ErrorCode::InsufficientFunds,message:message.into(),path:None}}
fn hex(b:&[u8])->String{b.iter().map(|b|format!("{b:02x}")).collect()}

pub fn build_transfer_plan(options:TransferOptions<'_>)->Result<TransferPlan,EngineError>{
    if !(1..=5).contains(&options.inputs.len())||options.amount==0||options.amount>MAX_AMOUNT{return Err(invalid("LP requires 1-5 inputs and a positive signed-63-bit amount"));}
    options.fee_policy.fee(0)?;
    let first=options.inputs[0].parent;let locked=first.code().timelocked;
    if !locked&&options.output_lock_time.is_some(){return Err(invalid("Plain LP does not accept an output lock time"));}
    let mut seen=BTreeSet::new();let mut locks=Vec::new();let mut balances=Vec::new();
    for input in options.inputs{
        let p=input.parent;
        if options.expected_identity.is_empty()||p.identity().as_slice()!=options.expected_identity{return Err(invalid("LP input differs from bound Pool/template identity"));}
        if p.code().controller[20]!=0||p.code().controller[..20]!=input.public_key.hash160(){return Err(invalid("LP holder builder requires matching address-owned inputs"));}
        if !seen.insert((p.selected().txid.to_string(),p.selected().vout)){return Err(invalid("LP input repeats an outpoint"));}
        balances.push(p.tape().balance().map_err(|_|invalid("LP amount invalid"))?);locks.push(p.tape().lock_time);
    }
    let required=lp::required_lock_time(&locks).map_err(|_|invalid("LP inputs mix height/timestamp locks"))?;
    let lock_time=options.lock_time.unwrap_or(required);let output_lock=if locked{options.output_lock_time.unwrap_or(required)}else{0};
    let mut needed=options.amount as u128;let mut receiver_slots=[0;6];let mut change_slots=[0;6];
    let mut change_owners=BTreeSet::new();
    for(i,&balance)in balances.iter().enumerate(){
        let used=balance.min(needed);let change=balance-used;needed-=used;
        if used>MAX_AMOUNT as u128||change>MAX_AMOUNT as u128{return Err(invalid("LP output absolute input slot exceeds signed-63-bit range"));}
        receiver_slots[i]=used as u64;change_slots[i]=change as u64;
        if change>0{change_owners.insert(options.inputs[i].parent.code().controller);}
    }
    if needed>0{return Err(insufficient("LP selected balance is insufficient"));}
    if change_owners.len()>1&&options.lp_change_controller.is_none(){return Err(invalid("Multiple LP change owners require explicit destination"));}
    let mut token_outputs=vec![TokenOutput{controller:options.receiver_controller,amount:options.amount as u128,amounts_by_input:receiver_slots}];
    let change:u128=change_slots.iter().map(|n|*n as u128).sum();
    if change>0{token_outputs.push(TokenOutput{controller:options.lp_change_controller.unwrap_or(*change_owners.first().unwrap()),amount:change,amounts_by_input:change_slots});}
    let fee=options.fee_input;
    if fee.output.satoshis==0||fee.output.satoshis>MAX_SAFE||fee.output.script_pubkey!=Script::p2pkh(&fee.public_key.hash160())
        ||!seen.insert((fee.outpoint.txid.to_string(),fee.outpoint.vout)){return Err(invalid("LP funding must be distinct, positive, owner-controlled P2PKH"));}
    let native_total=fee.output.satoshis.checked_add(options.inputs.len() as u64*lp::CODE_DUST)
        .filter(|n|*n<=MAX_SAFE).ok_or_else(||invalid("LP native total exceeds safe range"))?;
    let mut outputs=Vec::new();let mut groups=Vec::new();
    for(index,output)in token_outputs.iter().enumerate(){
        let code=lp::Code{controller:output.controller,..first.code().clone()};
        let tape=lp::Tape{amounts:output.amounts_by_input,size:code.tape_size,timelocked:locked,lock_time:if index==0{output_lock}else{required}};
        groups.push(Tbc20OutputGroup{code_vout:outputs.len() as u32,tape_vout:Some(outputs.len() as u32+1)});
        outputs.push(PlannedOutput{satoshis:lp::CODE_DUST,locking_script:hex(&lp::instantiate_code(&code).map_err(|_|invalid("LP recipient Code invalid"))?)});
        outputs.push(PlannedOutput{satoshis:0,locking_script:hex(&tape.encode().map_err(|_|invalid("LP recipient Tape invalid"))?)});
    }
    let available=native_total.checked_sub(token_outputs.len() as u64*lp::CODE_DUST).ok_or_else(||insufficient("LP funding cannot cover asset outputs"))?;

    // Parse each supplied immutable ancestor once across all selected inputs;
    // intern both parents and ancestors once in the shared signing evidence table.
    let mut evidence=Vec::new();let mut ids=BTreeMap::new();let mut cache:Vec<(&[u8],Transaction)>=Vec::new();let mut prepared=Vec::new();
    for input in options.inputs{
        let p=input.parent;let parent=intern(p.transaction(),&mut evidence,&mut ids);
        if input.ancestor_raws.len()>6{return Err(invalid("LP ancestor set exceeds six slots"));}
        let mut supplied=BTreeMap::new();
        for raw in input.ancestor_raws{
            let index=if let Some(i)=cache.iter().position(|(bytes,_)|bytes==raw){i}else{
                if raw.is_empty()||raw.len()>MAX_MATERIAL_TRANSACTION_BYTES{return Err(invalid("LP ancestor exceeds byte budget"));}
                let tx=Transaction::from_bytes(raw).map_err(|_|invalid("LP ancestor malformed"))?;
                if tx.serialize()!=*raw{return Err(invalid("LP ancestor raw is not canonical"));}cache.push((raw,tx));cache.len()-1
            };
            if supplied.insert(cache[index].1.txid().to_string(),index).is_some(){return Err(invalid("LP ancestor repeated"));}
        }
        let required:BTreeSet<_>=p.dependencies().iter().map(|point|point.txid.to_string()).collect();
        if required!=supplied.keys().cloned().collect(){return Err(invalid("LP requires exactly its direct ancestors"));}
        let proof_references=p.dependencies().iter().map(|point|ProofReference{source:intern(&cache[supplied[&point.txid.to_string()]].1,&mut evidence,&mut ids),output_index:point.vout}).collect();
        let planned=PlannedInput{previous_transaction_id:p.selected().txid.to_string(),previous_output_index:p.selected().vout,
            previous_output_script:hex(p.transaction().outputs[p.selected().vout as usize].script_pubkey.as_bytes()),previous_output_satoshis:lp::CODE_DUST,
            sequence:if locked{0xfffffffe}else{tbc_sdk::DEFAULT_SEQUENCE},signer:public_context(input.public_key),unlocking_script:String::new()};
        prepared.push((planned,AmmLpUnlockRecipe{parent,proof_references,output_groups:Vec::new(),contract_controller:None}));
    }
    let make_plan=|with_change:bool|->Result<UnsignedPlan,EngineError>{
        let mut outputs=outputs.clone();let mut groups=groups.clone();
        if with_change{groups.push(Tbc20OutputGroup{code_vout:outputs.len() as u32,tape_vout:None});
            outputs.push(PlannedOutput{satoshis:options.fee_policy.change_dust,locking_script:hex(Script::p2pkh(&options.native_change_hash).as_bytes())});}
        let mut inputs=Vec::new();
        for(planned,recipe)in &prepared{let mut input=planned.clone();let mut recipe=recipe.clone();recipe.output_groups=groups.clone();input.unlocking_script=amm_lp_unlocking_descriptor(recipe)?;inputs.push(input);}
        inputs.push(PlannedInput{previous_transaction_id:fee.outpoint.txid.to_string(),previous_output_index:fee.outpoint.vout,
            previous_output_script:hex(fee.output.script_pubkey.as_bytes()),previous_output_satoshis:fee.output.satoshis,
            sequence:tbc_sdk::DEFAULT_SEQUENCE,signer:public_context(fee.public_key),unlocking_script:String::new()});
        Ok(UnsignedPlan{evidence_table:evidence.clone(),transactions:vec![PlannedTransaction{transaction_id:"tbc20-lp-transfer".into(),role:"tbc20-lp-transfer".into(),
            stage:0,depends_on:vec![],version:10,lock_time,inputs,outputs}]})
    };
    let funded=super::amm_transaction::finish_plan(make_plan,available,options.fee_policy,options.max_fee)?;
    Ok(TransferPlan{unsigned_plan:funded.unsigned_plan,token_outputs,fee:funded.fee,maximum_signed_bytes:funded.maximum_signed_bytes})
}
pub fn build_merge_plan(mut options:TransferOptions<'_>)->Result<TransferPlan,EngineError>{
    let total=options.inputs.iter().try_fold(0u128,|sum,input|input.parent.tape().balance().map(|n|sum+n)).map_err(|_|invalid("LP balance invalid"))?;
    options.amount=u64::try_from(total).map_err(|_|invalid("LP merge amount exceeds range"))?;
    let mut plan=build_transfer_plan(options)?;plan.unsigned_plan.transactions[0].transaction_id="tbc20-lp-merge".into();plan.unsigned_plan.transactions[0].role="tbc20-lp-merge".into();Ok(plan)
}
/// Removes the consumed lock only after the transaction satisfies it, without
/// changing ownership. This is not a bypass for premature chain submission.
pub fn build_unlock_plan(mut options:TransferOptions<'_>)->Result<TransferPlan,EngineError>{
    if options.inputs.is_empty()||options.inputs.iter().any(|i|!i.parent.code().timelocked||i.parent.code().controller!=options.receiver_controller){return Err(invalid("LP unlock must retain all input owners and use locked template"));}
    options.output_lock_time=Some(0);let mut plan=build_merge_plan(options)?;
    plan.unsigned_plan.transactions[0].transaction_id="tbc20-lp-unlock".into();plan.unsigned_plan.transactions[0].role="tbc20-lp-unlock".into();Ok(plan)
}
