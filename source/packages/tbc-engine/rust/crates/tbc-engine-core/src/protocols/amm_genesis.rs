//! Bounded deferred genesis outputs. Source txid is resolved only after external
//! signature finalization, never guessed from an unsigned parent or fetched.
use serde::{Deserialize,Serialize};
use tbc_sdk::{Txid,hash,script::Script};
use crate::{EngineError,ErrorCode};
use super::{amm_code::{self,Authorization},amm_profile,amm_lp,amm_state::{PoolConfig,contract_controller},tbc20};
pub(crate) const OUTPUT_PREFIX:&str="tbc-amm-genesis:";
fn invalid(message:&str)->EngineError{EngineError{code:ErrorCode::InvalidPlan,message:message.into(),path:None}}
fn hex(bytes:&[u8])->String{bytes.iter().map(|b|format!("{b:02x}")).collect()}
fn fixed<const N:usize>(value:&str)->Result<[u8;N],EngineError>{
    if value.len()!=N*2||!value.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err(invalid("AMM descriptor has noncanonical fixed hex"));}
    let mut result=[0;N];for(i,n)in result.iter_mut().enumerate(){*n=u8::from_str_radix(&value[i*2..i*2+2],16).map_err(|_|invalid("AMM descriptor hex invalid"))?;}Ok(result)
}
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Definition{
    ft_original_outpoint:String,ft_id:String,ft_tape_size:u8,
    #[serde(default,skip_serializing_if="Option::is_none")]lp_plan:Option<u8>,
    #[serde(default,skip_serializing_if="Option::is_none")]profile:Option<amm_profile::Profile>,
    timelocked:bool,controllers:Vec<String>,
}
impl Definition{
    pub(crate) fn from_config(config:&PoolConfig)->Result<Self,EngineError>{
        let code=tbc20::parse_code(config.ft_code()).map_err(|_|invalid("AMM deferred FT Code invalid"))?;
        Ok(Self{ft_original_outpoint:hex(&code.original_outpoint),ft_id:config.ft_id().to_string(),ft_tape_size:config.tape_size(),
            lp_plan:match config.profile().fees{amm_profile::FeeTerms::Preset{lp_plan,..}=>Some(lp_plan),_=>None},
            profile:config.profile().is_explicit().then(||config.profile().clone()),
            timelocked:config.timelocked(),controllers:match config.authorization(){Authorization::Public=>vec![],Authorization::Controller(h)=>h.iter().map(|v|hex(v)).collect()}})
    }
    fn profile(&self)->Result<amm_profile::Profile,EngineError>{match (&self.profile,self.lp_plan) {
        (None,Some(plan))=>amm_profile::Profile::preset(plan,None).map_err(|_|invalid("AMM descriptor fee plan invalid")),
        (Some(p),None) if p.is_explicit()=>{p.validate().map_err(|_|invalid("AMM descriptor explicit fee invalid"))?;Ok(p.clone())},
        _=>Err(invalid("AMM descriptor requires one unambiguous fee profile")),
    }}
    fn authorization(&self)->Result<Authorization,EngineError>{
        if self.controllers.is_empty(){return Ok(Authorization::Public);}
        if self.controllers.len()>5{return Err(invalid("AMM descriptor controller limit"));}
        let hashes=self.controllers.iter().map(|v|fixed::<20>(v)).collect::<Result<Vec<_>,_>>()?;
        let auth=Authorization::Controller(hashes);if auth.normalized().map_err(|_|invalid("AMM descriptor duplicate controller"))?!=auth{return Err(invalid("AMM descriptor controllers not canonical"));}Ok(auth)
    }
    fn validate(&self)->Result<(),EngineError>{
        amm_code::validate_tape_size(self.ft_tape_size,self.timelocked).map_err(|_|invalid("AMM descriptor Tape size invalid"))?;
        fixed::<32>(&self.ft_id)?;fixed::<36>(&self.ft_original_outpoint)?;self.authorization()?;
        self.profile()?;Ok(())
    }
    pub(crate) fn validate_zero_ft_tape(&self,script:&[u8])->Result<(),EngineError>{
        let tape=tbc20::parse_tape(script).map_err(|_|invalid("AMM genesis FT Tape invalid"))?;
        if script.len()!=self.ft_tape_size as usize||tape.balance!=0{return Err(invalid("AMM genesis must start with zero FT of exact Tape size"));}Ok(())
    }
    fn output(&self,source_id:Txid,part:u8)->Result<Script,EngineError>{
        amm_code::validate_tape_size(self.ft_tape_size,self.timelocked).map_err(|_|invalid("AMM descriptor Tape size invalid"))?;
        let ft_id=fixed::<32>(&self.ft_id)?;let ft_original=fixed::<36>(&self.ft_original_outpoint)?;
        let authorization=self.authorization()?;let controlled=matches!(authorization,Authorization::Controller(_));
        let profile=self.profile()?;
        let mut original=[0;36];original[..32].copy_from_slice(source_id.as_le_bytes());
        let code=profile.code(original,self.ft_tape_size,authorization).and_then(|c|c.encode())
            .map_err(|_|invalid("AMM deferred Code invalid"))?;
        if part==0{return Ok(Script::from_bytes(code));}
        let pool_hash=hash::sha256(&code);
        let ft=tbc20::instantiate_code(&tbc20::CodeDescriptor{original_outpoint:ft_original,tape_size:self.ft_tape_size,controller:contract_controller(&pool_hash)})
            .map_err(|_|invalid("AMM deferred Pool FT invalid"))?;
        if part==2{return Ok(Script::from_bytes(ft));}
        if part!=1{return Err(invalid("AMM genesis output part invalid"));}
        let ft_identity=tbc20::code_identity(&ft).map_err(|_|invalid("AMM deferred FT identity invalid"))?;
        let lp=amm_lp::instantiate_code(&amm_lp::Code{pool_code_hash:pool_hash,tape_size:self.ft_tape_size,controller:[0;21],timelocked:self.timelocked})
            .map_err(|_|invalid("AMM deferred LP invalid"))?;
        let lp_identity=amm_lp::code_identity(&lp).map_err(|_|invalid("AMM deferred LP identity invalid"))?;
        let tape=amm_profile::Tape{ft_lp_partial_hash:lp_identity[..32].try_into().unwrap(),ft_lp_code_size:lp.len() as u16,
            ft_a_partial_hash:ft_identity[..32].try_into().unwrap(),ft_a_code_size:ft.len() as u16,
            ft_lp_amount:0,ft_a_amount:0,tbc_amount:0,ft_a_contract_id:ft_id,fees:profile.fees,
            with_swap_hash_lock:controlled,with_lp_hash_lock:controlled,with_lp_locktime:self.timelocked}.encode().map_err(|_|invalid("AMM deferred Tape invalid"))?;
        Ok(Script::from_bytes(tape))
    }
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct GenesisOutput{pub parent_id:String,pub part:u8,pub definition:Definition}
pub(crate) fn descriptor(parent_id:&str,part:u8,definition:&Definition)->Result<String,EngineError>{
    let output=GenesisOutput{parent_id:parent_id.into(),part,definition:definition.clone()};
    let encoded=format!("{OUTPUT_PREFIX}{}",serde_json::to_string(&output).map_err(|_|invalid("AMM descriptor encoding failed"))?);
    parse_output(&encoded)?;Ok(encoded)
}
pub(crate) fn parse_output(value:&str)->Result<GenesisOutput,EngineError>{
    let json=value.strip_prefix(OUTPUT_PREFIX).filter(|s|s.len()<=2048).ok_or_else(||invalid("AMM genesis descriptor prefix or size invalid"))?;
    let result:GenesisOutput=serde_json::from_str(json).map_err(|_|invalid("AMM genesis descriptor malformed"))?;
    if result.parent_id.is_empty()||result.parent_id.len()>128||result.part>2{return Err(invalid("AMM genesis source or part invalid"));}
    result.definition.validate()?;Ok(result)
}
pub(crate) fn instantiate_output(value:&GenesisOutput,source_id:Txid)->Result<Script,EngineError>{
    value.definition.output(source_id,value.part)
}
