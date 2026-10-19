//! Pure tbc20-lp Code/Tape and script-lock codec, pinned to tbc-contract
//! af77616121db340e15bb8b73c197bc2f8d1ee986 lib/contract/ftlpTbc20.ts.
//! OpenTBC artifact redistribution remains a release gate. Recognition/lock
//! satisfaction is NOT ancestry, ownership, chain finality or an approved spend.
use std::sync::OnceLock;
use tbc_sdk::contracts::ft::partial_sha256::calculate_partial_hash;
use super::{amm::{AmmError,Result,amount},amm_code::validate_tape_size,amm_template::{Template,Values}};
pub const STANDARD_ID:&str="tbc20-lp";
pub const CODE_DUST:u64=500;
pub const LOCKTIME_THRESHOLD:u32=500_000_000;
const POOL:&str="<self.PoolCodeHash32>";
const SIZE:&str="<self.ConstTapeSize1>";
const CONTROLLER:&str="<self.Controller21>";
fn template(locked:bool) -> &'static Template {
    static PLAIN:OnceLock<Template>=OnceLock::new();static LOCKED:OnceLock<Template>=OnceLock::new();
    let compile=|source|Template::compile(source,&[(POOL,32),(SIZE,1),(CONTROLLER,21)]);
    if locked {LOCKED.get_or_init(||compile(include_str!("amm-ftlp_tbc20_locktime-template.hex")))}
    else {PLAIN.get_or_init(||compile(include_str!("amm-ftlp_tbc20-template.hex")))}
}
#[derive(Debug,Clone,PartialEq,Eq)]
pub struct Code {
    pub pool_code_hash:[u8;32],pub tape_size:u8,
    /// hash160 followed by 0 (address) or 1 (contract), no other controller tag.
    pub controller:[u8;21],pub timelocked:bool,
}
pub fn instantiate_code(code:&Code) -> Result<Vec<u8>> {
    validate_tape_size(code.tape_size,code.timelocked)?;
    if code.controller[20]>1 {return Err(AmmError("LP controller tag must be address or contract"));}
    let bytes=template(code.timelocked).instantiate(&Values::from([(POOL,code.pool_code_hash.to_vec()),
        (SIZE,vec![code.tape_size]),(CONTROLLER,code.controller.to_vec())]))?;
    // The controller's direct push + data and terminal marker occupy 35 bytes.
    assert_eq!((bytes.len()-35)%64,0,"pinned LP immutable prefix alignment");
    assert!((128..=32767).contains(&bytes.len()),"pinned LP ScriptNum width");Ok(bytes)
}
pub fn parse_code(bytes:&[u8]) -> Result<Code> {
    for timelocked in [false,true] {
        let t=template(timelocked);if bytes.len()!=t.len() {continue;}
        let Ok(values)=t.parse_prefix(bytes) else {continue};
        let code=Code {pool_code_hash:values[POOL].as_slice().try_into().unwrap(),tape_size:values[SIZE][0],
            controller:values[CONTROLLER].as_slice().try_into().unwrap(),timelocked};
        if instantiate_code(&code).is_ok_and(|canonical|canonical==bytes) {return Ok(code);}
    }
    Err(AmmError("Unsupported or modified LP Code"))
}
/// SHA256 midstate of immutable prefix + two-byte positive ScriptNum length.
/// This intentionally survives controller replacement; not SHA256(full Code).
pub fn code_identity(bytes:&[u8]) -> Result<[u8;34]> {
    parse_code(bytes)?;let offset=bytes.len()-35;let mut identity=[0;34];
    identity[..32].copy_from_slice(&calculate_partial_hash(&bytes[..offset]));
    identity[32..].copy_from_slice(&(bytes.len() as u16).to_le_bytes());Ok(identity)
}
pub fn replace_controller(bytes:&[u8],controller:[u8;21]) -> Result<Vec<u8>> {
    let original=code_identity(bytes)?;let mut code=parse_code(bytes)?;code.controller=controller;
    let next=instantiate_code(&code)?;
    if code_identity(&next)?!=original {return Err(AmmError("LP replacement changed identity"));}Ok(next)
}
#[derive(Debug,Clone,PartialEq,Eq)]
pub struct Tape {pub amounts:[u64;6],pub size:u8,pub timelocked:bool,pub lock_time:u32}
impl Tape {
    pub fn balance(&self) -> Result<u128> {self.amounts.iter().try_fold(0,|sum,&v|Ok(sum+amount(v)? as u128))}
    pub fn encode(&self) -> Result<Vec<u8>> {
        validate_tape_size(self.size,self.timelocked)?;
        if !self.timelocked && self.lock_time!=0 {return Err(AmmError("Ordinary LP cannot have a lock time"));}
        let mut bytes=vec![0;self.size as usize];bytes[..3].copy_from_slice(&[0,0x6a,0x30]);
        for (i,&value) in self.amounts.iter().enumerate() {bytes[3+i*8..11+i*8].copy_from_slice(&amount(value)?.to_le_bytes());}
        if self.timelocked {bytes[51]=4;bytes[52..56].copy_from_slice(&self.lock_time.to_le_bytes());}
        let start=bytes.len()-10;bytes[start..].copy_from_slice(b"\x09TBC20TAPE");Ok(bytes)
    }
    /// The caller must supply the Code's mode; Tape markers alone cannot select it.
    pub fn decode(bytes:&[u8],timelocked:bool,expected_size:Option<u8>) -> Result<Self> {
        let size=u8::try_from(bytes.len()).map_err(|_|AmmError("LP Tape too long"))?;
        validate_tape_size(size,timelocked)?;
        if expected_size.is_some_and(|wanted|wanted!=size) || bytes[..3]!=[0,0x6a,0x30]
            || &bytes[bytes.len()-10..]!=b"\x09TBC20TAPE" {return Err(AmmError("LP Tape framing or size mismatch"));}
        let padding=if timelocked {56} else {51};
        if (timelocked && bytes[51]!=4) || bytes[padding..bytes.len()-10].iter().any(|&b|b!=0) {
            return Err(AmmError("LP Tape lock push or padding is not canonical"));
        }
        let mut amounts=[0;6];for(i,value)in amounts.iter_mut().enumerate() {*value=amount(u64::from_le_bytes(bytes[3+i*8..11+i*8].try_into().unwrap()))?;}
        Ok(Self {amounts,size,timelocked,lock_time:if timelocked {u32::from_le_bytes(bytes[52..56].try_into().unwrap())} else {0}})
    }
    pub fn verify_input_lock(&self,sequence:u32,tx_lock_time:u32) -> Result<()> {
        self.encode()?;
        if !self.timelocked {return Ok(());}
        if sequence==u32::MAX || self.lock_time>tx_lock_time || (self.lock_time!=0 &&
            (self.lock_time<LOCKTIME_THRESHOLD)!=(tx_lock_time<LOCKTIME_THRESHOLD)) {
            return Err(AmmError("LP input lock is not satisfied"));
        }Ok(())
    }
}
pub fn required_lock_time(locks:&[u32]) -> Result<u32> {
    let mut domain=None;let mut maximum=0;
    for &lock in locks {
        if lock!=0 {
            let height=lock<LOCKTIME_THRESHOLD;
            if domain.is_some_and(|old|old!=height) {return Err(AmmError("Cannot combine LP height and timestamp locks"));}
            domain=Some(height);
        }maximum=maximum.max(lock);
    }Ok(maximum)
}
