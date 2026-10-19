//! Explicit-fee AMM codec pinned to tbc-contract 1.7.3 / 2f3fe787.
//! Separate from the deployed 143-byte preset codec. Neither template parsing
//! nor a fee quote establishes ancestry, authorization or consensus validity.
//! Keyless/read-free: shared transaction planning and finalization own those checks.
use std::sync::OnceLock;
use serde::{Deserialize, Serialize};
use tbc_sdk::{Address, hash};
use super::{amm::{self, amount, AmmError, Result, Variant}, amm_code::{self, Authorization},
    amm_math::{self, State, Fees, BuyQuote, SellQuote}, amm_template::{Template, Values}};

pub const TAPE_BYTES: usize = 168;
const PREFIX: &[u8] = &[0, 0x6a, 0x4c, 0x9b];
const MARKER: &[u8] = b"POOLTAPE";

/// Raw lossless Tape fields, in basis points. Deserialization rejects fractions,
/// negatives, unknown properties and numeric strings, but the codec alone must
/// not pretend that a combined rate is an executable swap policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct FeeRates {
    pub lp_fee_rate: u16,
    pub tax_fee_rate: u16,
    pub service_provider_fee_rate: u16,
    pub protocol_fee_rate: u16,
}
impl FeeRates {
    pub fn total(self) -> u32 {
        u32::from(self.lp_fee_rate) + u32::from(self.tax_fee_rate)
            + u32::from(self.service_provider_fee_rate) + u32::from(self.protocol_fee_rate)
    }
    pub fn validate(self) -> Result<Self> {
        if self.total() >= 10_000 { return Err(AmmError("AMM total fee must be below 10000 bps")); }
        Ok(self)
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeePolicy { rates: FeeRates, recipient: Address }
impl FeePolicy {
    pub fn new(rates: FeeRates, fee_address: &str) -> Result<Self> {
        rates.validate()?;
        let recipient=Address::from_string(fee_address).map_err(|_|AmmError("AMM fee recipient must be canonical P2PKH"))?;
        if recipient.to_string()!=fee_address { return Err(AmmError("Noncanonical AMM fee address")); }
        Ok(Self{rates,recipient})
    }
    pub fn from_tape(tape: &Tape) -> Result<Self> {
        Self::new(tape.rates,&Address::from_hash160(tape.fee_pubkey_hash).to_string())
    }
    pub fn rates(&self) -> FeeRates { self.rates }
    pub fn total_fee_bps(&self) -> u16 { self.rates.total() as u16 }
    pub fn lp_fee_bps(&self) -> u16 { self.rates.lp_fee_rate }
    pub fn fee_address(&self) -> String { self.recipient.to_string() }
    pub fn fee_pubkey_hash(&self) -> [u8;20] { self.recipient.hash160() }
    pub fn fee_script_hash(&self) -> [u8;32] { hash::sha256(self.recipient.script_pubkey().as_bytes()) }
    pub fn calculate(&self, base: u64) -> Result<Fees> {
        // The existing primitive implements floor(total) - floor(LP), the
        // 10-atomic payout floor, reserve accounting and checked u128 math.
        amm_math::calculate_with_rates(base,self.total_fee_bps(),self.lp_fee_bps())
    }
    pub fn quote_buy(&self, state: State, input: u64, minimum: u64) -> Result<BuyQuote> {
        state.validate(true)?;amount(input)?;amount(minimum)?;
        if input==0 { return Err(AmmError("Positive AMM input required")); }
        let fees=self.calculate(input)?;
        // npm 1.7.3 math.ts still requires strictly positive retained fees.
        // A valid zero-rate Tape is not proof that a swap is executable.
        if fees.pool_fee_retained_sat==0 { return Err(AmmError("AMM swap requires positive retained pool fee")); }
        amm_math::quote_buy_fees(state,input,fees,minimum)
    }
    pub fn quote_sell(&self, state: State, input: u64, minimum: u64) -> Result<SellQuote> {
        let quote=amm_math::quote_sell_rates(state,input,self.total_fee_bps(),self.lp_fee_bps(),minimum)?;
        if quote.pool_value_decrement_sat>=quote.gross_tbc_out_sat { return Err(AmmError("AMM swap requires positive retained pool fee")); }
        Ok(quote)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tape {
    pub ft_lp_partial_hash: [u8;32], pub ft_lp_code_size: u16,
    pub ft_a_partial_hash: [u8;32], pub ft_a_code_size: u16,
    pub ft_lp_amount: u64, pub ft_a_amount: u64, pub tbc_amount: u64,
    pub ft_a_contract_id: [u8;32],
    pub rates: FeeRates, pub fee_pubkey_hash: [u8;20],
    pub with_swap_hash_lock: bool, pub with_lp_locktime: bool, pub with_lp_hash_lock: bool,
}
impl Tape {
    pub fn variant(&self) -> Result<Variant> {
        if self.with_swap_hash_lock!=self.with_lp_hash_lock { return Err(AmmError("Unsupported AMM authorization flags")); }
        Ok(match(self.with_swap_hash_lock,self.with_lp_locktime) {
            (false,false)=>Variant::Public,(false,true)=>Variant::PublicTimelocked,
            (true,false)=>Variant::Controller,(true,true)=>Variant::ControllerTimelocked,
        })
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.variant()?;
        for size in [self.ft_lp_code_size,self.ft_a_code_size] {
            if !(128..=0x7fff).contains(&size) { return Err(AmmError("AMM Code size must be positive two-byte ScriptNum")); }
        }
        let mut bytes=vec![0;TAPE_BYTES];bytes[..4].copy_from_slice(PREFIX);
        bytes[4..36].copy_from_slice(&self.ft_lp_partial_hash);bytes[36..38].copy_from_slice(&self.ft_lp_code_size.to_le_bytes());
        bytes[38..70].copy_from_slice(&self.ft_a_partial_hash);bytes[70..72].copy_from_slice(&self.ft_a_code_size.to_le_bytes());
        for(offset,value)in[(72,self.ft_lp_amount),(80,self.ft_a_amount),(88,self.tbc_amount)] {
            bytes[offset..offset+8].copy_from_slice(&amount(value)?.to_le_bytes());
        }
        bytes[96..128].copy_from_slice(&self.ft_a_contract_id);
        for(offset,rate)in[(128,self.rates.lp_fee_rate),(130,self.rates.tax_fee_rate),
            (132,self.rates.service_provider_fee_rate),(134,self.rates.protocol_fee_rate)] {
            bytes[offset..offset+2].copy_from_slice(&rate.to_le_bytes());
        }
        bytes[136..156].copy_from_slice(&self.fee_pubkey_hash);
        bytes[156]=self.with_swap_hash_lock as u8;bytes[157]=self.with_lp_locktime as u8;bytes[158]=self.with_lp_hash_lock as u8;
        bytes[159]=8;bytes[160..].copy_from_slice(MARKER);Ok(bytes)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len()!=TAPE_BYTES || &bytes[..4]!=PREFIX || &bytes[160..]!=MARKER {
            return Err(AmmError("Unsupported explicit-fee AMM Tape"));
        }
        if bytes[156..159].iter().any(|&x|x>1) { return Err(AmmError("AMM flags must be zero or one")); }
        let u16_at=|i|u16::from_le_bytes(bytes[i..i+2].try_into().unwrap());
        let u64_at=|i|u64::from_le_bytes(bytes[i..i+8].try_into().unwrap());
        let value=Self {
            ft_lp_partial_hash:bytes[4..36].try_into().unwrap(),ft_lp_code_size:u16_at(36),
            ft_a_partial_hash:bytes[38..70].try_into().unwrap(),ft_a_code_size:u16_at(70),
            ft_lp_amount:u64_at(72),ft_a_amount:u64_at(80),tbc_amount:u64_at(88),
            ft_a_contract_id:bytes[96..128].try_into().unwrap(),
            rates:FeeRates{lp_fee_rate:u16_at(128),tax_fee_rate:u16_at(130),service_provider_fee_rate:u16_at(132),protocol_fee_rate:u16_at(134)},
            fee_pubkey_hash:bytes[136..156].try_into().unwrap(),
            with_swap_hash_lock:bytes[156]==1,with_lp_locktime:bytes[157]==1,with_lp_hash_lock:bytes[158]==1,
        };
        // Upstream does not constrain byte159 preceding POOLTAPE. Validate all
        // fields while accepting that byte. Keep original raw parent bytes in
        // ancestry evidence; encode() is for newly constructed state only.
        value.encode()?;Ok(value)
    }
    pub fn with_amounts(&self, lp:u64, ft:u64, tbc:u64) -> Result<Self> {
        let next=Self{ft_lp_amount:lp,ft_a_amount:ft,tbc_amount:tbc,..self.clone()};next.encode()?;Ok(next)
    }
    pub fn same_configuration(&self, next:&Self) -> Result<()> {
        let old=self.encode()?;let new=next.encode()?;
        if old[..72]!=new[..72] || old[96..]!=new[96..] { return Err(AmmError("AMM identity or fee configuration changed")); }
        Ok(())
    }
}

const PUBLIC:&str=include_str!("amm-explicit173-pool.hex");
const CONTROLLED:&str=include_str!("amm-explicit173-pool_hash_lock.hex");
const TAG_END:&str="<self.ServiceProviderTag>09504f4f4c434f444532";
const CONTROL_TAIL:&str="76a9<self.Controller20>88ad516a11ffffffffffffffffffffffffffffffffff<self.ServiceProviderTag>09504f4f4c434f444532";
const CONTROL_RETURN:&[u8]=&[0xad,0x51,0x6a,0x11,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff];
const CODE_FLAG:&[u8]=b"\x09POOLCODE2";
const ORIGINAL:&str="<self.OriginalUTXO36>";
const FEE:&str="<self.TbcFeeScriptHash32>";
const SIZE:&str="<self.FtTapeSize1>";

#[derive(Debug,Clone,PartialEq,Eq)]
pub struct Code {
    pub original_utxo:[u8;36], pub fee_script_hash:[u8;32], pub ft_tape_size:u8,
    pub authorization:Authorization, pub service_provider_tag:Vec<u8>,
}
impl Code {
    /// Bind both template and Tape; the shared planner must additionally bind
    /// FT/LP identities, controller flags, ancestry and the complete request.
    pub fn fee_policy(&self, tape:&Tape) -> Result<FeePolicy> {
        let policy=FeePolicy::from_tape(tape)?;
        if policy.fee_script_hash()!=self.fee_script_hash { return Err(AmmError("AMM Tape fee address differs from Code commitment")); }
        Ok(policy)
    }
}
fn template(controlled:bool) -> &'static Template {
    static PUBLIC_TEMPLATE:OnceLock<Template>=OnceLock::new();
    static CONTROLLED_TEMPLATE:OnceLock<Template>=OnceLock::new();
    let compile=|s|Template::compile(s,&[(ORIGINAL,36),(FEE,32),(SIZE,1)]);
    if controlled { CONTROLLED_TEMPLATE.get_or_init(||compile(CONTROLLED.trim().strip_suffix(CONTROL_TAIL).expect("pinned explicit AMM controller tail"))) }
    else { PUBLIC_TEMPLATE.get_or_init(||compile(PUBLIC.trim().strip_suffix(TAG_END).expect("pinned explicit AMM tag tail"))) }
}
fn push_tag(tag:&[u8]) -> Result<Vec<u8>> {
    let mut output=Vec::new();let n=tag.len();
    match n {
        0..=75=>output.push(n as u8),
        76..=255=>output.extend_from_slice(&[0x4c,n as u8]),
        256..=65535=>{output.push(0x4d);output.extend_from_slice(&(n as u16).to_le_bytes());},
        _=>{let n=u32::try_from(n).map_err(|_|AmmError("AMM tag exceeds script encoding"))?;output.push(0x4e);output.extend_from_slice(&n.to_le_bytes());},
    }
    output.extend_from_slice(tag);Ok(output)
}
fn read_tag(tail:&[u8]) -> Result<Vec<u8>> {
    let (prefix,n):(usize,usize)=match tail.first().copied() {
        Some(n @ 0..=75)=>(1,n as usize),
        Some(0x4c) if tail.len()>=2=>(2,tail[1] as usize),
        Some(0x4d) if tail.len()>=3=>(3,u16::from_le_bytes(tail[1..3].try_into().unwrap()) as usize),
        Some(0x4e) if tail.len()>=5=>(5,u32::from_le_bytes(tail[1..5].try_into().unwrap()) as usize),
        _=>return Err(AmmError("Invalid AMM tag push")),
    };
    let end=prefix.checked_add(n).ok_or(AmmError("AMM tag length overflow"))?;
    let tag=tail.get(prefix..end).ok_or(AmmError("Truncated AMM tag"))?;
    if tail.get(end..)!=Some(CODE_FLAG) || push_tag(tag)?!=tail[..end] { return Err(AmmError("Noncanonical AMM tag or marker")); }
    Ok(tag.to_vec())
}
pub fn instantiate_code(code:&Code) -> Result<Vec<u8>> {
    amm_code::validate_tape_size(code.ft_tape_size,false)?;
    let authorization=code.authorization.normalized()?;
    let values=Values::from([(ORIGINAL,code.original_utxo.to_vec()),(FEE,code.fee_script_hash.to_vec()),(SIZE,vec![code.ft_tape_size])]);
    let mut bytes=template(matches!(authorization,Authorization::Controller(_))).instantiate(&values)?;
    if let Authorization::Controller(hashes)=authorization {
        bytes.extend_from_slice(&[0x76,0xa9]);bytes.extend_from_slice(&amm_code::controller_membership(&hashes)?);bytes.extend_from_slice(CONTROL_RETURN);
    }
    bytes.extend_from_slice(&push_tag(&code.service_provider_tag)?);bytes.extend_from_slice(CODE_FLAG);Ok(bytes)
}
fn membership_length(tail:&[u8]) -> Result<usize> {
    let mut offset=0;let mut branches=0;
    while tail.get(offset)==Some(&0x76) {
        if branches>=4 || tail.get(offset+1)!=Some(&0x14) || tail.get(offset+22..offset+26)!=Some(&[0x87,0x63,0x75,0x67][..]) {
            return Err(AmmError("Invalid AMM controller branch"));
        }
        branches+=1;offset+=26;
    }
    let length=offset+22+branches;
    let script=tail.get(..length).ok_or(AmmError("Truncated AMM membership"))?;
    amm_code::parse_membership(script)?;Ok(length)
}
pub fn parse_code(bytes:&[u8]) -> Result<Code> {
    for controlled in [false,true] {
        let parsed=(|| -> Result<Code> {
            let t=template(controlled);let values=t.parse_prefix(bytes)?;
            let mut tail=&bytes[t.len()..];
            let authorization=if controlled {
                tail=tail.strip_prefix(&[0x76,0xa9]).ok_or(AmmError("Missing AMM controller prefix"))?;
                let n=membership_length(tail)?;let hashes=amm_code::parse_membership(&tail[..n])?;
                tail=tail[n..].strip_prefix(CONTROL_RETURN).ok_or(AmmError("Modified AMM controller return"))?;
                Authorization::Controller(hashes)
            }else{Authorization::Public};
            let code=Code{original_utxo:values[ORIGINAL].as_slice().try_into().unwrap(),fee_script_hash:values[FEE].as_slice().try_into().unwrap(),
                ft_tape_size:values[SIZE][0],authorization,service_provider_tag:read_tag(tail)?};
            if instantiate_code(&code)?!=bytes { return Err(AmmError("Noncanonical explicit AMM Code")); }
            Ok(code)
        })();
        if let Ok(code)=parsed { return Ok(code); }
    }
    Err(AmmError("Unsupported or modified explicit AMM Code"))
}

/// Explicit profiles remain separate even though their human-readable marker
/// is identical. Callers must match Code and Tape profiles, not just POOLTAPE.
pub enum VersionedTape { Preset(amm::Tape), Explicit(Tape) }
pub fn decode_tape(bytes:&[u8]) -> Result<VersionedTape> {
    match bytes.len() {
        amm::TAPE_BYTES=>amm::Tape::decode(bytes).map(VersionedTape::Preset),
        TAPE_BYTES=>Tape::decode(bytes).map(VersionedTape::Explicit),
        _=>Err(AmmError("Unsupported AMM Tape length")),
    }
}
