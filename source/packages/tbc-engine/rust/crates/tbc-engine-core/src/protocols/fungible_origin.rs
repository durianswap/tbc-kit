//! Local material-selection hint from an already-required immutable origin.
//! Not holder identity, unspentness, supported issuance or signing authority.
//! The planner independently checks the selected holder Code/Tape and ancestry.
use tbc_sdk::{Transaction, Txid};
use super::{coin_identity, tbc721, fungible_change::{inspect_fungible_pair, FungibleProtocol},
    historical_coin::inspect_historical_coin_certificate};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FungibleOriginProfile { Tbc20, Coin, HistoricalFt, HistoricalStablecoin }

pub fn inspect_fungible_origin(asset_id: &Txid, raw: &[u8]) -> Result<FungibleOriginProfile, String> {
    if raw.is_empty() || raw.len() > 1_048_576 { return Err("Fungible origin exceeds byte bound".into()); }
    let tx = Transaction::from_bytes(raw).map_err(|_| "Fungible origin transaction invalid")?;
    if tx.txid() != *asset_id || tx.serialize() != raw || tx.version != 10 {
        return Err("Fungible origin transaction identity or encoding differs".into());
    }
    let code = tx.outputs.first().ok_or("Fungible origin Code is absent")?;
    if let Some(pair) = inspect_fungible_pair(code, tx.outputs.get(1))? {
        return match pair.identity.protocol {
            FungibleProtocol::Tbc20Standard => Ok(FungibleOriginProfile::Tbc20),
            FungibleProtocol::HistoricalFt(4) => Ok(FungibleOriginProfile::HistoricalFt),
            _ => Err("Fungible origin is not a supported FT genesis".into()),
        };
    }
    // Select exact certificate codecs, never fall back after validation fails.
    if tbc721::parse_code(code.script_pubkey.as_bytes()).is_ok() {
        coin_identity::inspect_issuer(asset_id, raw).map_err(|_| "Current Coin issuer origin invalid")?;
        return Ok(FungibleOriginProfile::Coin);
    }
    if let Some(certificate) = inspect_historical_coin_certificate(code, tx.outputs.get(1), tx.outputs.get(2))? {
        if tx.inputs.len() != 1 || tx.outputs.len() != 4 || tx.lock_time != 0 || certificate.total_supply != 0
            || certificate.source != tx.inputs[0].previous_output {
            return Err("Historical stablecoin issuer origin invalid".into());
        }
        // Certificate generation cannot assert the version of a holder output.
        // The existing historical builder still requires its supported V4 Code.
        return Ok(FungibleOriginProfile::HistoricalStablecoin);
    }
    Err("Unrecognized fungible origin template".into())
}
