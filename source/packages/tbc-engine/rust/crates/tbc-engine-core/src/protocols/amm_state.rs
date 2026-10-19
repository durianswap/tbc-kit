//! Immutable new AMM configuration and material binding, from fixed PoolNFT3.
//! No fetch/keys/persistence. Matching a supplied genesis ID is a local constraint,
//! not an independent proof of chain inclusion, ownership or current unspentness.
use tbc_sdk::{Address,Transaction,Txid,PublicKey,hash,script::Script};
use crate::{EngineError,ErrorCode};
use super::{amm,amm_code::{self,Authorization},amm_profile,amm_lp,amm_math,tbc20,tbc20_proof::check_transaction};
fn invalid(message:&str)->EngineError{EngineError{code:ErrorCode::InvalidAncestry,message:message.into(),path:None}}

#[derive(Clone,Debug)]
pub struct PoolConfig {
    ft_id:Txid,ft_code:Vec<u8>,ft_tape:Vec<u8>,ft_identity:[u8;34],ft_extension:Vec<u8>,
    tape_size:u8,authorization:Authorization,timelocked:bool,profile:amm_profile::Profile,fee_policy:amm_profile::FeePolicy,fee_script:Script,
}
impl PoolConfig {
    pub fn new(ft_genesis:&Transaction,expected_ft_id:&Txid,authorization:Authorization,timelocked:bool,lp_plan:u8,fee_rate:Option<u16>)->Result<Self,EngineError>{
        let profile=amm_profile::Profile::preset(lp_plan,fee_rate).map_err(|_|invalid("Pool fee plan/rate invalid"))?;
        Self::with_profile(ft_genesis,expected_ft_id,authorization,timelocked,profile)
    }
    pub fn with_profile(ft_genesis:&Transaction,expected_ft_id:&Txid,authorization:Authorization,timelocked:bool,profile:amm_profile::Profile)->Result<Self,EngineError>{
        check_transaction(ft_genesis)?;
        if &ft_genesis.txid()!=expected_ft_id||ft_genesis.inputs.len()!=1||!(2..=3).contains(&ft_genesis.outputs.len())
            ||ft_genesis.outputs[0].satoshis!=500||ft_genesis.outputs[1].satoshis!=0{
            return Err(invalid("Pool requires expected canonical FT genesis with Code/Tape at 0/1"));
        }
        let ft_code=ft_genesis.outputs[0].script_pubkey.as_bytes().to_vec();let ft_tape=ft_genesis.outputs[1].script_pubkey.as_bytes().to_vec();
        let code=tbc20::parse_code(&ft_code).map_err(|_|invalid("Pool underlying FT Code invalid"))?;
        let tape=tbc20::parse_tape(&ft_tape).map_err(|_|invalid("Pool underlying FT Tape invalid"))?;
        let mut original=Vec::new();ft_genesis.inputs[0].previous_output.serialize(&mut original);
        if code.original_outpoint.as_slice()!=original||code.tape_size as usize!=ft_tape.len()
            ||tape.amounts[0]==0||tape.amounts[1..].iter().any(|a|*a!=0){return Err(invalid("Pool FT reference is not canonical genesis"));}
        Self::with_indexed_ft(*expected_ft_id,ft_code,ft_tape,authorization,timelocked,profile)
    }
    /// Same config derivation, using the wallet's trusted index Code/Tape.
    /// Does not manufacture a genesis transaction or claim an issuance audit.
    pub fn with_indexed_ft(ft_id:Txid,ft_code:Vec<u8>,ft_tape:Vec<u8>,authorization:Authorization,timelocked:bool,profile:amm_profile::Profile)->Result<Self,EngineError>{
        if ft_code.is_empty()||ft_code.len()>65536||ft_tape.is_empty()||ft_tape.len()>65536{return Err(invalid("Pool FT scripts exceed bounds"));}
        let code=tbc20::parse_code(&ft_code).map_err(|_|invalid("Pool underlying FT Code invalid"))?;
        let tape=tbc20::parse_tape(&ft_tape).map_err(|_|invalid("Pool underlying FT Tape invalid"))?;
        if code.tape_size as usize!=ft_tape.len(){return Err(invalid("Pool underlying FT Tape size differs"));}
        amm_code::validate_tape_size(code.tape_size,timelocked).map_err(|_|invalid("FT Tape cannot support selected LP mode"))?;
        let fee_policy=profile.validate().map_err(|_|invalid("Pool fee profile invalid"))?;
        let fee_script=Address::from_string(&fee_policy.fee_address()).map_err(|_|invalid("Pool fee address invalid"))?.script_pubkey();
        let ft_identity=tbc20::code_identity(&ft_code).map_err(|_|invalid("Pool FT identity invalid"))?.try_into().map_err(|_|invalid("Pool FT identity must be 34 bytes"))?;
        Ok(Self{ft_id,ft_code,ft_tape,ft_identity,ft_extension:tape.extension,tape_size:code.tape_size,
            authorization:authorization.normalized().map_err(|_|invalid("Pool authorization invalid"))?,timelocked,profile,fee_policy,fee_script})
    }
    pub fn ft_id(&self)->&Txid{&self.ft_id}
    pub fn ft_identity(&self)->&[u8;34]{&self.ft_identity}
    pub fn ft_code(&self)->&[u8]{&self.ft_code}
    pub fn ft_tape(&self)->&[u8]{&self.ft_tape}
    pub fn tape_size(&self)->u8{self.tape_size}
    pub fn timelocked(&self)->bool{self.timelocked}
    pub fn authorization(&self)->&Authorization{&self.authorization}
    pub fn fee_policy(&self)->&amm_profile::FeePolicy{&self.fee_policy}
    pub fn profile(&self)->&amm_profile::Profile{&self.profile}
    pub fn pool_code(&self,original:[u8;36])->Result<Vec<u8>,EngineError>{
        self.profile.code(original,self.tape_size,self.authorization.clone()).and_then(|c|c.encode()).map_err(|_|invalid("Pool genesis Code invalid"))
    }
    pub fn fee_script(&self)->&Script{&self.fee_script}
    pub fn fee_script_hash(&self)->[u8;32]{hash::sha256(self.fee_script.as_bytes())}
    pub fn lp_code(&self,pool_hash:[u8;32],controller:[u8;21])->Result<Vec<u8>,EngineError>{
        amm_lp::instantiate_code(&amm_lp::Code{pool_code_hash:pool_hash,tape_size:self.tape_size,controller,timelocked:self.timelocked})
            .map_err(|_|invalid("Pool LP Code could not be formed"))
    }
    pub fn genesis_tape(&self,pool_hash:[u8;32])->Result<amm_profile::Tape,EngineError>{
        let lp=self.lp_code(pool_hash,[0;21])?;let identity=amm_lp::code_identity(&lp).map_err(|_|invalid("Pool LP identity invalid"))?;
        let controlled=matches!(self.authorization,Authorization::Controller(_));
        // Txid exposes display-order bytes via its canonical string.
        let id=self.ft_id.to_string();let mut ft_id=[0;32];
        for(i,value)in ft_id.iter_mut().enumerate(){*value=u8::from_str_radix(&id[i*2..i*2+2],16).map_err(|_|invalid("FT ID encoding invalid"))?;}
        Ok(amm_profile::Tape{ft_lp_partial_hash:identity[..32].try_into().unwrap(),ft_lp_code_size:lp.len() as u16,
            ft_a_partial_hash:self.ft_identity[..32].try_into().unwrap(),ft_a_code_size:self.ft_code.len() as u16,
            ft_lp_amount:0,ft_a_amount:0,tbc_amount:0,ft_a_contract_id:ft_id,fees:self.profile.fees.clone(),
            with_swap_hash_lock:controlled,with_lp_hash_lock:controlled,with_lp_locktime:self.timelocked})
    }
    pub fn read_pool<'a>(&self,transaction:&'a Transaction,expected_pool_hash:&[u8;32])->Result<PoolSnapshot<'a>,EngineError>{
        check_transaction(transaction)?;
        let code_out=&transaction.outputs[0];let tape_out=transaction.outputs.get(1).ok_or_else(||invalid("Pool Tape missing"))?;
        if code_out.satoshis<amm::CODE_DUST||tape_out.satoshis!=0{return Err(invalid("Pool Code reserve or Tape value invalid"));}
        let code=amm_profile::Code::decode(code_out.script_pubkey.as_bytes()).map_err(|_|invalid("Pool Code invalid"))?;
        let pool_hash=hash::sha256(code_out.script_pubkey.as_bytes());
        if &pool_hash!=expected_pool_hash||code.ft_tape_size!=self.tape_size||code.authorization!=self.authorization||code.fee_script_hash!=self.fee_script_hash(){
            return Err(invalid("Pool Code differs from bound asset, controller or fee profile"));
        }
        let tape=amm_profile::Tape::decode(tape_out.script_pubkey.as_bytes()).map_err(|_|invalid("Pool Tape invalid"))?;
        if amm_profile::Profile::from_parts(&code,&tape).map_err(|_|invalid("Pool Code/Tape configuration invalid"))?!=self.profile{
            return Err(invalid("Pool differs from authenticated configuration"));
        }
        self.genesis_tape(pool_hash)?.same_configuration(&tape).map_err(|_|invalid("Pool FT/LP genesis identity or configuration mismatch"))?;
        let math=amm_math::State{ft_lp_amount:tape.ft_lp_amount,ft_a_amount:tape.ft_a_amount,tbc_amount:tape.tbc_amount,pool_value:code_out.satoshis};
        math.validate(false).map_err(|_|invalid("Pool reserves out of range"))?;
        let id=transaction.txid().to_string();let mut snapshot=Vec::with_capacity(215);
        for i in (0..id.len()).step_by(2){snapshot.push(u8::from_str_radix(&id[i..i+2],16).map_err(|_|invalid("Pool ID encoding invalid"))?);}
        snapshot.extend_from_slice(&pool_hash);snapshot.extend_from_slice(&code_out.satoshis.to_le_bytes());snapshot.extend_from_slice(tape_out.script_pubkey.as_bytes());
        Ok(PoolSnapshot{transaction,code,tape,pool_hash,math,snapshot_hash:hash::sha256(&snapshot),ft_id:self.ft_id.clone()})
    }
    fn ensure_snapshot(&self,pool:&PoolSnapshot<'_>)->Result<(),EngineError>{
        if pool.ft_id!=self.ft_id||pool.code.authorization!=self.authorization||pool.code.ft_tape_size!=self.tape_size
            ||pool.tape.fees!=self.profile.fees||pool.code.service_provider_tag!=self.profile.service_provider_tag||pool.tape.with_lp_locktime!=self.timelocked{
            return Err(invalid("Pool snapshot belongs to another bound configuration"));
        }Ok(())
    }
    /// Fresh current material remains the caller's responsibility. This checks
    /// its asset/metadata/holder and, for Pool-owned FT, exact state balance.
    pub fn validate_ft(&self,parent:&Transaction,vout:usize,key:&PublicKey,pool:Option<&PoolSnapshot<'_>>)->Result<tbc20::TapeDescriptor,EngineError>{
        check_transaction(parent)?;
        let code=parent.outputs.get(vout).ok_or_else(||invalid("Pool FT Code missing"))?;
        let tape=parent.outputs.get(vout.checked_add(1).ok_or_else(||invalid("Pool FT index overflow"))?).ok_or_else(||invalid("Pool FT Tape missing"))?;
        if code.satoshis!=500||tape.satoshis!=0{return Err(invalid("Pool FT Code/Tape must be 500/0"));}
        let descriptor=tbc20::parse_code(code.script_pubkey.as_bytes()).map_err(|_|invalid("Pool FT Code invalid"))?;
        let parsed=tbc20::parse_tape(tape.script_pubkey.as_bytes()).map_err(|_|invalid("Pool FT Tape invalid"))?;
        if descriptor.tape_size!=self.tape_size||tape.script_pubkey.as_bytes().len()!=self.tape_size as usize
            ||parsed.extension!=self.ft_extension||tbc20::code_identity(code.script_pubkey.as_bytes()).map_err(|_|invalid("FT identity invalid"))?!=self.ft_identity{
            return Err(invalid("Wrong underlying FT identity or metadata"));
        }
        if let Some(pool)=pool{
            self.ensure_snapshot(pool)?;
            if descriptor.controller!=contract_controller(&pool.pool_hash)||parsed.balance!=pool.math.ft_a_amount as u128{return Err(invalid("Pool FT control or balance differs from Pool state"));}
        }else if descriptor.controller!=owner_controller(key){return Err(invalid("User FT is not owned by supplied public key"));}
        Ok(parsed)
    }
    pub fn validate_lp(&self,parent:&Transaction,vout:usize,key:&PublicKey,pool:&PoolSnapshot<'_>)->Result<amm_lp::Tape,EngineError>{
        self.ensure_snapshot(pool)?;
        check_transaction(parent)?;
        let code=parent.outputs.get(vout).ok_or_else(||invalid("User LP Code missing"))?;
        let tape=parent.outputs.get(vout.checked_add(1).ok_or_else(||invalid("LP index overflow"))?).ok_or_else(||invalid("User LP Tape missing"))?;
        if code.satoshis!=500||tape.satoshis!=0{return Err(invalid("User LP Code/Tape must be 500/0"));}
        let descriptor=amm_lp::parse_code(code.script_pubkey.as_bytes()).map_err(|_|invalid("User LP Code invalid"))?;
        if descriptor.pool_code_hash!=pool.pool_hash||descriptor.timelocked!=self.timelocked||descriptor.tape_size!=self.tape_size
            ||descriptor.controller!=owner_controller(key){return Err(invalid("User LP Pool/template or ownership differs"));}
        amm_lp::Tape::decode(tape.script_pubkey.as_bytes(),self.timelocked,Some(self.tape_size)).map_err(|_|invalid("User LP Tape invalid"))
    }
}
pub fn owner_controller(key:&PublicKey)->[u8;21]{let mut c=[0;21];c[..20].copy_from_slice(&key.hash160());c}
pub fn contract_controller(code_hash:&[u8;32])->[u8;21]{let mut c=[0;21];c[..20].copy_from_slice(&hash::hash160(code_hash));c[20]=1;c}
#[derive(Debug)]
pub struct PoolSnapshot<'a>{transaction:&'a Transaction,code:amm_profile::Code,tape:amm_profile::Tape,pool_hash:[u8;32],math:amm_math::State,snapshot_hash:[u8;32],ft_id:Txid}
impl<'a> PoolSnapshot<'a>{
    pub fn transaction(&self)->&'a Transaction{self.transaction}
    pub fn code(&self)->&amm_profile::Code{&self.code}
    pub fn tape(&self)->&amm_profile::Tape{&self.tape}
    pub fn pool_hash(&self)->&[u8;32]{&self.pool_hash}
    pub fn math(&self)->amm_math::State{self.math}
    pub fn snapshot_hash(&self)->&[u8;32]{&self.snapshot_hash}
}
