#[cfg(feature = "internal-signing")]
pub mod builder;
mod data;
pub mod scripts;

use crate::{Error, Result};

pub use data::{
    AdminSighash, CoinNftData, FinalizedStableCoinCreate, StableCoinCreate, StableCoinMint,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StableCoin {
    pub name: String,
    pub symbol: String,
    pub decimal: u8,
    pub total_supply_raw: u128,
    pub code_script: String,
    pub tape_script: String,
    pub contract_txid: String,
}

impl StableCoin {
    pub fn new(name: String, symbol: String, total_supply_raw: u128, decimal: u8) -> Result<Self> {
        if decimal > 18 {
            return Err(Error::InvalidUtxo(
                "stableCoin decimal cannot exceed 18".to_string(),
            ));
        }
        if total_supply_raw > 10u128.pow(18) {
            return Err(Error::InvalidUtxo(
                "stableCoin total supply cannot exceed 10^18 raw units".to_string(),
            ));
        }
        Ok(Self {
            name,
            symbol,
            decimal,
            total_supply_raw,
            code_script: String::new(),
            tape_script: String::new(),
            contract_txid: String::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn stable_coin_new_allows_zero_initial_supply_for_existing_coin_state() {
        let coin =
            super::StableCoin::new("USD Coin".to_string(), "USDC".to_string(), 0, 6).unwrap();

        assert_eq!(coin.total_supply_raw, 0);
        assert_eq!(coin.decimal, 6);
    }
}
