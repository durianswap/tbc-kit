//! Keyless LP material binding and fixed 123-leaf ABI. Reference:
//! tbc-contract af77616121db340e15bb8b73c197bc2f8d1ee986,
//! lib/util/poolnft3/ftlpTbc20unlock.ts (OpenTBC release terms remain separate).
//! Shared TBC20 proof serialization and ECDSA finalizer; LP-specific ancestry,
//! controller, locks and absolute-vin allocation. No HTTP or private keys.
use std::collections::{BTreeMap,BTreeSet};
use tbc_sdk::{hash,OutPoint,PublicKey,Transaction,DEFAULT_SIGHASH,sighash::forkid_sighash};
use crate::{EngineError,ErrorCode};
use super::{amm_lp as lp,tbc20_material::MAX_MATERIAL_TRANSACTION_BYTES};
use super::tbc20_proof::{check_transaction,unsigned_script_num,output_fields,group_fields,current_output_fields};
use super::transaction_proof::{input_record,input_records,inputs_hash_data,unlocking_scripts_hash,output_records,vlio};
pub use super::tbc20_proof::{PreparedUnlock,OutputGroup,ContractControllerWitness,UNLOCK_LEAF_COUNT};

fn invalid(message:&str)->EngineError {EngineError{code:ErrorCode::InvalidAncestry,message:message.into(),path:None}}
fn parse_material(raw:&[u8])->Result<Transaction,EngineError>{
    if raw.is_empty()||raw.len()>MAX_MATERIAL_TRANSACTION_BYTES{return Err(invalid("LP material exceeds local byte bound"));}
    let tx=Transaction::from_bytes(raw).map_err(|_|invalid("LP material is malformed"))?;
    check_transaction(&tx)?;
    if tx.serialize()!=raw{return Err(invalid("LP material is not canonically encoded"));}Ok(tx)
}
fn unique_inputs(tx:&Transaction)->Result<(),EngineError>{
    let mut seen=BTreeSet::new();
    for input in &tx.inputs {if !seen.insert((input.previous_output.txid.to_string(),input.previous_output.vout)){
        return Err(invalid("LP transaction repeats an input outpoint"));
    }}Ok(())
}
#[derive(Clone,Debug)]
pub struct ParentMaterial {
    transaction:Transaction,selected:OutPoint,code:lp::Code,tape:lp::Tape,identity:[u8;34],dependencies:Vec<OutPoint>,
}
impl ParentMaterial {
    pub fn transaction(&self)->&Transaction{&self.transaction}
    pub fn selected(&self)->&OutPoint{&self.selected}
    pub fn code(&self)->&lp::Code{&self.code}
    pub fn tape(&self)->&lp::Tape{&self.tape}
    pub fn identity(&self)->&[u8;34]{&self.identity}
    /// Nonzero parent vin slots only. Caller deduplicates txids before reading.
    pub fn dependencies(&self)->&[OutPoint]{&self.dependencies}
}
/// Optional identity is an independent caller constraint, not a self-certifying
/// trust anchor. Parsing selected untrusted bytes does not prove chain validity.
pub fn inspect_parent(raw:&[u8],selected:&OutPoint,expected_identity:Option<&[u8]>)->Result<ParentMaterial,EngineError>{
    let tx=parse_material(raw)?;
    if tx.txid()!=selected.txid||tx.inputs.len()>6{return Err(invalid("LP parent identity or six-input boundary differs"));}
    unique_inputs(&tx)?;
    let index=selected.vout as usize;
    let code_out=tx.outputs.get(index).ok_or_else(||invalid("LP selected Code missing"))?;
    let tape_out=tx.outputs.get(index.checked_add(1).ok_or_else(||invalid("LP Tape index overflow"))?).ok_or_else(||invalid("LP adjacent Tape missing"))?;
    if code_out.satoshis!=lp::CODE_DUST||tape_out.satoshis!=0{return Err(invalid("LP parent Code/Tape must be 500/0"));}
    let code=lp::parse_code(code_out.script_pubkey.as_bytes()).map_err(|_|invalid("LP parent Code invalid"))?;
    let tape=lp::Tape::decode(tape_out.script_pubkey.as_bytes(),code.timelocked,Some(code.tape_size)).map_err(|_|invalid("LP parent Tape invalid"))?;
    let identity=lp::code_identity(code_out.script_pubkey.as_bytes()).map_err(|_|invalid("LP parent identity invalid"))?;
    if expected_identity.is_some_and(|expected|expected!=identity){return Err(invalid("LP differs from independently expected identity"));}
    let mut dependencies=Vec::new();
    for (slot,&amount) in tape.amounts.iter().enumerate(){if amount!=0{
        dependencies.push(tx.inputs.get(slot).ok_or_else(||invalid("LP nonzero Tape slot has no parent input"))?.previous_output.clone());
    }}
    Ok(ParentMaterial{transaction:tx,selected:selected.clone(),code,tape,identity,dependencies})
}
pub struct UnlockOptions<'a>{
    pub current_tx:&'a Transaction,pub input_index:usize,pub parent:&'a ParentMaterial,
    /// Exact deduplicated direct ancestor raws, never a recursive history walk.
    pub ancestor_raws:&'a [&'a [u8]],pub output_groups:&'a [OutputGroup],pub public_key:&'a [u8],
    pub contract_controller:Option<ContractControllerWitness<'a>>,
}
fn ancestor_fields(options:&UnlockOptions<'_>)->Result<Vec<Vec<u8>>,EngineError>{
    let parent=options.parent;
    if options.ancestor_raws.len()>6{return Err(invalid("LP ancestor set exceeds six required slots"));}
    let required:BTreeSet<_>=parent.dependencies.iter().map(|p|p.txid.to_string()).collect();
    let mut by_id=BTreeMap::new();
    for raw in options.ancestor_raws {
        let tx=parse_material(raw)?;let id=tx.txid().to_string();
        if !required.contains(&id)||by_id.insert(id,tx).is_some(){return Err(invalid("LP ancestor is unrelated or duplicated"));}
    }
    let mut fields=Vec::with_capacity(48);
    for slot in (0..6).rev(){
        if parent.tape.amounts[slot]==0{fields.resize(fields.len()+8,Vec::new());continue;}
        let point=&parent.transaction.inputs[slot].previous_output;
        let tx=by_id.get(&point.txid.to_string()).ok_or_else(||EngineError{code:ErrorCode::MissingMaterial,message:"LP required direct ancestor is missing".into(),path:None})?;
        let vout=point.vout as usize;let output=tx.outputs.get(vout).ok_or_else(||invalid("LP ancestor output missing"))?;
        let same_lp=lp::code_identity(output.script_pubkey.as_bytes()).is_ok_and(|identity|identity==parent.identity);
        let pool_issuance=slot==0&&vout==0&&hash::sha256(output.script_pubkey.as_bytes())==parent.code.pool_code_hash;
        if !same_lp&&!pool_issuance{return Err(invalid("LP ancestor is neither same LP identity nor authorized Pool issuance"));}
        fields.push(vlio(tx));fields.push(inputs_hash_data(tx));fields.push(output_records(&tx.outputs[..vout]));
        fields.extend(output_fields(output)?);fields.push(output_records(&tx.outputs[vout+1..]));
    }Ok(fields)
}
fn controller_fields(options:&UnlockOptions<'_>)->Result<(Vec<Vec<u8>>,usize),EngineError>{
    let controller=&options.parent.code.controller;
    if controller[20]==0{
        if options.contract_controller.is_some(){return Err(invalid("Address-held LP must not include contract witness"));}
        if hash::hash160(options.public_key)!=controller[..20]{return Err(invalid("LP key does not own address controller"));}
        return Ok((vec![Vec::new();6],0));
    }
    let witness=options.contract_controller.as_ref().ok_or_else(||invalid("Contract-held LP requires explicit controller witness"))?;
    if witness.current_input_index==options.input_index{return Err(invalid("LP cannot be its own controlling input"));}
    check_transaction(witness.transaction)?;
    let input=options.current_tx.inputs.get(witness.current_input_index).ok_or_else(||invalid("LP controller input missing"))?;
    if input.previous_output.txid!=witness.transaction.txid(){return Err(invalid("LP controller transaction mismatch"));}
    let vout=input.previous_output.vout as usize;
    let output=witness.transaction.outputs.get(vout).ok_or_else(||invalid("LP controller output missing"))?;
    let code_hash=hash::sha256(output.script_pubkey.as_bytes());
    if hash::hash160(&code_hash)!=controller[..20]{return Err(invalid("LP controller is not the consumed contract"));}
    Ok((vec![vlio(witness.transaction),inputs_hash_data(witness.transaction),output_records(&witness.transaction.outputs[..vout]),
        output.satoshis.to_le_bytes().to_vec(),code_hash.to_vec(),output_records(&witness.transaction.outputs[vout+1..])],witness.current_input_index))
}
pub fn prepare_unlock(options:UnlockOptions<'_>)->Result<PreparedUnlock,EngineError>{
    let tx=options.current_tx;let parent=options.parent;
    check_transaction(tx)?;unique_inputs(tx)?;
    if tx.inputs.len()>6||options.input_index>=6{return Err(invalid("LP current transaction exceeds six-input boundary"));}
    let input=tx.inputs.get(options.input_index).ok_or_else(||invalid("LP current input missing"))?;
    if input.previous_output!=parent.selected{return Err(invalid("LP current input does not spend inspected parent"));}
    let public_key:[u8;33]=options.public_key.try_into().map_err(|_|invalid("LP requires compressed 33-byte public key"))?;
    PublicKey::from_slice(&public_key).map_err(|_|invalid("LP public key invalid"))?;
    parent.tape.verify_input_lock(input.sequence,tx.lock_time).map_err(|_|invalid("LP input lock domain, sequence or required nLockTime invalid"))?;
    let (controller,controller_vin)=controller_fields(&options)?;
    let mut fields=current_output_fields(tx,options.output_groups)?;
    let mut allocated=0u128;
    for group in options.output_groups{
        let output=&tx.outputs[group.code_vout];let code_raw=output.script_pubkey.as_bytes();
        if code_raw.len()==parent.code.tape_size as usize&&code_raw.ends_with(b"TBC20TAPE"){return Err(invalid("LP Tape hidden in a Code field"));}
        let Some(tape_vout)=group.tape_vout else{continue};
        let tape=&tx.outputs[tape_vout];let raw=tape.script_pubkey.as_bytes();
        if raw.len()!=parent.code.tape_size as usize{continue;}
        // Match SDK readTBC20TapeAmounts before LP-specific nonzero output validation.
        if !raw.starts_with(&[0,0x6a,0x30])||!raw.ends_with(b"TBC20TAPE"){return Err(invalid("LP allocation Tape envelope invalid"));}
        let mut amounts=[0;6];
        for(i,value)in amounts.iter_mut().enumerate(){*value=u64::from_le_bytes(raw[3+i*8..11+i*8].try_into().unwrap());
            if *value>super::amm::MAX_AMOUNT{return Err(invalid("LP allocation slot overflow"));}}
        let amount=amounts[options.input_index];allocated+=amount as u128;
        if amount==0{continue;}
        if output.satoshis!=lp::CODE_DUST||tape.satoshis!=0
            ||lp::code_identity(code_raw).map_err(|_|invalid("LP recipient Code invalid"))?!=parent.identity{
            return Err(invalid("LP recipient identity or Code/Tape values differ"));
        }
        lp::Tape::decode(raw,parent.code.timelocked,Some(parent.code.tape_size)).map_err(|_|invalid("LP output Tape invalid"))?;
    }
    if allocated!=parent.tape.balance().map_err(|_|invalid("LP balance overflow"))?{return Err(invalid("LP output allocations do not conserve absolute input slot"));}
    fields.push(input_records(tx));fields.push(unsigned_script_num(options.input_index));fields.extend(ancestor_fields(&options)?);
    fields.push(Vec::new());fields.push(public_key.to_vec());fields.extend(controller);fields.push(unsigned_script_num(controller_vin));
    let selected=parent.selected.vout as usize;
    fields.push(vlio(&parent.transaction));
    for vin in 0..6{fields.push(if vin<parent.transaction.inputs.len(){input_record(&parent.transaction,vin)}else{Vec::new()});}
    fields.push(unlocking_scripts_hash(&parent.transaction));fields.push(output_records(&parent.transaction.outputs[..selected]));
    fields.extend(group_fields(&parent.transaction.outputs[selected],Some(&parent.transaction.outputs[selected+1]))?);
    fields.push(output_records(&parent.transaction.outputs[selected+2..]));
    let previous=&parent.transaction.outputs[selected];
    let digest=forkid_sighash(tx,options.input_index,&previous.script_pubkey,previous.satoshis,DEFAULT_SIGHASH).map_err(|_|invalid("LP digest cannot be formed"))?;
    PreparedUnlock::from_parts(fields,digest,public_key)
}
