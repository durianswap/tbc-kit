//! Shared NFT read-plan recognition, not spendability or signing authority.
//! Reuses pinned current and existing historical complete Code reconstruction.
use tbc_sdk::{Address, OutPoint, Transaction, Txid, script::Script,
    contracts::nft::{CollectionData, NftData, scripts}};

/// Collection framing is shared by historical and current NFT contracts.
/// This immutable layout is not an unspentness observation or mint permission.
pub struct CollectionLayout {
    pub metadata: CollectionData,
    pub owner: Address,
}

pub fn inspect_collection_layout(tx: &Transaction) -> Result<CollectionLayout, String> {
    let metadata: CollectionData = super::nft_metadata::decode_tape(
        tx.outputs.first().ok_or("Collection Tape missing")?
    ).map_err(|_| "Collection Tape is invalid")?;
    if tx.version != 10 || tx.inputs.is_empty()
        || tx.serialize().len() > super::tbc20_material::MAX_MATERIAL_TRANSACTION_BYTES
        || metadata.supply == 0
        || u64::from(metadata.supply) + 1 > crate::signing::MAX_SIGNING_PLAN_OUTPUTS as u64
        || ![metadata.supply as usize + 1, metadata.supply as usize + 2].contains(&tx.outputs.len()) {
        return Err("Collection layout does not match its supply".into());
    }
    let hash: [u8; 20] = tx.outputs[1].script_pubkey.as_bytes().get(3..23)
        .ok_or("Collection mint owner missing")?.try_into().map_err(|_| "Collection mint owner invalid")?;
    let owner = Address::from_hash160(hash);
    let script = scripts::mint_script(&owner);
    if tx.outputs[1..=metadata.supply as usize].iter().any(|o| o.satoshis != 100 || o.script_pubkey != script) {
        return Err("Collection slots do not match their mint owner".into());
    }
    Ok(CollectionLayout { metadata, owner })
}

pub fn inspect_collection_origin(id: &Txid, raw: &[u8]) -> Result<CollectionLayout, String> {
    if raw.is_empty() || raw.len() > super::tbc20_material::MAX_MATERIAL_TRANSACTION_BYTES {
        return Err("Collection origin exceeds byte bound".into());
    }
    let tx = Transaction::from_bytes(raw).map_err(|_| "Collection origin transaction invalid")?;
    if tx.txid() != *id || tx.serialize() != raw {
        return Err("Collection origin identity or encoding invalid".into());
    }
    inspect_collection_layout(&tx)
}

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
