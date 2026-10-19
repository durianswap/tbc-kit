//! Keyless LOP match construction from selected, independently authenticated
//! order/token material. No HTTP, key custody, database or wallet policy.
use std::collections::{BTreeMap,BTreeSet};
use tbc_sdk::{Transaction,script::Script};
use crate::{EngineError,ErrorCode,signing::{UnsignedPlan,PlannedTransaction,PlannedInput,PlannedOutput,
    Tbc20OutputGroup,Tbc20UnlockRecipe,Tbc20ContractControllerReference,LopMatchUnlockRecipe,
    lop_match_unlocking_descriptor,tbc20_unlocking_descriptor,coin_unlocking_descriptor,maximum_signed_transaction_sizes}};
use super::{lop::{Code,Market,Side,TapeMarker},lop_transaction::LopPlan,
    lop_settlement::{quote_match,validate_match_receivers},coin,
    controlled_token::{Material,inspect,pair,recipe,selected_input,fee_input},
    tbc20_transfer::{FeeInput,intern,public_context},tbc20_mint::fee_for_size};
pub use super::controlled_token::{TokenInput,TokenProfile,ChainContext};
pub struct OrderInput<'a>{pub parent:&'a Transaction,pub vout:u32}
pub struct AssetInput<'a>{pub profile:TokenProfile,pub token:TokenInput<'a>,pub expected_identity:&'a [u8]}
pub struct MatchOptions<'a>{
    pub buy:OrderInput<'a>,pub sell:OrderInput<'a>,pub quote:AssetInput<'a>,
    /// None only for the native-TBC sell side.
    pub base:Option<AssetInput<'a>>,pub funding:&'a FeeInput<'a>,pub chain:ChainContext,pub max_fee:u64,
}
fn invalid(message:&str)->EngineError{EngineError{code:ErrorCode::InvalidPlan,message:message.into(),path:None}}
fn hex(bytes:&[u8])->String{bytes.iter().map(|v|format!("{v:02x}")).collect()}
fn owner(hash:[u8;20])->[u8;21]{let mut c=[0;21];c[..20].copy_from_slice(&hash);c}
fn controlled(code:&Code)->Result<[u8;21],EngineError>{let mut c=[0;21];c[..20].copy_from_slice(&code.token_controller().map_err(|_|invalid("LOP continuation Code invalid"))?);c[20]=1;Ok(c)}
fn native_output(hash:[u8;20],amount:u64)->PlannedOutput{PlannedOutput{satoshis:amount,locking_script:hex(Script::p2pkh(&hash).as_bytes())}}
fn read_order(input:&OrderInput<'_>,side:Side)->Result<Code,EngineError>{
    let output=input.parent.outputs.get(input.vout as usize).ok_or_else(||invalid("LOP selected order missing"))?;
    let code=Code::decode(output.script_pubkey.as_bytes()).map_err(|_|invalid("LOP selected Code invalid"))?;
    if code.side!=side{return Err(invalid("LOP selected order side mismatch"));}
    if (side==Side::Buy||matches!(code.market,Market::TokenToken{..}))&&output.satoshis!=300{return Err(invalid("LOP Token order native value must be 300"));}
    Ok(code)
}
fn asset_material(asset:&AssetInput<'_>,order:&OrderInput<'_>,code:&Code,quote:bool,chain:ChainContext)->Result<Material,EngineError>{
    if asset.token.parent.txid()!=order.parent.txid()||order.vout.checked_add(1)!=Some(asset.token.vout){return Err(invalid("LOP Token must be the selected order's adjacent pair"));}
    let m=inspect(&asset.token,asset.profile,asset.expected_identity)?;
    let terms=if quote&&matches!(code.market,Market::TokenToken{..}){code.terms.asset_b.as_ref().ok_or_else(||invalid("LOP quote identity missing"))?}else{&code.terms.asset_a};
    if asset.expected_identity.len()<32||asset.expected_identity[..32]!=terms.partial_hash||m.controller!=controlled(code)?||!chain.mature(m.lock){
        return Err(invalid("LOP Token identity, controller or maturity mismatch"));
    }
    Ok(m)
}
fn token_output(profile:TokenProfile,m:&Material,controller:[u8;21],amount:u64,vin:usize,outputs:&mut Vec<PlannedOutput>,groups:&mut Vec<Tbc20OutputGroup>)->Result<(),EngineError>{
    let mut slots=[0;6];slots[vin]=amount;pair(profile,m,controller,slots,outputs,groups)
}
pub fn build_match_plan(options:MatchOptions<'_>)->Result<LopPlan,EngineError>{
    let buy=read_order(&options.buy,Side::Buy)?;let sell=read_order(&options.sell,Side::Sell)?;
    let native=matches!(buy.market,Market::NativeToken{..});let key=options.funding.public_key;
    if native!=options.base.is_none(){return Err(invalid("LOP base asset presence differs from market"));}
    validate_match_receivers(&buy,&sell,key.hash160(),buy.tax_hash,sell.tax_hash).map_err(|_|invalid("LOP matcher change conflicts with order owner"))?;
    let b=asset_material(&options.quote,&options.buy,&buy,true,options.chain)?;
    let a=options.base.as_ref().map(|asset|asset_material(asset,&options.sell,&sell,false,options.chain)).transpose()?;
    match buy.market{
        Market::NativeToken{marker,token_code_bytes}=>if marker!=TapeMarker::Modern||usize::from(token_code_bytes)!=b.code.len(){return Err(invalid("LOP native market Token profile differs"));},
        Market::TokenToken{a,b}=>if a!=TapeMarker::Modern||b!=TapeMarker::Modern{return Err(invalid("LOP match requires current Token profiles"));},
    }
    let native_sell=options.sell.parent.outputs[options.sell.vout as usize].satoshis;
    let narrow=|n:u128|u64::try_from(n).map_err(|_|invalid("LOP selected balance exceeds u64"));
    let settlement=quote_match(&buy,&sell,match &a{Some(a)=>narrow(a.balance)?,None=>native_sell},narrow(b.balance)?)
        .map_err(|e|invalid(e.0))?;
    let continuation=settlement.continuation(&buy,&sell).map_err(|e|invalid(e.0))?;
    let lock=coin::required_lock_time(&[b.lock,a.as_ref().map_or(0,|a|a.lock)]).map_err(|_|invalid("LOP Coin locks mix height/time domains"))?;
    let mut outputs=vec![];let mut groups=vec![];
    token_output(options.quote.profile,&b,owner(sell.terms.owner_hash),settlement.b_to_seller,1,&mut outputs,&mut groups)?;
    token_output(options.quote.profile,&b,owner(sell.tax_hash),settlement.b_tax,1,&mut outputs,&mut groups)?;
    if let(Some(a),Some(asset))=(&a,&options.base){
        token_output(asset.profile,a,owner(buy.terms.owner_hash),settlement.a_to_buyer,3,&mut outputs,&mut groups)?;
        token_output(asset.profile,a,owner(buy.tax_hash),settlement.a_tax,3,&mut outputs,&mut groups)?;
    }else{
        groups.push(Tbc20OutputGroup{code_vout:outputs.len()as u32,tape_vout:None});outputs.push(native_output(buy.terms.owner_hash,settlement.a_to_buyer));
        groups.push(Tbc20OutputGroup{code_vout:outputs.len()as u32,tape_vout:None});
        outputs.push(if settlement.native_zero_tax_placeholder{let mut script=vec![0,0x6a,0x16];script.extend_from_slice(&[0xff;22]);PlannedOutput{satoshis:0,locking_script:hex(&script)}}else{native_output(buy.tax_hash,settlement.a_tax)});
    }
    let change_index=outputs.len();groups.push(Tbc20OutputGroup{code_vout:change_index as u32,tape_vout:None});outputs.push(native_output(key.hash160(),24));
    if let Some(next)=continuation{
        groups.push(Tbc20OutputGroup{code_vout:outputs.len()as u32,tape_vout:None});
        outputs.push(PlannedOutput{satoshis:if native&&next.side==Side::Sell{settlement.sell_remaining}else{300},
            locking_script:hex(&next.encode().map_err(|_|invalid("LOP continuation Code invalid"))?)});
        if next.side==Side::Buy{token_output(options.quote.profile,&b,controlled(&next)?,settlement.b_escrow_change,1,&mut outputs,&mut groups)?;}
        else if let(Some(a),Some(asset))=(&a,&options.base){token_output(asset.profile,a,controlled(&next)?,settlement.a_escrow_change,3,&mut outputs,&mut groups)?;}
    }
    let mut evidence=vec![];let mut ids=BTreeMap::new();
    let buy_source=intern(options.buy.parent,&mut evidence,&mut ids);let sell_source=intern(options.sell.parent,&mut evidence,&mut ids);
    let make_order=|order:&OrderInput<'_>,source|->Result<PlannedInput,EngineError>{let out=&order.parent.outputs[order.vout as usize];Ok(PlannedInput{
        previous_transaction_id:order.parent.txid().to_string(),previous_output_index:order.vout,previous_output_satoshis:out.satoshis,
        previous_output_script:hex(out.script_pubkey.as_bytes()),sequence:u32::MAX,signer:public_context(key),
        unlocking_script:lop_match_unlocking_descriptor(LopMatchUnlockRecipe{parent:source})?,})};
    let mut inputs=vec![make_order(&options.buy,buy_source.clone())?,selected_input(&options.quote.token,&b,key,options.quote.profile),make_order(&options.sell,sell_source.clone())?];
    let mut descriptors:Vec<(usize,TokenProfile,Tbc20UnlockRecipe)>=vec![(1,options.quote.profile,recipe(&options.quote.token,&b,&mut evidence,&mut ids,
        Some(Tbc20ContractControllerReference{source:buy_source,current_input_index:0}))?)];
    if let(Some(a),Some(asset))=(&a,&options.base){inputs.push(selected_input(&asset.token,a,key,asset.profile));
        descriptors.push((3,asset.profile,recipe(&asset.token,a,&mut evidence,&mut ids,Some(Tbc20ContractControllerReference{source:sell_source,current_input_index:2}))?));}
    inputs.push(fee_input(options.funding)?);
    for(index,profile,mut recipe)in descriptors{recipe.output_groups=groups.clone();inputs[index].unlocking_script=match profile{
        TokenProfile::Tbc20=>tbc20_unlocking_descriptor(recipe)?,TokenProfile::Coin=>coin_unlocking_descriptor(recipe)?,};}
    let mut seen=BTreeSet::new();let total=inputs.iter().try_fold(0u64,|sum,i|{
        if !seen.insert((&i.previous_transaction_id,i.previous_output_index)){return Err(invalid("LOP match repeats input"));}
        sum.checked_add(i.previous_output_satoshis).filter(|s|*s<=9_007_199_254_740_991).ok_or_else(||invalid("LOP native total exceeds safe range"))
    })?;
    let fixed=outputs.iter().enumerate().filter(|(i,_)|*i!=change_index).try_fold(0u64,|sum,(_,o)|sum.checked_add(o.satoshis).ok_or_else(||invalid("LOP native output sum overflow")))?;
    let mut plan=UnsignedPlan{evidence_table:evidence,transactions:vec![PlannedTransaction{transaction_id:"tbc-lop-match".into(),role:"tbc-lop-match".into(),
        stage:0,depends_on:vec![],version:10,lock_time:lock,inputs,outputs}]};
    let size=maximum_signed_transaction_sizes(&plan)?[0];let fee=fee_for_size(size)?;
    let change=total.checked_sub(fixed).and_then(|n|n.checked_sub(fee)).filter(|n|*n>=24).ok_or(EngineError{code:ErrorCode::InsufficientFunds,message:"LOP fee funding cannot cover exact outputs and fee".into(),path:None})?;
    if fee>options.max_fee{return Err(EngineError{code:ErrorCode::FeeCapExceeded,message:"LOP match fee exceeds cap".into(),path:None});}
    plan.transactions[0].outputs[change_index].satoshis=change;
    Ok(LopPlan{unsigned_plan:plan,fee,maximum_signed_bytes:size})
}
