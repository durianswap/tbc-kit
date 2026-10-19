//! Pure evidence for the historical stableCoin issuance certificate.
//! This is not the new `tbc20-stablecoin` profile and does not authorize minting,
//! management signing, or a transaction. Authenticate all supplied adjacent
//! outputs first; unknown templates must be handled by the complete policy.

use std::sync::OnceLock;
use tbc_sdk::{Address, OutPoint, TxOut, Txid, script::Script,
    contracts::{nft, stable_coin::{CoinNftData, scripts}}};
use super::historical_nft::decode_tape;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoricalCoinCertificate {
    /// Original funding outpoint bound by the complete immutable Code.
    pub source: OutPoint,
    pub admin_hash: [u8; 20],
    pub total_supply: u128,
    pub data: CoinNftData,
}

/// Return a source only after reconstructing and matching the entire released
/// Code. Sharing the `3Code` suffix with historical NFTs is not identification.
pub fn historical_coin_source(code: &Script) -> Result<Option<OutPoint>, String> {
    static CODE_BYTES: OnceLock<usize> = OnceLock::new();
    let expected_length = *CODE_BYTES.get_or_init(|| {
        scripts::coin_nft_code_script(&Txid::from_le_bytes([0; 32]).to_string(), 0)
            .expect("fixed SDK coin certificate template").as_bytes().len()
    });
    let bytes = code.as_bytes();
    if bytes.len() != expected_length || !bytes.ends_with(b"\x053Code") {
        return Ok(None);
    }
    for index in 0..bytes.len().saturating_sub(36) {
        if bytes[index] != 0x24 { continue; }
        let source = OutPoint {
            txid: Txid::from_le_bytes(bytes[index + 1..index + 33].try_into().unwrap()),
            vout: u32::from_le_bytes(bytes[index + 33..index + 37].try_into().unwrap()),
        };
        let rebuilt = scripts::coin_nft_code_script(&source.txid.to_string(), source.vout)
            .map_err(|error| error.to_string())?;
        if rebuilt == *code { return Ok(Some(source)); }
    }
    // Could be another template sharing size/marker, not an authorized asset.
    Ok(None)
}

// Some deployed Coin certificates use the older NFT Code. That Code is also
// used by ordinary NFTs, so it is only a candidate here: the caller must
// validate the adjacent Coin Hold and CoinNftData Tape before classification.
fn deployed_coin_candidate_source(code: &Script) -> Result<Option<OutPoint>, String> {
    static CODE_BYTES: OnceLock<usize> = OnceLock::new();
    let bytes = code.as_bytes();
    let expected_length = *CODE_BYTES.get_or_init(|| nft::scripts::code_script(
        &Txid::from_le_bytes([0; 32]).to_string(), 0,
    ).expect("fixed deployed NFT Code template").as_bytes().len());
    if bytes.len() != expected_length || !bytes.ends_with(b"\x053Code") { return Ok(None); }
    for index in 0..bytes.len().saturating_sub(36) {
        if bytes[index] != 0x24 { continue; }
        let source = OutPoint {
            txid: Txid::from_le_bytes(bytes[index + 1..index + 33].try_into().unwrap()),
            vout: u32::from_le_bytes(bytes[index + 33..index + 37].try_into().unwrap()),
        };
        let rebuilt = nft::scripts::code_script(&source.txid.to_string(), source.vout)
            .map_err(|error| error.to_string())?;
        if rebuilt == *code { return Ok(Some(source)); }
    }
    Ok(None)
}

pub fn inspect_historical_coin_certificate(
    code: &TxOut, hold: Option<&TxOut>, tape: Option<&TxOut>,
) -> Result<Option<HistoricalCoinCertificate>, String> {
    let canonical_source = historical_coin_source(&code.script_pubkey)?;
    let deployed_source = if canonical_source.is_none() {
        deployed_coin_candidate_source(&code.script_pubkey)?
    } else { None };
    let Some(source) = canonical_source.clone().or(deployed_source) else { return Ok(None); };
    let hold = hold.ok_or("historical stableCoin certificate Hold is missing")?;
    let tape = tape.ok_or("historical stableCoin certificate Tape is missing")?;
    // The older Code is also an ordinary NFT Code. Recognize its complete
    // regular Hold and let the NFT codec validate that group's Tape.
    if canonical_source.is_none() {
        let bytes = hold.script_pubkey.as_bytes();
        if let Some(hash) = bytes.get(3..23).and_then(|bytes| bytes.try_into().ok()) {
            if nft::scripts::hold_script(&Address::from_hash160(hash)) == hold.script_pubkey {
                return Ok(None);
            }
        }
    }
    if code.satoshis != scripts::COIN_NFT_CODE_SATOSHIS
        || hold.satoshis != scripts::COIN_NFT_HOLD_SATOSHIS {
        return Err("historical stableCoin certificate output values differ".into());
    }
    let data: CoinNftData = match decode_tape(tape) {
        Ok(data) => data,
        // A deployed-candidate NFT Code with a regular NFT Tape is not a
        // Coin certificate. The NFT codec still validates the full group.
        Err(_) if canonical_source.is_none() => return Ok(None),
        Err(error) => return Err(error),
    };
    let total_supply: u128 = data.coin_total_supply.parse()
        .map_err(|_| "historical stableCoin certificate supply is invalid")?;
    if total_supply.to_string() != data.coin_total_supply
        || total_supply > 10u128.pow(18) || data.coin_decimal > 18 {
        return Err("historical stableCoin certificate supply/precision is invalid".into());
    }
    let admin_hash: [u8; 20] = hold.script_pubkey.as_bytes().get(3..23)
        .ok_or("historical stableCoin certificate Hold is truncated")?
        .try_into().unwrap();
    let rebuilt = scripts::coin_nft_hold_script_from_hash(&admin_hash, &data.nft_name);
    if rebuilt != hold.script_pubkey {
        return Err("historical stableCoin certificate Hold binding differs".into());
    }
    Ok(Some(HistoricalCoinCertificate { source, admin_hash, total_supply, data }))
}

impl HistoricalCoinCertificate {
    /// A new zero-supply certificate is issuance setup and is forbidden too.
    /// Existing management authorization/metadata rules remain separate.
    pub fn creates_or_increases_supply(&self, previous: Option<&Self>) -> bool {
        match previous {
            None => true,
            Some(previous) => self.source != previous.source
                || self.total_supply > previous.total_supply,
        }
    }
}
