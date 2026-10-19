//! Exact current LOP script codec; no wallet, key, HTTP, storage or VM.
//! Templates mechanically extracted from TuringBitChain/tbc-contract
//! af77616121db340e15bb8b73c197bc2f8d1ee986 (OpenTBC). This attribution
//! does not relicense the artifacts; redistribution remains a release gate.
//! Recognizing a covenant is not proof of its assets, provenance or authority.
use sha2::{Digest, Sha256};
use std::{fmt, sync::OnceLock};

pub const STANDARD_ID: &str = "tbc-lop";
pub const NATIVE_DATA_BYTES: usize = 114;
pub const TOKEN_DATA_BYTES: usize = 180;
pub const TOKEN_CODE_BYTES: usize = 1332;
pub const PRICE_SCALE: u64 = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LopError(pub &'static str);
impl fmt::Display for LopError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.0) }
}
impl std::error::Error for LopError {}
pub type Result<T> = std::result::Result<T, LopError>;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side { Sell, Buy }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TapeMarker { Legacy, Modern }
impl TapeMarker {
    fn bytes(self) -> &'static [u8] { match self { Self::Legacy => b"FTape", Self::Modern => b"0TAPE" } }
    fn decode(bytes: &[u8]) -> Result<Self> {
        match bytes { b"FTape" => Ok(Self::Legacy), b"0TAPE" => Ok(Self::Modern), _ => Err(LopError("Unknown LOP Tape marker")) }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Market {
    NativeToken { token_code_bytes: u16, marker: TapeMarker },
    /// This covenant encodes Tape kinds, not TBC20-vs-Coin identity. Both modern
    /// profiles use the same marker; authenticate supplied Token Code separately.
    TokenToken { a: TapeMarker, b: TapeMarker },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetTerms { pub partial_hash: [u8;32], pub contract_id: [u8;32] }
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Terms {
    pub owner_hash: [u8;20],
    pub sale_volume: u64,
    pub fee_rate: u64,
    pub unit_price: u64,
    pub asset_a: AssetTerms,
    pub asset_b: Option<AssetTerms>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Code { pub side: Side, pub market: Market, pub tax_hash: [u8;20], pub terms: Terms }

enum Part { Bytes(Vec<u8>), Field(String) }
fn templates() -> &'static Vec<Vec<Part>> {
    static T: OnceLock<Vec<Vec<Part>>> = OnceLock::new();
    T.get_or_init(|| {
        let source: serde_json::Value = serde_json::from_str(include_str!("lop-templates.json")).expect("pinned LOP artifact");
        let compiled: Vec<_> = source["templates"].as_array().unwrap().iter().map(|value| {
            let mut rest=value.as_str().unwrap(); let mut parts=Vec::new();
            while !rest.is_empty() {
                let at=rest.find("${").unwrap_or(rest.len());
                let literal=&rest[..at];assert_eq!(literal.len()%2,0);
                if !literal.is_empty() { parts.push(Part::Bytes(literal.as_bytes().chunks_exact(2).map(|p|
                    u8::from_str_radix(std::str::from_utf8(p).unwrap(),16).unwrap()).collect())); }
                rest=&rest[at..];if rest.is_empty(){break;}
                let end=rest.find('}').unwrap();let name=&rest[2..end];
                assert!(matches!(name,"address"|"taxAddressHex"|"ftCodeSize"|"tapeMarker"|"a"|"b"|"buyCodeSize"|"sellCodeSize"));
                parts.push(Part::Field(name.to_owned()));rest=&rest[end+1..];
            } parts
        }).collect();assert_eq!(compiled.len(),4);compiled
    })
}
fn push(out:&mut Vec<u8>,value:&[u8]) { out.push(value.len() as u8);out.extend_from_slice(value); }
fn take<'a>(bytes:&mut &'a [u8],size:usize) -> Result<&'a [u8]> {
    if bytes.len()<size { return Err(LopError("Truncated LOP Code")); }
    let (value,rest)=bytes.split_at(size);*bytes=rest;Ok(value)
}
fn pushed<const N:usize>(bytes:&mut &[u8]) -> Result<[u8;N]> {
    if take(bytes,1)?!=[N as u8] { return Err(LopError("Noncanonical LOP field push")); }
    Ok(take(bytes,N)?.try_into().unwrap())
}
fn same<T:PartialEq>(slot:&mut Option<T>,value:T)->Result<()> {
    if slot.as_ref().is_some_and(|old|old!=&value){return Err(LopError("Inconsistent repeated LOP field"));}
    *slot=Some(value);Ok(())
}
impl Terms {
    fn encode(&self) -> Vec<u8> {
        let mut out=Vec::new();push(&mut out,&self.owner_hash);push(&mut out,&self.sale_volume.to_le_bytes());
        push(&mut out,&self.asset_a.partial_hash);
        if let Some(b)=&self.asset_b {push(&mut out,&b.partial_hash);}
        push(&mut out,&self.fee_rate.to_le_bytes());push(&mut out,&self.unit_price.to_le_bytes());
        push(&mut out,&self.asset_a.contract_id);
        if let Some(b)=&self.asset_b {push(&mut out,&b.contract_id);}out
    }
    fn decode(mut bytes:&[u8],pair:bool)->Result<Self> {
        let owner_hash=pushed(&mut bytes)?;let sale_volume=u64::from_le_bytes(pushed(&mut bytes)?);
        let partial_hash=pushed(&mut bytes)?;
        let b_hash=if pair{Some(pushed::<32>(&mut bytes)?)}else{None};
        let fee_rate=u64::from_le_bytes(pushed(&mut bytes)?);let unit_price=u64::from_le_bytes(pushed(&mut bytes)?);
        let contract_id=pushed(&mut bytes)?;
        let asset_b=if let Some(partial_hash)=b_hash{Some(AssetTerms{partial_hash,contract_id:pushed(&mut bytes)?})}else{None};
        if !bytes.is_empty(){return Err(LopError("Trailing LOP fields"));}
        Ok(Self{owner_hash,sale_volume,fee_rate,unit_price,asset_a:AssetTerms{partial_hash,contract_id},asset_b})
    }
    /// Codec preserves all u64 wire values. New business construction must also
    /// reject eight-byte signed ScriptNum sign-bit encodings and zero orders.
    pub fn validate_new_order(&self)->Result<()> {
        if self.sale_volume==0||self.unit_price==0||[self.sale_volume,self.unit_price,self.fee_rate].iter().any(|v|*v>i64::MAX as u64) {
            return Err(LopError("LOP terms outside positive signed ScriptNum range"));
        }Ok(())
    }
}
impl Code {
    fn index(&self)->usize { (if matches!(self.market,Market::TokenToken{..}){2}else{0}) + usize::from(self.side==Side::Buy) }
    pub fn encode(&self)->Result<Vec<u8>> {
        if matches!(self.market,Market::TokenToken{..})!=self.terms.asset_b.is_some(){return Err(LopError("LOP market and fields disagree"));}
        let mut out=Vec::new();
        for part in &templates()[self.index()] {
            match part {
                Part::Bytes(bytes)=>out.extend_from_slice(bytes),
                Part::Field(name)=>match name.as_str(){
                    "address"=>push(&mut out,&self.terms.owner_hash),"taxAddressHex"=>push(&mut out,&self.tax_hash),
                    "ftCodeSize"=>if let Market::NativeToken{token_code_bytes,..}=self.market{out.extend_from_slice(&token_code_bytes.to_le_bytes());},
                    "tapeMarker"=>if let Market::NativeToken{marker,..}=self.market{out.extend_from_slice(marker.bytes());},
                    "a"=>if let Market::TokenToken{a,..}=self.market{out.extend_from_slice(a.bytes());},
                    "b"=>if let Market::TokenToken{b,..}=self.market{out.extend_from_slice(b.bytes());},
                    "buyCodeSize"|"sellCodeSize"=>out.extend_from_slice(&[2,0x34,5]),_=>unreachable!(),
                }
            }
        }
        out.extend_from_slice(&self.terms.encode());Ok(out)
    }
    pub fn decode(bytes:&[u8])->Result<Self> {
        for index in 0..4 {if let Ok(code)=Self::decode_at(bytes,index){return Ok(code);}}
        Err(LopError("Unsupported or modified LOP Code"))
    }
    fn decode_at(bytes:&[u8],index:usize)->Result<Self> {
        let pair=index>=2;let size=if pair{TOKEN_DATA_BYTES}else{NATIVE_DATA_BYTES};
        if bytes.len()<size{return Err(LopError("Truncated LOP data"));}
        let (mut prefix,tail)=bytes.split_at(bytes.len()-size);
        let terms=Terms::decode(tail,pair)?;
        let mut tax=None;let mut length=None;let mut marker=None;let mut a=None;let mut b=None;
        for part in &templates()[index] {
            match part {
                Part::Bytes(expected)=>if take(&mut prefix,expected.len())?!=expected {return Err(LopError("Modified LOP opcode"));},
                Part::Field(name)=>match name.as_str(){
                    "address"=>if pushed::<20>(&mut prefix)?!=terms.owner_hash{return Err(LopError("LOP owner tail mismatch"));},
                    "taxAddressHex"=>same(&mut tax,pushed::<20>(&mut prefix)?)?,
                    "ftCodeSize"=>same(&mut length,u16::from_le_bytes(take(&mut prefix,2)?.try_into().unwrap()))?,
                    "tapeMarker"=>same(&mut marker,TapeMarker::decode(take(&mut prefix,5)?)?)?,
                    "a"=>same(&mut a,TapeMarker::decode(take(&mut prefix,5)?)?)?,
                    "b"=>same(&mut b,TapeMarker::decode(take(&mut prefix,5)?)?)?,
                    "buyCodeSize"|"sellCodeSize"=>if take(&mut prefix,3)?!=[2,0x34,5]{return Err(LopError("Modified LOP continuation size"));},
                    _=>unreachable!(),
                }
            }
        }
        if !prefix.is_empty(){return Err(LopError("Trailing LOP opcode"));}
        let market=if pair {Market::TokenToken{a:a.ok_or(LopError("Missing A marker"))?,b:b.ok_or(LopError("Missing B marker"))?}}
            else{Market::NativeToken{token_code_bytes:length.ok_or(LopError("Missing Token size"))?,marker:marker.ok_or(LopError("Missing Token marker"))?}};
        Ok(Self{side:if index%2==0{Side::Sell}else{Side::Buy},market,tax_hash:tax.ok_or(LopError("Missing fee recipient"))?,terms})
    }
    /// Pure continuation; caller verifies fill arithmetic and authorizes the
    /// transition. No identity, owner, fee policy or price can silently change.
    pub fn with_sale_volume(&self,remaining:u64)->Self {let mut next=self.clone();next.terms.sale_volume=remaining;next}
    pub fn token_controller(&self)->Result<[u8;20]> {Ok(tbc_sdk::hash::hash160(&Sha256::digest(self.encode()?)))}
}
