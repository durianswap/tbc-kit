//! Keyless administrator lock changes; SDK coinTbc20.ts changeLocks semantics.
//! Reuses holder ancestry binding and shared external-signature fee sizing.
use std::collections::BTreeSet;
use tbc_sdk::{hash,script::Script};
use crate::{EngineError,ErrorCode,signing::{UnsignedPlan,PlannedTransaction,PlannedInput,PlannedOutput,Tbc20OutputGroup}};
use super::{coin,coin_proof::ParentMaterial,coin_transfer::bound_coin_inputs,
    coin_issuance::{administrator_context,fund_last,IssuancePlan},tbc20::MAX_SLOT_AMOUNT,
    tbc20_transfer::{FeeInput,public_context}};

pub struct AdminInput<'a> {
    pub parent:&'a ParentMaterial,
    pub ancestor_raws:&'a [&'a [u8]],
}
pub struct ChangeLocksOptions<'a> {
    pub inputs:&'a [AdminInput<'a>],
    pub expected_identity:&'a [u8],
    pub administrator:&'a [u8;32],
    pub fee_input:&'a FeeInput<'a>,
    /// Zero unlocks; other uint32 values use the existing Coin lock semantics.
    pub lock_time:u32,
    pub max_fee:u64,
}
fn invalid(message:&str)->EngineError {
    EngineError{code:ErrorCode::InvalidPlan,message:message.into(),path:None}
}
fn hex(bytes:&[u8])->String{bytes.iter().map(|b|format!("{b:02x}")).collect()}

pub fn build_change_locks_plan(options:ChangeLocksOptions<'_>)->Result<IssuancePlan,EngineError> {
    let ChangeLocksOptions{inputs,expected_identity,administrator,fee_input,lock_time,max_fee}=options;
    if inputs.is_empty() || inputs.len()>5 || expected_identity.is_empty() {
        return Err(invalid("Coin administrator needs one to five selected inputs and a bound identity"));
    }
    let signer=administrator_context(administrator)?;let admin_hash=hash::hash160(administrator);
    let mut seen=BTreeSet::new();
    // Preserve first-seen controller order and that controller's first Tape.
    // Amount slots are absolute input indexes, not compacted group indexes.
    let mut allocations:Vec<(&ParentMaterial,[u64;6])>=Vec::new();
    for (vin,input) in inputs.iter().enumerate() {
        let parent=input.parent;
        if parent.identity()!=expected_identity || parent.code().admin_pubkey_hash!=admin_hash
            || parent.tape().balance==0 || parent.tape().balance>MAX_SLOT_AMOUNT as u128
            || !seen.insert((parent.selected().txid.to_string(),parent.selected().vout)) {
            return Err(invalid("Coin administrator input identity, authority, slot balance or uniqueness invalid"));
        }
        let index=allocations.iter().position(|(p,_)|p.code().controller==parent.code().controller)
            .unwrap_or_else(||{allocations.push((parent,[0;6]));allocations.len()-1});
        allocations[index].1[vin]=parent.tape().balance as u64;
    }
    if fee_input.output.satoshis==0 || fee_input.output.satoshis>9_007_199_254_740_991
        || fee_input.output.script_pubkey!=Script::p2pkh(&fee_input.public_key.hash160())
        || !seen.insert((fee_input.outpoint.txid.to_string(),fee_input.outpoint.vout)) {
        return Err(invalid("Coin administrator fee must be positive distinct owner-controlled P2PKH"));
    }
    let mut outputs=Vec::new();let mut groups=Vec::new();
    for (parent,amounts) in allocations {
        let vout=outputs.len() as u32;
        groups.push(Tbc20OutputGroup{code_vout:vout,tape_vout:Some(vout+1)});
        outputs.push(PlannedOutput{satoshis:500,locking_script:hex(parent.transaction().outputs[parent.selected().vout as usize].script_pubkey.as_bytes())});
        outputs.push(PlannedOutput{satoshis:0,locking_script:hex(&coin::build_tape(amounts,parent.code().tape_size as usize,lock_time,&parent.tape().metadata)
            .map_err(|_|invalid("Coin administrator output Tape invalid"))?)});
    }
    groups.push(Tbc20OutputGroup{code_vout:outputs.len() as u32,tape_vout:None});
    let (mut planned_inputs,evidence_table)=bound_coin_inputs(inputs.iter().map(|input|(input.parent,input.ancestor_raws,signer.clone())),&groups)?;
    planned_inputs.push(PlannedInput{previous_transaction_id:fee_input.outpoint.txid.to_string(),previous_output_index:fee_input.outpoint.vout,
        previous_output_script:hex(fee_input.output.script_pubkey.as_bytes()),previous_output_satoshis:fee_input.output.satoshis,
        sequence:tbc_sdk::DEFAULT_SEQUENCE,unlocking_script:String::new(),signer:public_context(fee_input.public_key)});
    let operation=if lock_time==0{"tbc20-stablecoin-unfreeze"}else{"tbc20-stablecoin-freeze"};
    let mut unsigned_plan=UnsignedPlan{evidence_table,transactions:vec![PlannedTransaction{transaction_id:operation.into(),role:operation.into(),
        stage:0,depends_on:vec![],version:10,lock_time:0,inputs:planned_inputs,outputs}]};
    let (fee,bytes)=fund_last(&mut unsigned_plan,fee_input.public_key,max_fee)?;
    Ok(IssuancePlan{unsigned_plan,fees:vec![fee],maximum_signed_bytes:vec![bytes]})
}
