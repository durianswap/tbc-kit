//! Full pinned tbc-amm Pool3 templates and canonical 1-of-N controller whitelist.
//! Source: tbc-contract af77616121db340e15bb8b73c197bc2f8d1ee986,
//! lib/util/poolnft3/{artifacts,authorization}.ts. Adjacent templates are verbatim;
//! upstream OpenTBC redistribution terms remain a release gate, not relicensed CC0.
//! This codec does not prove UTXO ancestry, authorization of a request or spendability.
use std::sync::OnceLock;
use sha2::{Digest,Sha256};
use tbc_sdk::PublicKey;
use super::{amm::{AmmError,Result},amm_template::{Template,Values}};

pub const STANDARD_ID:&str="tbc-amm";
const PUBLIC:&str=include_str!("amm-pool-template.hex");
const CONTROLLED:&str=include_str!("amm-pool_hash_lock-template.hex");
const CONTROLLER_TAIL:&str="76a9<self.Controller20>88ad516a09504f4f4c434f444532";
const CODE_END:&[u8]=b"\xad\x51\x6a\x09POOLCODE2";
const ORIGINAL:&str="<self.OriginalUTXO36>";
const FEE:&str="<self.TbcFeeScriptHash32>";
const SIZE:&str="<self.FtTapeSize1>";

#[derive(Debug,Clone,PartialEq,Eq)]
pub enum Authorization {Public, Controller(Vec<[u8;20]>)}
impl Authorization {
    /// Canonical ascending unique hashes; one member suffices, NOT M-of-N multisig.
    pub fn normalized(&self) -> Result<Self> {
        match self {
            Self::Public=>Ok(Self::Public),
            Self::Controller(hashes)=> {
                if !(1..=5).contains(&hashes.len()) {return Err(AmmError("Pool requires 1-5 controllers"));}
                let mut sorted=hashes.clone();sorted.sort_unstable();
                if sorted.windows(2).any(|pair|pair[0]==pair[1]) {return Err(AmmError("Duplicate Pool controller"));}
                Ok(Self::Controller(sorted))
            }
        }
    }
    pub fn verify_controller(&self, key:&[u8]) -> Result<()> {
        let Self::Controller(hashes)=self.normalized()? else {return Err(AmmError("Public Pool has no controller signature"));};
        if key.len()!=33 {return Err(AmmError("Pool controller key must be compressed"));}
        let key=PublicKey::from_slice(key).map_err(|_|AmmError("Invalid Pool controller public key"))?;
        if !hashes.contains(&key.hash160()) {return Err(AmmError("Signer not in Pool controller whitelist"));} Ok(())
    }
}
pub fn controller_membership(hashes:&[[u8;20]]) -> Result<Vec<u8>> {
    let Authorization::Controller(hashes)=Authorization::Controller(hashes.to_vec()).normalized()? else {unreachable!()};
    let mut script=Vec::with_capacity(22+27*(hashes.len()-1));
    for hash in &hashes[..hashes.len()-1] {
        script.extend_from_slice(&[0x76,0x14]);script.extend_from_slice(hash);
        script.extend_from_slice(&[0x87,0x63,0x75,0x67]);
    }
    script.push(0x14);script.extend_from_slice(hashes.last().unwrap());script.push(0x88);
    script.resize(script.len()+hashes.len()-1,0x68);Ok(script)
}
pub fn parse_membership(script:&[u8]) -> Result<Vec<[u8;20]>> {
    let mut offset=0;let mut hashes=Vec::new();
    while script.get(offset)==Some(&0x76) {
        if hashes.len()>=4 || script.get(offset+1)!=Some(&0x14)
            || script.get(offset+22..offset+26)!=Some(&[0x87,0x63,0x75,0x67][..]) {
            return Err(AmmError("Noncanonical controller branch"));
        }
        hashes.push(script[offset+2..offset+22].try_into().unwrap());offset+=26;
    }
    if script.get(offset)!=Some(&0x14) || script.get(offset+21)!=Some(&0x88) {
        return Err(AmmError("Missing terminal controller comparison"));
    }
    hashes.push(script[offset+1..offset+21].try_into().unwrap());offset+=22;
    if script.len()!=offset+hashes.len()-1 || script[offset..].iter().any(|&b|b!=0x68)
        || controller_membership(&hashes)?!=script {
        return Err(AmmError("Noncanonical controller order or closure"));
    }
    Ok(hashes)
}
#[derive(Debug,Clone,PartialEq,Eq)]
pub struct Code {
    /// Serialized outpoint: little-endian txid then vout.
    pub original_utxo:[u8;36],
    /// SHA256 of the complete fee recipient P2PKH script, not hash160/address.
    pub fee_script_hash:[u8;32],
    pub ft_tape_size:u8,
    pub authorization:Authorization,
}
fn template(controlled:bool) -> &'static Template {
    static PUBLIC_TEMPLATE:OnceLock<Template>=OnceLock::new();
    static CONTROLLED_TEMPLATE:OnceLock<Template>=OnceLock::new();
    let compile=|source|Template::compile(source,&[(ORIGINAL,36),(FEE,32),(SIZE,1)]);
    if controlled {CONTROLLED_TEMPLATE.get_or_init(|| {
        let source=CONTROLLED.trim().strip_suffix(CONTROLLER_TAIL).expect("pinned controller boundary");
        // HASH160 prefix added outside this compiled fixed body.
        compile(source)
    })} else {PUBLIC_TEMPLATE.get_or_init(||compile(PUBLIC))}
}
pub fn validate_tape_size(size:u8, locked:bool) -> Result<()> {
    let minimum=if locked {66} else {61};
    if !(minimum..=127).contains(&size) {return Err(AmmError("Invalid Pool/LP Tape size"));}Ok(())
}
pub fn instantiate_code(code:&Code) -> Result<Vec<u8>> {
    validate_tape_size(code.ft_tape_size,false)?;
    let authorization=code.authorization.normalized()?;
    let values=Values::from([(ORIGINAL,code.original_utxo.to_vec()),(FEE,code.fee_script_hash.to_vec()),(SIZE,vec![code.ft_tape_size])]);
    let mut bytes=template(matches!(authorization,Authorization::Controller(_))).instantiate(&values)?;
    if let Authorization::Controller(hashes)=authorization {
        bytes.extend_from_slice(&[0x76,0xa9]);bytes.extend_from_slice(&controller_membership(&hashes)?);bytes.extend_from_slice(CODE_END);
    }
    Ok(bytes)
}
pub fn parse_code(bytes:&[u8]) -> Result<Code> {
    for controlled in [false,true] {
        let t=template(controlled);
        let Ok(values)=t.parse_prefix(bytes) else {continue};
        let tail=&bytes[t.len()..];
        let authorization=if controlled {
            let Some(membership)=tail.strip_prefix(&[0x76,0xa9]).and_then(|b|b.strip_suffix(CODE_END)) else {continue};
            let Ok(hashes)=parse_membership(membership) else {continue};Authorization::Controller(hashes)
        } else {if !tail.is_empty() {continue;}Authorization::Public};
        let code=Code {original_utxo:values[ORIGINAL].as_slice().try_into().unwrap(),
            fee_script_hash:values[FEE].as_slice().try_into().unwrap(),ft_tape_size:values[SIZE][0],authorization};
        if instantiate_code(&code).is_ok_and(|canonical|canonical==bytes) {return Ok(code);}
    }
    Err(AmmError("Unsupported or modified Pool Code"))
}
pub fn code_hash(bytes:&[u8]) -> Result<[u8;32]> {parse_code(bytes)?;Ok(Sha256::digest(bytes).into())}
