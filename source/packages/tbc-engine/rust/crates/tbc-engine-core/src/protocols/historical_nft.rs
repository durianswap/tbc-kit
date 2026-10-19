//! Pure identity evidence for historical NFT policy, not permission to sign.
//!
//! Callers must authenticate the supplied prevouts and adjacent outputs, account
//! for every input/output, and apply the complete operation policy. `None` means
//! unrecognized, never allowed. No network, ancestry traversal, keys or storage.
//! Reuses the holder builder's complete V0/V1/V2 template recognition.

use serde::de::DeserializeOwned;
use tbc_sdk::{Address, OutPoint, TxOut, script::Script,
    contracts::nft::{CollectionData, NftData, scripts::{self, NftVersion}}};

#[cfg(test)]
mod identity_parity_tests {
    use super::*;
    use tbc_sdk::Txid;

    #[test]
    fn v0_policy_identity_matches_the_supported_holder_builder() {
        let collection = Txid::from_le_bytes([7; 32]).to_string();
        for token in [1, 3, u32::MAX] {
            let code = crate::families::nft::legacy_code_script(&collection, token).unwrap();
            let identity = historical_nft_identity(&code).unwrap().unwrap();
            assert_eq!(identity.version, 0);
            assert_eq!(identity.collection_id, collection);
            assert_eq!(identity.token_id, token);
            let owner = Address::from_hash160([1;20]);
            let mut parent = tbc_sdk::Transaction::new();
            parent.outputs = vec![TxOut {satoshis:200,script_pubkey:code.clone()},
                TxOut {satoshis:100,script_pubkey:scripts::hold_script(&owner)},
                TxOut {satoshis:0,script_pubkey:scripts::tape_script(&NftData {
                    nft_name:"V0".into(),symbol:"V0".into(),description:"".into(),
                    attributes:"[]".into(),file:None,
                }).unwrap()}];
            let resolved = parent.outputs.iter().enumerate().map(|(vout,output)|
                super::super::historical_policy::ResolvedHistoricalOutput {
                    outpoint:OutPoint {txid:parent.txid(),vout:vout as u32},output,
                }).collect::<Vec<_>>();
            let mut transfer = parent.clone();
            transfer.inputs = [0,1].into_iter().map(|vout|tbc_sdk::TxIn::new(
                OutPoint {txid:parent.txid(),vout})).collect();
            transfer.outputs[1].script_pubkey=scripts::hold_script(&Address::from_hash160([2;20]));
            let assess = |tx:&tbc_sdk::Transaction|super::super::historical_policy::assess_historical_issuance(
                tx,&resolved,super::super::historical_policy::HistoricalPolicyTemplates::default()).unwrap();
            assert!(assess(&transfer).require_no_historical_issuance().is_ok());
            transfer.inputs.remove(0); // Spending Hold alone cannot credit an issued NFT.
            let minted=assess(&transfer);
            assert_eq!(minted.violations[0].family,"nft");
            assert!(minted.require_no_historical_issuance().is_err());
            let mut tampered = code.as_bytes().to_vec();
            tampered[0] ^= 1;
            assert!(historical_nft_identity(&Script::from_bytes(tampered)).is_err());
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct HistoricalNftIdentity {
    pub version: u8,
    pub collection_id: String,
    pub token_id: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoricalNft {
    pub identity: HistoricalNftIdentity,
    pub controller: [u8; 21],
    /// Retained for callers to enforce immutable metadata on an existing NFT.
    pub tape_script: Vec<u8>,
}

/// Coarse SDK version detection is only a candidate filter. Successful
/// recognition requires equality with the whole reconstructed SDK Code.
pub fn historical_nft_identity(script: &Script) -> Result<Option<HistoricalNftIdentity>, String> {
    // Current TBC721 is a distinct complete covenant, even where historical
    // suffix/length heuristics could select it as an old candidate.
    if super::tbc721::parse_code(script.as_bytes()).is_ok() { return Ok(None); }
    let Some(version) = scripts::nft_version(script) else { return Ok(None); };
    let (collection_id, token_id) = crate::families::nft::code_origin(script, version)
        .map_err(|_| "historical NFT Code does not match its complete origin-bound template")?;
    Ok(Some(HistoricalNftIdentity {
        version: match version { NftVersion::V0 => 0, NftVersion::V1 => 1, NftVersion::V2 => 2 },
        collection_id, token_id,
    }))
}

fn controller(script: &Script, mint: bool) -> Option<[u8; 21]> {
    let bytes = script.as_bytes();
    // Extract a candidate hash only; the SDK reconstruction verifies every byte,
    // including the P2PKH prefix and the complete Mint/Curr Hold suffix.
    let hash: [u8; 20] = bytes.get(3..23)?.try_into().ok()?;
    let address = Address::from_hash160(hash);
    let expected = if mint { scripts::mint_script(&address) } else { scripts::hold_script(&address) };
    if expected != *script { return None; }
    let mut result = [0; 21]; result[..20].copy_from_slice(&hash); Some(result)
}

/// `hold` and `tape` must be the authenticated adjacent Code+1 and Code+2
/// outputs. Missing adjacent material for recognized Code is an error.
pub fn inspect_historical_nft(
    code: &TxOut, hold: Option<&TxOut>, tape: Option<&TxOut>,
) -> Result<Option<HistoricalNft>, String> {
    let Some(identity) = historical_nft_identity(&code.script_pubkey)? else { return Ok(None); };
    let hold = hold.ok_or("historical NFT Hold material is missing")?;
    let tape = tape.ok_or("historical NFT Tape material is missing")?;
    if code.satoshis != scripts::NFT_CODE_SATOSHIS || hold.satoshis != scripts::NFT_HOLD_SATOSHIS {
        return Err("historical NFT Code/Hold values are not canonical".into());
    }
    let controller = controller(&hold.script_pubkey, false)
        .ok_or("historical NFT Hold script is not canonical")?;
    let _: NftData = decode_tape(tape)?;
    Ok(Some(HistoricalNft { identity, controller, tape_script: tape.script_pubkey.as_bytes().to_vec() }))
}

/// Excludes an exact current regular-NFT group from historical issuance rules.
/// This is classification only: collection provenance, spendability, immutable
/// continuation and signing authorization remain the planner/VM's responsibility.
/// Coin certificates share the Code but not the regular Hold/metadata profile;
/// they must receive their own classification rather than a generic Code bypass.
pub fn is_current_regular_nft_group(
    code: &TxOut, hold: Option<&TxOut>, tape: Option<&TxOut>,
) -> Result<bool, String> {
    if super::tbc721::parse_code(code.script_pubkey.as_bytes()).is_err() { return Ok(false); }
    let hold = hold.ok_or("current NFT Hold material is missing")?;
    let tape = tape.ok_or("current NFT Tape material is missing")?;
    if code.satoshis != scripts::NFT_CODE_SATOSHIS || hold.satoshis != scripts::NFT_HOLD_SATOSHIS {
        return Err("current NFT Code/Hold values are not canonical".into());
    }
    controller(&hold.script_pubkey, false).ok_or("current NFT Hold script is not canonical")?;
    let _: NftData = decode_tape(tape)?;
    Ok(true)
}

/// A Mint Hold is a collection issuance slot, NOT an already issued NFT.
/// Recognition alone does not authenticate a collection or grant mint authority.
pub fn inspect_historical_mint_slot(slot: &TxOut) -> Result<Option<[u8; 21]>, String> {
    let Some(owner) = controller(&slot.script_pubkey, true) else { return Ok(None); };
    if slot.satoshis != scripts::NFT_HOLD_SATOSHIS {
        return Err("historical collection mint slot value is not canonical".into());
    }
    Ok(Some(owner))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoricalCollectionSlot {
    pub collection_id: String,
    pub token_id: u32,
    pub controller: [u8; 21],
    pub collection_supply: u32,
}

/// Caller must bind `slot` to `outpoint` and `collection_tape` to vout zero of
/// that SAME authenticated parent. This does not scan a whole collection or
/// establish unspentness, all sibling slots, or historical mint validity.
pub fn inspect_historical_collection_slot(
    outpoint: &OutPoint, slot: &TxOut, collection_tape: Option<&TxOut>,
) -> Result<Option<HistoricalCollectionSlot>, String> {
    let Some(controller) = inspect_historical_mint_slot(slot)? else { return Ok(None); };
    let data: CollectionData = decode_tape(collection_tape.ok_or("historical collection Tape material is missing")?)?;
    if data.supply == 0 || outpoint.vout == 0 || outpoint.vout > data.supply {
        return Err("historical collection slot lies outside its declared supply".into());
    }
    Ok(Some(HistoricalCollectionSlot { collection_id: outpoint.txid.to_string(),
        token_id: outpoint.vout, controller, collection_supply: data.supply }))
}

// Shared historical NTape framing; stableCoin's management certificate uses
// the same envelope with a different, strictly deserialized payload type.
pub(crate) fn decode_tape<T: DeserializeOwned>(output: &TxOut) -> Result<T, String> {
    if output.satoshis != scripts::NFT_TAPE_SATOSHIS { return Err("historical NFT Tape value is not zero".into()); }
    let bytes = output.script_pubkey.as_bytes();
    if !bytes.starts_with(&[0, 0x6a]) { return Err("historical NFT Tape framing is invalid".into()); }
    let mut offset = 2;
    let json = take_push(bytes, &mut offset)?;
    // Match the already deployed receipt parser's bounded historical framing:
    // JSON up to PUSHDATA2, followed by the exact direct five-byte marker.
    if bytes.get(offset..) != Some(b"\x05NTape".as_slice()) {
        return Err("historical NFT Tape marker is invalid".into());
    }
    serde_json::from_slice(json).map_err(|_| "historical NFT Tape JSON is invalid".into())
}

fn take_push<'a>(bytes: &'a [u8], offset: &mut usize) -> Result<&'a [u8], String> {
    let opcode = *bytes.get(*offset).ok_or("historical NFT Tape push is truncated")?;
    *offset += 1;
    let width = match opcode { 0..=75 => 0, 0x4c => 1, 0x4d => 2,
        _ => return Err("historical NFT Tape contains a non-data push".into()) };
    let length = if width == 0 { u32::from(opcode) } else {
        let end = offset.checked_add(width).ok_or("historical NFT Tape push overflow")?;
        let header = bytes.get(*offset..end).ok_or("historical NFT Tape push is truncated")?;
        let mut raw = [0; 4]; raw[..width].copy_from_slice(header); *offset = end; u32::from_le_bytes(raw)
    };
    let length = usize::try_from(length).map_err(|_| "historical NFT Tape push overflow")?;
    let end = offset.checked_add(length).ok_or("historical NFT Tape length overflow")?;
    let value = bytes.get(*offset..end).ok_or("historical NFT Tape push is truncated")?;
    *offset = end; Ok(value)
}
