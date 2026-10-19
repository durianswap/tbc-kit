//! One material/planning profile for deployed preset and explicit-fee AMM.
//! Profile selection comes from exact Code AND Tape, never API labels or a
//! shared marker. Both profiles use the same business planner and signer.
use serde::{Deserialize, Serialize};
use tbc_sdk::{Address, hash};
use super::{amm::{self, AmmError, Result}, amm_code::{self, Authorization},
    amm_explicit as explicit, amm_math::{self, State, BuyQuote, SellQuote}};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag="format", rename_all="camelCase", rename_all_fields="camelCase", deny_unknown_fields)]
pub enum FeeTerms {
    Preset { lp_plan: u8, service_fee_rate: u16 },
    Explicit { rates: explicit::FeeRates, fee_address: String },
}
#[derive(Clone, Debug)]
pub enum FeePolicy { Preset(amm_math::FeePolicy), Explicit(explicit::FeePolicy) }
impl FeeTerms {
    pub fn policy(&self)->Result<FeePolicy>{match self {
        Self::Preset{lp_plan,service_fee_rate}=>amm_math::fee_policy(*lp_plan,Some(*service_fee_rate)).map(FeePolicy::Preset),
        Self::Explicit{rates,fee_address}=>explicit::FeePolicy::new(*rates,fee_address).map(FeePolicy::Explicit),
    }}
}
impl FeePolicy {
    pub fn total_fee_bps(&self)->u16{match self {Self::Preset(p)=>p.total_fee_bps,Self::Explicit(p)=>p.total_fee_bps()}}
    pub fn lp_fee_bps(&self)->u16{match self {Self::Preset(p)=>p.lp_fee_bps,Self::Explicit(p)=>p.lp_fee_bps()}}
    pub fn fee_address(&self)->String{match self {Self::Preset(p)=>p.service_fee_address.into(),Self::Explicit(p)=>p.fee_address()}}
    pub fn quote_buy(&self,state:State,input:u64,minimum:u64)->Result<BuyQuote>{match self {
        Self::Preset(p)=>amm_math::quote_buy(state,input,p.lp_plan,Some(p.total_fee_bps),minimum),
        Self::Explicit(p)=>p.quote_buy(state,input,minimum),
    }}
    pub fn quote_sell(&self,state:State,input:u64,minimum:u64)->Result<SellQuote>{match self {
        Self::Preset(p)=>amm_math::quote_sell(state,input,p.lp_plan,Some(p.total_fee_bps),minimum),
        Self::Explicit(p)=>p.quote_sell(state,input,minimum),
    }}
}

/// Serializable immutable configuration used by deferred genesis descriptors.
/// Explicit tags are raw bytes; Some(empty) is different from historical None.
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Profile { pub fees:FeeTerms, pub service_provider_tag:Option<Vec<u8>> }
impl Profile {
    pub fn preset(plan:u8,rate:Option<u16>)->Result<Self>{
        let p=amm_math::fee_policy(plan,rate)?;
        Ok(Self{fees:FeeTerms::Preset{lp_plan:plan,service_fee_rate:p.total_fee_bps},service_provider_tag:None})
    }
    pub fn explicit(rates:explicit::FeeRates,address:&str,tag:Vec<u8>)->Result<Self>{
        let p=Self{fees:FeeTerms::Explicit{rates,fee_address:address.into()},service_provider_tag:Some(tag)};p.validate()?;Ok(p)
    }
    pub fn validate(&self)->Result<FeePolicy>{
        match (&self.fees,&self.service_provider_tag) {
            (FeeTerms::Preset{..},None)|(FeeTerms::Explicit{..},Some(_))=>self.fees.policy(),
            _=>Err(AmmError("AMM Code/Tape format mismatch")),
        }
    }
    pub fn code(&self,original_utxo:[u8;36],ft_tape_size:u8,authorization:Authorization)->Result<Code>{
        let policy=self.validate()?;
        let address=Address::from_string(&policy.fee_address()).map_err(|_|AmmError("AMM fee address invalid"))?;
        Ok(Code{original_utxo,fee_script_hash:hash::sha256(address.script_pubkey().as_bytes()),ft_tape_size,authorization,
            service_provider_tag:self.service_provider_tag.clone()})
    }
    pub fn from_parts(code:&Code,tape:&Tape)->Result<Self>{
        let profile=Self{fees:tape.fees.clone(),service_provider_tag:code.service_provider_tag.clone()};
        let expected=profile.code(code.original_utxo,code.ft_tape_size,code.authorization.clone())?;
        if expected.fee_script_hash!=code.fee_script_hash{return Err(AmmError("AMM fee address differs from Code commitment"));}
        let controlled=matches!(code.authorization,Authorization::Controller(_));
        if tape.with_swap_hash_lock!=controlled || tape.with_lp_hash_lock!=controlled{return Err(AmmError("AMM Code/Tape authority mismatch"));}
        Ok(profile)
    }
    pub fn is_explicit(&self)->bool{matches!(self.fees,FeeTerms::Explicit{..})}
}

