//! Selected-material LOP Token escrow, shared keyless proof/signing assembly.
//! Asset IDs must separately be bound to authenticated issuance by the caller.
use std::collections::BTreeMap;
use crate::{EngineError,ErrorCode,signing::{PlannedInput,PlannedOutput,Tbc20OutputGroup,Tbc20ContractControllerReference}};
use super::{coin,tbc20,lop::{Code,Market,Side,TapeMarker,AssetTerms},
    lop_transaction::{LopPlan,CANCEL_DESCRIPTOR},
    tbc20_transfer::{allocate,intern,public_context,FeeInput},
    controlled_token::{address_controller,inspect,pair,recipe,selected_input,fee_input,Assembly}};
pub use super::controlled_token::{TokenProfile,TokenInput,ChainContext};
const PRECISION:u128=1_000_000;
const ORDER_DUST:u64=300;
pub struct MakeOptions<'a>{
    pub profile:TokenProfile,pub inputs:&'a [TokenInput<'a>],pub funding:&'a FeeInput<'a>,
    pub expected_identity:&'a [u8],pub code:&'a Code,
    pub asset_a_code:&'a [u8],pub asset_b_code:Option<&'a [u8]>,
    pub chain:ChainContext,pub max_fee:u64,
}
pub struct CancelOptions<'a>{
    pub profile:TokenProfile,pub token:TokenInput<'a>,pub order_vout:u32,
    pub funding:&'a FeeInput<'a>,pub expected_identity:&'a [u8],
    pub chain:ChainContext,pub max_fee:u64,
}
fn invalid(message:&str)->EngineError{EngineError{code:ErrorCode::InvalidPlan,message:message.into(),path:None}}
fn hex(bytes:&[u8])->String{bytes.iter().map(|b|format!("{b:02x}")).collect()}
fn controller(code:&Code)->Result<[u8;21],EngineError>{
    let mut result=[0;21];result[..20].copy_from_slice(&code.token_controller().map_err(|_|invalid("LOP Code invalid"))?);result[20]=1;Ok(result)
}
fn identity(code:&[u8])->Result<Vec<u8>,EngineError>{
    tbc20::code_identity(code).or_else(|_|coin::code_identity(code).map_err(|_|tbc20::CodecError::CodeTemplate))
        .map(|v|v.to_vec()).map_err(|_|invalid("LOP requires an exact supported Token Code"))
}
fn matches_asset(script:&[u8],terms:&AssetTerms)->Result<(),EngineError>{
    if identity(script)?[..32]!=terms.partial_hash{return Err(invalid("LOP Token midstate differs from order"));}Ok(())
}
fn selected_terms(code:&Code)->Result<&AssetTerms,EngineError>{
    match (code.market,code.side){
        (Market::NativeToken{..},Side::Buy)|(Market::TokenToken{..},Side::Sell)=>Ok(&code.terms.asset_a),
        (Market::TokenToken{..},Side::Buy)=>code.terms.asset_b.as_ref().ok_or_else(||invalid("LOP quote terms missing")),
        _=>Err(invalid("Native sell requires native funding builder")),
    }
}
pub fn build_make_plan(options:MakeOptions<'_>)->Result<LopPlan,EngineError>{
    let code=options.code;let key=options.funding.public_key;
    code.terms.validate_new_order().map_err(|_|invalid("LOP order numeric terms invalid"))?;
    if code.terms.owner_hash!=key.hash160()||options.inputs.is_empty()||options.inputs.len()>5{return Err(invalid("LOP owner or Token input count invalid"));}
    matches_asset(options.asset_a_code,&code.terms.asset_a)?;
    match code.market{
        Market::NativeToken{token_code_bytes,marker}=>{
            if marker!=TapeMarker::Modern||usize::from(token_code_bytes)!=options.asset_a_code.len()||options.asset_b_code.is_some(){return Err(invalid("LOP native market asset shape invalid"));}
        },
        Market::TokenToken{a,b}=>{
            let terms=code.terms.asset_b.as_ref().ok_or_else(||invalid("LOP quote terms missing"))?;
            matches_asset(options.asset_b_code.ok_or_else(||invalid("LOP quote Code missing"))?,terms)?;
            if a!=TapeMarker::Modern||b!=TapeMarker::Modern||terms.contract_id==code.terms.asset_a.contract_id{return Err(invalid("LOP Token pair must contain distinct modern assets"));}
        },
    }
    let selected=selected_terms(code)?;
    let amount=match code.side{Side::Sell=>u128::from(code.terms.sale_volume),Side::Buy=>u128::from(code.terms.sale_volume)*u128::from(code.terms.unit_price)/PRECISION};
    // A later cancellation or match consumes this escrow as one six-slot input.
    if amount==0||amount>u128::from(tbc20::MAX_SLOT_AMOUNT){return Err(invalid("LOP escrow amount outside single spend slot"));}
    let materials=options.inputs.iter().map(|i|inspect(i,options.profile,options.expected_identity)).collect::<Result<Vec<_>,_>>()?;
    let first=&materials[0];let owner=address_controller(key);matches_asset(&first.code,selected)?;
    let selected_code=if matches!(code.market,Market::TokenToken{..})&&code.side==Side::Buy{options.asset_b_code.unwrap()}else{options.asset_a_code};
    if identity(selected_code)?!=options.expected_identity{return Err(invalid("LOP selected asset identity differs from authenticated input"));}
    let envelope=|tape:&[u8]|->Result<Vec<u8>,EngineError>{match options.profile{
        TokenProfile::Tbc20=>tbc20::parse_tape(tape).map(|t|t.extension).map_err(|_|invalid("LOP Token Tape invalid")),
        TokenProfile::Coin=>coin::replace_tape_amounts(tape,[0;6]).and_then(|t|coin::set_lock_time(&t,0)).map_err(|_|invalid("LOP Coin Tape invalid")),
    }};
    for m in &materials{if m.controller!=owner||!options.chain.mature(m.lock)||envelope(&m.tape)?!=envelope(&first.tape)?{return Err(invalid("LOP holder, Coin maturity or Tape envelope mismatch"));}}
    let lock=coin::required_lock_time(&materials.iter().map(|m|m.lock).collect::<Vec<_>>()).map_err(|_|invalid("LOP Coin locks mix domains"))?;
    let mut remaining:Vec<_>=materials.iter().map(|m|m.balance).collect();
    if amount>remaining.iter().sum(){return Err(EngineError{code:ErrorCode::InsufficientFunds,message:"LOP Token balance insufficient".into(),path:None});}
    let mut allocated=vec![];allocate(&mut remaining,controller(code)?,amount,&mut allocated)?;
    if allocated.len()!=1{return Err(invalid("LOP escrow must be one Code group"));}
    let change=remaining.iter().sum();allocate(&mut remaining,owner,change,&mut allocated)?;
    if allocated.len()>2{return Err(invalid("LOP Token change exceeds one Code group"));}
    let mut a=Assembly{profile:options.profile,role:"tbc-lop-create",inputs:vec![],
        outputs:vec![PlannedOutput{satoshis:ORDER_DUST,locking_script:hex(&code.encode().map_err(|_|invalid("LOP Code invalid"))?)}],
        groups:vec![Tbc20OutputGroup{code_vout:0,tape_vout:None}],recipes:vec![],evidence:vec![],lock};
    for out in allocated{pair(options.profile,first,out.controller,out.amounts_by_input,&mut a.outputs,&mut a.groups)?;}
    let mut ids=BTreeMap::new();
    for(input,m)in options.inputs.iter().zip(&materials){let r=recipe(input,m,&mut a.evidence,&mut ids,None)?;a.recipes.push((a.inputs.len(),r));a.inputs.push(selected_input(input,m,key,options.profile));}
    a.inputs.push(fee_input(options.funding)?);
    a.finish(key,options.max_fee).map(|p|LopPlan{unsigned_plan:p.unsigned_plan,fee:p.fee,maximum_signed_bytes:p.maximum_signed_bytes})
}
pub fn build_cancel_plan(options:CancelOptions<'_>)->Result<LopPlan,EngineError>{
    let key=options.funding.public_key;let token=&options.token;
    if options.order_vout.checked_add(1)!=Some(token.vout){return Err(invalid("LOP Token must immediately follow selected order"));}
    let m=inspect(token,options.profile,options.expected_identity)?;
    let escrow=token.parent.outputs.get(options.order_vout as usize).ok_or_else(||invalid("LOP order output missing"))?;
    let code=Code::decode(escrow.script_pubkey.as_bytes()).map_err(|_|invalid("LOP cancellation Code invalid"))?;
    matches_asset(&m.code,selected_terms(&code)?)?;
    if escrow.satoshis!=ORDER_DUST||code.terms.owner_hash!=key.hash160()||m.controller!=controller(&code)?||!options.chain.mature(m.lock){return Err(invalid("LOP cancellation owner, controller, value or maturity mismatch"));}
    let mut a=Assembly{profile:options.profile,role:"tbc-lop-cancel",inputs:vec![PlannedInput{
        previous_transaction_id:token.parent.txid().to_string(),previous_output_index:options.order_vout,
        previous_output_script:hex(escrow.script_pubkey.as_bytes()),previous_output_satoshis:ORDER_DUST,
        sequence:u32::MAX,signer:public_context(key),unlocking_script:CANCEL_DESCRIPTOR.into(),
    }],outputs:vec![],groups:vec![],recipes:vec![],evidence:vec![],lock:m.lock};
    let mut slots=[0;6];slots[1]=u64::try_from(m.balance).ok().filter(|n|*n<=tbc20::MAX_SLOT_AMOUNT).ok_or_else(||invalid("LOP escrow exceeds one spend allocation slot"))?;
    pair(options.profile,&m,address_controller(key),slots,&mut a.outputs,&mut a.groups)?;
    let mut ids=BTreeMap::new();let source=intern(token.parent,&mut a.evidence,&mut ids);
    a.recipes.push((1,recipe(token,&m,&mut a.evidence,&mut ids,Some(Tbc20ContractControllerReference{source,current_input_index:0}))?));
    a.inputs.push(selected_input(token,&m,key,options.profile));a.inputs.push(fee_input(options.funding)?);
    a.finish(key,options.max_fee).map(|p|LopPlan{unsigned_plan:p.unsigned_plan,fee:p.fee,maximum_signed_bytes:p.maximum_signed_bytes})
}
