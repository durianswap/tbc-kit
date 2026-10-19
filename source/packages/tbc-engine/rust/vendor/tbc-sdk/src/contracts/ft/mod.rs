pub mod amount;
#[cfg(feature = "internal-signing")]
pub mod builder;
mod data;
pub mod partial_sha256;
pub mod scripts;
pub mod unlock;

use crate::{Error, Result};

pub use data::{BatchFtTx, FtInfo, FtReceiver, FtUtxo, MintFtTx};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ft {
    pub name: String,
    pub symbol: String,
    pub decimal: u8,
    pub total_supply_raw: u128,
    pub code_script: String,
    pub tape_script: String,
    pub contract_txid: String,
}

impl Ft {
    pub fn new(name: String, symbol: String, total_supply_raw: u128, decimal: u8) -> Result<Self> {
        if total_supply_raw == 0 {
            return Err(Error::InvalidUtxo(
                "FT total supply must be greater than zero".to_string(),
            ));
        }
        if decimal > 18 {
            return Err(Error::InvalidUtxo(
                "FT decimal cannot exceed 18".to_string(),
            ));
        }
        if total_supply_raw > 10u128.pow(18) {
            return Err(Error::InvalidUtxo(
                "FT total supply cannot exceed 10^18 raw units".to_string(),
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

    pub fn initialize(&mut self, info: FtInfo) {
        self.name = info.name;
        self.symbol = info.symbol;
        self.decimal = info.decimal;
        self.total_supply_raw = info.total_supply_raw;
        self.code_script = info.code_script;
        self.tape_script = info.tape_script;
        if let Some(contract_txid) = info.contract_txid {
            self.contract_txid = contract_txid;
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn ft_new_stores_raw_supply_and_metadata() {
        let ft = super::Ft::new("Token".to_string(), "TOK".to_string(), 1_000_000, 6).unwrap();
        assert_eq!(ft.name, "Token");
        assert_eq!(ft.symbol, "TOK");
        assert_eq!(ft.total_supply_raw, 1_000_000);
        assert_eq!(ft.decimal, 6);
    }
}