#[derive(Clone,Debug,PartialEq,Eq)]
pub struct Code {
    pub original_utxo:[u8;36],pub fee_script_hash:[u8;32],pub ft_tape_size:u8,
    pub authorization:Authorization,pub service_provider_tag:Option<Vec<u8>>,
}
impl Code {
    pub fn encode(&self)->Result<Vec<u8>>{match &self.service_provider_tag {
        None=>amm_code::instantiate_code(&amm_code::Code{original_utxo:self.original_utxo,fee_script_hash:self.fee_script_hash,
            ft_tape_size:self.ft_tape_size,authorization:self.authorization.clone()}),
        Some(tag)=>explicit::instantiate_code(&explicit::Code{original_utxo:self.original_utxo,fee_script_hash:self.fee_script_hash,
            ft_tape_size:self.ft_tape_size,authorization:self.authorization.clone(),service_provider_tag:tag.clone()}),
    }}
    pub fn decode(bytes:&[u8])->Result<Self>{
        if let Ok(c)=explicit::parse_code(bytes){return Ok(Self{original_utxo:c.original_utxo,fee_script_hash:c.fee_script_hash,
            ft_tape_size:c.ft_tape_size,authorization:c.authorization,service_provider_tag:Some(c.service_provider_tag)});}
        let c=amm_code::parse_code(bytes)?;Ok(Self{original_utxo:c.original_utxo,fee_script_hash:c.fee_script_hash,
            ft_tape_size:c.ft_tape_size,authorization:c.authorization,service_provider_tag:None})
    }
}

#[derive(Clone,Debug,PartialEq,Eq)]
pub struct Tape {
    pub ft_lp_partial_hash:[u8;32],pub ft_lp_code_size:u16,pub ft_a_partial_hash:[u8;32],pub ft_a_code_size:u16,
    pub ft_lp_amount:u64,pub ft_a_amount:u64,pub tbc_amount:u64,pub ft_a_contract_id:[u8;32],
    pub with_swap_hash_lock:bool,pub with_lp_locktime:bool,pub with_lp_hash_lock:bool,pub fees:FeeTerms,
}
impl Tape {
    pub fn decode(bytes:&[u8])->Result<Self>{match explicit::decode_tape(bytes)? {
        explicit::VersionedTape::Preset(t)=>Ok(Self{ft_lp_partial_hash:t.ft_lp_partial_hash,ft_lp_code_size:t.ft_lp_code_size,
            ft_a_partial_hash:t.ft_a_partial_hash,ft_a_code_size:t.ft_a_code_size,ft_lp_amount:t.ft_lp_amount,ft_a_amount:t.ft_a_amount,
            tbc_amount:t.tbc_amount,ft_a_contract_id:t.ft_a_contract_id,with_swap_hash_lock:t.with_swap_hash_lock,
            with_lp_locktime:t.with_lp_locktime,with_lp_hash_lock:t.with_lp_hash_lock,
            fees:FeeTerms::Preset{lp_plan:t.lp_plan,service_fee_rate:t.service_fee_rate}}),
        explicit::VersionedTape::Explicit(t)=>Ok(Self{ft_lp_partial_hash:t.ft_lp_partial_hash,ft_lp_code_size:t.ft_lp_code_size,
            ft_a_partial_hash:t.ft_a_partial_hash,ft_a_code_size:t.ft_a_code_size,ft_lp_amount:t.ft_lp_amount,ft_a_amount:t.ft_a_amount,
            tbc_amount:t.tbc_amount,ft_a_contract_id:t.ft_a_contract_id,with_swap_hash_lock:t.with_swap_hash_lock,
            with_lp_locktime:t.with_lp_locktime,with_lp_hash_lock:t.with_lp_hash_lock,
            fees:FeeTerms::Explicit{rates:t.rates,fee_address:Address::from_hash160(t.fee_pubkey_hash).to_string()}}),
    }}
    pub fn encode(&self)->Result<Vec<u8>>{match &self.fees {
        FeeTerms::Preset{lp_plan,service_fee_rate}=>amm::Tape{ft_lp_partial_hash:self.ft_lp_partial_hash,ft_lp_code_size:self.ft_lp_code_size,
            ft_a_partial_hash:self.ft_a_partial_hash,ft_a_code_size:self.ft_a_code_size,ft_lp_amount:self.ft_lp_amount,ft_a_amount:self.ft_a_amount,
            tbc_amount:self.tbc_amount,ft_a_contract_id:self.ft_a_contract_id,with_swap_hash_lock:self.with_swap_hash_lock,
            with_lp_locktime:self.with_lp_locktime,with_lp_hash_lock:self.with_lp_hash_lock,lp_plan:*lp_plan,service_fee_rate:*service_fee_rate}.encode(),
        FeeTerms::Explicit{rates,fee_address}=>{
            let policy=explicit::FeePolicy::new(*rates,fee_address)?;
            explicit::Tape{ft_lp_partial_hash:self.ft_lp_partial_hash,ft_lp_code_size:self.ft_lp_code_size,
                ft_a_partial_hash:self.ft_a_partial_hash,ft_a_code_size:self.ft_a_code_size,ft_lp_amount:self.ft_lp_amount,ft_a_amount:self.ft_a_amount,
                tbc_amount:self.tbc_amount,ft_a_contract_id:self.ft_a_contract_id,with_swap_hash_lock:self.with_swap_hash_lock,
                with_lp_locktime:self.with_lp_locktime,with_lp_hash_lock:self.with_lp_hash_lock,rates:*rates,fee_pubkey_hash:policy.fee_pubkey_hash()}.encode()
        },
    }}
    pub fn same_configuration(&self,next:&Self)->Result<()>{
        let old=self.encode()?;let new=next.encode()?;
        if old.len()!=new.len()||old[..72]!=new[..72]||old[96..]!=new[96..]{return Err(AmmError("AMM identity or fee configuration changed"));}Ok(())
    }
}
