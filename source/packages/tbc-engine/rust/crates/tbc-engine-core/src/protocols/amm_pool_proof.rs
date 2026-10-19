//! New Pool3 active-branch witness, fixed tbc-contract af776161 witness.ts.
//! Pure proof serialization + external controller signature verification.
//! This is NOT a quote/intent validator or VM: the business planner must bind
//! FT genesis, amounts, recipients, fees and approval before exposing a request.
use std::collections::BTreeSet;
use tbc_sdk::{hash,Transaction,TxOut,script::Script,sighash::forkid_sighash,DEFAULT_SIGHASH};
use crate::{EngineError,ErrorCode};
use super::{amm,amm_code::Authorization,amm_profile,covenant_signature::CovenantPublicKey,
    tbc20_proof::{check_transaction,output_fields,group_fields,unsigned_script_num,MAX_SIGNATURE},
    transaction_proof::{vlio,input_records,inputs_hash_data,unlocking_scripts_hash,output_records,push_data}};

#[derive(Clone,Copy,Debug,PartialEq,Eq)]
#[repr(u8)]
pub enum Operation { AddLp=1, RemoveLp=2, BuyFt=3, SellFt=4 }
impl Operation {
    pub fn auxiliary_inputs(self)->usize {if self==Self::BuyFt {2} else {3}}
    pub fn leaf_count(self,controlled:bool)->usize {
        (match self {Self::AddLp=>66,Self::RemoveLp=>76,Self::BuyFt=>56,Self::SellFt=>68})+if controlled {2} else {0}
    }
}
#[derive(Clone,Debug,PartialEq,Eq)]
pub struct OutputLayout {
    pub pool_ft:usize,pub user_ft:Option<usize>,pub lp:Option<usize>,pub lp_burn:Option<usize>,
    pub ft_change:Option<usize>,pub lp_change:Option<usize>,pub tbc:Option<usize>,pub fee:Option<usize>,pub native_change:Option<usize>,
}
fn invalid(message:&str)->EngineError {EngineError{code:ErrorCode::InvalidAncestry,message:message.into(),path:None}}
/// Physical positions are part of the four distinct covenant branches, not a
/// generic fungible grouping. Omitted optional fields still have empty leaves.
pub fn output_layout(operation:Operation,count:usize)->Result<OutputLayout,EngineError>{
    let mut layout=OutputLayout{pool_ft:0,user_ft:None,lp:None,lp_burn:None,ft_change:None,lp_change:None,tbc:None,fee:None,native_change:None};
    if operation==Operation::BuyFt {
        if !matches!(count,7|8){return Err(invalid("Pool buy requires seven or eight outputs"));}
        layout.pool_ft=5;layout.user_ft=Some(2);layout.fee=Some(4);layout.native_change=(count==8).then_some(7);return Ok(layout);
    }
    let base=if operation==Operation::RemoveLp {9} else {6};
    if count<base||count>base+3{return Err(invalid("Pool operation output count differs from active ABI"));}
    let token_change=count-base>=2;layout.native_change=((count-base)%2==1).then_some(count-1);
    match operation {
        Operation::AddLp=>{layout.pool_ft=2;layout.lp=Some(4);layout.ft_change=token_change.then_some(6);},
        Operation::RemoveLp=>{layout.tbc=Some(2);layout.user_ft=Some(3);layout.lp_burn=Some(5);layout.pool_ft=7;layout.lp_change=token_change.then_some(9);},
        Operation::SellFt=>{layout.tbc=Some(2);layout.fee=Some(3);layout.pool_ft=4;layout.ft_change=token_change.then_some(6);},
        Operation::BuyFt=>unreachable!(),
    }Ok(layout)
}
fn output(tx:&Transaction,index:usize)->Result<&TxOut,EngineError>{
    let out=tx.outputs.get(index).ok_or_else(||invalid("Pool proof output missing"))?;
    if out.script_pubkey.as_bytes().is_empty(){return Err(invalid("Pool proof output script empty"));}Ok(out)
}
fn single(tx:&Transaction,index:Option<usize>)->Result<Vec<Vec<u8>>,EngineError>{
    index.map(|i|output_fields(output(tx,i)?)).unwrap_or_else(||Ok(vec![Vec::new();4]))
}
fn pair(tx:&Transaction,index:Option<usize>)->Result<Vec<Vec<u8>>,EngineError>{
    index.map(|i|group_fields(output(tx,i)?,Some(output(tx,i+1)?))).unwrap_or_else(||Ok(vec![Vec::new();6]))
}
fn context(tx:&Transaction,operation:Operation,l:&OutputLayout)->Result<Vec<Vec<u8>>,EngineError>{
    let code=output(tx,0)?;let tape=output(tx,1)?;
    let mut fields=vec![code.satoshis.to_le_bytes().to_vec(),hash::sha256(code.script_pubkey.as_bytes()).to_vec(),
        tape.satoshis.to_le_bytes().to_vec(),tape.script_pubkey.as_bytes().to_vec()];
    match operation {
        Operation::AddLp=>{fields.extend(pair(tx,Some(l.pool_ft))?);fields.extend(pair(tx,l.lp)?);fields.extend(pair(tx,l.ft_change)?);},
        Operation::RemoveLp=>{fields.extend(single(tx,l.tbc)?);fields.extend(pair(tx,l.user_ft)?);fields.extend(pair(tx,l.lp_burn)?);fields.extend(pair(tx,Some(l.pool_ft))?);fields.extend(pair(tx,l.lp_change)?);},
        Operation::BuyFt=>{fields.extend(pair(tx,l.user_ft)?);fields.extend(single(tx,l.fee)?);fields.extend(pair(tx,Some(l.pool_ft))?);},
        Operation::SellFt=>{fields.extend(single(tx,l.tbc)?);fields.extend(single(tx,l.fee)?);fields.extend(pair(tx,Some(l.pool_ft))?);fields.extend(pair(tx,l.ft_change)?);},
    }
    fields.extend(single(tx,l.native_change)?);Ok(fields)
}
fn parent_link(current:&Transaction,vin:usize,parent:&Transaction)->Result<usize,EngineError>{
    let input=current.inputs.get(vin).ok_or_else(||invalid("Pool input missing"))?;
    if input.previous_output.txid!=parent.txid(){return Err(invalid("Pool supplied parent txid does not match input"));}
    let vout=input.previous_output.vout as usize;output(parent,vout)?;Ok(vout)
}
fn pool_profile(tx:&Transaction)->Result<(amm_profile::Code,amm_profile::Tape),EngineError>{
    let code=output(tx,0)?;let tape=output(tx,1)?;
    if code.satoshis<amm::CODE_DUST||tape.satoshis!=0{return Err(invalid("Pool Code reserve or Tape value invalid"));}
    let profile=amm_profile::Code::decode(code.script_pubkey.as_bytes()).map_err(|_|invalid("Pool complete Code template invalid"))?;
    let tape=amm_profile::Tape::decode(tape.script_pubkey.as_bytes()).map_err(|_|invalid("Pool Tape malformed"))?;
    amm_profile::Profile::from_parts(&profile,&tape).map_err(|_|invalid("Pool Code/Tape profile mismatch"))?;
    if tape.with_swap_hash_lock!=matches!(profile.authorization,Authorization::Controller(_)){
        return Err(invalid("Pool Code authorization and Tape flags differ"));
    }
    Ok((profile,tape))
}
pub struct UnlockOptions<'a>{
    pub current_tx:&'a Transaction,pub parent:&'a Transaction,pub ancestor:&'a Transaction,
    /// Exact parents in vin[1..] order. Repeated parent txids with different
    /// outpoints are valid; the caller should share parsed immutable material.
    pub auxiliary_parents:&'a [&'a Transaction],pub operation:Operation,
    /// Caller binds this from its trusted Pool identity, not a magic trust root.
    pub expected_pool_hash:&'a [u8;32],pub controller_public_key:Option<&'a [u8]>,
}
#[derive(Clone,Debug)]
pub struct PreparedUnlock {fields:Vec<Vec<u8>>,digest:[u8;32],controller:Option<CovenantPublicKey>}
impl PreparedUnlock {
    pub fn proof_fields(&self)->&[Vec<u8>]{&self.fields}
    /// Public pools have no controller-signature request.
    pub fn signing_digest(&self)->Option<&[u8;32]>{self.controller.as_ref().map(|_|&self.digest)}
    pub fn controller_public_key(&self)->Option<&[u8]>{self.controller.as_ref().map(CovenantPublicKey::bytes)}
    fn encode(&self,signature:Option<&[u8]>)->Script{
        let mut bytes=Vec::new();
        for(i,field)in self.fields.iter().enumerate(){push_data(&mut bytes,if i==0&&self.controller.is_some(){signature.unwrap()}else{field});}
        Script::from_bytes(bytes)
    }
    pub fn max_unlocking_script_bytes(&self)->usize{self.encode(self.controller.as_ref().map(|_|MAX_SIGNATURE.as_slice())).as_bytes().len()}
    pub fn finalize(&self,signature:Option<&[u8]>)->Result<Script,EngineError>{
        match (&self.controller,signature){
            (Some(key),Some(signature))=>key.verify_transaction_signature(&self.digest,signature)?,
            (None,None)=>{},
            _=>return Err(invalid("Pool signature must be present only for controller profile")),
        }
        Ok(self.encode(signature))
    }
}
pub fn prepare_unlock(options:UnlockOptions<'_>)->Result<PreparedUnlock,EngineError>{
    let tx=options.current_tx;let parent=options.parent;let ancestor=options.ancestor;
    for material in [tx,parent,ancestor]{check_transaction(material)?;}
    if tx.inputs.len()!=options.operation.auxiliary_inputs()+1||options.auxiliary_parents.len()!=options.operation.auxiliary_inputs(){
        return Err(invalid("Pool auxiliary input count differs from active branch"));
    }
    let mut seen=BTreeSet::new();
    for input in &tx.inputs{if !seen.insert((input.previous_output.txid.to_string(),input.previous_output.vout)){return Err(invalid("Pool repeats input outpoint"));}}
    if parent_link(tx,0,parent)?!=0{return Err(invalid("Pool input zero must consume parent Code zero"));}
    let ancestor_vout=parent_link(parent,0,ancestor)?;
    let (profile,previous_tape)=pool_profile(parent)?;
    let (_,next_tape)=pool_profile(tx)?;
    previous_tape.same_configuration(&next_tape).map_err(|_|invalid("Pool identity or fee configuration changed"))?;
    let code=output(parent,0)?;
    if code.script_pubkey!=output(tx,0)?.script_pubkey||&hash::sha256(code.script_pubkey.as_bytes())!=options.expected_pool_hash{
        return Err(invalid("Pool Code differs from bound identity or previous Code"));
    }
    let mut original=Vec::new();parent.inputs[0].previous_output.serialize(&mut original);
    if original.as_slice()!=profile.original_utxo && (ancestor_vout!=0||output(ancestor,ancestor_vout)?.script_pubkey!=code.script_pubkey){
        return Err(invalid("Pool ancestry is neither original source nor same Pool Code"));
    }
    let controller=match (&profile.authorization,options.controller_public_key){
        (Authorization::Public,None)=>None,
        (Authorization::Controller(_),Some(key))=>{
            profile.authorization.verify_controller(key).map_err(|_|invalid("Pool controller not in bound whitelist"))?;
            Some(CovenantPublicKey::parse(key)?)
        },
        _=>return Err(invalid("Pool controller key required only for controller profile")),
    };
    let layout=output_layout(options.operation,tx.outputs.len())?;
    let mut fields=Vec::new();
    if let Some(key)=&controller{fields.push(Vec::new());fields.push(key.bytes().to_vec());}
    fields.extend(context(tx,options.operation,&layout)?);
    for(vin,other)in options.auxiliary_parents.iter().enumerate(){
        check_transaction(other)?;let vout=parent_link(tx,vin+1,other)?;
        fields.push(vlio(other));fields.push(inputs_hash_data(other));fields.push(output_records(&other.outputs[..vout]));
        fields.extend(output_fields(output(other,vout)?)?);fields.push(output_records(&other.outputs[vout+1..]));
    }
    fields.push(input_records(tx));fields.push(unsigned_script_num(options.operation as usize));
    let previous=output(ancestor,ancestor_vout)?;
    fields.extend([vlio(ancestor),inputs_hash_data(ancestor),output_records(&ancestor.outputs[..ancestor_vout]),
        previous.satoshis.to_le_bytes().to_vec(),hash::sha256(previous.script_pubkey.as_bytes()).to_vec(),output_records(&ancestor.outputs[ancestor_vout+1..])]);
    fields.extend([vlio(parent),input_records(parent),unlocking_scripts_hash(parent),code.satoshis.to_le_bytes().to_vec(),
        hash::sha256(code.script_pubkey.as_bytes()).to_vec(),parent.outputs[1].satoshis.to_le_bytes().to_vec(),
        parent.outputs[1].script_pubkey.as_bytes().to_vec(),output_records(&parent.outputs[2..])]);
    if fields.len()!=options.operation.leaf_count(controller.is_some()){return Err(invalid("Pool active ABI count mismatch"));}
    // A public Pool has no controller signature. Do not compute an unused
    // signature digest (or manufacture an extra signing request) for it.
    let digest=if controller.is_some(){
        forkid_sighash(tx,0,&code.script_pubkey,code.satoshis,DEFAULT_SIGHASH).map_err(|_|invalid("Pool digest invalid"))?
    }else{[0;32]};
    Ok(PreparedUnlock{fields,digest,controller})
}
