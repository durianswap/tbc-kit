//! Shared AMM/LP exact fee reservation. No input selection, I/O or signing.
use crate::{EngineError,ErrorCode,signing::{UnsignedPlan,maximum_signed_transaction_sizes}};
use super::{amm::MIN_PAYOUT,tbc20_material::MAX_MATERIAL_TRANSACTION_BYTES};
const MAX_SAFE:u64=9_007_199_254_740_991;
fn invalid(message:&str)->EngineError{EngineError{code:ErrorCode::InvalidPlan,message:message.into(),path:None}}
fn insufficient()->EngineError{EngineError{code:ErrorCode::InsufficientFunds,message:"AMM funding cannot cover complete witness fee".into(),path:None}}
#[derive(Clone,Copy,Debug)]
pub struct MinerFeePolicy {pub satoshis_per_kb:u64,pub minimum_fee:u64,pub change_dust:u64}
impl Default for MinerFeePolicy {fn default()->Self{Self{satoshis_per_kb:80,minimum_fee:80,change_dust:10}}}
impl MinerFeePolicy {
    pub fn fee(&self,bytes:usize)->Result<u64,EngineError>{
        if self.satoshis_per_kb==0||self.minimum_fee==0||self.change_dust<MIN_PAYOUT
            ||[self.satoshis_per_kb,self.minimum_fee,self.change_dust].iter().any(|v|*v>MAX_SAFE){return Err(invalid("AMM miner fee policy invalid"));}
        let required=((bytes as u128*self.satoshis_per_kb as u128+999)/1000).max(self.minimum_fee as u128);
        u64::try_from(required).ok().filter(|n|*n<=MAX_SAFE).ok_or_else(||invalid("AMM fee exceeds safe amount range"))
    }
}
#[derive(Debug)]
pub struct FeePlan {pub unsigned_plan:UnsignedPlan,pub fee:u64,pub maximum_signed_bytes:usize,pub change_output_index:Option<u32>}
/// `make_plan(true)` appends one native change output containing change_dust.
/// Covenant output groups must already account for that optional output.
pub(crate) fn finish_plan(make_plan:impl Fn(bool)->Result<UnsignedPlan,EngineError>,available:u64,policy:MinerFeePolicy,max_fee:u64)->Result<FeePlan,EngineError>{
    policy.fee(0)?;
    if available<policy.minimum_fee{return Err(insufficient());}
    let with_change=available>=policy.change_dust;
    let mut plan=make_plan(with_change)?;
    if plan.transactions.len()!=1{return Err(invalid("AMM local fee reservation requires one transaction"));}
    let mut size=maximum_signed_transaction_sizes(&plan)?[0];let needed=policy.fee(size)?;
    let (fee,change_output_index)=if with_change&&available.checked_sub(needed).is_some_and(|v|v>=policy.change_dust){
        let outputs=&mut plan.transactions[0].outputs;
        outputs.last_mut().ok_or_else(||invalid("AMM change output missing"))?.satoshis=available-needed;
        (needed,Some((outputs.len()-1) as u32))
    }else{
        if with_change{plan=make_plan(false)?;size=maximum_signed_transaction_sizes(&plan)?[0];}
        if available<policy.fee(size)?{return Err(insufficient());}(available,None)
    };
    if size>MAX_MATERIAL_TRANSACTION_BYTES{return Err(invalid("AMM transaction exceeds byte budget"));}
    if fee>max_fee{return Err(EngineError{code:ErrorCode::FeeCapExceeded,message:"AMM fee exceeds approved cap".into(),path:None});}
    Ok(FeePlan{unsigned_plan:plan,fee,maximum_signed_bytes:size,change_output_index})
}
