//! LOP permissionless match-branch proof serializer, pinned orderbookunlock.ts.
//! Does not sign and is NOT settlement validation. Business construction must
//! bind prices, taxes, assets and continuation; the covenant verifies execution.
use tbc_sdk::{Transaction,TxOut,script::Script,contracts::ft::partial_sha256::calculate_partial_hash};
use crate::{EngineError,ErrorCode};
use super::{lop::{Code,Market,Side,NATIVE_DATA_BYTES,TOKEN_DATA_BYTES},tbc20,coin,
    tbc20_proof::check_transaction,transaction_proof::{vlio,input_record,unlocking_scripts_hash}};
fn invalid(message:&str)->EngineError{EngineError{code:ErrorCode::InvalidAncestry,message:message.into(),path:None}}
// Exact pinned ABI uses length pushes, not ScriptNum shortcuts for single bytes.
fn push(out:&mut Vec<u8>,value:&[u8])->Result<(),EngineError>{
    match value.len(){0..=75=>out.push(value.len()as u8),76..=255=>out.extend_from_slice(&[0x4c,value.len()as u8]),
        256..=65535=>{out.push(0x4d);out.extend_from_slice(&(value.len()as u16).to_le_bytes());},
        _=>return Err(invalid("LOP proof element exceeds push encoding budget")),}
    out.extend_from_slice(value);Ok(())
}
fn output_fields(out:&mut Vec<u8>,output:&TxOut,offset:usize)->Result<(),EngineError>{
    let script=output.script_pubkey.as_bytes();
    if script.is_empty()||script.len()>65535||offset>script.len()||offset%64!=0{return Err(invalid("LOP proof script split invalid"));}
    push(out,&output.satoshis.to_le_bytes())?;push(out,&script[offset..])?;
    if offset==0{push(out,&[])?;}else{push(out,&calculate_partial_hash(&script[..offset]))?;}
    if script.len()<256{push(out,&[script.len()as u8])?;}else{push(out,&(script.len()as u16).to_le_bytes())?;}
    Ok(())
}
fn lop_offset(code:&Code,script:&[u8])->usize{script.len()-if matches!(code.market,Market::TokenToken{..}){TOKEN_DATA_BYTES}else{NATIVE_DATA_BYTES}}
fn current_outputs(tx:&Transaction,slots:usize)->Result<Vec<u8>,EngineError>{
    if tx.outputs.len()>slots{return Err(invalid("LOP current outputs exceed covenant slots"));}
    let mut out=vec![];let mut i=0;
    while i<tx.outputs.len(){
        let output=&tx.outputs[i];let script=output.script_pubkey.as_bytes();
        let standard=tbc20::code_identity(script).is_ok();let token=standard||coin::code_identity(script).is_ok();
        let offset=if token{script.len()/64*64}else if let Ok(code)=Code::decode(script){lop_offset(&code,script)}else{
            // The pinned current-output writer cannot reliably encode a generic
            // long script midstate. Match layouts use only P2PKH/placeholders here.
            if script.len()>=64{return Err(invalid("LOP current output is not a supported match template"));}0
        };
        output_fields(&mut out,output,offset)?;
        if token{
            let tape=tx.outputs.get(i+1).ok_or_else(||invalid("LOP Token Tape output missing"))?;
            if tape.satoshis!=0{return Err(invalid("LOP Token Tape must have zero native value"));}
            if standard{tbc20::parse_tape(tape.script_pubkey.as_bytes()).map_err(|_|invalid("LOP TBC20 Tape invalid"))?;}
            else{coin::parse_tape(tape.script_pubkey.as_bytes(),None).map_err(|_|invalid("LOP Coin Tape invalid"))?;}
            push(&mut out,&tape.satoshis.to_le_bytes())?;push(&mut out,tape.script_pubkey.as_bytes())?;i+=1;
        }i+=1;
    }
    let missing=slots-tx.outputs.len();out.resize(out.len()+if missing>0{missing*4-2}else{0},0);Ok(out)
}
fn parent_fields(parent:&Transaction,vout:usize,code:&Code,slots:usize)->Result<Vec<u8>,EngineError>{
    if parent.inputs.len()>10||parent.outputs.len()>slots{return Err(invalid("LOP parent exceeds covenant input/output slots"));}
    let mut out=vec![];push(&mut out,&vlio(parent))?;
    for i in 0..10{if i<parent.inputs.len(){push(&mut out,&input_record(parent,i))?;}else{push(&mut out,&[])?;}}
    push(&mut out,&unlocking_scripts_hash(parent))?;
    for(i,output)in parent.outputs.iter().enumerate(){let script=output.script_pubkey.as_bytes();
        let offset=if i==vout{lop_offset(code,script)}else{script.len()/64*64};output_fields(&mut out,output,offset)?;
    }
    out.resize(out.len()+(slots-parent.outputs.len())*4,0);Ok(out)
}
/// Exact order parent, selected input and current outputs are required. No
/// extra ancestry, HTTP or private key is needed by the order match covenant.
fn bound_order(current:&Transaction,parent:&Transaction,input_index:usize)->Result<(usize,Code),EngineError>{
    check_transaction(parent)?;
    let input=current.inputs.get(input_index).ok_or_else(||invalid("LOP match input missing"))?;
    if input.previous_output.txid!=parent.txid(){return Err(invalid("LOP match parent does not match outpoint"));}
    let vout=input.previous_output.vout as usize;let output=parent.outputs.get(vout).ok_or_else(||invalid("LOP order output missing"))?;
    let code=Code::decode(output.script_pubkey.as_bytes()).map_err(|_|invalid("LOP exact order Code required"))?;
    if input_index!=if code.side==Side::Buy{0}else{2}{return Err(invalid("LOP match input role index mismatch"));}
    let token=matches!(code.market,Market::TokenToken{..});
    if current.inputs.len()>if token{6}else{10}{return Err(invalid("LOP current inputs exceed covenant bounds"));}
    Ok((vout,code))
}
pub fn build_match_unlock(current:&Transaction,parent:&Transaction,input_index:usize)->Result<Script,EngineError>{
    check_transaction(current)?;let(vout,code)=bound_order(current,parent,input_index)?;
    let slots=if matches!(code.market,Market::TokenToken{..}){12}else{10};
    let mut bytes=current_outputs(current,slots)?;bytes.extend_from_slice(&parent_fields(parent,vout,&code,slots)?);bytes.push(0x51);
    Ok(Script::from_bytes(bytes))
}
/// The normal two-order path parses/encodes current outputs only once.
pub fn build_match_unlock_pair(current:&Transaction,buy_parent:&Transaction,sell_parent:&Transaction)->Result<[Script;2],EngineError>{
    check_transaction(current)?;
    let(buy_vout,buy)=bound_order(current,buy_parent,0)?;let(sell_vout,sell)=bound_order(current,sell_parent,2)?;
    if buy.market!=sell.market{return Err(invalid("LOP paired proof markets differ"));}
    let slots=if matches!(buy.market,Market::TokenToken{..}){12}else{10};let shared=current_outputs(current,slots)?;
    let encode=|parent,vout,code|->Result<Script,EngineError>{let mut bytes=shared.clone();bytes.extend_from_slice(&parent_fields(parent,vout,code,slots)?);bytes.push(0x51);Ok(Script::from_bytes(bytes))};
    Ok([encode(buy_parent,buy_vout,&buy)?,encode(sell_parent,sell_vout,&sell)?])
}
