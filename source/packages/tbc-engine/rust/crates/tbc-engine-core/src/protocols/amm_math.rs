//! Keyless, read-free Pool3 integer quote rules, pinned to tbc-contract 1.7.0
//! af776161 lib/util/poolnft3/{math,fees}.ts. Not a transaction builder or
//! slippage authorization. Pricing reserves and actual Code value stay distinct.
use super::amm::{amount,AmmError,Result,MAX_AMOUNT,CODE_DUST,MIN_PAYOUT};
use serde::Serialize;

#[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize)]
#[serde(rename_all="camelCase")]
pub struct State {pub ft_lp_amount:u64,pub ft_a_amount:u64,pub tbc_amount:u64,pub pool_value:u64}
impl State {
    pub fn validate(self,active:bool)->Result<Self>{
        for v in [self.ft_lp_amount,self.ft_a_amount,self.tbc_amount,self.pool_value]{amount(v)?;}
        if self.pool_value<CODE_DUST{return Err(AmmError("Pool Code value below retained dust"));}
        if active && [self.ft_lp_amount,self.ft_a_amount,self.tbc_amount].contains(&0){return Err(AmmError("Pool is not active"));} Ok(self)
    }
}
fn positive(v:u64)->Result<u64>{amount(v)?;if v==0{Err(AmmError("Positive Pool amount required"))}else{Ok(v)}}
fn narrow(v:u128)->Result<u64>{if v>MAX_AMOUNT as u128{Err(AmmError("Pool amount overflow"))}else{Ok(v as u64)}}
fn proportional(a:u64,b:u64,d:u64,ceil:bool)->Result<u64>{
    if d==0{return Err(AmmError("Zero Pool denominator"));}
    // Valid operands are <=2^63-1, so product plus denominator fits u128.
    let n=a as u128*b as u128;let d=d as u128;narrow((n+if ceil{d-1}else{0})/d)
}
fn add(a:u64,b:u64)->Result<u64>{narrow(a as u128+b as u128)}
fn sub(a:u64,b:u64)->Result<u64>{a.checked_sub(b).ok_or(AmmError("Negative Pool reserve"))}

#[derive(Debug,Clone,Copy,PartialEq,Eq)]
pub struct FeePolicy {pub lp_plan:u8,pub total_fee_bps:u16,pub lp_fee_bps:u16,pub service_fee_address:&'static str}
pub fn fee_policy(plan:u8,rate:Option<u16>)->Result<FeePolicy>{
    let (total,lp,address)=match plan {
        1=>(35,25,"13oCEJaqyyiC8iRrfup6PDL2GKZ3xQrsZL"),2=>(35,5,"1Fa6Uy64Ub4qNdB896zX2pNMx4a8zMhtCy"),
        3=>(135,5,"125fTLNsraQxTYqT4EeQNF2ggzcqicveKL"),4=>(335,5,"19DetoaaohQkjFVJ6oGXd83xhZYQSbpE1g"),
        5=>(535,5,"15EKrhuD8Yf3SfhjAgbizYqfnBbKh9ZMZ7"),6=>(130,80,"1N7rf2AuAHB2aCrVgnbQhSWhaUVk3rGhjm"),
        _=>return Err(AmmError("Pool fee plan must be 1-6")),
    };
    if rate.is_some_and(|r|r!=total){return Err(AmmError("Pool fee rate does not match plan"));}
    Ok(FeePolicy{lp_plan:plan,total_fee_bps:total,lp_fee_bps:lp,service_fee_address:address})
}
#[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Fees {pub base_tbc_sat:u64,pub total_fee_sat:u64,pub lp_fee_sat:u64,pub service_fee_accrued_sat:u64,
    pub service_fee_paid_sat:u64,pub service_fee_retained_sat:u64,pub pool_fee_retained_sat:u64,pub net_amount_sat:u64}
