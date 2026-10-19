//! Shared, offline Pool read-plan identification. No FT-version or index labels
//! authorize a spend. Exact Code/Tape matching is followed by the normal planner's
//! independent underlying FT/LP, source, ownership, policy and state validation.
use std::sync::OnceLock;
use tbc_sdk::{Transaction, Txid, OutPoint, script::Script, contracts::pool_nft_v2::{
    FtScriptVersion, PoolCodeParams, pool_code,
    unlock::pool_code_lock,
}};
use super::{amm_material, historical_pool::{inspect_historical_pool, HistoricalPoolTemplate,
    HistoricalPoolLockTemplate, released_locked_pool_lp_cost}};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolProfile { Current, Historical }

struct Chunk<'a> { opcode: u8, data: Option<&'a [u8]> }
fn chunks(bytes: &[u8]) -> Result<Vec<Chunk<'_>>, String> {
    let mut result = Vec::new();let mut at = 0;
    while at < bytes.len() {
        let opcode = bytes[at];at += 1;
        let length = match opcode {
            0..=75 => Some(opcode as usize),
            76 => {let n=*bytes.get(at).ok_or("truncated Pool push")? as usize;at+=1;Some(n)},
            77 => {let n=bytes.get(at..at+2).ok_or("truncated Pool push")?;at+=2;Some(u16::from_le_bytes(n.try_into().unwrap()) as usize)},
            78 => {let n=bytes.get(at..at+4).ok_or("truncated Pool push")?;at+=4;Some(u32::from_le_bytes(n.try_into().unwrap()) as usize)},
            _ => None,
        };
        let data = if let Some(length) = length {
            let end=at.checked_add(length).ok_or("Pool push overflow")?;
            let data=bytes.get(at..end).ok_or("truncated Pool field")?;at=end;Some(data)
        } else {None};
        result.push(Chunk {opcode,data});
    }Ok(result)
}

pub(crate) fn historical_template(code: &Script) -> Result<HistoricalPoolTemplate, String> {
    let fields=chunks(code.as_bytes())?;
    let tail=fields.get(fields.len().checked_sub(4).ok_or("Pool tail absent")?..).ok_or("Pool tail absent")?;
    if tail[0].opcode!=0x51 || tail[1].opcode!=0x6a || tail[3].data!=Some(b"2Code".as_slice()) {
        return Err("historical Pool tag framing invalid".into());
    }
    let tag=tail[2].data.ok_or("historical Pool tag absent")?;
    if tag.len()>75 || tail[2].opcode as usize != tag.len() {return Err("historical Pool tag is not a direct push".into());}
    // Both pinned public and locked Code begin with the same fixed prefix.
    // Locate its first FT-size push from the SDK template once, not by scanning
    // attacker data for constants or trying multiple FT versions/builders.
    static SIZE_INDEX: OnceLock<usize> = OnceLock::new();
    let index=*SIZE_INDEX.get_or_init(|| {
        let script=pool_code(OutPoint {txid:"00".repeat(32).parse().unwrap(),vout:0},b"x",
            &PoolCodeParams {lp_plan:1,ft_version:FtScriptVersion::V4,is_coin:false}).expect("pinned Pool prototype");
        let fields=chunks(script.as_bytes()).expect("pinned Pool chunks");
        fields.windows(3).position(|w|w[0].opcode==0x52&&w[1].opcode==0x79&&w[2].data==Some([0x1c,0x08].as_slice()))
            .expect("pinned Pool FT-size field")+2
    });
    let size=fields.get(index).and_then(|f|f.data).ok_or("Pool FT-size field absent")?;
    // These are Code equivalence classes, not claims about the real underlying
    // FT generation. E.g. V4 ordinary/Coin and V2/V3 share their Pool template.
    let (ft_version,is_coin)=match size {
        [0x1c,0x08] => (FtScriptVersion::V4,false),
        [0xdc,0x07] => (FtScriptVersion::V3,true),
        [0x1c,0x06] => (FtScriptVersion::V1,false),
        [0x5c,0x07] => (FtScriptVersion::V2,false),
        _ => return Err("unsupported Pool FT-size template".into()),
    };
    let public_keys=pool_code_lock(code).map_err(|e|e.to_string())?;
    let lock=if public_keys.is_empty(){None}else{
        let (lp_cost_address,lp_cost_sat)=released_locked_pool_lp_cost(code)?;
        Some(HistoricalPoolLockTemplate {public_keys,lp_cost_address,lp_cost_sat})
    };
    Ok(HistoricalPoolTemplate {ft_version,is_coin,tag:tag.to_vec(),lock})
}

fn inspect(tx: &Transaction) -> Result<(PoolProfile, Vec<u8>), String> {
    if tx.version!=10 || tx.inputs.is_empty() || tx.outputs.len()<2 {return Err("Pool transaction framing invalid".into());}
    let code=&tx.outputs[0];
    if code.script_pubkey.as_bytes().ends_with(b"\x052Code") {
        let template=historical_template(&code.script_pubkey)?;
        let pool=inspect_historical_pool(code,tx.outputs.get(1),Some(&template))?.ok_or("historical Pool template absent")?;
        let mut source=Vec::new();pool.identity.source.serialize(&mut source);
        Ok((PoolProfile::Historical,source))
    }else{
        let pool=amm_material::inspect_pool(tx).map_err(|e|e.message)?;
        Ok((PoolProfile::Current,pool.code.original_utxo.to_vec()))
    }
}
pub fn inspect_pool_profile(tx: &Transaction) -> Result<PoolProfile, String> {inspect(tx).map(|value|value.0)}

pub fn inspect_pool_origin(id: &Txid, bytes: &[u8]) -> Result<PoolProfile, String> {
    if bytes.len()>1_048_576 {return Err("Pool origin exceeds byte bound".into());}
    let tx=Transaction::from_bytes(bytes).map_err(|e|e.to_string())?;
    if tx.serialize()!=bytes || &tx.txid()!=id {return Err("Pool origin identity mismatch".into());}
    let (profile,source)=inspect(&tx)?;
    if profile==PoolProfile::Historical && tx.outputs[0].satoshis!=1_000 {return Err("historical Pool origin value invalid".into());}
    let mut expected=Vec::new();tx.inputs[0].previous_output.serialize(&mut expected);
    if source!=expected {return Err("Pool origin source mismatch".into());}
    Ok(profile)
}
