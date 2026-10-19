//! Pure tbc-amm Pool3 Tape codec. Semantics ported from tbc-contract 1.7.0,
//! af77616121db340e15bb8b73c197bc2f8d1ee986 lib/util/poolnft3/tape.ts.
//! Tape recognition alone does not identify a valid Pool Code or authorize a spend.
use std::fmt;

pub const MAX_AMOUNT: u64 = i64::MAX as u64;
pub const TAPE_BYTES: usize = 143;
pub const CODE_DUST: u64 = 1500;
pub const MIN_PAYOUT: u64 = 10;
const PREFIX: &[u8] = &[0, 0x6a, 0x4c, 0x82];
const SUFFIX: &[u8] = b"\x08POOLTAPE";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmmError(pub &'static str);
impl fmt::Display for AmmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.0) }
}
impl std::error::Error for AmmError {}
pub type Result<T> = std::result::Result<T, AmmError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant { Public, PublicTimelocked, Controller, ControllerTimelocked }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tape {
    pub ft_lp_partial_hash: [u8; 32],
    pub ft_lp_code_size: u16,
    pub ft_a_partial_hash: [u8; 32],
    pub ft_a_code_size: u16,
    pub ft_lp_amount: u64,
    pub ft_a_amount: u64,
    pub tbc_amount: u64,
    /// Display-order bytes, not reversed outpoint encoding.
    pub ft_a_contract_id: [u8; 32],
    /// Total swap fee bps, not just the service share. Codec preserves uint16;
    /// business policy separately validates the exact plan/rate pair.
    pub service_fee_rate: u16,
    pub lp_plan: u8,
    pub with_swap_hash_lock: bool,
    pub with_lp_locktime: bool,
    pub with_lp_hash_lock: bool,
}
pub fn amount(value: u64) -> Result<u64> {
    if value > MAX_AMOUNT { return Err(AmmError("Pool amount exceeds signed 63-bit range")); }
    Ok(value)
}
impl Tape {
    pub fn variant(&self) -> Result<Variant> {
        if self.with_swap_hash_lock != self.with_lp_hash_lock {
            return Err(AmmError("Unsupported Pool authorization flag combination"));
        }
        Ok(match (self.with_swap_hash_lock, self.with_lp_locktime) {
            (false,false) => Variant::Public, (false,true) => Variant::PublicTimelocked,
            (true,false) => Variant::Controller, (true,true) => Variant::ControllerTimelocked,
        })
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.variant()?;
        for size in [self.ft_lp_code_size, self.ft_a_code_size] {
            if !(128..=0x7fff).contains(&size) { return Err(AmmError("Code size is not a positive two-byte ScriptNum")); }
        }
        let mut bytes=vec![0;TAPE_BYTES]; bytes[..4].copy_from_slice(PREFIX);
        bytes[4..36].copy_from_slice(&self.ft_lp_partial_hash);
        bytes[36..38].copy_from_slice(&self.ft_lp_code_size.to_le_bytes());
        bytes[38..70].copy_from_slice(&self.ft_a_partial_hash);
        bytes[70..72].copy_from_slice(&self.ft_a_code_size.to_le_bytes());
        for (offset,value) in [(72,self.ft_lp_amount),(80,self.ft_a_amount),(88,self.tbc_amount)] {
            bytes[offset..offset+8].copy_from_slice(&amount(value)?.to_le_bytes());
        }
        bytes[96..128].copy_from_slice(&self.ft_a_contract_id);
        bytes[128..130].copy_from_slice(&self.service_fee_rate.to_le_bytes());
        bytes[130]=self.lp_plan; bytes[131]=self.with_swap_hash_lock as u8;
        bytes[132]=self.with_lp_locktime as u8; bytes[133]=self.with_lp_hash_lock as u8;
        bytes[134..].copy_from_slice(SUFFIX); Ok(bytes)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len()!=TAPE_BYTES || &bytes[..4]!=PREFIX || &bytes[134..]!=SUFFIX {
            return Err(AmmError("Noncanonical Pool Tape framing"));
        }
        if bytes[131..134].iter().any(|&v|v>1) { return Err(AmmError("Pool flags must be zero or one")); }
        let value=Self {
            ft_lp_partial_hash:bytes[4..36].try_into().unwrap(),ft_lp_code_size:u16::from_le_bytes(bytes[36..38].try_into().unwrap()),
            ft_a_partial_hash:bytes[38..70].try_into().unwrap(),ft_a_code_size:u16::from_le_bytes(bytes[70..72].try_into().unwrap()),
            ft_lp_amount:u64::from_le_bytes(bytes[72..80].try_into().unwrap()),
            ft_a_amount:u64::from_le_bytes(bytes[80..88].try_into().unwrap()),
            tbc_amount:u64::from_le_bytes(bytes[88..96].try_into().unwrap()),
            ft_a_contract_id:bytes[96..128].try_into().unwrap(),service_fee_rate:u16::from_le_bytes(bytes[128..130].try_into().unwrap()),
            lp_plan:bytes[130],with_swap_hash_lock:bytes[131]==1,with_lp_locktime:bytes[132]==1,with_lp_hash_lock:bytes[133]==1,
        };
        if value.encode()?!=bytes { return Err(AmmError("Noncanonical Pool Tape")); } Ok(value)
    }
    pub fn with_amounts(&self, lp:u64, ft:u64, tbc:u64) -> Result<Self> {
        let next=Self {ft_lp_amount:lp,ft_a_amount:ft,tbc_amount:tbc,..self.clone()};next.encode()?;Ok(next)
    }
    pub fn same_configuration(&self, next:&Self) -> Result<()> {
        let old=self.encode()?;let new=next.encode()?;
        if old[..72]!=new[..72] || old[96..]!=new[96..] {return Err(AmmError("Pool identity or configuration changed"));} Ok(())
    }
}
