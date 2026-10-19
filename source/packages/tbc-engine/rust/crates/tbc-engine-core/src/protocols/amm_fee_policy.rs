//! Custom-fee math preparation. Not yet wired to the production AMM codec.
//! Existing scripts can preserve compact custom configuration; zero-retention
//! and exact service-payment constraints remain separate script work. No I/O or signing.
use serde::{Deserialize, Serialize};
use tbc_sdk::Address;
use super::{amm::{AmmError,Result},amm_math::{self,Fees}};

pub const MAX_TOTAL_FEE_BPS:u16=600;

/// Validated once when configuration is accepted; quote paths reuse the value.
/// No preset ID is part of this configuration or its serialized representation.
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase",try_from="FeePolicyInput")]
pub struct FeePolicy {
    total_fee_bps:u16,
    lp_fee_bps:u16,
    service_fee_address:String,
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct FeePolicyInput {total_fee_bps:u16,lp_fee_bps:u16,service_fee_address:String}
impl TryFrom<FeePolicyInput> for FeePolicy {
    type Error=AmmError;
    fn try_from(value:FeePolicyInput)->Result<Self>{Self::new(value.total_fee_bps,value.lp_fee_bps,&value.service_fee_address)}
}
impl FeePolicy {
    pub fn new(total_fee_bps:u16,lp_fee_bps:u16,service_fee_address:&str)->Result<Self>{
        if total_fee_bps>MAX_TOTAL_FEE_BPS||lp_fee_bps>total_fee_bps{return Err(AmmError("AMM fees require 0 <= LP <= total <= 600 bps"));}
        let address=Address::from_string(service_fee_address).map_err(|_|AmmError("AMM service fee address must be canonical P2PKH"))?;
        if address.to_string()!=service_fee_address{return Err(AmmError("AMM service fee address is not canonical"));}
        Ok(Self{total_fee_bps,lp_fee_bps,service_fee_address:service_fee_address.into()})
    }
    pub fn total_fee_bps(&self)->u16{self.total_fee_bps}
    pub fn lp_fee_bps(&self)->u16{self.lp_fee_bps}
    pub fn service_fee_bps(&self)->u16{self.total_fee_bps-self.lp_fee_bps}
    pub fn service_fee_address(&self)->&str{&self.service_fee_address}
    pub fn calculate(&self,base:u64)->Result<Fees>{amm_math::calculate_with_rates(base,self.total_fee_bps,self.lp_fee_bps)}
}
