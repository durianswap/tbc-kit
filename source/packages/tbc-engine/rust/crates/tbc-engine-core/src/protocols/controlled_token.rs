//! Shared selected-token material, output allocation, proof and fee assembly.
//! Pure supplied data only; no contract-specific authorization or secret input.
use std::collections::{BTreeMap, BTreeSet};
use tbc_sdk::{OutPoint, PublicKey, Transaction, script::Script};
use crate::{EngineError, ErrorCode, signing::{EvidenceEntry, PlannedInput, PlannedOutput,
    PlannedTransaction, ProofReference, Tbc20OutputGroup, Tbc20UnlockRecipe,
    Tbc20ContractControllerReference, UnsignedPlan, maximum_signed_transaction_sizes,
    tbc20_unlocking_descriptor, coin_unlocking_descriptor}};
use super::{coin, coin_proof, tbc20, tbc20_material, tbc20_proof::check_transaction,
    tbc20_mint::fee_for_size, tbc20_transfer::{intern, public_context, FeeInput}};
const MAX_SAFE:u64=9_007_199_254_740_991;
const DUST:u64=42;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenProfile { Tbc20, Coin }
pub struct TokenInput<'a> {
    pub parent: &'a Transaction,
    pub vout: u32,
    /// Exact unique direct ancestors, not a recursive history or an index claim.
    pub ancestors: &'a [&'a Transaction],
}
#[derive(Clone, Copy)]
pub struct ChainContext { pub height: Option<u64>, pub median_time_past: Option<u64> }
impl ChainContext {
    pub fn mature(self, lock: u32) -> bool {
        if lock == 0 { true }
        else if lock < 500_000_000 { self.height.is_some_and(|height| u64::from(lock) <= height) }
        else { self.median_time_past.is_some_and(|time| u64::from(lock) < time) }
    }
}

