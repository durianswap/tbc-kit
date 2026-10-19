//! Keyless height-profile lock/unlock builders. Caller supplies authenticated
//! UTXOs and observed height; no queries, selection, UI, custody or signatures.
use std::collections::BTreeSet;
use tbc_sdk::{PublicKey,Transaction,TxIn,TxOut,UtxoInfo,script::Script};
use crate::{EngineError,ErrorCode,signing::{PlannedInput,PlannedOutput,PlannedTransaction,
    PublicSigningContext,UnsignedPlan,MAX_SIGNING_PLAN_INPUTS,TIMELOCK_UNLOCK_DESCRIPTOR}};
use super::{timelock::{Code,height_code,UNLOCK_SEQUENCE,LOCKTIME_THRESHOLD},tbc20_mint::fee_for_size};
const MAX_SAFE_INTEGER:u64=9_007_199_254_740_991;
const CHANGE_DUST:u64=42;
#[derive(Debug)]
pub struct TimelockPlan{pub unsigned_plan:UnsignedPlan,pub fee:u64,pub maximum_signed_bytes:usize}
fn error(code:ErrorCode,message:&str)->EngineError{EngineError{code,message:message.to_owned(),path:None}}
fn invalid(message:&str)->EngineError{error(ErrorCode::InvalidPlan,message)}
fn insufficient()->EngineError{error(ErrorCode::InsufficientFunds,"Timelock inputs cannot cover amount and bounded fee")}
fn hex(bytes:&[u8])->String{bytes.iter().map(|b|format!("{b:02x}")).collect()}
fn total(inputs:&[UtxoInfo])->Result<u64,EngineError>{
    if inputs.is_empty()||inputs.len()>MAX_SIGNING_PLAN_INPUTS{return Err(invalid("Timelock input count outside shared bounds"));}
    let mut seen=BTreeSet::new();let mut sum=0u64;
    for input in inputs{
        if input.satoshis==0||!seen.insert((input.outpoint.txid.to_string(),input.outpoint.vout)){
            return Err(invalid("Timelock input is zero-valued or duplicated"));
        }
        sum=sum.checked_add(input.satoshis).filter(|n|*n<=MAX_SAFE_INTEGER)
            .ok_or_else(||invalid("Timelock input sum exceeds safe integer range"))?;
    }Ok(sum)
}
fn estimate(inputs:&[UtxoInfo],outputs:Vec<TxOut>,sequence:u32,lock_time:u32)->usize{
    let inputs=inputs.iter().map(|utxo|{let mut input=TxIn::new(utxo.outpoint.clone());
        // Compressed public key + maximal low-S DER/sighash, with two pushes.
        input.script_sig=Script::from_bytes(vec![0;107]);input.sequence=sequence;input}).collect();
    Transaction{version:10,inputs,outputs,lock_time}.serialize().len()
}
fn assemble(inputs:&[UtxoInfo],owner:&PublicKey,outputs:Vec<TxOut>,fee:u64,maximum_signed_bytes:usize,
    sequence:u32,lock_time:u32,unlock:bool,max_fee:u64)->Result<TimelockPlan,EngineError>{
    if fee>max_fee{return Err(error(ErrorCode::FeeCapExceeded,"Timelock fee exceeds caller cap"));}
    let public=PublicSigningContext{address:owner.address().to_string(),public_key:hex(&owner.to_bytes()),public_key_hash:hex(&owner.hash160())};
    let role=if unlock{"tbc-timelock-unlock"}else{"tbc-timelock-lock"};
    Ok(TimelockPlan{fee,maximum_signed_bytes,unsigned_plan:UnsignedPlan{evidence_table:vec![],transactions:vec![PlannedTransaction{
        transaction_id:role.into(),role:role.into(),stage:0,depends_on:vec![],version:10,lock_time,
        inputs:inputs.iter().map(|utxo|PlannedInput{previous_transaction_id:utxo.outpoint.txid.to_string(),
            previous_output_index:utxo.outpoint.vout,previous_output_satoshis:utxo.satoshis,
            previous_output_script:hex(utxo.script_pubkey.as_bytes()),sequence,
            unlocking_script:if unlock{TIMELOCK_UNLOCK_DESCRIPTOR.into()}else{String::new()},signer:public.clone()}).collect(),
        outputs:outputs.iter().map(|out|PlannedOutput{satoshis:out.satoshis,locking_script:hex(out.script_pubkey.as_bytes())}).collect(),
    }]}})
}
pub fn build_lock_plan(inputs:&[UtxoInfo],owner:&PublicKey,amount:u64,height:u32,max_fee:u64)->Result<TimelockPlan,EngineError>{
    let value=total(inputs)?;if amount==0||amount>MAX_SAFE_INTEGER{return Err(invalid("Timelock amount must be positive safe atomic units"));}
    let owner_script=Script::p2pkh(&owner.hash160());
    if inputs.iter().any(|u|u.script_pubkey!=owner_script){return Err(invalid("Timelock funding must belong to the public owner"));}
    let code=height_code(owner.hash160(),height).map_err(|_|invalid("Unsupported timelock height"))?;
    let mut outputs=vec![TxOut{satoshis:amount,script_pubkey:Script::from_bytes(code)}];
    let remaining=value.checked_sub(amount).ok_or_else(insufficient)?;
    let mut with_change=outputs.clone();with_change.push(TxOut{satoshis:CHANGE_DUST,script_pubkey:owner_script.clone()});
    let size=estimate(inputs,with_change,u32::MAX,0);let requested_fee=fee_for_size(size)?;
    let (fee,size)=if let Some(change)=remaining.checked_sub(requested_fee).filter(|v|*v>=CHANGE_DUST){
        outputs.push(TxOut{satoshis:change,script_pubkey:owner_script});(requested_fee,size)
    }else{
        let size=estimate(inputs,outputs.clone(),u32::MAX,0);
        if remaining<fee_for_size(size)?{return Err(insufficient());}(remaining,size)
    };
    assemble(inputs,owner,outputs,fee,size,u32::MAX,0,false,max_fee)
}
pub fn build_unlock_plan(inputs:&[UtxoInfo],owner:&PublicKey,observed_height:u32,max_fee:u64)->Result<TimelockPlan,EngineError>{
    let value=total(inputs)?;
    if observed_height>=LOCKTIME_THRESHOLD{return Err(invalid("Timelock observed height is outside height profile"));}
    for input in inputs{
        let code=Code::decode(input.script_pubkey.as_bytes()).map_err(|_|invalid("Timelock input template is unsupported"))?;
        if code.owner_hash!=owner.hash160(){return Err(invalid("Timelock public key does not own input"));}
        code.validate_height_spend(UNLOCK_SEQUENCE,observed_height,observed_height)
            .map_err(|_|invalid("Timelock is immature or outside height profile"))?;
    }
    let mut outputs=vec![TxOut{satoshis:1,script_pubkey:Script::p2pkh(&owner.hash160())}];
    let size=estimate(inputs,outputs.clone(),UNLOCK_SEQUENCE,observed_height);let fee=fee_for_size(size)?;
    outputs[0].satoshis=value.checked_sub(fee).filter(|v|*v>0).ok_or_else(insufficient)?;
    assemble(inputs,owner,outputs,fee,size,UNLOCK_SEQUENCE,observed_height,true,max_fee)
}
