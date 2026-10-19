//! Pinned PiggyBank Code codec for tbc-timelock. No HTTP, custody or signing.
//! The script compares OP_PUSH_META locktime through OP_BIN2NUM; it is NOT
//! OP_CHECKLOCKTIMEVERIFY. Decoding does not establish spendability or finality.
use std::{error::Error,fmt};
pub const STANDARD_ID:&str="tbc-timelock";
pub const LOCKTIME_THRESHOLD:u32=500_000_000;
pub const UNLOCK_SEQUENCE:u32=u32::MAX-1;
const PREFIX:&[u8]=&[0x76,0xa9,0x14];
const MIDDLE:&[u8]=&[0x88,0xad,0x56,0xba,0x01,0x24,0x7f,0x77,0x81,0x04,0xff,0xff,0xff,0xff,0x81,0x9e,0x51,0x88,0x04];
const SUFFIX:&[u8]=&[0x81,0x52,0xba,0x81,0xa1,0x51,0x87];
pub const CODE_BYTES:usize=53;
#[derive(Debug,Clone,Copy,PartialEq,Eq)]
pub struct TimelockError(pub &'static str);
impl fmt::Display for TimelockError{fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result{f.write_str(self.0)}}
impl Error for TimelockError{}
pub type Result<T>=std::result::Result<T,TimelockError>;
#[derive(Debug,Clone,PartialEq,Eq)]
pub struct Code{pub owner_hash:[u8;20],pub raw_lock_time:u32}
impl Code{
    /// Exact fixed SDK encoding, including historical unsafe lock values.
    /// Builders must call height_lock(), not treat recognition as approval.
    pub fn encode(&self)->Vec<u8>{
        let mut script=Vec::with_capacity(CODE_BYTES);script.extend_from_slice(PREFIX);
        script.extend_from_slice(&self.owner_hash);script.extend_from_slice(MIDDLE);
        script.extend_from_slice(&self.raw_lock_time.to_le_bytes());script.extend_from_slice(SUFFIX);script
    }
    pub fn decode(script:&[u8])->Result<Self>{
        if script.len()!=CODE_BYTES||&script[..3]!=PREFIX||&script[23..42]!=MIDDLE||&script[46..]!=SUFFIX{
            return Err(TimelockError("Unsupported or modified timelock Code"));
        }
        Ok(Self{owner_hash:script[3..23].try_into().unwrap(),raw_lock_time:u32::from_le_bytes(script[42..46].try_into().unwrap())})
    }
    /// First public profile is height based, matching SDK unfreeze's chain-height
    /// input. Explicitly excludes timestamp-domain and signed-four-byte hazards.
    pub fn height_lock(&self)->Result<u32>{
        if self.raw_lock_time>=LOCKTIME_THRESHOLD{return Err(TimelockError("Timelock height profile does not accept timestamp or signed lock values"));}
        Ok(self.raw_lock_time)
    }
    /// Necessary local height-profile checks, NOT an emulator of all Script or
    /// a claim of node finality. Signature, ownership and chain finality are separate.
    pub fn validate_height_spend(&self,sequence:u32,transaction_lock_time:u32,observed_height:u32)->Result<()>{
        let lock=self.height_lock()?;
        if sequence==u32::MAX||transaction_lock_time>=LOCKTIME_THRESHOLD||observed_height>=LOCKTIME_THRESHOLD
            ||transaction_lock_time<lock||transaction_lock_time>observed_height{
            return Err(TimelockError("Timelock height spend is premature, final-sequence or outside height profile"));
        }Ok(())
    }
}
/// Construct only the supported height profile. Low-level parsing retains raw
/// wire values to let callers explain unsupported historical outputs honestly.
pub fn height_code(owner_hash:[u8;20],height:u32)->Result<Vec<u8>>{
    let code=Code{owner_hash,raw_lock_time:height};code.height_lock()?;Ok(code.encode())
}
