//! Shared NFT read-plan recognition, not spendability or signing authority.
//! Reuses pinned current and existing historical complete Code reconstruction.
use tbc_sdk::{Address, OutPoint, Transaction, Txid, script::Script,
    contracts::nft::{NftData, scripts}};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NftOriginProfile { Current, Historical }

pub fn inspect_nft_code(script: &Script) -> Result<(NftOriginProfile, OutPoint), String> {
    if let Ok(code) = super::tbc721::parse_code(script.as_bytes()) {
        return Ok((NftOriginProfile::Current, code.original_outpoint));
    }
    let version = scripts::nft_version(script).ok_or("unified NFT template is unrecognized")?;
    let (id, vout) = crate::families::nft::code_origin(script, version)
        .map_err(|_| "unified NFT template does not match")?;
    Ok((NftOriginProfile::Historical, OutPoint {
        txid: id.parse().map_err(|_| "NFT origin identity invalid")?, vout,
    }))
}

pub fn inspect_nft_origin(id: &Txid, raw: &[u8]) -> Result<NftOriginProfile, String> {
    if raw.is_empty() || raw.len() > 1_048_576 { return Err("NFT origin exceeds byte bound".into()); }
    let tx = Transaction::from_bytes(raw).map_err(|_| "NFT origin transaction invalid")?;
    if tx.txid() != *id || tx.serialize() != raw || tx.version != 10 || tx.inputs.is_empty()
        || !(3..=4).contains(&tx.outputs.len()) {
        return Err("NFT origin identity or topology invalid".into());
    }
    let (profile, origin) = inspect_nft_code(&tx.outputs[0].script_pubkey)?;
    if origin.vout == 0 || tx.inputs[0].previous_output != origin
        || tx.outputs[0].satoshis != 200 || tx.outputs[1].satoshis != 100 {
        return Err("NFT origin must spend a bound collection slot".into());
    }
    let hash: [u8;20] = tx.outputs[1].script_pubkey.as_bytes().get(3..23)
        .ok_or("NFT Hold missing")?.try_into().map_err(|_| "NFT Hold invalid")?;
    if tx.outputs[1].script_pubkey != scripts::hold_script(&Address::from_hash160(hash)) {
        return Err("NFT origin requires ordinary NFT Hold, not Coin or mint authority".into());
    }
    let _: NftData = super::nft_metadata::decode_tape(&tx.outputs[2])
        .map_err(|_| "NFT metadata is invalid")?;
    Ok(profile)
}
