use crate::{Address, Transaction, Utxo};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FtInfo {
    pub contract_txid: Option<String>,
    pub code_script: String,
    pub tape_script: String,
    pub total_supply_raw: u128,
    pub decimal: u8,
    pub name: String,
    pub symbol: String,
}

#[derive(Clone, Debug)]
pub struct FtUtxo {
    pub base: Utxo,
    pub ft_balance_raw: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FtReceiver {
    pub address: Address,
    pub amount_raw: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MintFtTx {
    pub source: Transaction,
    pub mint: Transaction,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BatchFtTx {
    pub txraw: String,
    pub txid: String,
}