pub(crate) struct ControlledTokenPlan {pub unsigned_plan:UnsignedPlan,pub fee:u64,pub maximum_signed_bytes:usize}
fn invalid(message:&str)->EngineError{EngineError{code:ErrorCode::InvalidPlan,message:message.into(),path:None}}
fn insufficient()->EngineError{EngineError{code:ErrorCode::InsufficientFunds,message:"Controlled Token funding or balance insufficient".into(),path:None}}
fn hex(bytes:&[u8])->String{bytes.iter().map(|b|format!("{b:02x}")).collect()}
pub(crate) fn address_controller(key:&PublicKey)->[u8;21]{let mut out=[0;21];out[..20].copy_from_slice(&key.hash160());out}
pub(crate) struct Material {
    pub controller: [u8;21], pub balance: u128, pub lock: u32,
    pub code: Vec<u8>, pub tape: Vec<u8>, pub dependencies: Vec<OutPoint>,
}
pub(crate) fn inspect(input: &TokenInput<'_>, profile: TokenProfile, identity: &[u8]) -> Result<Material,EngineError> {
    if identity.is_empty() { return Err(invalid("Controlled Token independent identity required")); }
    check_transaction(input.parent)?;
    let point=OutPoint {txid:input.parent.txid(),vout:input.vout};
    let raw=input.parent.serialize();
    let (controller,balance,lock,dependencies)=match profile {
        TokenProfile::Tbc20 => {
            let p=tbc20_material::inspect_parent(&raw,&point,Some(identity))?;
            (p.code().controller,p.tape().balance,0,p.dependencies().iter().map(|d|d.outpoint.clone()).collect())
        },
        TokenProfile::Coin => {
            let p=coin_proof::inspect_parent(&raw,&point,Some(identity))?;
            (p.code().controller,p.tape().balance,p.tape().lock_time,p.dependencies().to_vec())
        },
    };
    if balance==0 {return Err(invalid("Controlled Token deposit must have a positive authenticated balance"));}
    Ok(Material {controller,balance,lock,dependencies,
        code:input.parent.outputs[input.vout as usize].script_pubkey.as_bytes().to_vec(),
        tape:input.parent.outputs[input.vout as usize+1].script_pubkey.as_bytes().to_vec()})
}
pub(crate) fn pair(profile:TokenProfile,material:&Material,controller:[u8;21],slots:[u64;6],outputs:&mut Vec<PlannedOutput>,groups:&mut Vec<Tbc20OutputGroup>)->Result<(),EngineError> {
    let code=match profile {
        TokenProfile::Tbc20=>tbc20::replace_controller(&material.code,controller).map_err(|_|invalid("Controlled Token output controller invalid")),
        TokenProfile::Coin=>coin::replace_controller(&material.code,controller).map_err(|_|invalid("Controlled Coin output controller invalid")),
    }?;
    // SDK ContractToken replaces amounts, preserving the exact Tape envelope,
    // including Coin locks. Do not reuse holder-transfer's clear-lock policy.
    let tape=match profile {
        TokenProfile::Tbc20=>{let prior=tbc20::parse_tape(&material.tape).map_err(|_|invalid("Controlled Token Tape invalid"))?;tbc20::build_tape(slots,&prior.extension).map_err(|_|invalid("Controlled Token output Tape invalid"))},
        TokenProfile::Coin=>coin::replace_tape_amounts(&material.tape,slots).map_err(|_|invalid("Controlled Coin output Tape invalid")),
    }?;
    groups.push(Tbc20OutputGroup{code_vout:outputs.len() as u32,tape_vout:Some(outputs.len() as u32+1)});
    outputs.push(PlannedOutput{satoshis:500,locking_script:hex(&code)});
    outputs.push(PlannedOutput{satoshis:0,locking_script:hex(&tape)});Ok(())
}
pub(crate) fn recipe(input:&TokenInput<'_>,material:&Material,evidence:&mut Vec<EvidenceEntry>,ids:&mut BTreeMap<String,u32>,controller:Option<Tbc20ContractControllerReference>)->Result<Tbc20UnlockRecipe,EngineError> {
    if input.ancestors.len()>6 {return Err(invalid("Controlled Token ancestor set exceeds six slots"));}
    let mut supplied=BTreeMap::new();
    for tx in input.ancestors {check_transaction(tx)?;if supplied.insert(tx.txid().to_string(),*tx).is_some(){return Err(invalid("Controlled Token repeated ancestor"));}}
    let required:BTreeSet<_>=material.dependencies.iter().map(|p|p.txid.to_string()).collect();
    if required!=supplied.keys().cloned().collect(){return Err(invalid("Controlled Token requires exact direct ancestors"));}
    let parent=intern(input.parent,evidence,ids);
    let proof_references=material.dependencies.iter().map(|point|ProofReference{
        source:intern(supplied[&point.txid.to_string()],evidence,ids),output_index:point.vout,
    }).collect();
    Ok(Tbc20UnlockRecipe{parent,proof_references,output_groups:vec![],contract_controller:controller})
}
pub(crate) fn selected_input(input:&TokenInput<'_>,material:&Material,key:&PublicKey,profile:TokenProfile)->PlannedInput {
    PlannedInput{previous_transaction_id:input.parent.txid().to_string(),previous_output_index:input.vout,
        previous_output_script:hex(&material.code),previous_output_satoshis:500,
        sequence:if profile==TokenProfile::Coin{u32::MAX-1}else{u32::MAX},signer:public_context(key),unlocking_script:String::new()}
}
pub(crate) fn fee_input(funding:&FeeInput<'_>)->Result<PlannedInput,EngineError>{
    if funding.output.satoshis==0 || funding.output.satoshis>MAX_SAFE || funding.output.script_pubkey!=Script::p2pkh(&funding.public_key.hash160()) {
        return Err(invalid("Controlled Token fee input must match public signer and safe amount range"));
    }
    Ok(PlannedInput{previous_transaction_id:funding.outpoint.txid.to_string(),previous_output_index:funding.outpoint.vout,
        previous_output_script:hex(funding.output.script_pubkey.as_bytes()),previous_output_satoshis:funding.output.satoshis,
        sequence:u32::MAX,signer:public_context(funding.public_key),unlocking_script:String::new()})
}
pub(crate) struct Assembly {
    pub profile:TokenProfile,pub role:&'static str,pub inputs:Vec<PlannedInput>,pub outputs:Vec<PlannedOutput>,
    pub groups:Vec<Tbc20OutputGroup>,pub recipes:Vec<(usize,Tbc20UnlockRecipe)>,pub evidence:Vec<EvidenceEntry>,pub lock:u32,
}
impl Assembly {
    pub(crate) fn finish(self,key:&PublicKey,max_fee:u64)->Result<ControlledTokenPlan,EngineError>{
        let mut seen=BTreeSet::new();
        let total=self.inputs.iter().try_fold(0u64,|sum,i|{
            if !seen.insert((&i.previous_transaction_id,i.previous_output_index)){return Err(invalid("Controlled Token duplicate selected input"));}
            sum.checked_add(i.previous_output_satoshis).filter(|n|*n<=MAX_SAFE).ok_or_else(||invalid("Controlled Token native total exceeds safe range"))
        })?;
        let fixed=self.outputs.iter().map(|o|o.satoshis).sum::<u64>();
        let available=total.checked_sub(fixed).ok_or_else(insufficient)?;
        let make=|change:bool|->Result<UnsignedPlan,EngineError>{
            let mut outputs=self.outputs.clone();let mut groups=self.groups.clone();let mut inputs=self.inputs.clone();
            if change{groups.push(Tbc20OutputGroup{code_vout:outputs.len() as u32,tape_vout:None});outputs.push(PlannedOutput{satoshis:DUST,locking_script:hex(Script::p2pkh(&key.hash160()).as_bytes())});}
            for(index,value)in &self.recipes{
                let mut value=value.clone();value.output_groups=groups.clone();
                inputs[*index].unlocking_script=match self.profile{TokenProfile::Tbc20=>tbc20_unlocking_descriptor(value),TokenProfile::Coin=>coin_unlocking_descriptor(value)}?;
            }
            Ok(UnsignedPlan{evidence_table:self.evidence.clone(),transactions:vec![PlannedTransaction{
                transaction_id:self.role.into(),role:self.role.into(),stage:0,depends_on:vec![],version:10,lock_time:self.lock,inputs,outputs,
            }]})
        };
        let mut plan=make(true)?;let mut size=maximum_signed_transaction_sizes(&plan)?[0];let required=fee_for_size(size)?;
        let fee=if let Some(change)=available.checked_sub(required).filter(|n|*n>=DUST){
            plan.transactions[0].outputs.last_mut().unwrap().satoshis=change;required
        }else{
            plan=make(false)?;size=maximum_signed_transaction_sizes(&plan)?[0];
            if available<fee_for_size(size)?{return Err(insufficient());}available
        };
        if size>tbc20_material::MAX_MATERIAL_TRANSACTION_BYTES{return Err(invalid("Controlled Token transaction exceeds byte budget"));}
        if fee>max_fee{return Err(EngineError{code:ErrorCode::FeeCapExceeded,message:"Controlled Token fee exceeds approved cap".into(),path:None});}
        Ok(ControlledTokenPlan{unsigned_plan:plan,fee,maximum_signed_bytes:size})
    }
}