pub fn calculate_fees(base:u64,plan:u8,rate:Option<u16>)->Result<Fees>{
    let policy=fee_policy(plan,rate)?;calculate_with_rates(base,policy.total_fee_bps,policy.lp_fee_bps)
}
/// Only validated configuration calls this arithmetic primitive. Preset lookup
/// is temporarily retained at the old artifact boundary, never in this path.
pub(crate) fn calculate_with_rates(base:u64,total_fee_bps:u16,lp_fee_bps:u16)->Result<Fees>{
    amount(base)?;
    let total=proportional(base,total_fee_bps as u64,10000,false)?;
    let lp=proportional(base,lp_fee_bps as u64,10000,false)?;
    let accrued=total-lp;let paid=if accrued>=MIN_PAYOUT{accrued}else{0};
    Ok(Fees{base_tbc_sat:base,total_fee_sat:total,lp_fee_sat:lp,service_fee_accrued_sat:accrued,
        service_fee_paid_sat:paid,service_fee_retained_sat:accrued-paid,pool_fee_retained_sat:total-paid,net_amount_sat:base-total})
}
#[derive(Debug,Clone,Copy)]
pub enum AddBudget {Tbc{amount:u64,first_ft:Option<u64>},Ft(u64)}
#[derive(Debug,Clone,PartialEq,Eq,Serialize)]
#[serde(rename_all="camelCase")]
pub struct AddQuote {pub next_state:State,#[serde(rename="isFirstAddLP")]pub is_first_add_lp:bool,pub tbc_increment_sat:u64,pub tbc_reserve_increment_sat:u64,pub ft_a_increment_raw:u64,pub ft_lp_increment_raw:u64}
pub fn quote_add(state:State,budget:AddBudget)->Result<AddQuote>{
    state.validate(false)?;
    let (budget,use_tbc,first)=match budget{AddBudget::Tbc{amount,first_ft}=>(amount,true,first_ft),AddBudget::Ft(amount)=>(amount,false,None)};
    positive(budget)?;let empty=state.ft_lp_amount==0&&state.ft_a_amount==0&&state.tbc_amount==0;
    let (tbc,reserve,ft,lp)=if empty {
        if state.pool_value!=CODE_DUST||!use_tbc{return Err(AmmError("First liquidity requires empty dust Pool and TBC budget"));}
        let ft=positive(first.ok_or(AmmError("First liquidity requires explicit FT amount"))?)?;(budget,budget,ft,budget)
    }else{
        if first.is_some(){return Err(AmmError("Initial FT amount only applies to empty Pool"));}
        state.validate(true)?;let actual=state.pool_value-CODE_DUST;
        if actual<state.tbc_amount{return Err(AmmError("Actual reserve below pricing reserve"));}
        let lp=positive(proportional(budget,state.ft_lp_amount,if use_tbc{actual}else{state.ft_a_amount},false)?)?;
        (proportional(actual,lp,state.ft_lp_amount,true)?,proportional(state.tbc_amount,lp,state.ft_lp_amount,true)?,proportional(state.ft_a_amount,lp,state.ft_lp_amount,true)?,lp)
    };
    positive(ft)?;positive(lp)?;
    let next_state=State{pool_value:add(state.pool_value,tbc)?,tbc_amount:add(state.tbc_amount,reserve)?,ft_a_amount:add(state.ft_a_amount,ft)?,ft_lp_amount:add(state.ft_lp_amount,lp)?}.validate(true)?;
    Ok(AddQuote{next_state,is_first_add_lp:empty,tbc_increment_sat:tbc,tbc_reserve_increment_sat:reserve,ft_a_increment_raw:ft,ft_lp_increment_raw:lp})
}
#[derive(Debug,Clone,PartialEq,Eq,Serialize)]
#[serde(rename_all="camelCase")]
pub struct RemoveQuote {pub next_state:State,pub ft_lp_burn_raw:u64,pub ft_a_decrement_raw:u64,pub tbc_decrement_sat:u64,pub pool_value_decrement_sat:u64}
pub fn quote_remove(state:State,burn:u64)->Result<RemoveQuote>{
    state.validate(false)?;positive(burn)?;
    if burn>state.ft_lp_amount{return Err(AmmError("Burn exceeds LP supply"));}
    let ft=proportional(state.ft_a_amount,burn,state.ft_lp_amount,false)?;
    let tbc=proportional(state.tbc_amount,burn,state.ft_lp_amount,false)?;
    let actual=proportional(state.pool_value-CODE_DUST,burn,state.ft_lp_amount,false)?;
    if actual<MIN_PAYOUT{return Err(AmmError("LP payout below minimum"));}
    let next_state=State{pool_value:sub(state.pool_value,actual)?,ft_lp_amount:sub(state.ft_lp_amount,burn)?,ft_a_amount:sub(state.ft_a_amount,ft)?,tbc_amount:sub(state.tbc_amount,tbc)?}.validate(false)?;
    Ok(RemoveQuote{next_state,ft_lp_burn_raw:burn,ft_a_decrement_raw:ft,tbc_decrement_sat:tbc,pool_value_decrement_sat:actual})
}
#[derive(Debug,Clone,PartialEq,Eq,Serialize)]
#[serde(rename_all="camelCase")]
pub struct BuyQuote {pub next_state:State,pub input_tbc_sat:u64,pub effective_tbc_increment_sat:u64,pub pool_value_increment_sat:u64,pub ft_out_raw:u64,pub fees:Fees}
pub fn quote_buy(state:State,input:u64,plan:u8,rate:Option<u16>,minimum:u64)->Result<BuyQuote>{
    state.validate(true)?;positive(input)?;amount(minimum)?;let fees=calculate_fees(input,plan,rate)?;
    // Frozen preset artifacts require positive retained fees. Keep their old
    // behavior until replacement covenants are available and independently tested.
    if input-fees.service_fee_paid_sat<=fees.net_amount_sat{return Err(AmmError("Swap increment or retained fee invalid"));}
    quote_buy_fees(state,input,fees,minimum)
}
pub fn quote_buy_with_fee_policy(state:State,input:u64,policy:&super::amm_fee_policy::FeePolicy,minimum:u64)->Result<BuyQuote>{
    state.validate(true)?;positive(input)?;amount(minimum)?;
    quote_buy_fees(state,input,policy.calculate(input)?,minimum)
}
pub(crate) fn quote_buy_fees(state:State,input:u64,fees:Fees,minimum:u64)->Result<BuyQuote>{
    let effective=fees.net_amount_sat;let actual=input-fees.service_fee_paid_sat;
    if effective==0||effective>=state.tbc_amount||actual<effective{return Err(AmmError("Swap increment or retained fee invalid"));}
    let reserve=add(state.tbc_amount,effective)?;let output=positive(proportional(state.ft_a_amount,effective,reserve,false)?)?;
    if output<minimum{return Err(AmmError("FT minimum output not met"));}
    let next_state=State{pool_value:add(state.pool_value,actual)?,tbc_amount:reserve,ft_a_amount:sub(state.ft_a_amount,output)?,..state}.validate(true)?;
    Ok(BuyQuote{next_state,input_tbc_sat:input,effective_tbc_increment_sat:effective,pool_value_increment_sat:actual,ft_out_raw:output,fees})
}
#[derive(Debug,Clone,PartialEq,Eq,Serialize)]
#[serde(rename_all="camelCase")]
pub struct SellQuote {pub next_state:State,pub input_ft_raw:u64,pub gross_tbc_out_sat:u64,pub tbc_out_sat:u64,pub pool_value_decrement_sat:u64,pub fees:Fees}
pub fn quote_sell(state:State,input:u64,plan:u8,rate:Option<u16>,minimum:u64)->Result<SellQuote>{
    let policy=fee_policy(plan,rate)?;
    let quote=quote_sell_rates(state,input,policy.total_fee_bps,policy.lp_fee_bps,minimum)?;
    if quote.pool_value_decrement_sat>=quote.gross_tbc_out_sat{return Err(AmmError("Swap payout or retained fee invalid"));}Ok(quote)
}
pub fn quote_sell_with_fee_policy(state:State,input:u64,policy:&super::amm_fee_policy::FeePolicy,minimum:u64)->Result<SellQuote>{
    quote_sell_rates(state,input,policy.total_fee_bps(),policy.lp_fee_bps(),minimum)
}
pub(crate) fn quote_sell_rates(state:State,input:u64,total_fee_bps:u16,lp_fee_bps:u16,minimum:u64)->Result<SellQuote>{
    state.validate(true)?;positive(input)?;amount(minimum)?;
    if input>=state.ft_a_amount{return Err(AmmError("FT input must be below old reserve"));}
    let ft=add(state.ft_a_amount,input)?;let gross=positive(proportional(state.tbc_amount,input,ft,false)?)?;
    let fees=calculate_with_rates(gross,total_fee_bps,lp_fee_bps)?;let output=fees.net_amount_sat;let actual=add(output,fees.service_fee_paid_sat)?;
    if output<MIN_PAYOUT||actual==0||actual>gross{return Err(AmmError("Swap payout or retained fee invalid"));}
    if output<minimum{return Err(AmmError("TBC minimum output not met"));}
    let next_state=State{pool_value:sub(state.pool_value,actual)?,tbc_amount:sub(state.tbc_amount,gross)?,ft_a_amount:ft,..state}.validate(true)?;
    Ok(SellQuote{next_state,input_ft_raw:input,gross_tbc_out_sat:gross,tbc_out_sat:output,pool_value_decrement_sat:actual,fees})
}
