//! Native-funded LOP sell make/cancel. Caller supplies authenticated chain
//! material; no private key, HTTP, UI, persistence or automatic input selection.
use std::collections::BTreeSet;
use tbc_sdk::{PublicKey, Transaction, TxIn, TxOut, UtxoInfo, script::Script};
use crate::{EngineError, ErrorCode, signing::{PlannedInput,PlannedOutput,PlannedTransaction,
    PublicSigningContext,UnsignedPlan,MAX_SIGNING_PLAN_INPUTS}};
use super::{lop::{Code,Market,Side,TapeMarker},tbc20,coin,tbc20_mint::fee_for_size};

pub(crate) const CANCEL_DESCRIPTOR:&str="tbc-lop-cancel";
const MAX_SAFE_INTEGER:u64=9_007_199_254_740_991;
const MAX_SELL_FUNDING:usize=10;
const CHANGE_DUST:u64=42;
pub struct LopPlan {pub unsigned_plan:UnsignedPlan,pub fee:u64,pub maximum_signed_bytes:usize}
fn invalid(message:&str)->EngineError{EngineError{code:ErrorCode::InvalidPlan,message:message.into(),path:None}}
fn insufficient()->EngineError{EngineError{code:ErrorCode::InsufficientFunds,message:"LOP funding cannot cover outputs and bounded fee".into(),path:None}}
fn hex(b:&[u8])->String{b.iter().map(|v|format!("{v:02x}")).collect()}
fn total(inputs:&[UtxoInfo])->Result<u64,EngineError>{
    if inputs.is_empty()||inputs.len()>MAX_SIGNING_PLAN_INPUTS{return Err(invalid("LOP input count outside shared bounds"));}
    let mut seen=BTreeSet::new();let mut sum=0u64;
    for u in inputs{
        if u.satoshis==0||!seen.insert((u.outpoint.txid.to_string(),u.outpoint.vout)){return Err(invalid("LOP input is empty or duplicated"));}
        sum=sum.checked_add(u.satoshis).filter(|n|*n<=MAX_SAFE_INTEGER).ok_or_else(||invalid("LOP input sum exceeds safe atomic range"))?;
    }Ok(sum)
}
fn require_funding(inputs:&[UtxoInfo],owner:&PublicKey)->Result<(),EngineError>{
    if inputs.iter().any(|u|u.script_pubkey!=Script::p2pkh(&owner.hash160())){return Err(invalid("LOP fee funding does not belong to owner"));}Ok(())
}
fn estimate(inputs:&[UtxoInfo],outputs:Vec<TxOut>,cancel:bool)->usize{
    Transaction{version:10,lock_time:0,inputs:inputs.iter().enumerate().map(|(i,u)|{
        let mut txin=TxIn::new(u.outpoint.clone());txin.script_sig=Script::from_bytes(vec![0;107+usize::from(cancel&&i==0)]);txin
    }).collect(),outputs}.serialize().len()
}
fn assemble(inputs:&[UtxoInfo],owner:&PublicKey,mut outputs:Vec<TxOut>,cancel:bool,max_fee:u64)->Result<LopPlan,EngineError>{
    let input_value=total(inputs)?;
    let spent=outputs.iter().try_fold(0u64,|sum,o|sum.checked_add(o.satoshis)).ok_or_else(||invalid("LOP output sum overflow"))?;
    let remaining=input_value.checked_sub(spent).ok_or_else(insufficient)?;
    let owner_script=Script::p2pkh(&owner.hash160());
    let mut with_change=outputs.clone();with_change.push(TxOut{satoshis:CHANGE_DUST,script_pubkey:owner_script.clone()});
    let maximum=estimate(inputs,with_change,cancel);let proposed_fee=fee_for_size(maximum)?;
    let (fee,size)=if let Some(change)=remaining.checked_sub(proposed_fee).filter(|v|*v>=CHANGE_DUST){
        outputs.push(TxOut{satoshis:change,script_pubkey:owner_script});(proposed_fee,maximum)
    }else{
        let size=estimate(inputs,outputs.clone(),cancel);
        if remaining<fee_for_size(size)?{return Err(insufficient());}(remaining,size)
    };
    if fee>max_fee{return Err(EngineError{code:ErrorCode::FeeCapExceeded,message:"LOP fee exceeds caller cap".into(),path:None});}
    let identity=PublicSigningContext{address:owner.address().to_string(),public_key:hex(&owner.to_bytes()),public_key_hash:hex(&owner.hash160())};
    let role=if cancel{"tbc-lop-cancel"}else{"tbc-lop-create"};
    Ok(LopPlan{fee,maximum_signed_bytes:size,unsigned_plan:UnsignedPlan{evidence_table:vec![],transactions:vec![PlannedTransaction{
        transaction_id:role.into(),role:role.into(),stage:0,depends_on:vec![],version:10,lock_time:0,
        inputs:inputs.iter().enumerate().map(|(i,u)|PlannedInput{previous_transaction_id:u.outpoint.txid.to_string(),previous_output_index:u.outpoint.vout,
            previous_output_satoshis:u.satoshis,previous_output_script:hex(u.script_pubkey.as_bytes()),sequence:u32::MAX,
            unlocking_script:if cancel&&i==0{CANCEL_DESCRIPTOR.into()}else{String::new()},signer:identity.clone()}).collect(),
        outputs:outputs.iter().map(|o|PlannedOutput{satoshis:o.satoshis,locking_script:hex(o.script_pubkey.as_bytes())}).collect(),
    }]}})
}
/// New TBC20/Coin quote Code must match the order's embedded midstate/size.
/// This does not authenticate a caller-supplied public asset ID; the public
/// planner must bind that ID to its authenticated Genesis/issuer anchor.
pub fn build_native_sell_plan(funding:&[UtxoInfo],owner:&PublicKey,code:&Code,quote_code:&[u8],max_fee:u64)->Result<LopPlan,EngineError>{
    if funding.len()>MAX_SELL_FUNDING||code.side!=Side::Sell||code.terms.owner_hash!=owner.hash160()||code.terms.sale_volume>MAX_SAFE_INTEGER{
        return Err(invalid("LOP sell shape, owner or amount invalid"));
    }
    code.terms.validate_new_order().map_err(|_|invalid("LOP new order numeric terms invalid"))?;
    let Market::NativeToken{token_code_bytes,marker}=code.market else{return Err(invalid("Native LOP sell requires one quote asset"));};
    let identity=tbc20::code_identity(quote_code).or_else(|_|coin::code_identity(quote_code).map_err(|_|tbc20::CodecError::CodeTemplate))
        .map_err(|_|invalid("LOP quote requires an exact supported Token Code"))?;
    if marker!=TapeMarker::Modern||usize::from(token_code_bytes)!=quote_code.len()||identity[..32]!=code.terms.asset_a.partial_hash{
        return Err(invalid("LOP quote identity differs from supplied Token Code"));
    }
    require_funding(funding,owner)?;
    let script=code.encode().map_err(|_|invalid("LOP Code fields inconsistent"))?;
    assemble(funding,owner,vec![TxOut{satoshis:code.terms.sale_volume,script_pubkey:Script::from_bytes(script)}],false,max_fee)
}
/// Return the entire selected order value to its owner. Independent P2PKH fee
/// inputs cover the fee; the order amount is not silently reduced or redirected.
pub fn build_native_cancel_plan(order:&UtxoInfo,funding:&[UtxoInfo],owner:&PublicKey,max_fee:u64)->Result<LopPlan,EngineError>{
    let code=Code::decode(order.script_pubkey.as_bytes()).map_err(|_|invalid("LOP cancellation requires exact latest Code"))?;
    if code.side!=Side::Sell||!matches!(code.market,Market::NativeToken{..})||code.terms.owner_hash!=owner.hash160()||order.satoshis!=code.terms.sale_volume{
        return Err(invalid("LOP native cancellation role, market or value mismatch"));
    }
    require_funding(funding,owner)?;
    let mut inputs=Vec::with_capacity(1+funding.len());inputs.push(order.clone());inputs.extend_from_slice(funding);
    assemble(&inputs,owner,vec![TxOut{satoshis:order.satoshis,script_pubkey:Script::p2pkh(&owner.hash160())}],true,max_fee)
}
