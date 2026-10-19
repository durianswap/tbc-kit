//! Exact pinned HTLC Code and necessary branch predicates. Pure supplied data;
//! no key, network, signing, wall clock, or VM. Recognition is not authorization.
use sha2::{Digest, Sha256};
use std::{error::Error, fmt};

pub const STANDARD_ID: &str = "tbc-htlc";
pub const CODE_BYTES: usize = 137;
pub const LOCKTIME_THRESHOLD: u32 = 500_000_000;
pub const REFUND_SEQUENCE: u32 = u32::MAX - 1;
const PREFIX: &[u8] = &[0x63,0xa8,0x20];
const RECEIVER: &[u8] = &[0x88,0x76,0xa9,0x14];
const TIME: &[u8] = &[0x67,0x04];
const REFUND: &[u8] = &[
    0x81,0x52,0xba,0x81,0x6e,0xa0,0x64,0x6e,0x04,0x00,0x65,0xcd,0x1d,0xa2,0x63,
    0x04,0x00,0x65,0xcd,0x1d,0xa2,0x69,0xa1,0x67,0x6d,0x75,0x51,0x68,0x67,0x00,
    0x68,0x69,0x56,0xba,0x01,0x24,0x7f,0x77,0x81,0x04,0xff,0xff,0xff,0xff,0x9e,
    0x69,0x76,0xa9,0x14,
];
const SUFFIX: &[u8] = &[0x68,0x88,0xac];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HtlcError(pub &'static str);
impl fmt::Display for HtlcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.0) }
}
impl Error for HtlcError {}
pub type Result<T> = std::result::Result<T,HtlcError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Code {
    pub sender_hash: [u8;20],
    pub receiver_hash: [u8;20],
    pub hashlock: [u8;32],
    pub raw_lock_time: u32,
}
impl Code {
    /// Exact wire codec preserves even unsafe historical u32 encodings. Public
    /// builders must additionally call supported_lock_time(). No hidden rewrite.
    pub fn encode(&self) -> Vec<u8> {
        let mut out=Vec::with_capacity(CODE_BYTES);
        out.extend_from_slice(PREFIX);out.extend_from_slice(&self.hashlock);
        out.extend_from_slice(RECEIVER);out.extend_from_slice(&self.receiver_hash);
        out.extend_from_slice(TIME);out.extend_from_slice(&self.raw_lock_time.to_le_bytes());
        out.extend_from_slice(REFUND);out.extend_from_slice(&self.sender_hash);out.extend_from_slice(SUFFIX);out
    }
    pub fn decode(script: &[u8]) -> Result<Self> {
        if script.len()!=CODE_BYTES || &script[..3]!=PREFIX || &script[35..39]!=RECEIVER ||
            &script[59..61]!=TIME || &script[65..114]!=REFUND || &script[134..]!=SUFFIX {
            return Err(HtlcError("Unsupported or modified HTLC Code"));
        }
        Ok(Self{hashlock:script[3..35].try_into().unwrap(),receiver_hash:script[39..59].try_into().unwrap(),
            raw_lock_time:u32::from_le_bytes(script[61..65].try_into().unwrap()),sender_hash:script[114..134].try_into().unwrap()})
    }
    /// Token controller = HASH160(SHA256(Code)), not HASH160(Code). The same
    /// fixed HTLC code can govern native TBC or an independently verified token.
    pub fn token_controller(&self) -> [u8;20] {
        tbc_sdk::hash::hash160(&Sha256::digest(self.encode()))
    }
    /// The pinned script uses four-byte signed-magnitude OP_BIN2NUM, not CLTV.
    /// Bit 31 makes positive-u32 values negative/negative-zero. Preserve their
    /// bytes in decoding, but never treat them as safe new locks or refunds.
    pub fn supported_lock_time(&self) -> Result<u32> {
        if self.raw_lock_time==0 || self.raw_lock_time>i32::MAX as u32 {
            return Err(HtlcError("HTLC lock is zero or outside safe four-byte signed range"));
        }
        Ok(self.raw_lock_time)
    }
    /// Claim has NO deadline predicate. A correct preimage does not replace
    /// receiver signature verification or asset/chain checks in the finalizer.
    /// Error messages deliberately contain neither preimage nor its bytes.
    pub fn verify_claim(&self, signer_hash: &[u8;20], preimage: &[u8]) -> Result<()> {
        if signer_hash!=&self.receiver_hash || Sha256::digest(preimage).as_slice()!=self.hashlock {
            return Err(HtlcError("HTLC claimant or hashlock proof does not match"));
        }
        Ok(())
    }
    /// Necessary supported-profile Script/role checks, not node finality.
    pub fn verify_refund(&self, signer_hash: &[u8;20], sequence:u32, tx_lock_time:u32) -> Result<()> {
        let lock=self.supported_lock_time()?;
        if signer_hash!=&self.sender_hash || sequence==u32::MAX || tx_lock_time>i32::MAX as u32 ||
            (lock<LOCKTIME_THRESHOLD)!=(tx_lock_time<LOCKTIME_THRESHOLD) || tx_lock_time<lock {
            return Err(HtlcError("HTLC refund role, sequence or lock domain does not match"));
        }
        Ok(())
    }
    /// Trusted chain observation is supplied by Kit, never Date.now or HTTP.
    /// Height is the current tip; timestamp finality uses strict MTP inequality.
    /// Reorg/double-spend/node policy still require normal submission handling.
    pub fn verify_refund_context(&self, signer_hash:&[u8;20], sequence:u32, tx_lock_time:u32,
        observed_height:u64, median_time_past:Option<u64>) -> Result<()> {
        self.verify_refund(signer_hash,sequence,tx_lock_time)?;
        let mature=if tx_lock_time<LOCKTIME_THRESHOLD { u64::from(tx_lock_time)<=observed_height }
            else { median_time_past.is_some_and(|time|u64::from(tx_lock_time)<time) };
        if !mature { return Err(HtlcError("HTLC refund is not mature at the supplied chain observation")); }
        Ok(())
    }
}
